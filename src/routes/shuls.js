import { Router } from 'express';
import multer from 'multer';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import { detectAndFlag, resolveFlag } from '../services/duplicates.js';
import { generateContractPdf, stampSignature } from '../services/pdf.js';
import { sendMail, templates } from '../services/mail.js';
import { parseSpreadsheet, buildCsvTemplate, SHUL_IMPORT_COLUMNS } from '../services/importer.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const REQUIRED_SHUL_FIELDS = ['name_en', 'address', 'city', 'state', 'zip', 'ruv_first_name', 'ruv_last_name', 'ruv_phone', 'gabai_first_name', 'gabai_last_name', 'gabai_cell', 'gabai_email'];

// ============================= PUBLIC ==============================
// Public shul onboarding form submission. No auth — this is the form referenced
// in spec item #1. Creates the shul record, runs duplicate detection, and
// generates (but does not yet send) the contract PDF.
router.post('/apply', (req, res) => {
  const orgId = req.body.org_id || DEFAULT_ORG_ID;
  const b = req.body || {};
  for (const f of REQUIRED_SHUL_FIELDS) {
    if (!b[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
  }
  const season = db.prepare('SELECT * FROM seasons WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(orgId);
  const id = uuid();
  db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip, lat, lng, place_id,
      ruv_first_name, ruv_last_name, ruv_phone, ruv_address, ruv_city, ruv_state, ruv_zip, ruv_place_id,
      gabai_first_name, gabai_last_name, gabai_cell, gabai_email, gabai_address, gabai_city, gabai_state, gabai_zip, gabai_place_id,
      status, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'submitted', 'form')`)
    .run(id, orgId, season?.id || null, b.name_en, b.name_he || '', b.address, b.city, b.state, b.zip, b.lat || null, b.lng || null, b.place_id || null,
      b.ruv_first_name, b.ruv_last_name, b.ruv_phone, b.ruv_address || '', b.ruv_city || '', b.ruv_state || '', b.ruv_zip || '', b.ruv_place_id || null,
      b.gabai_first_name, b.gabai_last_name, b.gabai_cell, b.gabai_email, b.gabai_address || '', b.gabai_city || '', b.gabai_state || '', b.gabai_zip || '', b.gabai_place_id || null);

  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
  const flag = detectAndFlag(orgId, 'shul', shul);
  logAudit(orgId, null, 'create', 'shul', id, null, shul, req.ip);
  if (flag) return res.status(201).json({ shul, duplicate: true, message: 'Your application was received, but a similar shul is already on file. Our team will follow up.' });
  res.status(201).json({ shul, duplicate: false, message: 'Application received. You will receive an email with your contract to sign shortly.' });
});

// Public: minimal shul picker list for public applicant forms (name + id only).
router.get('/public/list', (req, res) => {
  const orgId = req.query.org_id || DEFAULT_ORG_ID;
  const rows = db.prepare(`SELECT id, name_en, name_he FROM shuls WHERE org_id = ? AND status='approved' AND is_paused = 0 ORDER BY name_en`).all(orgId);
  res.json({ shuls: rows });
});

// Public: immediately generate the contract right after form submission so the
// applicant can sign in the same sitting (spec #1: "fill out a form... and
// esign a contract"), rather than waiting on an admin action. Idempotent per shul.
router.post('/:id/generate-contract', async (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(req.params.id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const existing = db.prepare(`SELECT * FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1`).get(shul.id);
  if (existing) return res.json({ sign_token: existing.status === 'signed' ? null : existing.sign_token, alreadySigned: existing.status === 'signed' });
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(shul.org_id);
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(shul.season_id);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'contract_template_text'`).get(shul.org_id);
  const pdfPath = await generateContractPdf({ shul, season, templateText: templateSetting?.value, orgName: org?.name });
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO contracts (id, shul_id, season_id, pdf_path, status, sign_token, sign_token_expires, sent_at)
    VALUES (?,?,?,?,'sent',?,?,datetime('now'))`).run(uuid(), shul.id, shul.season_id, pdfPath, token, expires);
  db.prepare(`UPDATE shuls SET status='contract_sent', updated_at=datetime('now') WHERE id=?`).run(shul.id);
  res.json({ sign_token: token, alreadySigned: false });
});

// Public: fetch a shul's contract by sign token (emailed link).
router.get('/contract/:token', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
  if (!contract) return res.status(404).json({ error: 'Not found' });
  if (contract.status === 'signed') return res.json({ contract, alreadySigned: true });
  if (contract.sign_token_expires && new Date(contract.sign_token_expires) < new Date()) return res.status(410).json({ error: 'This signing link has expired. Contact us for a new one.' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(contract.shul_id);
  res.json({ contract, shul });
});

// Public: inline PDF preview (unsigned, or signed once complete) for the iframe on apply.html / sign-contract.html.
router.get('/contract/:token/pdf-preview', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
  if (!contract) return res.status(404).send('Not found');
  const path = contract.signed_pdf_path || contract.pdf_path;
  if (!path) return res.status(404).send('PDF not available');
  res.sendFile(path);
});

// Public: submit e-signature.
router.post('/contract/:token/sign', async (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
  if (!contract) return res.status(404).json({ error: 'Not found' });
  if (contract.status === 'signed') return res.status(409).json({ error: 'This contract has already been signed' });
  const { signature_data, signer_name, signer_title } = req.body || {};
  if (!signer_name || !signature_data) return res.status(400).json({ error: 'Signature and signer name are required' });
  const signedAt = new Date().toISOString();
  const signedPath = await stampSignature({ unsignedPath: contract.pdf_path, shulId: contract.shul_id, signatureDataUrl: signature_data, signerName: signer_name, signedAt, ip: req.ip });
  db.prepare(`UPDATE contracts SET status='signed', signature_data=?, signer_name=?, signer_title=?, signed_at=?, ip_address=?, signed_pdf_path=? WHERE id=?`)
    .run(signature_data, signer_name, signer_title || '', signedAt, req.ip, signedPath, contract.id);
  db.prepare(`UPDATE shuls SET status='contract_signed', updated_at=datetime('now') WHERE id=?`).run(contract.shul_id);
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(contract.shul_id);
  logAudit(shul.org_id, null, 'esign', 'contract', contract.id, null, { signer_name, signedAt }, req.ip);
  res.json({ ok: true, message: 'Contract signed. An administrator will review and set up your account.' });
});

// ============================= ADMIN ==============================
router.use(auth, requirePermission('shuls'));

router.get('/', (req, res) => {
  const { search, status, season_id, sort = 'created_at', dir = 'DESC', page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE org_id = ?';
  const params = [req.user.org_id];
  if (req.permission.scope === 'assigned') {
    where += ` AND id IN (SELECT entity_id FROM user_assignments WHERE user_id = ? AND entity_type = 'shul')`;
    params.push(req.user.id);
  }
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (season_id) { where += ' AND season_id = ?'; params.push(season_id); }
  if (search) {
    where += ` AND (name_en LIKE ? OR name_he LIKE ? OR city LIKE ? OR ruv_last_name LIKE ? OR gabai_last_name LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  const allowedSort = ['created_at', 'name_en', 'status', 'city', 'slots_allocated'];
  const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
  const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) c FROM shuls ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT * FROM shuls ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  const withCounts = rows.map(s => ({
    ...s,
    applicant_count: db.prepare('SELECT COUNT(*) c FROM applicants WHERE shul_id = ?').get(s.id).c,
  }));
  res.json({ shuls: redact(withCounts, req.permission.hidden_fields), total, page: +page, pageSize: +pageSize });
});

router.get('/:id', (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul') { if (shul.id !== req.user.shul_id) return res.status(403).json({ error: 'Not your shul' }); }
  else { checkScope(req, res, shul.id); if (res.headersSent) return; }
  const notes = db.prepare('SELECT n.*, u.first_name, u.last_name FROM shul_notes n LEFT JOIN users u ON u.id = n.user_id WHERE shul_id = ? ORDER BY n.created_at DESC').all(shul.id);
  const contract = db.prepare('SELECT * FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1').get(shul.id);
  const applicants = db.prepare('SELECT id, first_name, last_name, approval_status FROM applicants WHERE shul_id = ?').all(shul.id);
  const flags = db.prepare(`SELECT * FROM duplicate_flags WHERE entity_type='shul' AND (entity_id = ? OR matched_entity_id = ?) AND status='open'`).all(shul.id, shul.id);
  res.json({ shul: redact(shul, req.permission.hidden_fields), notes, contract, applicants, flags });
});

router.post('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  for (const f of REQUIRED_SHUL_FIELDS) if (!b[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
  const id = uuid();
  const season = db.prepare('SELECT * FROM seasons WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(req.user.org_id);
  db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip,
      ruv_first_name, ruv_last_name, ruv_phone, gabai_first_name, gabai_last_name, gabai_cell, gabai_email, status, source, slots_allocated)
    VALUES (?,?,?,?,?,?,?,?,?, ?,?,?, ?,?,?,?, 'submitted','admin', ?)`)
    .run(id, req.user.org_id, season?.id || null, b.name_en, b.name_he || '', b.address, b.city, b.state, b.zip,
      b.ruv_first_name, b.ruv_last_name, b.ruv_phone, b.gabai_first_name, b.gabai_last_name, b.gabai_cell, b.gabai_email, b.slots_allocated || 0);
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
  const flag = detectAndFlag(req.user.org_id, 'shul', shul);
  logAudit(req.user.org_id, req.user.id, 'create', 'shul', id, null, shul, req.ip);
  res.status(201).json({ shul, duplicate: !!flag });
});

router.put('/:id', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const fields = ['name_en','name_he','address','city','state','zip','lat','lng','ruv_first_name','ruv_last_name','ruv_phone','ruv_address','ruv_city','ruv_state','ruv_zip',
    'gabai_first_name','gabai_last_name','gabai_cell','gabai_email','gabai_address','gabai_city','gabai_state','gabai_zip','slots_allocated'];
  const sets = fields.filter(f => b[f] !== undefined);
  if (sets.length) {
    db.prepare(`UPDATE shuls SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...sets.map(f => b[f]), shul.id);
  }
  const updated = db.prepare('SELECT * FROM shuls WHERE id = ?').get(shul.id);
  logAudit(req.user.org_id, req.user.id, 'update', 'shul', shul.id, shul, updated, req.ip);
  res.json({ shul: updated });
});

