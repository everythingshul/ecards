import { Router } from 'express';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import { sendMailChecked, renderSystemTemplate } from '../services/mail.js';
import { sendCsv } from '../services/csv.js';
import { normalizePhone } from '../utils/phone.js';
import { getFormWindow, formWindowError } from '../utils/formSchedule.js';
import { logAudit } from '../services/audit.js';

const router = Router();

// Public: store self-application (mirrors the shul public form) — spec #9 says
// stores can be added by admin OR sign up themselves. Starts at setup_status
// 'pending'; admin reviews and invites to the portal same as an admin-added store.
router.post('/apply', (req, res) => {
  const orgId = req.body.org_id || DEFAULT_ORG_ID;
  const windowError = formWindowError(getFormWindow(orgId, 'store-application'));
  if (windowError) return res.status(423).json({ error: windowError });
  const b = req.body || {};
  if (!b.name || !b.owner_email) return res.status(400).json({ error: 'Store name and owner email are required' });
  const id = uuid();
  db.prepare(`INSERT INTO stores (id, org_id, name, address, city, state, zip, phone, manager_name, manager_phone, manager_email,
      owner_name, owner_phone, owner_email, comments, setup_status, has_provider_account, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,'pending',?, 'application')`)
    .run(id, orgId, b.name, b.address || '', b.city || '', b.state || '', b.zip || '', normalizePhone(b.phone || ''),
      b.manager_name || '', normalizePhone(b.manager_phone || ''), b.manager_email || '', b.owner_name || '', normalizePhone(b.owner_phone || ''), b.owner_email,
      b.comments || '', b.has_provider_account ? 1 : 0);
  res.status(201).json({ store: db.prepare('SELECT * FROM stores WHERE id = ?').get(id), message: 'Application received. We will reach out once your store is reviewed and approved.' });
});

router.use(auth, requirePermission('stores'));

function scopeWhere(req) {
  let where = 'WHERE org_id = ?';
  const params = [req.user.org_id];
  if (req.user.role === 'store') { where += ' AND id = ?'; params.push(req.user.store_id); }
  else if (req.permission.scope === 'assigned') {
    where += ` AND id IN (SELECT entity_id FROM user_assignments WHERE user_id = ? AND entity_type = 'store')`;
    params.push(req.user.id);
  }
  return { where, params };
}

router.get('/', (req, res) => {
  const { search, setup_status } = req.query;
  let { where, params } = scopeWhere(req);
  if (setup_status) { where += ' AND setup_status = ?'; params.push(setup_status); }
  if (search) { where += ' AND (name LIKE ? OR city LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const stores = db.prepare(`SELECT * FROM stores ${where} ORDER BY created_at DESC`).all(...params);
  // Live spend per store — computed fresh on every request from the synced
  // transaction ledger, not cached, so it's always current as of the last sync.
  const spendStmt = db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) total_purchases,
    COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) total_refunds, COUNT(*) txn_count
    FROM card_transactions WHERE store_id = ?`);
  const withSpend = stores.map(s => ({ ...s, ...spendStmt.get(s.id) }));
  res.json({ stores: redact(withSpend, req.permission.hidden_fields) });
});

// Full-detail CSV export — every field. Must be registered before /:id.
router.get('/export', requirePermission('stores', 'can_export'), (req, res) => {
  const { search, setup_status } = req.query;
  let { where, params } = scopeWhere(req);
  if (setup_status) { where += ' AND setup_status = ?'; params.push(setup_status); }
  if (search) { where += ' AND (name LIKE ? OR city LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const stores = db.prepare(`SELECT * FROM stores ${where} ORDER BY created_at DESC`).all(...params);
  const withSpend = stores.map(s => {
    const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) total_purchases, COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) total_refunds FROM card_transactions WHERE store_id = ?`).get(s.id);
    return { ...s, total_purchases: totals.total_purchases, total_refunds: totals.total_refunds };
  });
  sendCsv(res, `stores-${Date.now()}.csv`, redact(withSpend, req.permission.hidden_fields));
});

