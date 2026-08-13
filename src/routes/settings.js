import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(auth);

// Generic org-scoped key/value settings (contract template text, gmaps key display, etc.)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE org_id = ?').all(req.user.org_id);
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
});

router.put('/', requireAdmin, (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`);
  for (const [key, value] of Object.entries(req.body || {})) upsert.run(req.user.org_id, key, String(value ?? ''));
  res.json({ ok: true });
});

// Field requirement config — powers "I should be able to set what's required and
// what not, as well as admin override" for both the shul and applicant forms.
router.get('/fields/:formType', (req, res) => {
  const rows = db.prepare('SELECT * FROM form_field_settings WHERE org_id = ? AND form_type = ?').all(req.user.org_id, req.params.formType);
  res.json({ fields: rows });
});

router.put('/fields/:formType', requireAdmin, (req, res) => {
  const { fields } = req.body || {}; // [{ field_key, is_required, is_admin_override, is_visible }]
  if (!Array.isArray(fields)) return res.status(400).json({ error: 'fields array required' });
  const upsert = db.prepare(`INSERT INTO form_field_settings (id, org_id, form_type, field_key, is_required, is_admin_override, is_visible)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(org_id, form_type, field_key) DO UPDATE SET is_required=excluded.is_required, is_admin_override=excluded.is_admin_override, is_visible=excluded.is_visible`);
  for (const f of fields) upsert.run(uuid(), req.user.org_id, req.params.formType, f.field_key, f.is_required ? 1 : 0, f.is_admin_override ? 1 : 0, f.is_visible === false ? 0 : 1);
  res.json({ ok: true });
});

export default router;