// Approve: sets slot allocation, creates the shul portal login, emails set-up link.
router.post('/:id/approve', requireAdmin, async (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  if (shul.is_paused) return res.status(423).json({ error: 'This shul has an unresolved duplicate flag and cannot be approved yet' });
  const slots = req.body?.slots_allocated;
  if (slots === undefined || slots === null) return res.status(400).json({ error: 'slots_allocated is required to approve' });

  let user = db.prepare('SELECT * FROM users WHERE shul_id = ?').get(shul.id);
  if (!user) {
    const email = req.body.portal_email || shul.gabai_email;
    const token = uuid();
    const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const uid = uuid();
    db.prepare(`INSERT INTO users (id, org_id, email, first_name, last_name, role, shul_id, invite_token, invite_expires, is_active)
      VALUES (?,?,?,?,?,'shul',?,?,?,0)`).run(uid, req.user.org_id, email, shul.gabai_first_name, shul.gabai_last_name, shul.id, token, expires);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  }
  db.prepare(`UPDATE shuls SET status='approved', slots_allocated=?, portal_user_id=?, updated_at=datetime('now') WHERE id=?`)
    .run(slots, user.id, shul.id);
  const loginUrl = `${process.env.APP_URL || ''}/accept-invite.html?token=${user.invite_token}`;
  const tmpl = templates.accountApproved(shul.name_en, loginUrl, slots);
  await sendMail(req.user.org_id, user.email, tmpl.subject, tmpl.body);
  logAudit(req.user.org_id, req.user.id, 'approve', 'shul', shul.id, shul, { slots_allocated: slots }, req.ip);
  res.json({ ok: true, shul: db.prepare('SELECT * FROM shuls WHERE id = ?').get(shul.id) });
});

