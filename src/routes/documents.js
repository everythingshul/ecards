import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { generateGenericDocumentPdf, stampSignatureFields, getSignatureFields, resolveSignatureValues } from '../services/pdf.js';
import { sendMailChecked, renderSystemTemplate } from '../services/mail.js';

const router = Router();

export function resolveEntity(entityType, entityId, orgId) {
  if (entityType === 'applicant') {
    const a = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(entityId, orgId);
    if (!a) return null;
    const shul = a.shul_id ? db.prepare('SELECT name_en FROM shuls WHERE id = ?').get(a.shul_id) : null;
    const season = a.season_id ? db.prepare('SELECT name FROM seasons WHERE id = ?').get(a.season_id) : null;
    return {
      contactEmail: a.email,
      displayName: `${a.first_name} ${a.last_name}`,
      record: a,
      extra: { shulName: shul?.name_en || '', seasonName: season?.name || '' },
      fieldLines: [
        `Applicant: ${a.first_name} ${a.last_name}`,
        `Address: ${[a.address, a.city, a.state, a.zip].filter(Boolean).join(', ')}`,
        `Phone: ${a.home_phone || a.husband_cell || a.wife_cell || ''}`,
        `Email: ${a.email || ''}`,
      ],
    };
  }
  if (entityType === 'store') {
    const s = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(entityId, orgId);
    if (!s) return null;
    return {
      contactEmail: s.owner_email || s.manager_email,
      displayName: s.name,
      record: s,
      extra: {},
      fieldLines: [
        `Store: ${s.name}`,
        `Address: ${[s.address, s.city, s.state, s.zip].filter(Boolean).join(', ')}`,
        `Owner: ${s.owner_name || ''}  |  ${s.owner_phone || ''}  |  ${s.owner_email || ''}`,
        `Manager: ${s.manager_name || ''}  |  ${s.manager_phone || ''}`,
      ],
    };
  }
  return null;
}

// ============================= ADMIN ==============================
router.get('/', auth, requireAdmin, (req, res) => {
  const { entity_type, entity_id } = req.query;
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id are required' });
  const docs = db.prepare(`SELECT * FROM documents WHERE org_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC`)
    .all(req.user.org_id, entity_type, entity_id);
  res.json({ documents: docs });
});

// Generate (or regenerate, if not yet sent) the unsigned PDF for an entity.
router.post('/generate', auth, requireAdmin, async (req, res) => {
  const { entity_type, entity_id, title } = req.body || {};
  if (!['applicant', 'store'].includes(entity_type)) return res.status(400).json({ error: 'entity_type must be applicant or store' });
  const entity = resolveEntity(entity_type, entity_id, req.user.org_id);
  if (!entity) return res.status(404).json({ error: 'Not found' });

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = ?`).get(req.user.org_id, `document_template_text_${entity_type}`);
  const pdfPath = await generateGenericDocumentPdf({
    entityType: entity_type, entityId: entity_id, title, fieldLines: entity.fieldLines,
    templateText: templateSetting?.value, orgName: org.name,
    record: entity.record, extra: entity.extra, orgId: req.user.org_id,
  });

  const id = uuid();
  db.prepare(`INSERT INTO documents (id, org_id, entity_type, entity_id, title, pdf_path, status, created_by)
    VALUES (?,?,?,?,?,?,'pending',?)`).run(id, req.user.org_id, entity_type, entity_id, title || 'Agreement', pdfPath, req.user.id);
  res.status(201).json({ document: db.prepare('SELECT * FROM documents WHERE id = ?').get(id) });
});

// Self-service: a store generates + signs its OWN participation agreement
// as part of onboarding (store-portal/onboarding.html step 2) — the same
// "generate a real contract, sign it inline" pattern shuls already have via
// the public /shuls/:id/generate-contract + apply.html, replacing what used
// to be just a plain "I agree to the terms" checkbox with no actual
// document. No email step needed here (unlike the admin /generate + /send
// pair above) since the store signs it immediately in the same session —
// returns the sign_token straight away for sign-document.html to use inline.
router.post('/store-agreement', auth, async (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Not permitted' });
  const storeId = req.user.store_id;
  const entity = resolveEntity('store', storeId, req.user.org_id);
  if (!entity) return res.status(404).json({ error: 'Store not found' });
  // Reuse an existing not-yet-signed agreement instead of piling up a new
  // document (and a new signing token) every time onboarding re-renders
  // this step.
  const existing = db.prepare(`SELECT * FROM documents WHERE org_id = ? AND entity_type = 'store' AND entity_id = ? AND status != 'signed' ORDER BY created_at DESC LIMIT 1`)
    .get(req.user.org_id, storeId);
  if (existing) return res.json({ document: existing, sign_token: existing.sign_token });

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'document_template_text_store'`).get(req.user.org_id);
  const pdfPath = await generateGenericDocumentPdf({
    entityType: 'store', entityId: storeId, title: 'Store Participation Agreement', fieldLines: entity.fieldLines,
    templateText: templateSetting?.value, orgName: org.name,
    record: entity.record, extra: entity.extra, orgId: req.user.org_id,
  });
  const id = uuid();
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO documents (id, org_id, entity_type, entity_id, title, pdf_path, status, sign_token, sign_token_expires, sent_at, created_by)
    VALUES (?,?,?,?,?,?,'sent',?,?,datetime('now'),?)`).run(id, req.user.org_id, 'store', storeId, 'Store Participation Agreement', pdfPath, token, expires, req.user.id);
  res.status(201).json({ document: db.prepare('SELECT * FROM documents WHERE id = ?').get(id), sign_token: token });
});

// Email the signing link. Generates first if this document hasn't been generated yet.
router.post('/:id/send', auth, requireAdmin, async (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!document) return res.status(404).json({ error: 'Not found' });
  const entity = resolveEntity(document.entity_type, document.entity_id, req.user.org_id);
  if (!entity) return res.status(404).json({ error: 'Linked record no longer exists' });
  const to = req.body?.email || entity.contactEmail;
  if (!to) return res.status(400).json({ error: 'No email on file for this record' });

  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`UPDATE documents SET status='sent', sign_token=?, sign_token_expires=?, sent_at=datetime('now') WHERE id=?`)
    .run(token, expires, document.id);

  const signUrl = `${process.env.APP_URL || ''}/sign-document?token=${token}`;
  const { subject, body, replyTo } = renderSystemTemplate(req.user.org_id, 'documentReady', {
    docTitle: document.title || 'Document', entityName: entity.displayName, signUrl,
  });
  const { emailError } = await sendMailChecked(req.user.org_id, to, subject, body, { replyTo });
  if (emailError) console.error('[mail] document send failed:', emailError);

  res.json({ document: db.prepare('SELECT * FROM documents WHERE id = ?').get(document.id), emailError });
});

router.post('/:id/void', auth, requireAdmin, (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!document) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE documents SET status='void' WHERE id=?`).run(document.id);
  res.json({ ok: true });
});

