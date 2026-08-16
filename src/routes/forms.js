import { Router } from 'express';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { detectAndFlag } from '../services/duplicates.js';
import { normalizePhone } from '../utils/phone.js';
import { generateApplicantExternalId } from '../utils/externalId.js';
import { isZipAllowed } from './applicants.js';
import { formWindowError } from '../utils/formSchedule.js';

const router = Router();

// Public: fetch a form definition by slug to render (spec #12: form builder with
// ability to set it public, groups, or individuals). Returns the form even when
// its schedule window hasn't opened/has closed yet (as long as it's still
// active) — the caller uses windowError to show a friendly "opens on X" /
// "closed" message rather than a bare 404, since is_active alone doesn't
// tell that story.
router.get('/public/:slug', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!form) return res.status(404).json({ error: 'Form not found or no longer active' });
  res.json({ form: { ...form, schema_json: JSON.parse(form.schema_json), target_json: JSON.parse(form.target_json || '[]') }, windowError: formWindowError(form) });
});

// Public: same as above but for the three built-in application pages
// (apply.html, apply-store.html, apply-ezras-habayis.html), which are fixed
// pages at fixed URLs — not slug-driven — so they look their form up by the
// permanent builtin_key instead of the now-editable slug (see PUT /:id and
// utils/formSchedule.js).
router.get('/public/builtin/:builtinKey', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE builtin_key = ? AND is_active = 1').get(req.params.builtinKey);
  if (!form) return res.status(404).json({ error: 'Form not found or no longer active' });
  res.json({ form: { ...form, schema_json: JSON.parse(form.schema_json), target_json: JSON.parse(form.target_json || '[]') }, windowError: formWindowError(form) });
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
  const windowError = formWindowError(form);
  if (windowError) return res.status(423).json({ error: windowError });
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
    // The form's own pinned season, not whichever season is "active" right
    // now — a link someone already has open shouldn't silently start
    // landing in a different season if the active one changes underneath it.
    const id = uuid();
    db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip,
        ruv_first_name, ruv_last_name, ruv_phone, gabai_first_name, gabai_last_name, gabai_cell, gabai_email, status, source)
      VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, 'submitted', 'form')`)
      .run(id, form.org_id, form.season_id, shul.name_en, shul.name_he || '', shul.address, shul.city, shul.state, shul.zip,
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
  const { name, type, visibility = 'public', slug, schema, target = [], season_id } = req.body || {};
  if (!name || !type || !slug) return res.status(400).json({ error: 'name, type, and slug are required' });
  if (!season_id) return res.status(400).json({ error: 'Every form must be linked to a season' });
  if (!db.prepare('SELECT 1 FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id)) return res.status(400).json({ error: 'Season not found' });
  if (db.prepare('SELECT 1 FROM forms WHERE slug = ?').get(slug)) return res.status(409).json({ error: 'That slug is already in use' });
  const id = uuid();
  db.prepare(`INSERT INTO forms (id, org_id, name, type, visibility, slug, schema_json, target_json, season_id, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,1)`).run(id, req.user.org_id, name, type, visibility, slug, JSON.stringify(schema || []), JSON.stringify(target), season_id);
  res.status(201).json({ form: db.prepare('SELECT * FROM forms WHERE id = ?').get(id) });
});

router.put('/:id', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!form) return res.status(404).json({ error: 'Not found' });
  const { name, visibility, schema, target, is_active, opens_at, closes_at, season_id, slug } = req.body || {};
  if (season_id !== undefined) {
    if (!season_id) return res.status(400).json({ error: 'Every form must be linked to a season' });
    if (!db.prepare('SELECT 1 FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id)) return res.status(400).json({ error: 'Season not found' });
  }
  // Renaming a built-in form's slug is safe — the public page that actually
  // serves it (apply.html etc.) looks itself up by the permanent
  // builtin_key, not slug (see utils/formSchedule.js) — but slug still has
  // to stay unique and non-empty for the generic /forms/public/:slug lookup
  // that custom forms (and anyone with an old link to this one) rely on.
  if (slug !== undefined) {
    if (!slug) return res.status(400).json({ error: 'URL Slug is required' });
    const conflict = db.prepare('SELECT 1 FROM forms WHERE slug = ? AND id != ?').get(slug, form.id);
    if (conflict) return res.status(409).json({ error: 'That slug is already in use' });
  }
  // opens_at/closes_at: undefined leaves it as-is; explicit null/'' clears
  // the date (open-ended) — same pattern as seasons.js's max_accepted_applicants.
  const opensAt = opens_at === undefined ? undefined : (opens_at || null);
  const closesAt = closes_at === undefined ? undefined : (closes_at || null);
  db.prepare(`UPDATE forms SET name=COALESCE(?,name), visibility=COALESCE(?,visibility), slug=COALESCE(?,slug),
    schema_json=COALESCE(?,schema_json), target_json=COALESCE(?,target_json), is_active=COALESCE(?,is_active), season_id=COALESCE(?,season_id),
    opens_at=CASE WHEN ? THEN ? ELSE opens_at END, closes_at=CASE WHEN ? THEN ? ELSE closes_at END, updated_at=datetime('now') WHERE id=?`)
    .run(name, visibility, slug, schema ? JSON.stringify(schema) : null, target ? JSON.stringify(target) : null, is_active === undefined ? undefined : (is_active ? 1 : 0), season_id || null,
      opensAt !== undefined ? 1 : 0, opensAt, closesAt !== undefined ? 1 : 0, closesAt, form.id);
  res.json({ form: db.prepare('SELECT * FROM forms WHERE id = ?').get(form.id) });
});

router.delete('/:id', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!form) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE forms SET is_active = 0 WHERE id = ?').run(form.id);
  res.json({ ok: true });
});

export default router;
