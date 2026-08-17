import { Router } from 'express';
import multer from 'multer';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import { detectAndFlag, resolveFlag } from '../services/duplicates.js';
import { sendMailChecked, renderSystemTemplate } from '../services/mail.js';
import { sendSmsChecked } from '../services/sms.js';
import * as giftcard from '../services/giftcard.js';
import { parseSpreadsheet, buildCsvTemplate, APPLICANT_IMPORT_COLUMNS } from '../services/importer.js';
import { sendCsv } from '../services/csv.js';
import { normalizePhone } from '../utils/phone.js';
import { generateApplicantExternalId } from '../utils/externalId.js';
import { getOrCreateEzrasHabayisShul } from '../utils/ezrasHabayis.js';
import { formWindowError, getFormSeasonId } from '../utils/formSchedule.js';
import { getDefaultForm, getDefaultFormSchema, validateBySchema, validateRowsBySchema, splitKnown, recordFormResponse, APPLICANT_FIELDS } from '../utils/formValidation.js';
import { logAudit } from '../services/audit.js';
import { deletePolymorphicRefs } from '../utils/entityDelete.js';
import { lockApplicantCards } from '../services/cardSync.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const EDITABLE_FIELDS = ['first_name','last_name','marital_status','home_phone','husband_cell','wife_cell','email',
  'address','city','state','zip','preferred_contact_method','preferred_number','num_children','home_for_yomtov','comments','card_amount'];

// ============================= PUBLIC ==============================
// Ezras Habayis applicants self-apply directly (no shul in between), so
// this mirrors the shul/store public /apply forms: no auth, and the shul_id
// is never taken from the client — every submission auto-attaches to this
// season's locked system shul (see utils/ezrasHabayis.js).
router.post('/apply-ezras-habayis', (req, res) => {
  const orgId = req.body.org_id || DEFAULT_ORG_ID;
  const defaultForm = getDefaultForm(orgId, 'applicant_application');
  const windowError = formWindowError(defaultForm);
  if (windowError) return res.status(423).json({ error: windowError });
  const b = req.body || {};
  if (b.home_phone !== undefined) b.home_phone = normalizePhone(b.home_phone);
  if (b.husband_cell !== undefined) b.husband_cell = normalizePhone(b.husband_cell);
  if (b.wife_cell !== undefined) b.wife_cell = normalizePhone(b.wife_cell);
  // The page itself is now a plain render of the live Applicant Application
  // form's schema (see form-render.js) — every field here, required-ness
  // included, comes from that schema, same as shuls.js/stores.js POST /apply.
  const schema = defaultForm ? JSON.parse(defaultForm.schema_json || '[]') : [];
  const errors = validateBySchema(schema, b, { isAdmin: false });
  if (errors.length) return res.status(400).json({ error: errors[0] });
  const { known: applicant, extra } = splitKnown(schema, b, APPLICANT_FIELDS);
  if (!applicant.first_name || !applicant.last_name) return res.status(400).json({ error: 'First and last name are required' });

  const shul = getOrCreateEzrasHabayisShul(orgId, defaultForm?.season_id || getFormSeasonId(orgId, 'applicant_application'));
  const capError = seasonCapacityError(shul.season_id);
  if (capError) return res.status(400).json({ error: capError });

  const id = uuid();
  const initialStatus = isZipAllowed(orgId, applicant.zip) ? 'pending' : 'rejected';
  // Anything the admin added to the schema beyond the known DB columns
  // (splitKnown above) lands in comments as free text, same as a generic
  // custom form. b.extra_notes is a legacy fallback for the old
  // fixed-fields-plus-bolt-ons page shape.
  const comments = [applicant.comments, extra, b.extra_notes].filter(Boolean).join(' | ');
  db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, external_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
      address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, comments, source, approval_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'public_form', ?)`)
    .run(id, orgId, shul.id, shul.season_id, generateApplicantExternalId(db), applicant.first_name, applicant.last_name, applicant.marital_status || '', applicant.home_phone || '', applicant.husband_cell || '', applicant.wife_cell || '', applicant.email || '',
      applicant.address || '', applicant.city || '', applicant.state || '', applicant.zip || '', applicant.preferred_contact_method || '', applicant.preferred_number || '', +applicant.num_children || 0, applicant.home_for_yomtov ? 1 : 0, comments, initialStatus);
  const created = db.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
  detectAndFlag(orgId, 'applicant', created);
  recordFormResponse(orgId, defaultForm, b, { type: 'applicant', id });
  res.status(201).json({ ok: true, message: 'Application received. You will be contacted if any additional information is needed.' });
});

router.use(auth, requirePermission('applicants'));

// Returns an error string if the given season has a max-accepted-applicants
// cap set and has already hit it — used to lock out new submissions once a
// season is full — or null if there's no cap or room remains.
function seasonCapacityError(seasonId) {
  if (!seasonId) return null;
  const season = db.prepare('SELECT max_accepted_applicants FROM seasons WHERE id = ?').get(seasonId);
  if (!season || season.max_accepted_applicants == null) return null;
  const accepted = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE season_id = ? AND approval_status = 'approved'`).get(seasonId).c;
  if (accepted >= season.max_accepted_applicants) return 'This season has reached its maximum number of accepted applicants and is no longer accepting new applications.';
  return null;
}