// Undo a signature — for a signed-in-error or outdated signature, not a
// rejection (that's what void is for). Clears the signature and the signed
// PDF, puts the document back to 'sent' with a fresh signing link so it can
// be signed again; does not email anyone automatically.
router.post('/:id/retract', auth, requireAdmin, (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!document) return res.status(404).json({ error: 'Not found' });
  if (document.status !== 'signed') return res.status(400).json({ error: 'Only a signed document can have its signature retracted' });
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`UPDATE documents SET status='sent', signature_data=NULL, signer_name=NULL, signer_title=NULL, signed_at=NULL, ip_address=NULL, signed_pdf_path=NULL, sign_token=?, sign_token_expires=? WHERE id=?`)
    .run(token, expires, document.id);
  res.json({ ok: true, document: db.prepare('SELECT * FROM documents WHERE id = ?').get(document.id) });
});

router.get('/:id/pdf', auth, requireAdmin, (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!document) return res.status(404).json({ error: 'Not found' });
  const path = document.signed_pdf_path || document.pdf_path;
  if (!path) return res.status(404).json({ error: 'PDF not available' });
  res.sendFile(path);
});

// ============================= PUBLIC (token-based signing) ==============================
router.get('/sign/:token', (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE sign_token = ?').get(req.params.token);
  if (!document) return res.status(404).json({ error: 'Not found' });
  if (document.status === 'signed') return res.json({ document, alreadySigned: true });
  if (document.status === 'void') return res.status(410).json({ error: 'This document has been voided.' });
  if (document.sign_token_expires && new Date(document.sign_token_expires) < new Date()) return res.status(410).json({ error: 'This signing link has expired. Contact us for a new one.' });
  const entity = resolveEntity(document.entity_type, document.entity_id, document.org_id);
  const fields = getSignatureFields(document.org_id, document.entity_type);
  res.json({ document, entityName: entity?.displayName || '', fields });
});

router.get('/sign/:token/pdf-preview', (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE sign_token = ?').get(req.params.token);
  if (!document) return res.status(404).send('Not found');
  const path = document.signed_pdf_path || document.pdf_path;
  if (!path) return res.status(404).send('PDF not available');
  res.sendFile(path);
});

router.post('/sign/:token/sign', async (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE sign_token = ?').get(req.params.token);
  if (!document) return res.status(404).json({ error: 'Not found' });
  if (document.status === 'signed') return res.status(409).json({ error: 'This document has already been signed' });
  if (document.status === 'void') return res.status(410).json({ error: 'This document has been voided' });
  const { signer_name, signer_title } = req.body || {};
  if (!signer_name) return res.status(400).json({ error: 'Signer name is required' });
  const fields = getSignatureFields(document.org_id, document.entity_type);
  const { values, missing } = resolveSignatureValues(fields, req.body);
  if (missing.length) return res.status(400).json({ error: `Please complete: ${missing.join(', ')}` });

  const signedAt = new Date().toISOString();
  const primary = fields.find(f => f.type === 'signature') || fields[0];
  const signedPath = await stampSignatureFields({
    unsignedPath: document.pdf_path, shulId: `${document.entity_type}-${document.entity_id}`,
    fields, values, signerName: signer_name, signedAt, ip: req.ip,
  });
  const signatureData = primary ? values[primary.id] : null;
  db.prepare(`UPDATE documents SET status='signed', signature_data=?, signer_name=?, signer_title=?, signed_at=?, ip_address=?, signed_pdf_path=?, field_values=? WHERE id=?`)
    .run(signatureData, signer_name, signer_title || '', signedAt, req.ip, signedPath, JSON.stringify(values), document.id);
  res.json({ ok: true, message: 'Document signed. Thank you.' });
});

export default router;