router.post('/:id/reject', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE shuls SET status='rejected', updated_at=datetime('now') WHERE id=?`).run(shul.id);
  logAudit(req.user.org_id, req.user.id, 'reject', 'shul', shul.id, shul, null, req.ip);
  res.json({ ok: true });
});

// Generate + email the contract (spec #3: "always email them when there's a doc to sign").
router.post('/:id/send-contract', requireAdmin, async (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(shul.season_id);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'contract_template_text'`).get(req.user.org_id);
  const pdfPath = await generateContractPdf({ shul, season, templateText: templateSetting?.value, orgName: org.name });
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const id = uuid();
  db.prepare(`INSERT INTO contracts (id, shul_id, season_id, pdf_path, status, sign_token, sign_token_expires, sent_at)
    VALUES (?,?,?,?,'sent',?,?,datetime('now'))`).run(id, shul.id, shul.season_id, pdfPath, token, expires);
  db.prepare(`UPDATE shuls SET status='contract_sent', updated_at=datetime('now') WHERE id=?`).run(shul.id);
  const signUrl = `${process.env.APP_URL || ''}/sign-contract.html?token=${token}`;
  const to = req.body.email || shul.gabai_email;
  const tmpl = templates.contractReady(shul.name_en, signUrl);
  await sendMail(req.user.org_id, to, tmpl.subject, tmpl.body);
  logAudit(req.user.org_id, req.user.id, 'send_contract', 'shul', shul.id, null, { to }, req.ip);
  res.json({ ok: true, contract: db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) });
});

