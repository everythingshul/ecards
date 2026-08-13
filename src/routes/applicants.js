import { Router } from 'express';
import multer from 'multer';
import { db, uuid } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import { detectAndFlag, resolveFlag } from '../services/duplicates.js';
import { sendMail, templates } from '../services/mail.js';
import { parseSpreadsheet, buildCsvTemplate, APPLICANT_IMPORT_COLUMNS } from '../services/importer.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const EDITABLE_FIELDS = ['first_name','last_name','marital_status','home_phone','husband_cell','wife_cell','email',
  'address','city','state','zip','preferred_contact_method','preferred_number','num_children','home_for_yomtov','comments','card_amount'];

router.use(auth, requirePermission('applicants'));

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
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR a.home_phone LIKE ? OR a.husband_cell LIKE ? OR a.wife_cell LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like);
  }
  const allowedSort = ['created_at','last_name','approval_status','num_children','card_amount'];
  const sortCol = allowedSort.includes(sort) ? `a.${sort}` : 'a.created_at';
  const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) c FROM applicants a ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  res.json({ applicants: redact(rows, req.permission.hidden_fields), total, page: +page, pageSize: +pageSize });
});

router.get('/:id', (req, res) => {
  const applicant = db.prepare('SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id=a.shul_id WHERE a.id = ? AND a.org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul' && applicant.shul_id !== req.user.shul_id) return res.status(403).json({ error: 'Not your applicant' });
  const notes = db.prepare('SELECT n.*, u.first_name, u.last_name FROM applicant_notes n LEFT JOIN users u ON u.id=n.user_id WHERE applicant_id = ? ORDER BY n.created_at DESC').all(applicant.id);
  const cards = db.prepare('SELECT * FROM cards WHERE applicant_id = ? ORDER BY created_at DESC').all(applicant.id);
  const flags = db.prepare(`SELECT * FROM duplicate_flags WHERE entity_type='applicant' AND (entity_id=? OR matched_entity_id=?) AND status='open'`).all(applicant.id, applicant.id);
  res.json({ applicant: redact(applicant, req.permission.hidden_fields), notes, cards, flags });
});

