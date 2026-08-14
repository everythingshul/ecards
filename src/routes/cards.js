import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import * as giftcard from '../services/giftcard.js';

const router = Router();
router.use(auth, requirePermission('cards'));

router.get('/', (req, res) => {
  const { search, status, season_id, page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND c.status = ?'; params.push(status); }
  if (season_id) { where += ' AND c.season_id = ?'; params.push(season_id); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR c.card_number_masked LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const total = db.prepare(`SELECT COUNT(*) c FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT c.*, a.first_name, a.last_name, a.email, s.name_en as shul_name
    FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id LEFT JOIN shuls s ON s.id=a.shul_id
    ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  res.json({ cards: redact(rows, req.permission.hidden_fields), total, page: +page, pageSize: +pageSize, mockMode: giftcard.isMockMode(req.user.org_id) });
});

router.get('/:id', (req, res) => {
  const card = db.prepare(`SELECT c.*, a.first_name, a.last_name FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id WHERE c.id = ? AND c.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const transactions = db.prepare('SELECT * FROM card_transactions WHERE card_id = ? ORDER BY occurred_at DESC').all(card.id);
  res.json({ card, transactions });
});

// Assign the next card to an approved applicant (spec #7: "assign a card, they get
// a random card and when they use the phone on the account to activate, it'll be
// written onto their account. We set the amount").
router.post('/assign', requireAdmin, async (req, res) => {
  const { applicant_id, amount } = req.body || {};
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(applicant_id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Applicant not found' });
  if (applicant.approval_status !== 'approved') return res.status(400).json({ error: 'Applicant must be approved before a card is assigned' });
  if (applicant.is_paused) return res.status(423).json({ error: 'Applicant is paused pending duplicate resolution' });
  const finalAmount = amount ?? applicant.card_amount ?? 0;
  const result = await giftcard.assignCard(req.user.org_id, { applicantId: applicant.id, amount: finalAmount });
  const id = uuid();
  db.prepare(`INSERT INTO cards (id, org_id, applicant_id, season_id, card_number_masked, provider_card_id, status, amount, assigned_at)
    VALUES (?,?,?,?,?,?,'assigned',?,datetime('now'))`)
    .run(id, req.user.org_id, applicant.id, applicant.season_id, result.maskedNumber, result.providerCardId, finalAmount);
  db.prepare(`INSERT INTO card_transactions (id, card_id, type, amount, occurred_at) VALUES (?,?,?,?,datetime('now'))`)
    .run(uuid(), id, 'load', finalAmount);
  db.prepare(`INSERT INTO audit_log (id, org_id, user_id, action, entity_type, entity_id, after_json) VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), req.user.org_id, req.user.id, 'assign_card', 'card', id, JSON.stringify({ applicant_id, amount: finalAmount }));
  res.status(201).json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(id) });
});

// Activate — the phone number the applicant/gabai provides "gets written onto their account."
router.post('/:id/activate', requireAdmin, async (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Activation phone number is required' });
  const result = await giftcard.activateCard(req.user.org_id, { providerCardId: card.provider_card_id, phone });
  db.prepare(`UPDATE cards SET status='activated', activation_phone=?, activated_at=? WHERE id=?`).run(phone, result.activatedAt, card.id);
  db.prepare(`INSERT INTO card_transactions (id, card_id, type, amount, occurred_at) VALUES (?,?,?,0,?)`).run(uuid(), card.id, 'activation', result.activatedAt);
  res.json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) });
});

router.post('/:id/deactivate', requireAdmin, async (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const result = await giftcard.deactivateCard(req.user.org_id, { providerCardId: card.provider_card_id, reason: req.body?.reason });
  db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=? WHERE id=?`).run(result.deactivatedAt, card.id);
  res.json({ ok: true });
});

// Pull latest balance/status + transactions from disccardpromos for one card.
router.post('/:id/sync', requireAdmin, async (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const txns = await giftcard.listTransactions(req.user.org_id, { providerCardId: card.provider_card_id, since: card.last_synced_at });
  const insert = db.prepare(`INSERT OR IGNORE INTO card_transactions (id, card_id, provider_txn_id, type, amount, balance_after, store_name, occurred_at, raw_payload)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const t of txns) {
    insert.run(uuid(), card.id, t.id || t.transaction_id, t.type || (t.amount < 0 ? 'purchase' : 'refund'), t.amount, t.balance_after ?? null, t.store_name || t.merchant || '', t.occurred_at || t.date, JSON.stringify(t));
  }
  db.prepare(`UPDATE cards SET last_synced_at = datetime('now') WHERE id = ?`).run(card.id);
  res.json({ synced: txns.length, mockMode: giftcard.isMockMode(req.user.org_id) });
});

router.get('/:id/transactions', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  res.json({ transactions: db.prepare('SELECT * FROM card_transactions WHERE card_id = ? ORDER BY occurred_at DESC').all(card.id) });
});

// All transactions across the org — "see all transactions they make in stores,
// with all transaction info, balance, activation time, refunds — everything."
router.get('/transactions/all', requireAdmin, (req, res) => {
  const { page = 1, pageSize = 100, type, store_id } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (type) { where += ' AND t.type = ?'; params.push(type); }
  if (store_id) { where += ' AND t.store_id = ?'; params.push(store_id); }
  const total = db.prepare(`SELECT COUNT(*) c FROM card_transactions t JOIN cards c ON c.id=t.card_id ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT t.*, a.first_name, a.last_name, c.card_number_masked
    FROM card_transactions t JOIN cards c ON c.id=t.card_id LEFT JOIN applicants a ON a.id=c.applicant_id
    ${where} ORDER BY t.occurred_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  res.json({ transactions: rows, total, page: +page, pageSize: +pageSize });
});

export default router;