router.get('/:id/contract/pdf', (req, res) => {
  const contract = db.prepare(`SELECT c.* FROM contracts c JOIN shuls s ON s.id=c.shul_id WHERE c.shul_id = ? AND s.org_id = ? ORDER BY c.created_at DESC LIMIT 1`).get(req.params.id, req.user.org_id);
  if (!contract) return res.status(404).json({ error: 'No contract on file' });
  const path = contract.signed_pdf_path || contract.pdf_path;
  if (!path) return res.status(404).json({ error: 'PDF not available' });
  res.sendFile(path);
});

router.post('/:id/notes', (req, res) => {
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: 'Note text required' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const id = uuid();
  db.prepare('INSERT INTO shul_notes (id, shul_id, user_id, note) VALUES (?,?,?,?)').run(id, shul.id, req.user.id, note);
  res.status(201).json({ note: db.prepare('SELECT * FROM shul_notes WHERE id = ?').get(id) });
});

router.post('/:id/pause', requireAdmin, (req, res) => {
  db.prepare('UPDATE shuls SET is_paused = 1 WHERE id = ? AND org_id = ?').run(req.params.id, req.user.org_id);
  db.prepare('UPDATE users SET is_paused = 1 WHERE shul_id = ?').run(req.params.id);
  res.json({ ok: true });
});
router.post('/:id/unpause', requireAdmin, (req, res) => {
  db.prepare('UPDATE shuls SET is_paused = 0 WHERE id = ? AND org_id = ?').run(req.params.id, req.user.org_id);
  db.prepare('UPDATE users SET is_paused = 0 WHERE shul_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Duplicate flags involving shuls
router.get('/duplicates/open', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type='shul' AND status='open' ORDER BY created_at DESC`).all(req.user.org_id);
  const withEntities = rows.map(r => ({
    ...r,
    entity: db.prepare('SELECT * FROM shuls WHERE id = ?').get(r.entity_id),
    matched: db.prepare('SELECT * FROM shuls WHERE id = ?').get(r.matched_entity_id),
  }));
  res.json({ flags: withEntities });
});

router.post('/duplicates/:flagId/resolve', requireAdmin, (req, res) => {
  const { action } = req.body || {}; // 'bypass' | 'resolve'
  const flag = resolveFlag(req.params.flagId, req.user.id, action);
  if (!flag) return res.status(404).json({ error: 'Not found' });
  logAudit(req.user.org_id, req.user.id, 'resolve_duplicate', 'duplicate_flag', flag.id, null, flag, req.ip);
  res.json({ flag });
});

// Mass upload template + import — spec #3: shuls uploaded from the back end
// should be able to receive the contract if signed up, always email when
// there's a doc to sign (handled by calling /send-contract per row, or in bulk below).
router.get('/import/template', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="shul_import_template.csv"');
  res.send(buildCsvTemplate(SHUL_IMPORT_COLUMNS));
});

router.post('/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const jobId = uuid();
  const rows = parseSpreadsheet(req.file.buffer, req.file.originalname);
  const season = db.prepare('SELECT * FROM seasons WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(req.user.org_id);
  let success = 0, dupes = 0; const errors = [];
  const sendContracts = req.body.send_contracts === 'true' || req.body.send_contracts === true;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.name_en || !r.gabai_email) { errors.push({ row: i + 2, error: 'Missing name_en or gabai_email' }); continue; }
    try {
      const id = uuid();
      db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip,
          ruv_first_name, ruv_last_name, ruv_phone, ruv_address, ruv_city, ruv_state, ruv_zip,
          gabai_first_name, gabai_last_name, gabai_cell, gabai_email, gabai_address, gabai_city, gabai_state, gabai_zip,
          status, source, slots_allocated)
        VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, 'submitted','mass_upload', ?)`)
        .run(id, req.user.org_id, season?.id || null, r.name_en, r.name_he || '', r.address || '', r.city || '', r.state || '', r.zip || '',
          r.ruv_first_name || '', r.ruv_last_name || '', r.ruv_phone || '', r.ruv_address || '', r.ruv_city || '', r.ruv_state || '', r.ruv_zip || '',
          r.gabai_first_name || '', r.gabai_last_name || '', r.gabai_cell || '', r.gabai_email, r.gabai_address || '', r.gabai_city || '', r.gabai_state || '', r.gabai_zip || '',
          Number(r.slots_allocated) || 0);
      const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
      const flag = detectAndFlag(req.user.org_id, 'shul', shul);
      if (flag) dupes++; else success++;
      if (sendContracts && !flag) {
        const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
        const pdfPath = await generateContractPdf({ shul, season, orgName: org.name });
        const token = uuid();
        const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
        db.prepare(`INSERT INTO contracts (id, shul_id, season_id, pdf_path, status, sign_token, sign_token_expires, sent_at) VALUES (?,?,?,?,'sent',?,?,datetime('now'))`)
          .run(uuid(), shul.id, shul.season_id, pdfPath, token, expires);
        db.prepare(`UPDATE shuls SET status='contract_sent' WHERE id=?`).run(shul.id);
        const signUrl = `${process.env.APP_URL || ''}/sign-contract.html?token=${token}`;
        const tmpl = templates.contractReady(shul.name_en, signUrl);
        sendMail(req.user.org_id, shul.gabai_email, tmpl.subject, tmpl.body);
      }
    } catch (e) {
      errors.push({ row: i + 2, error: e.message });
    }
  }
  db.prepare(`INSERT INTO import_jobs (id, org_id, entity_type, file_name, status, total_rows, success_count, error_count, duplicate_count, error_log, created_by)
    VALUES (?,?,?,?,'completed',?,?,?,?,?,?)`)
    .run(jobId, req.user.org_id, 'shuls', req.file.originalname, rows.length, success, errors.length, dupes, JSON.stringify(errors), req.user.id);
  res.json({ jobId, total: rows.length, success, duplicates: dupes, errors });
});

function checkScope(req, res, shulId) {
  if (req.permission.scope !== 'assigned') return;
  const ok = db.prepare(`SELECT 1 FROM user_assignments WHERE user_id = ? AND entity_type='shul' AND entity_id = ?`).get(req.user.id, shulId);
  if (!ok) res.status(403).json({ error: 'Not assigned to you' });
}

function logAudit(orgId, userId, action, entityType, entityId, before, after, ip) {
  db.prepare(`INSERT INTO audit_log (id, org_id, user_id, action, entity_type, entity_id, before_json, after_json, ip_address)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(uuid(), orgId, userId, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip);
}

export default router;