// Shuls must never learn that one of their applicants was rejected or
// flagged as a possible duplicate — from their side it should just look
// like a normal pending/approved application. Applies to both the zip-code
// auto-rejection below and any other rejection reason.
function maskForShul(records, role, orgId) {
  if (role !== 'shul') return records;
  // Card amount visibility is an admin-configurable toggle (Settings >
  // Organization > Shul Portal) — defaults to visible, same as before the
  // toggle existed, unless explicitly turned off.
  const cardVisible = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'shul_card_amount_visible'`).get(orgId)?.value !== '0';
  const mask = (r) => {
    const rec = { ...r, approval_status: r.approval_status === 'rejected' ? 'pending' : r.approval_status, duplicate_status: null, duplicate_of_applicant_id: null, is_paused: 0 };
    if (!cardVisible) delete rec.card_amount;
    return rec;
  };
  return Array.isArray(records) ? records.map(mask) : mask(records);
}

// If the org has restricted accepted zips (Settings > Organization >
// Allowed Zip Codes), an applicant outside that list is auto-rejected
// silently at submission time — the submission still appears to succeed
// normally so the submitting shul is never told why (or that) it happened.
export function isZipAllowed(orgId, zip) {
  const setting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'allowed_zip_codes'`).get(orgId);
  if (!setting || !setting.value.trim()) return true;
  const allowed = setting.value.split(',').map(z => z.trim()).filter(Boolean);
  if (!allowed.length) return true;
  return allowed.includes(String(zip || '').trim());
}

// Shul-portal users only ever see/act on their own shul's applicants; regardless
// of any assignment rows, force shul_id = req.user.shul_id for that role.
function scopeWhere(req) {
  let where = 'WHERE a.org_id = ?';
  const params = [req.user.org_id];
  if (req.user.role === 'shul') { where += ' AND a.shul_id = ?'; params.push(req.user.shul_id); }
  else if (req.permission.scope === 'assigned') {
    where += ` AND a.shul_id IN (SELECT entity_id FROM user_assignments WHERE user_id = ? AND entity_type = 'shul')`;
    params.push(req.user.id);
  }
  return { where, params };
}

router.get('/', (req, res) => {
  const { search, status, shul_id, season_id, home_for_yomtov, marital_status, sort = 'created_at', dir = 'DESC', page = 1, pageSize = 50 } = req.query;
  let { where, params } = scopeWhere(req);
  if (status) { where += ' AND a.approval_status = ?'; params.push(status); }
  if (shul_id) { where += ' AND a.shul_id = ?'; params.push(shul_id); }
  if (season_id) { where += ' AND a.season_id = ?'; params.push(season_id); }
  if (marital_status) { where += ' AND a.marital_status = ?'; params.push(marital_status); }
  if (home_for_yomtov !== undefined && home_for_yomtov !== '') { where += ' AND a.home_for_yomtov = ?'; params.push(home_for_yomtov === 'true' || home_for_yomtov === '1' ? 1 : 0); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR a.home_phone LIKE ? OR a.husband_cell LIKE ? OR a.wife_cell LIKE ? OR a.external_id LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }
  const allowedSort = ['created_at','last_name','approval_status','num_children','card_amount','external_id'];
  const sortCol = allowedSort.includes(sort) ? `a.${sort}` : 'a.created_at';
  const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) c FROM applicants a ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  res.json({ applicants: maskForShul(redact(rows, req.permission.hidden_fields), req.user.role, req.user.org_id), total, page: +page, pageSize: +pageSize });
});

