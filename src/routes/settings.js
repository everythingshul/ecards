import { Router } from 'express';
import multer from 'multer';
import { unlinkSync, writeFileSync, readFileSync } from 'fs';
import { PDFDocument } from 'pdf-lib';
import { db, uuid } from '../db.js';
import { auth, requireRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { CUSTOM_TEMPLATE_PATH, hasCustomTemplate, docTemplatePath, hasCustomDocTemplate, getSignatureFields, generatePreviewPdfBytes, getDataFields, getDataFieldDefs } from '../services/pdf.js';
import { isMockMode } from '../services/giftcard.js';
import { SYSTEM_EMAIL_TEMPLATES } from '../services/mail.js';
import { runBackup, listBackups, backupPath } from '../services/backup.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
router.use(auth);

// Generic org-scoped key/value settings (contract template text, gmaps key display, etc.)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE org_id = ?').all(req.user.org_id);
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
});

router.put('/', requirePermission('settings', 'can_edit'), (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`);
  for (const [key, value] of Object.entries(req.body || {})) upsert.run(req.user.org_id, key, String(value ?? ''));
  res.json({ ok: true });
});

// Surfaces whether disccardpromos is actually live or silently running in
// mock mode (both env vars must be set for it to be live — see
// services/giftcard.js's isMockMode()) directly in the admin UI, since mock
// mode returns fake success for every call with no error anywhere, so
// there's otherwise no way to tell from inside the app that it's not real.
router.get('/giftcard-status', (req, res) => {
  const mockMode = isMockMode();
  const missing = mockMode ? [!process.env.DISCCARDPROMOS_API_BASE && 'DISCCARDPROMOS_API_BASE', !process.env.DISCCARDPROMOS_API_KEY && 'DISCCARDPROMOS_API_KEY'].filter(Boolean) : [];
  res.json({ mockMode, missing });
});

// Custom contract PDF — uploaded once, used as the base document for every
// shul's contract from then on (the shul/season details are no longer
// auto-typed onto the page; the uploaded PDF is used verbatim). A signature
// block is still stamped onto its last page at sign time.
router.get('/contract-pdf', (req, res) => {
  res.json({ hasCustomTemplate: hasCustomTemplate() });
});

router.post('/contract-pdf', requirePermission('settings', 'can_edit'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'File must be a PDF' });
  writeFileSync(CUSTOM_TEMPLATE_PATH, req.file.buffer);
  res.json({ ok: true, hasCustomTemplate: true });
});

router.delete('/contract-pdf', requirePermission('settings', 'can_edit'), (req, res) => {
  try { unlinkSync(CUSTOM_TEMPLATE_PATH); } catch { /* already gone */ }
  res.json({ ok: true, hasCustomTemplate: false });
});

// Custom document PDFs for applicants and stores — same idea as the shul
// contract above, generalized. entityType is 'applicant' or 'store'.
router.get('/document-pdf/:entityType', (req, res) => {
  if (!['applicant', 'store'].includes(req.params.entityType)) return res.status(400).json({ error: 'Invalid entity type' });
  res.json({ hasCustomTemplate: hasCustomDocTemplate(req.params.entityType) });
});

router.post('/document-pdf/:entityType', requirePermission('settings', 'can_edit'), upload.single('file'), (req, res) => {
  const entityType = req.params.entityType;
  if (!['applicant', 'store'].includes(entityType)) return res.status(400).json({ error: 'Invalid entity type' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'File must be a PDF' });
  writeFileSync(docTemplatePath(entityType), req.file.buffer);
  res.json({ ok: true, hasCustomTemplate: true });
});

router.delete('/document-pdf/:entityType', requirePermission('settings', 'can_edit'), (req, res) => {
  const entityType = req.params.entityType;
  if (!['applicant', 'store'].includes(entityType)) return res.status(400).json({ error: 'Invalid entity type' });
  try { unlinkSync(docTemplatePath(entityType)); } catch { /* already gone */ }
  res.json({ ok: true, hasCustomTemplate: false });
});

// Signature placement editor (Settings > Documents > drag/resize box) —
// 'kind' is 'shul' | 'applicant' | 'store'. Coordinates are stored as
// fractions (0-1) of the page's actual width/height, top-left origin,
// matching the drag UI; stampSignature() in services/pdf.js converts to PDF
// points/bottom-left-origin at sign time.
const SIG_TEMPLATE_PATH = { shul: () => (hasCustomTemplate() ? CUSTOM_TEMPLATE_PATH : null), applicant: () => (hasCustomDocTemplate('applicant') ? docTemplatePath('applicant') : null), store: () => (hasCustomDocTemplate('store') ? docTemplatePath('store') : null) };

async function templatePageSize(kind) {
  const path = SIG_TEMPLATE_PATH[kind]?.();
  if (path) {
    try {
      const doc = await PDFDocument.load(readFileSync(path));
      const pages = doc.getPages();
      const { width, height } = pages[pages.length - 1].getSize();
      return { width, height };
    } catch { /* fall through to the generated-doc default below */ }
  }
  return { width: 612, height: 792 }; // our generated Letter-size default (services/pdf.js buildSimplePdf)
}

const SIG_FIELD_TYPES = ['signature', 'initial', 'date', 'text'];

router.get('/signature-box/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const fields = getSignatureFields(req.user.org_id, kind);
  const pageSize = await templatePageSize(kind);
  res.json({ fields, pageSize });
});

// Streams the actual PDF the signature-box editor renders as its
// background: the org's uploaded custom template if one exists for this
// kind, otherwise a sample of our own generated document — same
// heading/fieldLines/body layout the real thing uses, filled with
// placeholder values since there's no specific entity behind this editor.
// Either way, an admin dragging the box around is looking at the real page,
// not a blank proportioned rectangle.
router.get('/signature-box/:kind/preview-pdf', async (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const templatePath = SIG_TEMPLATE_PATH[kind]?.();
  res.type('application/pdf');
  if (templatePath) return res.send(readFileSync(templatePath));
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
  const bytes = await generatePreviewPdfBytes(req.user.org_id, org.name, kind);
  res.send(Buffer.from(bytes));
});

// Body is the full fields array (replaces whatever was saved before) — the
// admin editor always sends its whole current set, since fields can be
// added/removed/reordered in the same edit session.
router.put('/signature-box/:kind', requirePermission('settings', 'can_edit'), (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const fields = req.body?.fields;
  if (!Array.isArray(fields) || !fields.length) return res.status(400).json({ error: 'At least one field is required' });
  for (const f of fields) {
    if (!f.id || !SIG_FIELD_TYPES.includes(f.type)) return res.status(400).json({ error: 'Each field needs a valid id and type' });
    if ([f.x, f.y, f.width, f.height].some(v => typeof v !== 'number' || v < 0 || v > 1)) return res.status(400).json({ error: 'x/y/width/height must be numbers between 0 and 1' });
  }
  const value = JSON.stringify(fields.map(f => ({ id: f.id, type: f.type, label: f.label || '', required: f.required !== false, x: f.x, y: f.y, width: f.width, height: f.height })));
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`).run(req.user.org_id, `signature_box_${kind}`, value);
  res.json({ ok: true, fields: JSON.parse(value) });
});

