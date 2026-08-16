import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { sendSmsChecked, logInboundSms, isSmsMockMode } from '../services/sms.js';
import { sendCsv } from '../services/csv.js';

const router = Router();

// ============================= Inbound webhook (public) =============================
// No auth — this is what you point the provider's inbound-message webhook at
// (SimpleSender: Developer > Docs & Keys > Webhooks). Accepts several common
// field-name variants, including one level of nesting (some providers wrap
// the message under `data`/`message`/`payload`), and normalizes to
// {from, body} before logging.
//
// Never silently drops a payload we can't parse: an unrecognized shape still
// gets logged to the console (full raw body, so a real hit from the
// provider tells us exactly what field names to add) and stored to
// sms_messages as a 'received' row with a placeholder body, so at minimum
// the Inbox tab shows *that* something arrived even before we know how to
// read it. Always responds 200 so the provider doesn't retry.
router.post('/webhook/inbound', (req, res) => {
  const b = req.body || {};
  const nested = b.data || b.message || b.payload || {};
  const from = b.from || b.From || b.sender || b.msisdn || b.phone || b.source
    || nested.from || nested.From || nested.sender || nested.msisdn || nested.phone;
  const body = b.body || b.Body || b.text || b.message || b.content
    || nested.body || nested.Body || nested.text || nested.content;
  if (from && typeof body === 'string') {
    try { logInboundSms(null, from, body); } catch (e) { console.error('[sms] failed to log inbound message:', e.message); }
  } else {
    console.warn('[sms] inbound webhook hit with an unrecognized payload shape — logging raw body for review:', JSON.stringify(b));
    try { logInboundSms(null, from || '(unknown sender)', body || `Unrecognized webhook payload — raw: ${JSON.stringify(b).slice(0, 500)}`); }
    catch (e) { console.error('[sms] failed to log unrecognized inbound payload:', e.message); }
  }
  res.json({ ok: true });
});

router.use(auth, requireAdmin); // internal team feature — staff/org_admin/super_admin only

router.get('/config', (req, res) => res.json({ mockMode: isSmsMockMode() }));

