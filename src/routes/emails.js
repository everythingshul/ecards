import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { sendMailChecked } from '../services/mail.js';
import { sendXlsx } from '../services/xlsx.js';
import { findAccountByEmail } from '../utils/contactLookup.js';

const router = Router();
router.use(auth, requirePermission('emails')); // internal team feature — staff/org_admin/super_admin only

// ============================= Sent email log =============================
router.get('/', (req, res) => {
  const { search, status, page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE e.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND e.status = ?'; params.push(status); }
  if (search) { where += ' AND (e.to_email LIKE ? OR e.subject LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const total = db.prepare(`SELECT COUNT(*) c FROM emails_sent e ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  // sent_by_name is who to display as having sent this — the acting admin
  // for anything triggered from the admin side (quick-send, approvals,
  // invites, contract/document sends, ...), null/blank for genuinely
  // automatic system emails (password resets, task reminders) where no
  // admin was involved.
  const rows = db.prepare(`SELECT e.id, e.to_email, e.subject, e.status, e.error_message, e.related_entity_type, e.related_entity_id, e.sent_by, e.created_at,
      TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS sent_by_name
    FROM emails_sent e LEFT JOIN users u ON u.id = e.sent_by
    ${where}
    ORDER BY e.created_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  const emails = rows.map(r => ({ ...r, account: findAccountByEmail(req.user.org_id, r.to_email) }));
  res.json({ emails, total });
});

router.get('/export', requirePermission('emails', 'can_export'), (req, res) => {
  const rows = db.prepare(`SELECT e.to_email, e.subject, e.status, e.error_message, e.related_entity_type, e.related_entity_id, e.created_at,
      TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS sent_by_name
    FROM emails_sent e LEFT JOIN users u ON u.id = e.sent_by WHERE e.org_id = ? ORDER BY e.created_at DESC`).all(req.user.org_id);
  const withAccount = rows.map(r => {
    const account = findAccountByEmail(req.user.org_id, r.to_email);
    return { ...r, account_type: account?.type || '', account_name: account?.label || '' };
  });
  sendXlsx(res, `sent-emails-${Date.now()}.xlsx`, withAccount, ['to_email', 'account_type', 'account_name', 'subject', 'status', 'error_message', 'related_entity_type', 'related_entity_id', 'sent_by_name', 'created_at']);
});

router.get('/:id', (req, res) => {
  const email = db.prepare(`SELECT e.*, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS sent_by_name
    FROM emails_sent e LEFT JOIN users u ON u.id = e.sent_by WHERE e.id = ? AND e.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  res.json({ email: { ...email, account: findAccountByEmail(req.user.org_id, email.to_email) } });
});

// ============================= Templates =============================
router.get('/templates/all', (req, res) => {
  const templates = db.prepare('SELECT * FROM email_templates WHERE org_id = ? ORDER BY name').all(req.user.org_id);
  res.json({ templates });
});

router.post('/templates', requirePermission('emails', 'can_edit'), (req, res) => {
  const { name, category, subject, body_html } = req.body || {};
  if (!name || !subject || !body_html) return res.status(400).json({ error: 'name, subject, and body_html are required' });
  const id = uuid();
  db.prepare(`INSERT INTO email_templates (id, org_id, name, category, subject, body_html, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, name, category || '', subject, body_html, req.user.id);
  res.status(201).json({ template: db.prepare('SELECT * FROM email_templates WHERE id = ?').get(id) });
});

router.put('/templates/:id', requirePermission('emails', 'can_edit'), (req, res) => {
  const tmpl = db.prepare('SELECT * FROM email_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!tmpl) return res.status(404).json({ error: 'Not found' });
  const { name, category, subject, body_html } = req.body || {};
  db.prepare(`UPDATE email_templates SET name=COALESCE(?,name), category=COALESCE(?,category), subject=COALESCE(?,subject), body_html=COALESCE(?,body_html), updated_at=datetime('now') WHERE id=?`)
    .run(name, category, subject, body_html, tmpl.id);
  res.json({ template: db.prepare('SELECT * FROM email_templates WHERE id = ?').get(tmpl.id) });
});

router.delete('/templates/:id', requirePermission('emails', 'can_edit'), (req, res) => {
  const tmpl = db.prepare('SELECT * FROM email_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!tmpl) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM email_templates WHERE id = ?').run(tmpl.id);
  res.json({ ok: true });
});

// ============================= Compose & send =============================
// The "Email Builder" send action — an arbitrary one-off (or templated)
// email to any recipient, distinct from the system's automatic emails.
// {{variable}} placeholders in the template are substituted from `variables`.
router.post('/send', requirePermission('emails', 'can_edit'), async (req, res) => {
  const { to, subject, body_html, variables } = req.body || {};
  if (!to || !subject || !body_html) return res.status(400).json({ error: 'to, subject, and body_html are required' });
  const substitute = (text) => String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => (variables && variables[key] != null ? variables[key] : m));
  const finalSubject = substitute(subject);
  const finalBody = substitute(body_html);
  const { emailError } = await sendMailChecked(req.user.org_id, to, finalSubject, finalBody, { sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

export default router;
