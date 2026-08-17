import { Router } from 'express';
import multer from 'multer';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import { detectAndFlag, resolveFlag } from '../services/duplicates.js';
import { generateContractPdf, stampSignatureFields, getSignatureFields, resolveSignatureValues } from '../services/pdf.js';
import { sendMailChecked, renderSystemTemplate } from '../services/mail.js';
import { sendSmsChecked } from '../services/sms.js';
import { parseSpreadsheet, buildCsvTemplate, SHUL_IMPORT_COLUMNS } from '../services/importer.js';
import { sendCsv } from '../services/csv.js';
import { normalizePhone } from '../utils/phone.js';
import { formWindowError, getFormSeasonId } from '../utils/formSchedule.js';
import { getDefaultForm, validateBySchema, validateRowsBySchema, splitKnown, recordFormResponse, SHUL_FIELDS } from '../utils/formValidation.js';
import { logAudit } from '../services/audit.js';
import { deletePolymorphicRefs } from '../utils/entityDelete.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const REQUIRED_SHUL_FIELDS = ['name_en', 'address', 'city', 'state', 'zip', 'ruv_first_name', 'ruv_last_name', 'ruv_phone', 'gabai_first_name', 'gabai_last_name', 'gabai_cell', 'gabai_email'];

// ============================= PUBLIC ==============================
// Public shul onboarding form submission. No auth — this is the form referenced
// in spec item #1. Creates the shul record, runs duplicate detection, and
// generates (but does not yet send) the contract PDF.
router.post('/apply', (req, res) => {
  const orgId = req.body.org_id || DEFAULT_ORG_ID;
  const defaultForm = getDefaultForm(orgId, 'shul_application');
  const windowError = formWindowError(defaultForm);
  if (windowError) return res.status(423).json({ error: windowError });
  const b = req.body || {};
  // The page itself is now a plain render of defaultForm.schema_json (see
  // form-render.js), so every field an admin sees here — including ones that
  // used to be hardcoded HTML — lives in that schema. Required-ness and
  // per-field admin_override come from it too (isAdmin: false — a public
  // applicant never gets the override).
  const schema = defaultForm ? JSON.parse(defaultForm.schema_json || '[]') : [];
  const errors = validateBySchema(schema, b, { isAdmin: false });
  if (errors.length) return res.status(400).json({ error: errors[0] });
  const { known: shul, extra } = splitKnown(schema, b, SHUL_FIELDS);
  // Non-negotiable floor regardless of what the live schema currently asks
  // for (defense in depth — PUT /:id/set-default already refuses to switch
  // to a schema missing these, so this should never actually trip).
  for (const f of REQUIRED_SHUL_FIELDS) {
    if (!shul[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
  }
  if (shul.ruv_phone !== undefined) shul.ruv_phone = normalizePhone(shul.ruv_phone);
  if (shul.gabai_cell !== undefined) shul.gabai_cell = normalizePhone(shul.gabai_cell);
  const seasonId = defaultForm?.season_id || getFormSeasonId(orgId, 'shul_application');
  const id = uuid();
  // lat/lng/place_id (Places autocomplete) are technical fields the JS
  // widget fills in directly, not builder-configurable questions — read
  // straight off the body regardless of schema, same as before.
  db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip, lat, lng, place_id,
      ruv_first_name, ruv_last_name, ruv_phone, ruv_address, ruv_city, ruv_state, ruv_zip, ruv_place_id,
      gabai_first_name, gabai_last_name, gabai_cell, gabai_email, gabai_address, gabai_city, gabai_state, gabai_zip, gabai_place_id,
      status, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'submitted', 'form')`)
    .run(id, orgId, seasonId, shul.name_en, shul.name_he || '', shul.address, shul.city, shul.state, shul.zip, b.lat || null, b.lng || null, b.place_id || null,
      shul.ruv_first_name, shul.ruv_last_name, shul.ruv_phone, shul.ruv_address || '', shul.ruv_city || '', shul.ruv_state || '', shul.ruv_zip || '', b.ruv_place_id || null,
      shul.gabai_first_name, shul.gabai_last_name, shul.gabai_cell, shul.gabai_email, shul.gabai_address || '', shul.gabai_city || '', shul.gabai_state || '', shul.gabai_zip || '', b.gabai_place_id || null);

  // Anything the admin added to the schema beyond the known DB columns
  // (splitKnown above) lands here as free text, same as a generic custom
  // form. b.extra_notes is a legacy fallback for the old fixed-fields-plus-
  // bolt-ons page shape, kept in case anything still posts that field name.
  if (extra) db.prepare('INSERT INTO shul_notes (id, shul_id, note) VALUES (?,?,?)').run(uuid(), id, extra);
  if (b.extra_notes) db.prepare('INSERT INTO shul_notes (id, shul_id, note) VALUES (?,?,?)').run(uuid(), id, b.extra_notes);

  const shulRow = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
  const flag = detectAndFlag(orgId, 'shul', shulRow);
  logAudit(orgId, null, 'create', 'shul', id, null, shulRow, req.ip);
  recordFormResponse(orgId, defaultForm, b, { type: 'shul', id });
  if (flag) return res.status(201).json({ shul: shulRow, duplicate: true, message: 'Your application was received, but a similar shul is already on file. Our team will follow up.' });
  res.status(201).json({ shul: shulRow, duplicate: false, message: 'Application received. You will receive an email with your contract to sign shortly.' });
});

// Public: minimal shul picker list for public applicant forms (name + id only).
// Excludes locked system shuls (e.g. "Ezras Habayis") — those auto-attach
// applicants themselves and were never meant to be picked from a list.
router.get('/public/list', (req, res) => {
  const orgId = req.query.org_id || DEFAULT_ORG_ID;
  const rows = db.prepare(`SELECT id, name_en, name_he FROM shuls WHERE org_id = ? AND status='approved' AND is_paused = 0 AND is_locked = 0 ORDER BY name_en`).all(orgId);
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
  res.json({ contract, shul, fields: getSignatureFields(DEFAULT_ORG_ID, 'shul') });
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
  const { signer_name, signer_title } = req.body || {};
  if (!signer_name) return res.status(400).json({ error: 'Signer name is required' });
  const fields = getSignatureFields(DEFAULT_ORG_ID, 'shul');
  const { values, missing } = resolveSignatureValues(fields, req.body);
  if (missing.length) return res.status(400).json({ error: `Please complete: ${missing.join(', ')}` });
  const signedAt = new Date().toISOString();
  const primary = fields.find(f => f.type === 'signature') || fields[0];
  const signedPath = await stampSignatureFields({ unsignedPath: contract.pdf_path, shulId: contract.shul_id, fields, values, signerName: signer_name, signedAt, ip: req.ip });
  const signatureData = primary ? values[primary.id] : null;
  db.prepare(`UPDATE contracts SET status='signed', signature_data=?, signer_name=?, signer_title=?, signed_at=?, ip_address=?, signed_pdf_path=?, field_values=? WHERE id=?`)
    .run(signatureData, signer_name, signer_title || '', signedAt, req.ip, signedPath, JSON.stringify(values), contract.id);
  db.prepare(`UPDATE shuls SET status='contract_signed', updated_at=datetime('now') WHERE id=?`).run(contract.shul_id);
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(contract.shul_id);
  logAudit(shul.org_id, null, 'esign', 'contract', contract.id, null, { signer_name, signedAt }, req.ip);
  res.json({ ok: true, message: 'Contract signed. An administrator will review and set up your account.' });
});

// ============================= ADMIN ==============================
router.use(auth, requirePermission('shuls'));

// Full, unpaginated shul list for the applicant-profile "Shul" dropdown
// (frontend/js/app.js's attachShulSelect) — every non-locked shul regardless
// of status, since an admin correcting an applicant's shul assignment needs
// to be able to pick any real shul, not just approved/active ones.
router.get('/all-list', (req, res) => {
  const { season_id } = req.query;
  const clause = season_id ? ' AND season_id = ?' : '';
  const params = season_id ? [req.user.org_id, season_id] : [req.user.org_id];
  const rows = db.prepare(`SELECT id, name_en, name_he, city, state FROM shuls WHERE org_id = ? AND is_locked = 0${clause} ORDER BY name_en`).all(...params);
  res.json({ shuls: rows });
});

router.get('/', (req, res) => {
  const { search, status, season_id, sort = 'created_at', dir = 'DESC', page = 1, pageSize = 50 } = req.query;
  // Locked system shuls (e.g. "Ezras Habayis") are excluded from the normal
  // shul-management list — they're not a real shul to review/approve/edit.
  let where = 'WHERE org_id = ? AND is_locked = 0';
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

// Full-detail CSV export — every field, no pagination, respects the same
// filters as the list view. Must be registered before /:id.
router.get('/export', requirePermission('shuls', 'can_export'), (req, res) => {
  const { search, status, season_id } = req.query;
  let where = 'WHERE org_id = ? AND is_locked = 0';
  const params = [req.user.org_id];
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (season_id) { where += ' AND season_id = ?'; params.push(season_id); }
  if (search) {
    where += ` AND (name_en LIKE ? OR name_he LIKE ? OR city LIKE ? OR ruv_last_name LIKE ? OR gabai_last_name LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  const rows = db.prepare(`SELECT * FROM shuls ${where} ORDER BY created_at DESC`).all(...params);
  sendCsv(res, `shuls-${Date.now()}.csv`, redact(rows, req.permission.hidden_fields));
});

router.get('/:id', (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul') { if (shul.id !== req.user.shul_id) return res.status(403).json({ error: 'Not your shul' }); }
  else { checkScope(req, res, shul.id); if (res.headersSent) return; }
  const notes = db.prepare('SELECT n.*, u.first_name, u.last_name FROM shul_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.shul_id = ? ORDER BY n.created_at DESC').all(shul.id);
  const contract = db.prepare('SELECT * FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1').get(shul.id);
  const applicants = db.prepare('SELECT id, first_name, last_name, approval_status FROM applicants WHERE shul_id = ?').all(shul.id);
  const flags = db.prepare(`SELECT * FROM duplicate_flags WHERE entity_type='shul' AND (entity_id = ? OR matched_entity_id = ?) AND status='open'`).all(shul.id, shul.id);
  res.json({ shul: redact(shul, req.permission.hidden_fields), notes, contract, applicants, flags });
});

// Admin-only quick-contact: send a one-off SMS/email straight from a shul's
// detail view, and see the full history of both — matched by either
// related_entity_type/id tagging or the shul's own phone/email, so messages
// sent through the general SMS/Email Center compose flow still show up here.
router.get('/:id/messages', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const phones = [shul.gabai_cell, shul.ruv_phone].filter(Boolean);
  const phonePlaceholders = phones.length ? phones.map(() => '?').join(',') : "''";
  const sms = db.prepare(`SELECT * FROM sms_messages WHERE org_id = ? AND ((related_entity_type='shul' AND related_entity_id=?) OR phone IN (${phonePlaceholders})) ORDER BY created_at DESC`)
    .all(req.user.org_id, shul.id, ...phones);
  const emails = shul.gabai_email
    ? db.prepare(`SELECT * FROM emails_sent WHERE org_id = ? AND ((related_entity_type='shul' AND related_entity_id=?) OR to_email=?) ORDER BY created_at DESC`).all(req.user.org_id, shul.id, shul.gabai_email)
    : db.prepare(`SELECT * FROM emails_sent WHERE org_id = ? AND related_entity_type='shul' AND related_entity_id=? ORDER BY created_at DESC`).all(req.user.org_id, shul.id);
  res.json({ sms, emails });
});

router.post('/:id/send-sms', requireAdmin, async (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const { to, body } = req.body || {};
  const phone = to || shul.gabai_cell || shul.ruv_phone;
  if (!phone) return res.status(400).json({ error: 'No phone number on file for this shul' });
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  const { emailError } = await sendSmsChecked(req.user.org_id, phone, body, { relatedEntityType: 'shul', relatedEntityId: shul.id, sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

router.post('/:id/send-email', requireAdmin, async (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const { to, subject, body } = req.body || {};
  const email = to || shul.gabai_email;
  if (!email) return res.status(400).json({ error: 'No email on file for this shul' });
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body are required' });
  const { emailError } = await sendMailChecked(req.user.org_id, email, subject, body, { relatedEntityType: 'shul', relatedEntityId: shul.id, sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

// Each season's application is its own independent shul record (spec: "treat
// every season as an entire new thing"), so there's no direct foreign key
// tying one year's record to the next. This finds likely matches for "the
// same shul" in other seasons by the identifying fields most likely to stay
// stable year over year (Gabai email, falling back to the shul's name).
router.get('/:id/other-seasons', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const matches = shul.gabai_email
    ? db.prepare(`SELECT sh.id, sh.name_en, sh.status, sh.season_id, se.name AS season_name FROM shuls sh LEFT JOIN seasons se ON se.id = sh.season_id
        WHERE sh.org_id = ? AND sh.id != ? AND sh.gabai_email = ? ORDER BY se.created_at DESC`).all(req.user.org_id, shul.id, shul.gabai_email)
    : db.prepare(`SELECT sh.id, sh.name_en, sh.status, sh.season_id, se.name AS season_name FROM shuls sh LEFT JOIN seasons se ON se.id = sh.season_id
        WHERE sh.org_id = ? AND sh.id != ? AND sh.name_en = ? ORDER BY se.created_at DESC`).all(req.user.org_id, shul.id, shul.name_en);
  res.json({ matches });
});

router.post('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.ruv_phone !== undefined) b.ruv_phone = normalizePhone(b.ruv_phone);
  if (b.gabai_cell !== undefined) b.gabai_cell = normalizePhone(b.gabai_cell);
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
  if (b.ruv_phone !== undefined) b.ruv_phone = normalizePhone(b.ruv_phone);
  if (b.gabai_cell !== undefined) b.gabai_cell = normalizePhone(b.gabai_cell);
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
  const loginUrl = `${process.env.APP_URL || ''}/accept-invite?token=${user.invite_token}`;
  const tmpl = renderSystemTemplate(req.user.org_id, 'accountApproved', { shulName: shul.name_en, loginUrl, slots });
  const { emailError } = await sendMailChecked(req.user.org_id, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
  if (emailError) console.error('[mail] shul approval email failed:', emailError);
  logAudit(req.user.org_id, req.user.id, 'approve', 'shul', shul.id, shul, { slots_allocated: slots }, req.ip);
  res.json({ ok: true, shul: db.prepare('SELECT * FROM shuls WHERE id = ?').get(shul.id), emailError });
});

// Re-send the "you're approved, set up your account" email — for when the
// first send silently failed (e.g. no email provider configured at the
// time) and there's no "unapprove" action to redo the approve step with.
// Refreshes the invite token/expiry in case the original one already expired.
router.post('/:id/resend-welcome', requireAdmin, async (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  if (shul.status !== 'approved' || !shul.portal_user_id) return res.status(400).json({ error: 'This shul has not been approved yet' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(shul.portal_user_id);
  if (!user) return res.status(404).json({ error: 'Portal account not found' });
  if (user.is_active) return res.status(400).json({ error: 'This shul has already set up their account and signed in. Nothing to resend.' });
  const token = uuid();
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?').run(token, expires, user.id);
  const loginUrl = `${process.env.APP_URL || ''}/accept-invite?token=${token}`;
  const tmpl = renderSystemTemplate(req.user.org_id, 'accountApproved', { shulName: shul.name_en, loginUrl, slots: shul.slots_allocated });
  const { emailError } = await sendMailChecked(req.user.org_id, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
  if (emailError) console.error('[mail] shul welcome resend failed:', emailError);
  res.json({ ok: true, emailError });
});

router.post('/:id/reject', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE shuls SET status='rejected', updated_at=datetime('now') WHERE id=?`).run(shul.id);
  logAudit(req.user.org_id, req.user.id, 'reject', 'shul', shul.id, shul, null, req.ip);
  res.json({ ok: true });
});

// Manually move a shul back to 'submitted' (the pending-review state before
// approve/reject) — for un-rejecting or un-approving one to reconsider it.
router.post('/:id/set-pending', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE shuls SET status='submitted', updated_at=datetime('now') WHERE id=?`).run(shul.id);
  logAudit(req.user.org_id, req.user.id, 'set-pending', 'shul', shul.id, { status: shul.status }, { status: 'submitted' }, req.ip);
  res.json({ ok: true, shul: db.prepare('SELECT * FROM shuls WHERE id = ?').get(shul.id) });
});

// Permanent deletion — full removal, not the reject/pause soft-states
// elsewhere in this file. Applicants belonging to this shul are NOT
// deleted — that's a separate, deliberate action (DELETE
// /applicants/:id/permanent) — they're just unlinked (shul_id set to null)
// so an admin can reassign them rather than silently losing their records.
// A linked portal login is deactivated (not deleted) since that's the
// user-management flow's job, not this one's. FK enforcement is ON, so
// every hard reference is cleaned up first, wrapped in a transaction.
router.delete('/:id/permanent', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const del = db.transaction(() => {
    db.prepare('UPDATE applicants SET shul_id = NULL WHERE shul_id = ?').run(shul.id);
    db.prepare('UPDATE shuls SET duplicate_of_shul_id = NULL WHERE duplicate_of_shul_id = ?').run(shul.id);
    db.prepare('DELETE FROM contracts WHERE shul_id = ?').run(shul.id);
    db.prepare('DELETE FROM shul_notes WHERE shul_id = ?').run(shul.id);
    if (shul.portal_user_id) db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(shul.portal_user_id);
    deletePolymorphicRefs('shul', shul.id);
    db.prepare('DELETE FROM shuls WHERE id = ?').run(shul.id);
  });
  del();
  logAudit(req.user.org_id, req.user.id, 'delete', 'shul', shul.id, shul, null, req.ip);
  res.json({ ok: true });
});

// Generate + email the contract (spec #3: "always email them when there's a doc to sign").
router.post('/:id/send-contract', requireAdmin, async (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  // The shul detail view always shows the *latest* contract row for this
  // shul (ORDER BY created_at DESC LIMIT 1) — creating a new one here
  // unconditionally would shadow an already-executed, legally-signed
  // agreement behind a fresh unsigned one. This is exactly the scenario
  // triggered by "I uploaded a new template PDF, let me resend the
  // contract" for a shul that's already signed: nothing was actually
  // deleted (the old row and its signed_pdf_path both still exist), but it
  // would become unreachable through the normal admin UI, which reads as
  // "the signed one got lost." Block it; retracting the signature first
  // (a separate, explicit, audited action) is the real way to redo one.
  const existingContract = db.prepare('SELECT * FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1').get(shul.id);
  if (existingContract?.status === 'signed') {
    return res.status(409).json({ error: 'This shul already has a signed contract on file. Retract the existing signature first if you need to send a new one.' });
  }
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
  const signUrl = `${process.env.APP_URL || ''}/sign-contract?token=${token}`;
  const to = req.body.email || shul.gabai_email;
  const tmpl = renderSystemTemplate(req.user.org_id, 'contractReady', { shulName: shul.name_en, signUrl });
  const { emailError } = await sendMailChecked(req.user.org_id, to, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
  if (emailError) console.error('[mail] contract email failed:', emailError);
  logAudit(req.user.org_id, req.user.id, 'send_contract', 'shul', shul.id, null, { to }, req.ip);
  res.json({ ok: true, contract: db.prepare('SELECT * FROM contracts WHERE id = ?').get(id), emailError });
});

// Undo a signature — for a signed-in-error or outdated signature, not a
// rejection. Resets the shul's latest contract back to 'sent' with a fresh
// signing link so it can be signed again; doesn't email anyone
// automatically, and deliberately leaves the shul's own status alone (an
// already-approved shul stays approved) since that's a separate decision.
router.post('/:id/contract/retract', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const contract = db.prepare('SELECT * FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1').get(shul.id);
  if (!contract || contract.status !== 'signed') return res.status(400).json({ error: 'Only a signed contract can have its signature retracted' });
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`UPDATE contracts SET status='sent', signature_data=NULL, signer_name=NULL, signer_title=NULL, signed_at=NULL, ip_address=NULL, signed_pdf_path=NULL, sign_token=?, sign_token_expires=? WHERE id=?`)
    .run(token, expires, contract.id);
  logAudit(req.user.org_id, req.user.id, 'retract_signature', 'shul', shul.id, contract, null, req.ip);
  res.json({ ok: true, contract: db.prepare('SELECT * FROM contracts WHERE id = ?').get(contract.id) });
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
// Columns mirror whatever the live Shul Registration form currently asks
// for (same schema apply.html renders — see form-render.js), falling back
// to the static list only if no default form is configured yet.
router.get('/import/template', requireAdmin, (req, res) => {
  const schema = JSON.parse(getDefaultForm(req.user.org_id, 'shul_application')?.schema_json || '[]');
  const known = schema.filter(f => SHUL_FIELDS.includes(f.key)).map(f => f.key);
  const columns = known.length ? [...known, 'slots_allocated'] : SHUL_IMPORT_COLUMNS;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="shul_import_template.csv"');
  res.send(buildCsvTemplate(columns));
});

router.post('/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const jobId = uuid();
  const rows = parseSpreadsheet(req.file.buffer, req.file.originalname);
  // Defaults to the newest active season same as before; season_id lets an
  // admin target a specific (e.g. older/already-superseded) season instead —
  // for a one-time backfill import that shouldn't land in whatever season
  // happens to be current right now.
  const season = req.body.season_id
    ? db.prepare('SELECT * FROM seasons WHERE id = ? AND org_id = ?').get(req.body.season_id, req.user.org_id)
    : db.prepare('SELECT * FROM seasons WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(req.user.org_id);
  if (req.body.season_id && !season) return res.status(400).json({ error: 'Season not found' });
  const sendContracts = req.body.send_contracts === 'true' || req.body.send_contracts === true;

  // All-or-nothing: every row must have every field the live Shul
  // Registration form currently requires, or nothing in the sheet is
  // imported — no partial imports. An admin uploading a sheet gets the
  // per-field "Admin can override" leniency the public form never does.
  const schema = JSON.parse(getDefaultForm(req.user.org_id, 'shul_application')?.schema_json || '[]');
  const requiredErrors = validateRowsBySchema(schema, rows, { isAdmin: true });
  if (requiredErrors.length) {
    return res.status(400).json({ error: 'Some rows are missing required fields. Nothing was imported — fix the sheet and re-upload.', errors: requiredErrors });
  }

  const shulDefaultForm = getDefaultForm(req.user.org_id, 'shul_application');
  let success = 0, dupes = 0; const errors = [];
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
          r.ruv_first_name || '', r.ruv_last_name || '', normalizePhone(r.ruv_phone || ''), r.ruv_address || '', r.ruv_city || '', r.ruv_state || '', r.ruv_zip || '',
          r.gabai_first_name || '', r.gabai_last_name || '', normalizePhone(r.gabai_cell || ''), r.gabai_email, r.gabai_address || '', r.gabai_city || '', r.gabai_state || '', r.gabai_zip || '',
          Number(r.slots_allocated) || 0);
      const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
      const flag = detectAndFlag(req.user.org_id, 'shul', shul);
      recordFormResponse(req.user.org_id, shulDefaultForm, r, { type: 'shul', id });
      if (flag) dupes++; else success++;
      if (sendContracts && !flag) {
        const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
        const pdfPath = await generateContractPdf({ shul, season, orgName: org.name });
        const token = uuid();
        const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
        db.prepare(`INSERT INTO contracts (id, shul_id, season_id, pdf_path, status, sign_token, sign_token_expires, sent_at) VALUES (?,?,?,?,'sent',?,?,datetime('now'))`)
          .run(uuid(), shul.id, shul.season_id, pdfPath, token, expires);
        db.prepare(`UPDATE shuls SET status='contract_sent' WHERE id=?`).run(shul.id);
        const signUrl = `${process.env.APP_URL || ''}/sign-contract?token=${token}`;
        const tmpl = renderSystemTemplate(req.user.org_id, 'contractReady', { shulName: shul.name_en, signUrl });
        const { emailError } = await sendMailChecked(req.user.org_id, shul.gabai_email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
        if (emailError) { console.error('[mail] mass-upload contract email failed for', shul.gabai_email, emailError); errors.push({ row: i + 2, error: `Shul created but contract email failed: ${emailError}` }); }
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

export default router;
