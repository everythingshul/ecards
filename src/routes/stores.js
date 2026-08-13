import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import { sendMail, templates } from '../services/mail.js';

const router = Router();
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
  res.json({ stores: redact(stores, req.permission.hidden_fields) });
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

router.post('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Store name is required' });
  const id = uuid();
  db.prepare(`INSERT INTO stores (id, org_id, name, address, city, state, zip, phone, manager_name, manager_phone, manager_email,
      owner_name, owner_phone, owner_email, comments, setup_status, has_provider_account)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?)`)
    .run(id, req.user.org_id, b.name, b.address || '', b.city || '', b.state || '', b.zip || '', b.phone || '',
      b.manager_name || '', b.manager_phone || '', b.manager_email || '', b.owner_name || '', b.owner_phone || '', b.owner_email || '',
      b.comments || '', b.setup_status || 'pending', b.has_provider_account ? 1 : 0);
  res.status(201).json({ store: db.prepare('SELECT * FROM stores WHERE id = ?').get(id) });
});

router.put('/:id', requireAdmin, (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const fields = ['name','address','city','state','zip','phone','manager_name','manager_phone','manager_email','owner_name','owner_phone','owner_email','comments','setup_status','has_provider_account','provider_store_id'];
  const b = req.body || {};
  const sets = fields.filter(f => b[f] !== undefined);
  if (sets.length) db.prepare(`UPDATE stores SET ${sets.map(f=>`${f}=?`).join(',')} WHERE id=?`).run(...sets.map(f => f==='has_provider_account' ? (b[f]?1:0) : b[f]), store.id);
  res.json({ store: db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id) });
});

// Invite a store to their self-service portal.
router.post('/:id/invite', requireAdmin, (req, res) => {
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
  const tmpl = templates.storeSetup(store.name, portalUrl);
  sendMail(email, tmpl.subject, tmpl.body);
  res.json({ ok: true });
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
