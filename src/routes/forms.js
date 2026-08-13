import { Router } from 'express';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';

const router = Router();

// Public: fetch a form definition by slug to render (spec #12: form builder with
// ability to set it public, groups, or individuals).
router.get('/public/:slug', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!form) return res.status(404).json({ error: 'Form not found or no longer active' });
  res.json({ form: { ...form, schema_json: JSON.parse(form.schema_json), target_json: JSON.parse(form.target_json || '[]') } });
});

// Public: generic submission handler for custom "applicant_application" forms
// built in the form builder. Maps whatever schema fields match known applicant
// columns; anything else is appended to comments so no data is ever lost.
router.post('/public/:slug/submit', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!form) return res.status(404).json({ error: 'Form not found or no longer active' });
  if (form.type !== 'applicant_application') return res.status(400).json({ error: 'This form type is not publicly submittable here' });
  const schema = JSON.parse(form.schema_json);
  const b = req.body || {};
  for (const f of schema) if (f.required && !b[f.key]) return res.status(400).json({ error: `Missing required field: ${f.label || f.key}` });

  const KNOWN = ['first_name','last_name','marital_status','home_phone','husband_cell','wife_cell','email','address','city','state','zip','shul_id','preferred_contact_method','preferred_number','num_children','home_for_yomtov'];
  const extra = [];
  const applicant = {};
  for (const f of schema) {
    if (KNOWN.includes(f.key)) applicant[f.key] = b[f.key];
    else if (b[f.key]) extra.push(`${f.label || f.key}: ${b[f.key]}`);
  }
  if (!applicant.first_name || !applicant.last_name || !applicant.shul_id) return res.status(400).json({ error: 'Form must include first_name, last_name, and shul_id fields' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(applicant.shul_id, form.org_id);
  if (!shul) return res.status(400).json({ error: 'Invalid shul selection' });
  if (shul.is_paused) return res.status(423).json({ error: 'This shul is currently paused' });

  const id = uuid();
  db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
      address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, comments, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'public_form')`)
    .run(id, form.org_id, shul.id, shul.season_id, applicant.first_name, applicant.last_name, applicant.marital_status || '',
      applicant.home_phone || '', applicant.husband_cell || '', applicant.wife_cell || '', applicant.email || '',
      applicant.address || '', applicant.city || '', applicant.state || '', applicant.zip || '',
      applicant.preferred_contact_method || '', applicant.preferred_number || '', +applicant.num_children || 0,
      applicant.home_for_yomtov ? 1 : 0, extra.join(' | '));
  res.status(201).json({ ok: true, id });
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
