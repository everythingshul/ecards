import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { sendMailChecked } from '../services/mail.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });
const UPDATES_DIR = join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'updates');

router.use(auth);

// Resolves a recipient list (explicit entities and/or whole groups) down to
// a deduped [{entity_type, entity_id, label, email}] array. Locked system
// shuls (e.g. Ezras Habayis) are never valid recipients — same reasoning as
// the Ezras Habayis shul being excluded from the shul picker.
function resolveRecipients(orgId, { recipients = [], groups = [] }) {
  const out = new Map();
  for (const r of recipients) {
    if (r.entity_type === 'shul') {
      const s = db.prepare('SELECT id, name_en, gabai_email FROM shuls WHERE id = ? AND org_id = ? AND is_locked = 0').get(r.entity_id, orgId);
      if (s) out.set(`shul:${s.id}`, { entity_type: 'shul', entity_id: s.id, label: s.name_en, email: s.gabai_email });
    } else if (r.entity_type === 'store') {
      const s = db.prepare('SELECT id, name, manager_email, owner_email FROM stores WHERE id = ? AND org_id = ?').get(r.entity_id, orgId);
      if (s) out.set(`store:${s.id}`, { entity_type: 'store', entity_id: s.id, label: s.name, email: s.manager_email || s.owner_email });
    }
  }
  if (groups.includes('all_shuls')) {
    for (const s of db.prepare('SELECT id, name_en, gabai_email FROM shuls WHERE org_id = ? AND is_locked = 0').all(orgId)) {
      out.set(`shul:${s.id}`, { entity_type: 'shul', entity_id: s.id, label: s.name_en, email: s.gabai_email });
    }
  }
  if (groups.includes('all_stores')) {
    for (const s of db.prepare('SELECT id, name, manager_email, owner_email FROM stores WHERE org_id = ?').all(orgId)) {
      out.set(`store:${s.id}`, { entity_type: 'store', entity_id: s.id, label: s.name, email: s.manager_email || s.owner_email });
    }
  }
  return [...out.values()];
}

// ============================= Admin: compose/send =============================
router.get('/', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM updates WHERE org_id = ? ORDER BY created_at DESC').all(req.user.org_id);
  const withCounts = rows.map(u => {
    const c = db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) read FROM update_recipients WHERE update_id = ?').get(u.id);
    return { ...u, attachments: JSON.parse(u.attachments_json || '[]'), recipient_count: c.total, read_count: c.read || 0 };
  });
  res.json({ updates: withCounts });
});

router.get('/:id', requireAdmin, (req, res) => {
  const update = db.prepare('SELECT * FROM updates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!update) return res.status(404).json({ error: 'Not found' });
  const recipients = db.prepare('SELECT * FROM update_recipients WHERE update_id = ? ORDER BY created_at').all(update.id);
  res.json({ update: { ...update, attachments: JSON.parse(update.attachments_json || '[]') }, recipients });
});

router.post('/', requireAdmin, upload.array('files', 10), async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
  let recipientSpec;
  try { recipientSpec = JSON.parse(req.body.recipients || '{}'); } catch { return res.status(400).json({ error: 'Invalid recipients payload' }); }
  const targets = resolveRecipients(req.user.org_id, recipientSpec);
  if (!targets.length) return res.status(400).json({ error: 'No valid recipients selected' });

  const id = uuid();
  const attachments = (req.files || []).map(f => {
    const safeName = `${id}-${f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    writeFileSync(join(UPDATES_DIR, safeName), f.buffer);
    return { filename: f.originalname, path: safeName, mime_type: f.mimetype };
  });

  db.prepare(`INSERT INTO updates (id, org_id, title, body, attachments_json, created_by) VALUES (?,?,?,?,?,?)`)
    .run(id, req.user.org_id, title, body, JSON.stringify(attachments), req.user.id);

  // Images go inline as their own paragraph (what they'll actually look
  // like in the email/portal); non-images (PDFs etc.) stay as a link list.
  const imageAttachments = attachments.filter(a => a.mime_type.startsWith('image/'));
  const fileAttachments = attachments.filter(a => !a.mime_type.startsWith('image/'));
  const imagesHtml = imageAttachments.map(a => `<p><img src="${process.env.APP_URL || ''}/uploads/updates/${a.path}" alt="${a.filename}" style="max-width:100%;height:auto;"></p>`).join('');
  const fileLinks = fileAttachments.map(a => `<li><a href="${process.env.APP_URL || ''}/uploads/updates/${a.path}">${a.filename}</a></li>`).join('');
  const bodyHtml = `<p>${String(body).replace(/\n/g, '<br>')}</p>${imagesHtml}${fileAttachments.length ? `<p><strong>Attachments:</strong></p><ul>${fileLinks}</ul>` : ''}`;

  let sentCount = 0, failedCount = 0;
  for (const t of targets) {
    const recId = uuid();
    let emailStatus = 'sent', emailError = null;
    if (t.email) {
      const result = await sendMailChecked(req.user.org_id, t.email, title, bodyHtml, { relatedEntityType: t.entity_type, relatedEntityId: t.entity_id, sentBy: req.user.id });
      if (result.emailError) { emailStatus = 'failed'; emailError = result.emailError; }
    } else {
      emailStatus = 'failed'; emailError = 'No email on file';
    }
    if (emailStatus === 'failed') failedCount++; else sentCount++;
    db.prepare(`INSERT INTO update_recipients (id, update_id, entity_type, entity_id, email_status, email_error) VALUES (?,?,?,?,?,?)`)
      .run(recId, id, t.entity_type, t.entity_id, emailStatus, emailError);
  }

  res.status(201).json({ update: db.prepare('SELECT * FROM updates WHERE id = ?').get(id), recipientCount: targets.length, sentCount, failedCount });
});

// ============================= Portal: inbox =============================
function portalEntity(user) {
  if (user.role === 'shul' && user.shul_id) return { entity_type: 'shul', entity_id: user.shul_id };
  if (user.role === 'store' && user.store_id) return { entity_type: 'store', entity_id: user.store_id };
  return null;
}

router.get('/inbox/mine', (req, res) => {
  const entity = portalEntity(req.user);
  if (!entity) return res.status(403).json({ error: 'Not a shul or store portal account' });
  const rows = db.prepare(`SELECT ur.id AS recipient_id, ur.read_at, u.* FROM update_recipients ur JOIN updates u ON u.id = ur.update_id
    WHERE ur.entity_type = ? AND ur.entity_id = ? ORDER BY u.created_at DESC`).all(entity.entity_type, entity.entity_id);
  res.json({ updates: rows.map(r => ({ ...r, attachments: JSON.parse(r.attachments_json || '[]') })) });
});

router.get('/inbox/unread-count', (req, res) => {
  const entity = portalEntity(req.user);
  if (!entity) return res.json({ count: 0 });
  const c = db.prepare(`SELECT COUNT(*) c FROM update_recipients WHERE entity_type = ? AND entity_id = ? AND read_at IS NULL`).get(entity.entity_type, entity.entity_id);
  res.json({ count: c.c });
});

router.post('/inbox/:recipientId/read', (req, res) => {
  const entity = portalEntity(req.user);
  if (!entity) return res.status(403).json({ error: 'Not a shul or store portal account' });
  const row = db.prepare('SELECT * FROM update_recipients WHERE id = ? AND entity_type = ? AND entity_id = ?').get(req.params.recipientId, entity.entity_type, entity.entity_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.read_at) db.prepare(`UPDATE update_recipients SET read_at = datetime('now') WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

export default router;
