import { Router } from 'express';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { detectAndFlag } from '../services/duplicates.js';
import { normalizePhone } from '../utils/phone.js';
import { generateApplicantExternalId } from '../utils/externalId.js';
import { isZipAllowed } from './applicants.js';

const router = Router();

// Public: fetch a form definition by slug to render (spec #12: form builder with
// ability to set it public, groups, or individuals).
router.get('/public/:slug', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!form) return res.status(404).json({ error: 'Form not found or no longer active' });
  res.json({ form: { ...form, schema_json: JSON.parse(form.schema_json), target_json: JSON.parse(form.target_json || '[]') } });
});

// Splits submitted fields into whatever matches a known column for this
// entity type vs. everything else (appended to comments so no data is ever
// lost just because the builder let someone add an arbitrary field).
function splitKnown(schema, body, known) {
  const known_ = {}; const extra = [];
  for (const f of schema) {
    if (known.includes(f.key)) known_[f.key] = body[f.key];
    else if (body[f.key]) extra.push(`${f.label || f.key}: ${body[f.key]}`);
  }
  return { known: known_, extra: extra.join(' | ') };
}

const APPLICANT_FIELDS = ['first_name','last_name','marital_status','home_phone','husband_cell','wife_cell','email','address','city','state','zip','shul_id','preferred_contact_method','preferred_number','num_children','home_for_yomtov'];
const SHUL_FIELDS = ['name_en','name_he','address','city','state','zip','ruv_first_name','ruv_last_name','ruv_phone','gabai_first_name','gabai_last_name','gabai_cell','gabai_email'];
const STORE_FIELDS = ['name','address','city','state','zip','phone','manager_name','manager_phone','manager_email','owner_name','owner_phone','owner_email'];

// Public: generic submission handler for custom forms built in the form
// builder — one of applicant_application, shul_application, or
// store_application. Each branch mirrors the equivalent purpose-built public
// endpoint (applicants.js POST /, shuls.js POST /apply, stores.js POST
// /apply) so a custom-built form behaves the same as the hand-built one once
// submitted, just with whatever field set the builder configured.
router.post('/public/:slug/submit', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!form) return res.status(404).json({ error: 'Form not found or no longer active' });
  const schema = JSON.parse(form.schema_json);
  const b = req.body || {};
  for (const f of schema) if (f.required && !b[f.key]) return res.status(400).json({ error: `Missing required field: ${f.label || f.key}` });

  if (form.type === 'applicant_application') {
    const { known: applicant, extra } = splitKnown(schema, b, APPLICANT_FIELDS);
    if (!applicant.first_name || !applicant.last_name || !applicant.shul_id) return res.status(400).json({ error: 'Form must include first_name, last_name, and shul_id fields' });
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(applicant.shul_id, form.org_id);
    if (!shul) return res.status(400).json({ error: 'Invalid shul selection' });
    if (shul.is_paused) return res.status(423).json({ error: 'This shul is currently paused' });
    const id = uuid();
    const initialStatus = isZipAllowed(form.org_id, applicant.zip) ? 'pending' : 'rejected';
    db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, external_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
        address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, comments, source, approval_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'public_form', ?)`)
      .run(id, form.org_id, shul.id, shul.season_id, generateApplicantExternalId(db), applicant.first_name, applicant.last_name, applicant.marital_status || '',
        applicant.home_phone || '', applicant.husband_cell || '', applicant.wife_cell || '', applicant.email || '',
        applicant.address || '', applicant.city || '', applicant.state || '', applicant.zip || '',
        applicant.preferred_contact_method || '', applicant.preferred_number || '', +applicant.num_children || 0,
        applicant.home_for_yomtov ? 1 : 0, extra, initialStatus);
    return res.status(201).json({ ok: true, id });
  }

  if (form.type === 'shul_application') {
    const { known: shul, extra } = splitKnown(schema, b, SHUL_FIELDS);
    for (const f of ['name_en', 'address', 'city', 'state', 'zip', 'ruv_first_name', 'ruv_last_name', 'ruv_phone', 'gabai_first_name', 'gabai_last_name', 'gabai_cell', 'gabai_email']) {
      if (!shul[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
    }
    const season = db.prepare('SELECT * FROM seasons WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(form.org_id);
    const id = uuid();
    db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip,
        ruv_first_name, ruv_last_name, ruv_phone, gabai_first_name, gabai_last_name, gabai_cell, gabai_email, status, source)
      VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, 'submitted', 'form')`)
      .run(id, form.org_id, season?.id || null, shul.name_en, shul.name_he || '', shul.address, shul.city, shul.state, shul.zip,
        shul.ruv_first_name, shul.ruv_last_name, normalizePhone(shul.ruv_phone), shul.gabai_first_name, shul.gabai_last_name, normalizePhone(shul.gabai_cell), shul.gabai_email);
    const created = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
    if (extra) db.prepare('INSERT INTO shul_notes (id, shul_id, note) VALUES (?,?,?)').run(uuid(), id, extra);
    const flag = detectAndFlag(form.org_id, 'shul', created);
    return res.status(201).json({ ok: true, id, duplicate: !!flag });
  }

  if (form.type === 'store_application') {
    const { known: store, extra } = splitKnown(schema, b, STORE_FIELDS);
    if (!store.name || !store.owner_email) return res.status(400).json({ error: 'Form must include name and owner_email fields' });
    const id = uuid();
    db.prepare(`INSERT INTO stores (id, org_id, name, address, city, state, zip, phone, manager_name, manager_phone, manager_email,
        owner_name, owner_phone, owner_email, comments, setup_status, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,'pending','application')`)
      .run(id, form.org_id, store.name, store.address || '', store.city || '', store.state || '', store.zip || '', normalizePhone(store.phone || ''),
        store.manager_name || '', normalizePhone(store.manager_phone || ''), store.manager_email || '', store.owner_name || '', normalizePhone(store.owner_phone || ''), store.owner_email, extra);
    return res.status(201).json({ ok: true, id });
  }

  res.status(400).json({ error: 'This form type is not publicly submittable here' });
});