// ============================= Message log =============================
router.get('/', (req, res) => {
  const { search, status, direction, page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (direction) { where += ' AND direction = ?'; params.push(direction); }
  if (search) { where += ' AND (phone LIKE ? OR body LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const total = db.prepare(`SELECT COUNT(*) c FROM sms_messages ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT * FROM sms_messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  res.json({ messages: rows, total });
});

router.get('/export', (req, res) => {
  const rows = db.prepare(`SELECT direction, phone, body, status, error_message, related_entity_type, related_entity_id, created_at
    FROM sms_messages WHERE org_id = ? ORDER BY created_at DESC`).all(req.user.org_id);
  sendCsv(res, `sms-messages-${Date.now()}.csv`, rows, ['direction', 'phone', 'body', 'status', 'error_message', 'related_entity_type', 'related_entity_id', 'created_at']);
});

// ============================= Templates =============================
router.get('/templates/all', (req, res) => {
  const templates = db.prepare('SELECT * FROM sms_templates WHERE org_id = ? ORDER BY name').all(req.user.org_id);
  res.json({ templates });
});

router.post('/templates', (req, res) => {
  const { name, category, body: msgBody } = req.body || {};
  if (!name || !msgBody) return res.status(400).json({ error: 'name and body are required' });
  const id = uuid();
  db.prepare(`INSERT INTO sms_templates (id, org_id, name, category, body, created_by) VALUES (?,?,?,?,?,?)`)
    .run(id, req.user.org_id, name, category || '', msgBody, req.user.id);
  res.status(201).json({ template: db.prepare('SELECT * FROM sms_templates WHERE id = ?').get(id) });
});

router.put('/templates/:id', (req, res) => {
  const tmpl = db.prepare('SELECT * FROM sms_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!tmpl) return res.status(404).json({ error: 'Not found' });
  const { name, category, body: msgBody } = req.body || {};
  db.prepare(`UPDATE sms_templates SET name=COALESCE(?,name), category=COALESCE(?,category), body=COALESCE(?,body), updated_at=datetime('now') WHERE id=?`)
    .run(name, category, msgBody, tmpl.id);
  res.json({ template: db.prepare('SELECT * FROM sms_templates WHERE id = ?').get(tmpl.id) });
});

router.delete('/templates/:id', (req, res) => {
  const tmpl = db.prepare('SELECT * FROM sms_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!tmpl) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM sms_templates WHERE id = ?').run(tmpl.id);
  res.json({ ok: true });
});

// ============================= Recipients =============================
// Powers the "send to a group" picker — resolves each group to a list of
// {label, phone} pairs from wherever that group's phone numbers actually
// live (shuls' Gabai cell, stores' manager/owner phone, applicants' own
// numbers, internal staff's users.phone). Individual entities with no phone
// on file are silently skipped (nothing to send to).
router.get('/groups/:group', (req, res) => {
  const orgId = req.user.org_id;
  let rows = [];
  if (req.params.group === 'shuls') {
    rows = db.prepare(`SELECT name_en AS label, gabai_cell AS phone FROM shuls WHERE org_id = ? AND gabai_cell IS NOT NULL AND gabai_cell != ''`).all(orgId);
  } else if (req.params.group === 'stores') {
    rows = db.prepare(`SELECT name AS label, COALESCE(NULLIF(manager_phone,''), owner_phone) AS phone FROM stores WHERE org_id = ? AND (manager_phone IS NOT NULL AND manager_phone != '' OR owner_phone IS NOT NULL AND owner_phone != '')`).all(orgId);
  } else if (req.params.group === 'applicants') {
    rows = db.prepare(`SELECT first_name || ' ' || last_name AS label, COALESCE(NULLIF(husband_cell,''), NULLIF(wife_cell,''), home_phone) AS phone FROM applicants WHERE org_id = ? AND (husband_cell IS NOT NULL AND husband_cell != '' OR wife_cell IS NOT NULL AND wife_cell != '' OR home_phone IS NOT NULL AND home_phone != '')`).all(orgId);
  } else if (req.params.group === 'staff') {
    rows = db.prepare(`SELECT first_name || ' ' || last_name AS label, phone FROM users WHERE org_id = ? AND role IN ('super_admin','org_admin','staff') AND is_active = 1 AND phone IS NOT NULL AND phone != ''`).all(orgId);
  } else {
    return res.status(400).json({ error: 'Invalid group' });
  }
  res.json({ recipients: rows.filter(r => r.phone) });
});

// ============================= Compose & send =============================
// `to` is either a single phone number, or `group` is one of
// shuls|stores|applicants|staff to broadcast to every phone on file for
// that group. {{variable}} placeholders in body are substituted from
// `variables` for single sends (groups don't get per-recipient variables —
// send the same message to everyone).
router.post('/send', async (req, res) => {
  const { to, group, body, variables } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body is required' });
  const substitute = (text) => String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => (variables && variables[key] != null ? variables[key] : m));

  if (group) {
    let recipients = [];
    const orgId = req.user.org_id;
    if (group === 'shuls') recipients = db.prepare(`SELECT gabai_cell AS phone FROM shuls WHERE org_id = ? AND gabai_cell IS NOT NULL AND gabai_cell != ''`).all(orgId);
    else if (group === 'stores') recipients = db.prepare(`SELECT COALESCE(NULLIF(manager_phone,''), owner_phone) AS phone FROM stores WHERE org_id = ?`).all(orgId);
    else if (group === 'applicants') recipients = db.prepare(`SELECT COALESCE(NULLIF(husband_cell,''), NULLIF(wife_cell,''), home_phone) AS phone FROM applicants WHERE org_id = ?`).all(orgId);
    else if (group === 'staff') recipients = db.prepare(`SELECT phone FROM users WHERE org_id = ? AND role IN ('super_admin','org_admin','staff') AND is_active = 1 AND phone IS NOT NULL AND phone != ''`).all(orgId);
    else return res.status(400).json({ error: 'Invalid group' });
    const phones = [...new Set(recipients.map(r => r.phone).filter(Boolean))];
    if (!phones.length) return res.status(400).json({ error: 'No recipients with a phone number on file for this group' });
    let sent = 0, failed = 0;
    for (const phone of phones) {
      const { emailError } = await sendSmsChecked(orgId, phone, body, { sentBy: req.user.id });
      if (emailError) failed++; else sent++;
    }
    return res.json({ ok: true, sent, failed, total: phones.length });
  }

  if (!to) return res.status(400).json({ error: 'to or group is required' });
  const { emailError } = await sendSmsChecked(req.user.org_id, to, substitute(body), { sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

export default router;
