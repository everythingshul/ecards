import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { generateGenericDocumentPdf, stampSignature, getSignatureBox } from '../services/pdf.js';
import { sendMailChecked } from '../services/mail.js';

const router = Router();

function resolveEntity(entityType, entityId, orgId) {
  if (entityType === 'applicant') {
    const a = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(entityId, orgId);
    if (!a) return null;
    return {
      contactEmail: a.email,
      displayName: `${a.first_name} ${a.last_name}`,
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
  });

  const id = uuid();
  db.prepare(`INSERT INTO documents (id, org_id, entity_type, entity_id, title, pdf_path, status, created_by)
    VALUES (?,?,?,?,?,?,'pending',?)`).run(id, req.user.org_id, entity_type, entity_id, title || 'Agreement', pdfPath, req.user.id);
  res.status(201).json({ document: db.prepare('SELECT * FROM documents WHERE id = ?').get(id) });
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

  const signUrl = `${process.env.APP_URL || ''}/sign-document.html?token=${token}`;
  const subject = `${document.title || 'Document'} ready to sign: ${entity.displayName}`;
  const body = `<p>Shalom,</p><p>Please review and sign the following document: <strong>${document.title || 'Agreement'}</strong>.</p>
    <p style="text-align:center;margin:28px 0;"><a href="${signUrl}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Review & Sign</a></p>
    <p>If the button doesn't work, copy this link: ${signUrl}</p>`;
  const { emailError } = await sendMailChecked(req.user.org_id, to, subject, body);
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
  res.json({ document, entityName: entity?.displayName || '' });
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
  const { signature_data, signer_name, signer_title } = req.body || {};
  if (!signer_name || !signature_data) return res.status(400).json({ error: 'Signature and signer name are required' });

  const signedAt = new Date().toISOString();
  const signedPath = await stampSignature({
    unsignedPath: document.pdf_path, shulId: `${document.entity_type}-${document.entity_id}`,
    signatureDataUrl: signature_data, signerName: signer_name, signedAt, ip: req.ip,
    box: getSignatureBox(document.org_id, document.entity_type),
  });
  db.prepare(`UPDATE documents SET status='signed', signature_data=?, signer_name=?, signer_title=?, signed_at=?, ip_address=?, signed_pdf_path=? WHERE id=?`)
    .run(signature_data, signer_name, signer_title || '', signedAt, req.ip, signedPath, document.id);
  res.json({ ok: true, message: 'Document signed. Thank you.' });
});

export default router;