router.post('/', requirePermission('applicants', 'can_edit'), (req, res) => {
  const b = req.body || {};
  if (!b.first_name || !b.last_name) return res.status(400).json({ error: 'First and last name are required' });
  // Shul-portal users can only ever create applicants under their own shul.
  const shulId = req.user.role === 'shul' ? req.user.shul_id : b.shul_id;
  if (!shulId) return res.status(400).json({ error: 'shul_id is required' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(shulId, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Shul not found' });
  if (shul.is_paused) return res.status(423).json({ error: 'This shul account is paused and cannot submit applicants' });
  const used = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE shul_id = ? AND approval_status != 'rejected'`).get(shulId).c;
  if (shul.slots_allocated && used >= shul.slots_allocated) return res.status(400).json({ error: `This shul has used all ${shul.slots_allocated} allocated slot(s) for this season` });

  const id = uuid();
  db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
      address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, comments, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?)`)
    .run(id, req.user.org_id, shulId, shul.season_id, b.first_name, b.last_name, b.marital_status || '', b.home_phone || '', b.husband_cell || '', b.wife_cell || '', b.email || '',
      b.address || '', b.city || '', b.state || '', b.zip || '', b.preferred_contact_method || '', b.preferred_number || '', +b.num_children || 0, b.home_for_yomtov ? 1 : 0, b.comments || '',
      req.user.role === 'shul' ? 'shul_upload' : 'admin');
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
  const flag = detectAndFlag(req.user.org_id, 'applicant', applicant);
  res.status(201).json({ applicant, duplicate: !!flag });
});

router.put('/:id', requirePermission('applicants', 'can_edit'), (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul' && applicant.shul_id !== req.user.shul_id) return res.status(403).json({ error: 'Not your applicant' });
  const b = req.body || {};
  // card_amount is admin-only (spec #5: "amount of money to give them on the card (admin sets)").
  const fields = req.user.role === 'shul' ? EDITABLE_FIELDS.filter(f => f !== 'card_amount') : EDITABLE_FIELDS;
  const sets = fields.filter(f => b[f] !== undefined);
  if (sets.length) {
    const vals = sets.map(f => f === 'home_for_yomtov' ? (b[f] ? 1 : 0) : b[f]);
    db.prepare(`UPDATE applicants SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, applicant.id);
  }
  res.json({ applicant: db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id) });
});

router.post('/:id/approve', requireAdmin, (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  if (applicant.is_paused) return res.status(423).json({ error: 'Applicant has an unresolved duplicate flag' });
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(applicant.season_id);
  const amount = req.body?.card_amount ?? applicant.card_amount ?? season?.default_card_amount ?? 0;
  db.prepare(`UPDATE applicants SET approval_status='approved', approved_by=?, approved_at=datetime('now'), card_amount=? WHERE id=?`)
    .run(req.user.id, amount, applicant.id);
  const tmpl = templates.applicantApproved(`${applicant.first_name} ${applicant.last_name}`);
  if (applicant.email) sendMail(req.user.org_id, applicant.email, tmpl.subject, tmpl.body);
  res.json({ applicant: db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.id) });
});

router.post('/:id/reject', requireAdmin, (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE applicants SET approval_status='rejected', approved_by=?, approved_at=datetime('now') WHERE id=?`).run(req.user.id, applicant.id);
  res.json({ ok: true });
});

// Mass approval — spec #5 "allow mass approval".
router.post('/mass-approve', requireAdmin, (req, res) => {
  const { ids, card_amount } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let approved = 0, skipped = 0;
  for (const id of ids) {
    const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!applicant || applicant.is_paused) { skipped++; continue; }
    const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(applicant.season_id);
    const amount = card_amount ?? applicant.card_amount ?? season?.default_card_amount ?? 0;
    db.prepare(`UPDATE applicants SET approval_status='approved', approved_by=?, approved_at=datetime('now'), card_amount=? WHERE id=?`).run(req.user.id, amount, id);
    approved++;
  }
  res.json({ approved, skipped });
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
router.get('/import/template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="applicant_import_template.csv"');
  res.send(buildCsvTemplate(APPLICANT_IMPORT_COLUMNS));
});

router.post('/import', requirePermission('applicants', 'can_edit'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const rows = parseSpreadsheet(req.file.buffer, req.file.originalname);
  const jobId = uuid();
  let success = 0, dupes = 0; const errors = [];
  const forcedShul = req.user.role === 'shul' ? db.prepare('SELECT * FROM shuls WHERE id = ?').get(req.user.shul_id) : null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.first_name || !r.last_name) { errors.push({ row: i + 2, error: 'Missing first_name or last_name' }); continue; }
    let shul = forcedShul;
    if (!shul) {
      shul = r.shul_name ? db.prepare('SELECT * FROM shuls WHERE org_id = ? AND name_en = ?').get(req.user.org_id, r.shul_name) : null;
      if (!shul) { errors.push({ row: i + 2, error: `Shul not found: "${r.shul_name || ''}" (must match an existing shul name exactly)` }); continue; }
    }
    if (shul.is_paused) { errors.push({ row: i + 2, error: `Shul "${shul.name_en}" is paused` }); continue; }
    try {
      const id = uuid();
      db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
          address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, card_amount, comments, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?, 'mass_upload')`)
        .run(id, req.user.org_id, shul.id, shul.season_id, r.first_name, r.last_name, r.marital_status || '', r.home_phone || '', r.husband_cell || '', r.wife_cell || '', r.email || '',
          r.address || '', r.city || '', r.state || '', r.zip || '', r.preferred_contact_method || '', r.preferred_number || '', +r.num_children || 0,
          /^(y|yes|true|1)$/i.test(String(r.home_for_yomtov || '')) ? 1 : 0, r.card_amount ? +r.card_amount : null, r.comments || '');
      const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
      const flag = detectAndFlag(req.user.org_id, 'applicant', applicant);
      if (flag) dupes++; else success++;
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