// Full-detail CSV export — every field, no pagination, respects the same
// filters as the list view. Must be registered before /:id.
router.get('/export', requirePermission('applicants', 'can_export'), (req, res) => {
  const { search, status, shul_id, season_id, home_for_yomtov, marital_status } = req.query;
  let { where, params } = scopeWhere(req);
  if (status) { where += ' AND a.approval_status = ?'; params.push(status); }
  if (shul_id) { where += ' AND a.shul_id = ?'; params.push(shul_id); }
  if (season_id) { where += ' AND a.season_id = ?'; params.push(season_id); }
  if (marital_status) { where += ' AND a.marital_status = ?'; params.push(marital_status); }
  if (home_for_yomtov !== undefined && home_for_yomtov !== '') { where += ' AND a.home_for_yomtov = ?'; params.push(home_for_yomtov === 'true' || home_for_yomtov === '1' ? 1 : 0); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR a.home_phone LIKE ? OR a.husband_cell LIKE ? OR a.wife_cell LIKE ? OR a.external_id LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }
  const rows = db.prepare(`SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id ${where} ORDER BY a.created_at DESC`).all(...params);
  sendCsv(res, `applicants-${Date.now()}.csv`, redact(rows, req.permission.hidden_fields));
});

router.get('/:id', (req, res) => {
  const applicant = db.prepare('SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id=a.shul_id WHERE a.id = ? AND a.org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul' && applicant.shul_id !== req.user.shul_id) return res.status(403).json({ error: 'Not your applicant' });
  // Internal admin notes and duplicate flags may reference rejection/duplicate
  // reasons directly, so a shul-portal viewer gets neither, on top of the
  // approval_status/duplicate_status masking below.
  const notes = req.user.role === 'shul' ? [] : db.prepare('SELECT n.*, u.first_name, u.last_name FROM applicant_notes n LEFT JOIN users u ON u.id=n.user_id WHERE applicant_id = ? ORDER BY n.created_at DESC').all(applicant.id);
  const cards = db.prepare('SELECT * FROM cards WHERE applicant_id = ? ORDER BY created_at DESC').all(applicant.id);
  const flags = req.user.role === 'shul' ? [] : db.prepare(`SELECT * FROM duplicate_flags WHERE entity_type='applicant' AND (entity_id=? OR matched_entity_id=?) AND status='open'`).all(applicant.id, applicant.id);
  res.json({ applicant: maskForShul(redact(applicant, req.permission.hidden_fields), req.user.role, req.user.org_id), notes, cards, flags });
});

// Admin-only quick-contact: send a one-off SMS/email straight from an
// applicant's detail view, and see the full history of both — not just
// what was sent *about* this applicant (related_entity_type/id) but
// anything ever sent to their phone numbers/email, in case a message went
// out through the general SMS/Email Center compose flow rather than from
// this modal.
router.get('/:id/messages', requireAdmin, (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const phones = [applicant.home_phone, applicant.husband_cell, applicant.wife_cell].filter(Boolean);
  const phonePlaceholders = phones.length ? phones.map(() => '?').join(',') : "''";
  const sms = db.prepare(`SELECT * FROM sms_messages WHERE org_id = ? AND ((related_entity_type='applicant' AND related_entity_id=?) OR phone IN (${phonePlaceholders})) ORDER BY created_at DESC`)
    .all(req.user.org_id, applicant.id, ...phones);
  const emails = applicant.email
    ? db.prepare(`SELECT * FROM emails_sent WHERE org_id = ? AND ((related_entity_type='applicant' AND related_entity_id=?) OR to_email=?) ORDER BY created_at DESC`).all(req.user.org_id, applicant.id, applicant.email)
    : db.prepare(`SELECT * FROM emails_sent WHERE org_id = ? AND related_entity_type='applicant' AND related_entity_id=? ORDER BY created_at DESC`).all(req.user.org_id, applicant.id);
  res.json({ sms, emails });
});