// Contract data-field placement editor (Settings > Documents > "Edit
// Contract Field Placement") — distinct from the signature-box editor
// above: these fields get the entity's own record data stamped onto the
// uploaded template PDF at generation time, not whatever the signer types.
// Only meaningful once a custom template is uploaded (see
// generateContractPdf/generateGenericDocumentPdf in services/pdf.js) —
// hasTemplate tells the frontend whether to even offer this editor.
router.get('/contract-fields/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const fields = getDataFields(req.user.org_id, kind);
  const pageSize = await templatePageSize(kind);
  res.json({ fields, pageSize, availableFields: getDataFieldDefs(kind), hasTemplate: !!SIG_TEMPLATE_PATH[kind]?.() });
});

router.put('/contract-fields/:kind', requirePermission('settings', 'can_edit'), (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const fields = req.body?.fields;
  if (!Array.isArray(fields)) return res.status(400).json({ error: 'fields array required' });
  const validKeys = new Set(getDataFieldDefs(kind).map(([key]) => key));
  for (const f of fields) {
    if (!f.id || !validKeys.has(f.dataField)) return res.status(400).json({ error: 'Each field needs a valid id and a recognized dataField' });
    if ([f.x, f.y, f.width, f.height].some(v => typeof v !== 'number' || v < 0 || v > 1)) return res.status(400).json({ error: 'x/y/width/height must be numbers between 0 and 1' });
  }
  const value = JSON.stringify(fields.map(f => ({ id: f.id, dataField: f.dataField, x: f.x, y: f.y, width: f.width, height: f.height, fontSize: f.fontSize || null })));
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`).run(req.user.org_id, `contract_data_fields_${kind}`, value);
  res.json({ ok: true, fields: JSON.parse(value) });
});

// Auto-email message editor — every key in SYSTEM_EMAIL_TEMPLATES (contract
// ready, shul approved, applicant approved, store welcome, user invite,
// password reset), each with either the built-in default or this org's
// saved override. Only ever returns/accepts the {{var}} placeholder text —
// the actual substitution happens at send time in renderSystemTemplate().
router.get('/email-templates', requirePermission('settings'), (req, res) => {
  const overrides = Object.fromEntries(db.prepare('SELECT key, subject, body, reply_to FROM system_email_templates WHERE org_id = ?').all(req.user.org_id).map(r => [r.key, r]));
  const defaultReplyTo = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'email_reply_to'`).get(req.user.org_id)?.value || '';
  const templates = Object.entries(SYSTEM_EMAIL_TEMPLATES).map(([key, def]) => ({
    key, label: def.label, vars: def.vars,
    subject: overrides[key]?.subject ?? def.subject, body: overrides[key]?.body ?? def.body,
    replyTo: overrides[key]?.reply_to || '', defaultReplyTo,
    isCustomized: !!overrides[key], defaultSubject: def.subject, defaultBody: def.body,
  }));
  res.json({ templates });
});