router.use(auth, requireAdmin);

router.get('/', (req, res) => {
  const forms = db.prepare('SELECT * FROM forms WHERE org_id = ? ORDER BY created_at DESC').all(req.user.org_id);
  res.json({ forms: forms.map(f => ({ ...f, schema_json: JSON.parse(f.schema_json), target_json: JSON.parse(f.target_json || '[]') })) });
});

router.post('/', (req, res) => {
  const { name, type, visibility = 'public', slug, schema, target = [] } = req.body || {};
  if (!name || !type || !slug) return res.status(400).json({ error: 'name, type, and slug are required' });
  if (db.prepare('SELECT 1 FROM forms WHERE slug = ?').get(slug)) return res.status(409).json({ error: 'That slug is already in use' });
  const id = uuid();
  db.prepare(`INSERT INTO forms (id, org_id, name, type, visibility, slug, schema_json, target_json, is_active)
    VALUES (?,?,?,?,?,?,?,?,1)`).run(id, req.user.org_id, name, type, visibility, slug, JSON.stringify(schema || []), JSON.stringify(target));
  res.status(201).json({ form: db.prepare('SELECT * FROM forms WHERE id = ?').get(id) });
});

router.put('/:id', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!form) return res.status(404).json({ error: 'Not found' });
  const { name, visibility, schema, target, is_active } = req.body || {};
  db.prepare(`UPDATE forms SET name=COALESCE(?,name), visibility=COALESCE(?,visibility),
    schema_json=COALESCE(?,schema_json), target_json=COALESCE(?,target_json), is_active=COALESCE(?,is_active), updated_at=datetime('now') WHERE id=?`)
    .run(name, visibility, schema ? JSON.stringify(schema) : null, target ? JSON.stringify(target) : null, is_active === undefined ? undefined : (is_active ? 1 : 0), form.id);
  res.json({ form: db.prepare('SELECT * FROM forms WHERE id = ?').get(form.id) });
});

router.delete('/:id', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!form) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE forms SET is_active = 0 WHERE id = ?').run(form.id);
  res.json({ ok: true });
});

export default router;