router.post('/:id/send-sms', requireAdmin, async (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const { to, body } = req.body || {};
  const phone = to || applicant.husband_cell || applicant.wife_cell || applicant.home_phone;
  if (!phone) return res.status(400).json({ error: 'No phone number on file for this applicant' });
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  const { emailError } = await sendSmsChecked(req.user.org_id, phone, body, { relatedEntityType: 'applicant', relatedEntityId: applicant.id, sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

router.post('/:id/send-email', requireAdmin, async (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const { to, subject, body } = req.body || {};
  const email = to || applicant.email;
  if (!email) return res.status(400).json({ error: 'No email on file for this applicant' });
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body are required' });
  const { emailError } = await sendMailChecked(req.user.org_id, email, subject, body, { relatedEntityType: 'applicant', relatedEntityId: applicant.id, sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

// Same idea as shuls' /other-seasons: each season's applicant is its own
// independent record, so match likely repeat applicants across seasons by
// email (falling back to first+last name) rather than a direct foreign key.
router.get('/:id/other-seasons', requireAdmin, (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const matches = applicant.email
    ? db.prepare(`SELECT a.id, a.first_name, a.last_name, a.approval_status, a.season_id, se.name AS season_name FROM applicants a LEFT JOIN seasons se ON se.id = a.season_id
        WHERE a.org_id = ? AND a.id != ? AND a.email = ? ORDER BY se.created_at DESC`).all(req.user.org_id, applicant.id, applicant.email)
    : db.prepare(`SELECT a.id, a.first_name, a.last_name, a.approval_status, a.season_id, se.name AS season_name FROM applicants a LEFT JOIN seasons se ON se.id = a.season_id
        WHERE a.org_id = ? AND a.id != ? AND a.first_name = ? AND a.last_name = ? ORDER BY se.created_at DESC`).all(req.user.org_id, applicant.id, applicant.first_name, applicant.last_name);
  res.json({ matches });
});

router.post('/', requirePermission('applicants', 'can_edit'), (req, res) => {
  const b = req.body || {};
  if (b.home_phone !== undefined) b.home_phone = normalizePhone(b.home_phone);
  if (b.husband_cell !== undefined) b.husband_cell = normalizePhone(b.husband_cell);
  if (b.wife_cell !== undefined) b.wife_cell = normalizePhone(b.wife_cell);
  if (!b.first_name || !b.last_name) return res.status(400).json({ error: 'First and last name are required' });
  // Shul-portal users can only ever create applicants under their own shul.
  const shulId = req.user.role === 'shul' ? req.user.shul_id : b.shul_id;
  if (!shulId) return res.status(400).json({ error: 'shul_id is required' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(shulId, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Shul not found' });
  if (shul.is_paused) return res.status(423).json({ error: 'This shul account is paused and cannot submit applicants' });
  const used = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE shul_id = ? AND approval_status != 'rejected'`).get(shulId).c;
  if (shul.slots_allocated && used >= shul.slots_allocated) return res.status(400).json({ error: `This shul has used all ${shul.slots_allocated} allocated slot(s) for this season` });
  const capError = seasonCapacityError(shul.season_id);
  if (capError) return res.status(400).json({ error: capError });
  // Same field set/required-ness the live Applicant Application form asks
  // for (Form Builder), so a shul portal add, an admin add, and the public
  // form are always asking the same questions. Admins get two levels of
  // leniency: bypass_required skips every required field at once for this
  // one submission (e.g. an incomplete record that needs to exist now and
  // get filled in later); short of that, any individual field marked
  // "Admin can override" in the builder is skipped automatically. A
  // shul-portal submitter gets neither — only an admin.
  const isAdminSubmitter = req.user.role !== 'shul';
  const bypassRequired = isAdminSubmitter && !!b.bypass_required;
  if (!bypassRequired) {
    const errors = validateBySchema(getDefaultFormSchema(req.user.org_id, 'applicant_application'), b, { isAdmin: isAdminSubmitter });
    if (errors.length) return res.status(400).json({ error: errors[0] });
  }

  const id = uuid();
  // Zip-restricted applicants are auto-rejected silently — the submission
  // still appears to succeed normally so the submitting shul is never told.
  const initialStatus = isZipAllowed(req.user.org_id, b.zip) ? 'pending' : 'rejected';
  const cardAmount = req.user.role !== 'shul' && b.card_amount ? +b.card_amount : null;
  db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, external_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
      address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, card_amount, comments, source, approval_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?, ?, ?)`)
    .run(id, req.user.org_id, shulId, shul.season_id, generateApplicantExternalId(db), b.first_name, b.last_name, b.marital_status || '', b.home_phone || '', b.husband_cell || '', b.wife_cell || '', b.email || '',
      b.address || '', b.city || '', b.state || '', b.zip || '', b.preferred_contact_method || '', b.preferred_number || '', +b.num_children || 0, b.home_for_yomtov ? 1 : 0, cardAmount, b.comments || '',
      req.user.role === 'shul' ? 'shul_upload' : 'admin', initialStatus);
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
  const flag = detectAndFlag(req.user.org_id, 'applicant', applicant);
  logAudit(req.user.org_id, req.user.id, 'create', 'applicant', id, null, applicant, req.ip);
  recordFormResponse(req.user.org_id, getDefaultForm(req.user.org_id, 'applicant_application'), b, { type: 'applicant', id });
  res.status(201).json({ applicant: maskForShul(applicant, req.user.role), duplicate: req.user.role === 'shul' ? false : !!flag });
});

router.put('/:id', requirePermission('applicants', 'can_edit'), (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul' && applicant.shul_id !== req.user.shul_id) return res.status(403).json({ error: 'Not your applicant' });
  const b = req.body || {};
  if (b.home_phone !== undefined) b.home_phone = normalizePhone(b.home_phone);
  if (b.husband_cell !== undefined) b.husband_cell = normalizePhone(b.husband_cell);
  if (b.wife_cell !== undefined) b.wife_cell = normalizePhone(b.wife_cell);
  if (b.shul_id !== undefined) {
    const targetShul = db.prepare('SELECT id, name_en, season_id FROM shuls WHERE id = ? AND org_id = ?').get(b.shul_id, req.user.org_id);
    if (!targetShul) return res.status(400).json({ error: 'Shul not found' });
    // An applicant's season is fixed at creation (inherited from whichever
    // shul they were added under — see the INSERT statements above) and
    // never changes on its own, so reassigning them to a shul from a
    // different season would silently split their record across seasons —
    // e.g. an approved-this-season applicant reassigned under a next-season
    // shul while still showing as this season's approval/card. Block it
    // instead; if the applicant genuinely needs to move seasons, that's a
    // deliberate separate action, not a side effect of a shul reassignment.
    if (targetShul.season_id !== applicant.season_id) return res.status(400).json({ error: `"${targetShul.name_en}" is in a different season than this applicant — reassigning across seasons isn't allowed.` });
  }
  // card_amount and reassigning which shul an applicant belongs to are
  // admin-only (spec #5 for card_amount; shul_id because a shul reassigning
  // its own applicants to a different shul would be a data-integrity/scope
  // violation, not a legitimate self-service edit).
  const fields = req.user.role === 'shul' ? EDITABLE_FIELDS.filter(f => f !== 'card_amount') : [...EDITABLE_FIELDS, 'shul_id'];
  const sets = fields.filter(f => b[f] !== undefined);
  if (sets.length) {
    const vals = sets.map(f => f === 'home_for_yomtov' ? (b[f] ? 1 : 0) : b[f]);
    db.prepare(`UPDATE applicants SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, applicant.id);
    logAudit(req.user.org_id, req.user.id, 'update', 'applicant', applicant.id,
      Object.fromEntries(sets.map(f => [f, applicant[f]])), Object.fromEntries(sets.map((f, i) => [f, vals[i]])), req.ip);
  }
  res.json({ applicant: maskForShul(db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id), req.user.role, req.user.org_id) });
});

// Manually move an applicant back to 'pending' — for un-rejecting one after
// a decision was made too early/in error, or un-approving one to reconsider
// (approved_by/approved_at/card_amount are left as-is so there's a record of
// the prior decision; approving again overwrites them same as normal).
router.post('/:id/set-pending', requireAdmin, async (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE applicants SET approval_status='pending', updated_at=datetime('now') WHERE id=?`).run(applicant.id);
  logAudit(req.user.org_id, req.user.id, 'set-pending', 'applicant', applicant.id, { approval_status: applicant.approval_status }, { approval_status: 'pending' }, req.ip);
  const { errors: cardLockErrors } = await lockApplicantCards(req.user.org_id, applicant.id);
  res.json({ applicant: db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id), cardLockErrors });
});

// Permanent deletion — full removal, not the pause/reject soft-states
// elsewhere in this file. Every table's reference to this applicant is
// cleaned up first (FK enforcement is ON): cards + their transactions and
// notes are hard-deleted since they're meaningless without the applicant;
// any other applicant's duplicate_of_applicant_id pointing here is cleared
// so that applicant survives; the polymorphic entity_type/entity_id rows
// (documents, tasks, etc.) are cleaned up too. Wrapped in a transaction so a
// failure partway through doesn't leave orphaned rows.
router.delete('/:id/permanent', requireAdmin, (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const del = db.transaction(() => {
    db.prepare('DELETE FROM card_transactions WHERE card_id IN (SELECT id FROM cards WHERE applicant_id = ?)').run(applicant.id);
    db.prepare('DELETE FROM cards WHERE applicant_id = ?').run(applicant.id);
    db.prepare('DELETE FROM applicant_notes WHERE applicant_id = ?').run(applicant.id);
    db.prepare('UPDATE applicants SET duplicate_of_applicant_id = NULL WHERE duplicate_of_applicant_id = ?').run(applicant.id);
    deletePolymorphicRefs('applicant', applicant.id);
    db.prepare('DELETE FROM applicants WHERE id = ?').run(applicant.id);
  });
  del();
  logAudit(req.user.org_id, req.user.id, 'delete', 'applicant', applicant.id, applicant, null, req.ip);
  res.json({ ok: true });
});

router.post('/:id/approve', requireAdmin, async (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (applicant.is_paused) return res.status(423).json({ error: 'Applicant has an unresolved duplicate flag' });
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(applicant.season_id);
  if (applicant.approval_status !== 'approved' && season?.max_accepted_applicants != null) {
    const accepted = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE season_id = ? AND approval_status = 'approved'`).get(season.id).c;
    if (accepted >= season.max_accepted_applicants) return res.status(400).json({ error: `This season's cap of ${season.max_accepted_applicants} accepted applicant(s) has already been reached.` });
  }
  const amount = req.body?.card_amount ?? applicant.card_amount ?? season?.default_card_amount ?? 0;
  db.prepare(`UPDATE applicants SET approval_status='approved', approved_by=?, approved_at=datetime('now'), card_amount=? WHERE id=?`)
    .run(req.user.id, amount, applicant.id);
  logAudit(req.user.org_id, req.user.id, 'approve', 'applicant', applicant.id,
    { approval_status: applicant.approval_status, card_amount: applicant.card_amount }, { approval_status: 'approved', card_amount: amount }, req.ip);
  let emailError = null;
  if (applicant.email) {
    const tmpl = renderSystemTemplate(req.user.org_id, 'applicantApproved', { name: `${applicant.first_name} ${applicant.last_name}` });
    ({ emailError } = await sendMailChecked(req.user.org_id, applicant.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo }));
    if (emailError) console.error('[mail] applicant approval email failed:', emailError);
  }
  // Writes/links the disccardpromos account for this applicant — idempotent
  // by external_id (existing account just gets the current season added;
  // a new one is created under a group matching the shul's English name,
  // creating that group first if needed — see giftcard.js's
  // upsertAccountForApproval). Best-effort: a disccardpromos hiccup here
  // must never undo or block the approval that already committed above,
  // same "external side-effect can fail without failing the action" pattern
  // as the approval email right above.
  let providerAccountError = null;
  if (applicant.shul_id) {
    try {
      const shul = db.prepare('SELECT name_en FROM shuls WHERE id = ?').get(applicant.shul_id);
      const result = await giftcard.upsertAccountForApproval(req.user.org_id, {
        externalId: applicant.external_id, firstName: applicant.first_name, lastName: applicant.last_name,
        groupName: shul?.name_en || 'Unknown', seasonName: season?.name || '',
      });
      if (result.accountId) db.prepare('UPDATE applicants SET provider_account_id = ? WHERE id = ?').run(result.accountId, applicant.id);
    } catch (e) {
      providerAccountError = e.message;
      console.error('[giftcard] failed to write disccardpromos account on approval:', e.message);
    }
  }
  // disccardpromos has no separate "assign/activate a card" step — crediting
  // a customer's balance against a configured Package (Settings >
  // Organization > Gift Card Loading) via add-funds IS how a card actually
  // gets issued with an amount. Same best-effort pattern as the account
  // write above: skipped if that write failed (nothing to credit yet), and
  // never blocks/undoes the approval itself.
  let providerFundsError = null;
  if (applicant.shul_id && !providerAccountError && amount > 0) {
    const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(req.user.org_id)?.value;
    if (!discountId) {
      providerFundsError = 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading) — card amount was not loaded.';
    } else {
      try {
        await giftcard.addFunds(req.user.org_id, { externalId: applicant.external_id, discountId, amount });
      } catch (e) {
        providerFundsError = e.message;
        console.error('[giftcard] failed to load funds on approval:', e.message);
      }
    }
  }
  res.json({ applicant: db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id), emailError, providerAccountError, providerFundsError });
});

router.post('/:id/reject', requireAdmin, async (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE applicants SET approval_status='rejected', approved_by=?, approved_at=datetime('now') WHERE id=?`).run(req.user.id, applicant.id);
  logAudit(req.user.org_id, req.user.id, 'reject', 'applicant', applicant.id, { approval_status: applicant.approval_status }, { approval_status: 'rejected' }, req.ip);
  const { errors: cardLockErrors } = await lockApplicantCards(req.user.org_id, applicant.id);
  res.json({ ok: true, cardLockErrors });
});

// Mass approval — spec #5 "allow mass approval".
router.post('/mass-approve', requireAdmin, async (req, res) => {
  const { ids, card_amount } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(req.user.org_id)?.value;
  let approved = 0, skipped = 0, capReached = false, providerErrors = 0;
  for (const id of ids) {
    const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!applicant || applicant.is_paused) { skipped++; continue; }
    const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(applicant.season_id);
    if (applicant.approval_status !== 'approved' && season?.max_accepted_applicants != null) {
      const accepted = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE season_id = ? AND approval_status = 'approved'`).get(season.id).c;
      if (accepted >= season.max_accepted_applicants) { skipped++; capReached = true; continue; }
    }
    const amount = card_amount ?? applicant.card_amount ?? season?.default_card_amount ?? 0;
    db.prepare(`UPDATE applicants SET approval_status='approved', approved_by=?, approved_at=datetime('now'), card_amount=? WHERE id=?`).run(req.user.id, amount, id);
    logAudit(req.user.org_id, req.user.id, 'approve', 'applicant', id,
      { approval_status: applicant.approval_status, card_amount: applicant.card_amount }, { approval_status: 'approved', card_amount: amount }, req.ip);
    approved++;
    // Same best-effort account-write + fund-load as the single /:id/approve
    // route — see the comments there. A disccardpromos hiccup on one
    // applicant never stops the rest of the batch.
    if (applicant.shul_id) {
      let accountOk = false;
      try {
        const shul = db.prepare('SELECT name_en FROM shuls WHERE id = ?').get(applicant.shul_id);
        const result = await giftcard.upsertAccountForApproval(req.user.org_id, {
          externalId: applicant.external_id, firstName: applicant.first_name, lastName: applicant.last_name,
          groupName: shul?.name_en || 'Unknown', seasonName: season?.name || '',
        });
        if (result.accountId) db.prepare('UPDATE applicants SET provider_account_id = ? WHERE id = ?').run(result.accountId, id);
        accountOk = true;
      } catch (e) {
        providerErrors++;
        console.error('[giftcard] failed to write disccardpromos account on mass-approve:', e.message);
      }
      if (accountOk && amount > 0 && discountId) {
        try { await giftcard.addFunds(req.user.org_id, { externalId: applicant.external_id, discountId, amount }); }
        catch (e) { providerErrors++; console.error('[giftcard] failed to load funds on mass-approve:', e.message); }
      } else if (accountOk && amount > 0 && !discountId) {
        providerErrors++;
      }
    }
  }
  res.json({ approved, skipped, capReached, providerErrors, providerErrorsHint: providerErrors && !discountId ? 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading).' : undefined });
});

router.post('/:id/notes', (req, res) => {
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: 'Note text required' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  const id = uuid();
  db.prepare('INSERT INTO applicant_notes (id, applicant_id, user_id, note) VALUES (?,?,?,?)').run(id, applicant.id, req.user.id, note);
  res.status(201).json({ note: db.prepare('SELECT * FROM applicant_notes WHERE id = ?').get(id) });
});

// CSV/XLSX bulk import (spec #1 "via XCLS and CSV files", #3 mass upload, #5 shul self-upload).
// If the requester is a shul-portal user, shul_name is ignored — always their own shul.
// Columns mirror whatever the live Applicant Application form currently
// asks for (same schema the public/Ezras Habayis page and admin/shul-portal
// add-applicant form all validate against), falling back to the static
// list only if no default form is configured yet.
router.get('/import/template', (req, res) => {
  const schema = getDefaultFormSchema(req.user.org_id, 'applicant_application');
  const known = schema.filter(f => APPLICANT_FIELDS.includes(f.key)).map(f => f.key);
  const columns = known.length ? [...known.filter(k => k !== 'shul_id'), 'shul_name', 'card_amount'] : APPLICANT_IMPORT_COLUMNS;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="applicant_import_template.csv"');
  res.send(buildCsvTemplate(columns));
});

router.post('/import', requirePermission('applicants', 'can_edit'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const rows = parseSpreadsheet(req.file.buffer, req.file.originalname);
  const jobId = uuid();
  const forcedShul = req.user.role === 'shul' ? db.prepare('SELECT * FROM shuls WHERE id = ?').get(req.user.shul_id) : null;

  // All-or-nothing: every row must have every field the live Applicant
  // Application form currently requires, or nothing in the sheet is
  // imported — no partial imports. An admin uploading a sheet gets the
  // per-field "Admin can override" leniency the public form/shul-portal
  // upload never does. shul_name isn't a form field (shul assignment isn't
  // part of the intake questions) — checked separately, and only for an
  // admin upload; a shul-portal upload's shul is always forced to their own.
  const isAdminSubmitter = req.user.role !== 'shul';
  const defaultForm = getDefaultForm(req.user.org_id, 'applicant_application');
  const schema = defaultForm ? JSON.parse(defaultForm.schema_json || '[]') : [];
  const schemaErrors = validateRowsBySchema(schema, rows, { isAdmin: isAdminSubmitter, skipKeys: ['shul_id'] });
  const shulNameErrors = forcedShul ? [] : rows.map((r, i) => (!r.shul_name ? { row: i + 2, error: 'Missing required field: shul_name' } : null)).filter(Boolean);
  const requiredErrors = [...schemaErrors, ...shulNameErrors].sort((a, b) => a.row - b.row);
  if (requiredErrors.length) {
    return res.status(400).json({ error: 'Some rows are missing required fields. Nothing was imported — fix the sheet and re-upload.', errors: requiredErrors });
  }

  let success = 0, dupes = 0; const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.first_name || !r.last_name) { errors.push({ row: i + 2, error: 'Missing first_name or last_name' }); continue; }
    let shul = forcedShul;
    if (!shul) {
      shul = r.shul_name ? db.prepare('SELECT * FROM shuls WHERE org_id = ? AND name_en = ?').get(req.user.org_id, r.shul_name) : null;
      if (!shul) { errors.push({ row: i + 2, error: `Shul not found: "${r.shul_name || ''}" (must match an existing shul name exactly)` }); continue; }
    }
    if (shul.is_paused) { errors.push({ row: i + 2, error: `Shul "${shul.name_en}" is paused` }); continue; }
    const capError = seasonCapacityError(shul.season_id);
    if (capError) { errors.push({ row: i + 2, error: capError }); continue; }
    try {
      const id = uuid();
      // Zip-restricted rows are auto-rejected silently — the upload still
      // reports as a normal success so the submitting shul is never told.
      const initialStatus = isZipAllowed(req.user.org_id, r.zip) ? 'pending' : 'rejected';
      db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, external_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
          address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, card_amount, comments, source, approval_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?, 'mass_upload', ?)`)
        .run(id, req.user.org_id, shul.id, shul.season_id, generateApplicantExternalId(db), r.first_name, r.last_name, r.marital_status || '', normalizePhone(r.home_phone || ''), normalizePhone(r.husband_cell || ''), normalizePhone(r.wife_cell || ''), r.email || '',
          r.address || '', r.city || '', r.state || '', r.zip || '', r.preferred_contact_method || '', r.preferred_number || '', +r.num_children || 0,
          /^(y|yes|true|1)$/i.test(String(r.home_for_yomtov || '')) ? 1 : 0, r.card_amount ? +r.card_amount : null, r.comments || '', initialStatus);
      const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
      const flag = detectAndFlag(req.user.org_id, 'applicant', applicant);
      recordFormResponse(req.user.org_id, defaultForm, r, { type: 'applicant', id });
      if (flag && req.user.role !== 'shul') dupes++; else success++;
    } catch (e) {
      errors.push({ row: i + 2, error: e.message });
    }
  }
  db.prepare(`INSERT INTO import_jobs (id, org_id, entity_type, file_name, status, total_rows, success_count, error_count, duplicate_count, error_log, created_by)
    VALUES (?,?,?,?,'completed',?,?,?,?,?,?)`)
    .run(jobId, req.user.org_id, 'applicants', req.file.originalname, rows.length, success, errors.length, dupes, JSON.stringify(errors), req.user.id);
  res.json({ jobId, total: rows.length, success, duplicates: dupes, errors });
});

router.get('/duplicates/open', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type='applicant' AND status='open' ORDER BY created_at DESC`).all(req.user.org_id);
  const withEntities = rows.map(r => ({
    ...r,
    entity: db.prepare('SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id=a.shul_id WHERE a.id = ?').get(r.entity_id),
    matched: db.prepare('SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id=a.shul_id WHERE a.id = ?').get(r.matched_entity_id),
  }));
  res.json({ flags: withEntities });
});

router.post('/duplicates/:flagId/resolve', requireAdmin, (req, res) => {
  const { action } = req.body || {};
  const flag = resolveFlag(req.params.flagId, req.user.id, action);
  if (!flag) return res.status(404).json({ error: 'Not found' });
  res.json({ flag });
});

export default router;
