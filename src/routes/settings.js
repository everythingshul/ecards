import { Router } from 'express';
import multer from 'multer';
import { unlinkSync, writeFileSync } from 'fs';
import { db, uuid } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { CUSTOM_TEMPLATE_PATH, hasCustomTemplate } from '../services/pdf.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
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

// Custom contract PDF — uploaded once, used as the base document for every
// shul's contract from then on (the shul/season details are no longer
// auto-typed onto the page; the uploaded PDF is used verbatim). A signature
// block is still stamped onto its last page at sign time.
router.get('/contract-pdf', (req, res) => {
  res.json({ hasCustomTemplate: hasCustomTemplate() });
});

router.post('/contract-pdf', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'File must be a PDF' });
  writeFileSync(CUSTOM_TEMPLATE_PATH, req.file.buffer);
  res.json({ ok: true, hasCustomTemplate: true });
});

router.delete('/contract-pdf', requireAdmin, (req, res) => {
  try { unlinkSync(CUSTOM_TEMPLATE_PATH); } catch { /* already gone */ }
  res.json({ ok: true, hasCustomTemplate: false });
});

export default router;