router.put('/email-templates/:key', requirePermission('settings', 'can_edit'), (req, res) => {
  const { key } = req.params;
  if (!SYSTEM_EMAIL_TEMPLATES[key]) return res.status(404).json({ error: 'Unknown template key' });
  const { subject, body, reply_to } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });
  // reply_to undefined (caller didn't send the field at all) preserves
  // whatever was already saved; '' explicitly clears it back to "use the
  // org-wide default" rather than being coerced to null and losing the row's
  // existing value on a save that only touched subject/body.
  const existing = db.prepare('SELECT reply_to FROM system_email_templates WHERE org_id = ? AND key = ?').get(req.user.org_id, key);
  const replyTo = reply_to !== undefined ? (reply_to || null) : (existing?.reply_to || null);
  db.prepare(`INSERT INTO system_email_templates (id, org_id, key, subject, body, reply_to) VALUES (?,?,?,?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET subject=excluded.subject, body=excluded.body, reply_to=excluded.reply_to, updated_at=datetime('now')`)
    .run(uuid(), req.user.org_id, key, subject, body, replyTo);
  res.json({ ok: true });
});

// Revert to the built-in default (just deletes the override row).
router.delete('/email-templates/:key', requirePermission('settings', 'can_edit'), (req, res) => {
  db.prepare('DELETE FROM system_email_templates WHERE org_id = ? AND key = ?').run(req.user.org_id, req.params.key);
  res.json({ ok: true });
});

// Backups — super_admin only, not the general requireAdmin roster. The raw
// SQLite file is a complete copy of every applicant/shul/store/card record
// plus password hashes; that's a materially bigger blast radius than what
// staff/org_admin normally touch, so it gets its own tighter gate.
router.get('/backups', requireRole('super_admin'), (req, res) => {
  res.json({ backups: listBackups() });
});

router.post('/backups/run', requireRole('super_admin'), async (req, res) => {
  try {
    const path = await runBackup();
    res.json({ ok: true, backups: listBackups(), created: path.split('/').pop() });
  } catch (e) { res.status(500).json({ error: `Backup failed: ${e.message}` }); }
});

router.get('/backups/:filename/download', requireRole('super_admin'), (req, res) => {
  const path = backupPath(req.params.filename);
  if (!path) return res.status(404).json({ error: 'Backup not found' });
  res.download(path, req.params.filename);
});

// Fresh snapshot, right now, streamed straight to the browser — the
// "get me a copy off this server immediately" action, independent of the
// automatic rotation schedule.
router.get('/backups/download-now', requireRole('super_admin'), async (req, res) => {
  try {
    const path = await runBackup();
    res.download(path, path.split('/').pop());
  } catch (e) { res.status(500).json({ error: `Backup failed: ${e.message}` }); }
});

export default router;