router.get('/:id', (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  const billing = db.prepare('SELECT * FROM store_billing WHERE store_id = ? ORDER BY period DESC').all(store.id);
  const transactionTotals = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) total_purchases,
    COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) total_refunds
    FROM card_transactions WHERE store_id = ?`).get(store.id);
  res.json({ store: redact(store, req.permission.hidden_fields), billing, transactionTotals });
});

// Stores are one persistent record reused every season (unlike shuls and
// applicants, which get a fresh record each season) — so "other seasons"
// for a store means its real per-season activity, derived from the
// transaction ledger rather than a separate status table.
router.get('/:id/season-history', requireAdmin, (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const seasons = db.prepare(`SELECT c.season_id, se.name AS season_name, COUNT(*) AS txn_count,
      COALESCE(SUM(CASE WHEN ct.amount < 0 THEN -ct.amount ELSE 0 END),0) AS total_purchases,
      COALESCE(SUM(CASE WHEN ct.type='refund' THEN ct.amount ELSE 0 END),0) AS total_refunds
    FROM card_transactions ct JOIN cards c ON c.id = ct.card_id LEFT JOIN seasons se ON se.id = c.season_id
    WHERE ct.store_id = ? GROUP BY c.season_id ORDER BY se.created_at DESC`).all(store.id);
  res.json({ seasons });
});

router.post('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Store name is required' });
  const id = uuid();
  db.prepare(`INSERT INTO stores (id, org_id, name, address, city, state, zip, phone, manager_name, manager_phone, manager_email,
      owner_name, owner_phone, owner_email, comments, setup_status, has_provider_account)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?)`)
    .run(id, req.user.org_id, b.name, b.address || '', b.city || '', b.state || '', b.zip || '', normalizePhone(b.phone || ''),
      b.manager_name || '', normalizePhone(b.manager_phone || ''), b.manager_email || '', b.owner_name || '', normalizePhone(b.owner_phone || ''), b.owner_email || '',
      b.comments || '', b.setup_status || 'pending', b.has_provider_account ? 1 : 0);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  logAudit(req.user.org_id, req.user.id, 'create', 'store', id, null, store, req.ip);
  res.status(201).json({ store });
});

router.put('/:id', requireAdmin, (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const fields = ['name','address','city','state','zip','phone','manager_name','manager_phone','manager_email','owner_name','owner_phone','owner_email','comments','setup_status','has_provider_account','provider_store_id'];
  const b = req.body || {};
  if (b.phone !== undefined) b.phone = normalizePhone(b.phone);
  if (b.manager_phone !== undefined) b.manager_phone = normalizePhone(b.manager_phone);
  if (b.owner_phone !== undefined) b.owner_phone = normalizePhone(b.owner_phone);
  const sets = fields.filter(f => b[f] !== undefined);
  if (sets.length) {
    const vals = sets.map(f => f === 'has_provider_account' ? (b[f] ? 1 : 0) : b[f]);
    db.prepare(`UPDATE stores SET ${sets.map(f=>`${f}=?`).join(',')} WHERE id=?`).run(...vals, store.id);
    logAudit(req.user.org_id, req.user.id, 'update', 'store', store.id, Object.fromEntries(sets.map(f => [f, store[f]])), Object.fromEntries(sets.map((f,i) => [f, vals[i]])), req.ip);
  }
  res.json({ store: db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id) });
});

// Invite a store to their self-service portal.
router.post('/:id/invite', requireAdmin, async (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const email = req.body?.email || store.owner_email || store.manager_email;
  if (!email) return res.status(400).json({ error: 'No email on file for this store' });
  let user = db.prepare('SELECT * FROM users WHERE store_id = ?').get(store.id);
  const token = uuid();
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  if (user) {
    db.prepare('UPDATE users SET invite_token=?, invite_expires=?, email=? WHERE id=?').run(token, expires, email, user.id);
  } else {
    const uid = uuid();
    db.prepare(`INSERT INTO users (id, org_id, email, first_name, role, store_id, invite_token, invite_expires, is_active) VALUES (?,?,?,?,'store',?,?,?,0)`)
      .run(uid, req.user.org_id, email, store.manager_name || store.name, store.id, token, expires);
  }
  db.prepare(`UPDATE stores SET portal_user_id = (SELECT id FROM users WHERE store_id = ?) WHERE id = ?`).run(store.id, store.id);
  const portalUrl = `${process.env.APP_URL || ''}/accept-invite.html?token=${token}`;
  const tmpl = renderSystemTemplate(req.user.org_id, 'storeSetup', { storeName: store.name, portalUrl });
  const { emailError } = await sendMailChecked(req.user.org_id, email, tmpl.subject, tmpl.body);
  if (emailError) console.error('[mail] store invite email failed:', emailError);
  res.json({ ok: true, emailError });
});

// ---- Store portal onboarding wizard ----
// Steps: 1 = confirm store/contact info, 2 = billing contact + agree to terms, 3 = complete.
// Callable by the store's own portal login OR an admin walking them through it.
router.put('/:id/onboarding', (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  if (!['store', 'super_admin', 'org_admin', 'staff'].includes(req.user.role)) return res.status(403).json({ error: 'Not permitted' });

  const { step, info, agree_terms } = req.body || {};
  if (info) {
    if (info.phone !== undefined) info.phone = normalizePhone(info.phone);
    if (info.manager_phone !== undefined) info.manager_phone = normalizePhone(info.manager_phone);
    if (info.owner_phone !== undefined) info.owner_phone = normalizePhone(info.owner_phone);
    const fields = ['name', 'address', 'city', 'state', 'zip', 'phone', 'manager_name', 'manager_phone', 'manager_email', 'owner_name', 'owner_phone', 'owner_email'];
    const sets = fields.filter(f => info[f] !== undefined);
    if (sets.length) db.prepare(`UPDATE stores SET ${sets.map(f => `${f}=?`).join(',')} WHERE id=?`).run(...sets.map(f => info[f]), store.id);
  }
  if (agree_terms) db.prepare(`UPDATE stores SET agreed_terms_at = datetime('now') WHERE id = ?`).run(store.id);

  const newStep = Math.max(store.onboarding_step || 0, +step || 0);
  const isComplete = newStep >= 3;
  db.prepare(`UPDATE stores SET onboarding_step = ?, onboarding_completed_at = CASE WHEN ? THEN COALESCE(onboarding_completed_at, datetime('now')) ELSE onboarding_completed_at END,
      setup_status = CASE WHEN setup_status = 'pending' AND ? THEN 'in_progress' ELSE setup_status END
    WHERE id = ?`).run(newStep, isComplete ? 1 : 0, newStep > 0 ? 1 : 0, store.id);

  res.json({ store: db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id) });
});

// ---- Billing ----
router.get('/:id/billing', (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  res.json({ billing: db.prepare('SELECT * FROM store_billing WHERE store_id = ? ORDER BY period DESC').all(store.id) });
});

router.post('/:id/billing', requireAdmin, (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const { period, amount_owed, notes } = req.body || {};
  if (!period) return res.status(400).json({ error: 'period is required (e.g. "2026-08")' });
  const id = uuid();
  db.prepare(`INSERT INTO store_billing (id, store_id, period, amount_owed, notes, status) VALUES (?,?,?,?,?,'open')`)
    .run(id, store.id, period, amount_owed || 0, notes || '');
  res.status(201).json({ billing: db.prepare('SELECT * FROM store_billing WHERE id = ?').get(id) });
});

router.put('/billing/:billingId', requireAdmin, (req, res) => {
  const row = db.prepare(`SELECT b.* FROM store_billing b JOIN stores s ON s.id=b.store_id WHERE b.id=? AND s.org_id=?`).get(req.params.billingId, req.user.org_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { amount_owed, amount_paid, status, invoice_ref, notes } = req.body || {};
  db.prepare(`UPDATE store_billing SET amount_owed=COALESCE(?,amount_owed), amount_paid=COALESCE(?,amount_paid),
    status=COALESCE(?,status), invoice_ref=COALESCE(?,invoice_ref), notes=COALESCE(?,notes) WHERE id=?`)
    .run(amount_owed, amount_paid, status, invoice_ref, notes, row.id);
  res.json({ billing: db.prepare('SELECT * FROM store_billing WHERE id = ?').get(row.id) });
});

export default router;
