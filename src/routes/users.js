import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireRole } from '../middleware/auth.js';
import { assign, unassign } from '../middleware/permissions.js';
import { sendMailChecked } from '../services/mail.js';
import { normalizePhone } from '../utils/phone.js';

const router = Router();
const RESOURCES = ['dashboard', 'shuls', 'applicants', 'cards', 'stores', 'forms', 'users', 'settings'];

router.use(auth, requireRole('super_admin', 'org_admin'));

router.get('/', (req, res) => {
  const users = db.prepare(`SELECT id, email, first_name, last_name, phone, role, is_active, is_paused, last_login_at, created_at FROM users WHERE org_id = ? ORDER BY created_at DESC`).all(req.user.org_id);
  res.json({ users });
});

router.get('/:id', (req, res) => {
  const user = db.prepare('SELECT id, email, first_name, last_name, phone, role, is_active, is_paused FROM users WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const perms = db.prepare('SELECT * FROM permissions WHERE user_id = ?').all(user.id).map(p => ({ ...p, hidden_fields: JSON.parse(p.hidden_fields || '[]') }));
  const assignments = db.prepare('SELECT * FROM user_assignments WHERE user_id = ?').all(user.id);
  res.json({ user, permissions: perms, assignments });
});

// Invite a new internal user with a role + optional per-resource permission overrides.
router.post('/', async (req, res) => {
  const { email, first_name, last_name, phone, role = 'staff', permissions = [] } = req.body || {};
  if (!email || !first_name) return res.status(400).json({ error: 'Email and first name are required' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'A user with this email already exists' });
  const id = uuid();
  const token = uuid();
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO users (id, org_id, email, first_name, last_name, phone, role, invite_token, invite_expires, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,0)`).run(id, req.user.org_id, String(email).trim().toLowerCase(), first_name, last_name || '', normalizePhone(phone || ''), role, token, expires);
  for (const p of permissions) upsertPermission(id, p);
  const inviteUrl = `${process.env.APP_URL || ''}/accept-invite.html?token=${token}`;
  const { emailError } = await sendMailChecked(req.user.org_id, email, "You've been invited", `<p>You've been invited as <strong>${role.replace('_', ' ')}</strong>. Set your password to get started:</p><p><a href="${inviteUrl}">${inviteUrl}</a></p>`);
  if (emailError) console.error('[mail] user invite email failed:', emailError);
  res.status(201).json({ user: db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id), emailError });
});

router.put('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const { first_name, last_name, phone, role, is_active, permissions, assignments } = req.body || {};
  db.prepare(`UPDATE users SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), phone = COALESCE(?, phone), role = COALESCE(?, role), is_active = COALESCE(?, is_active) WHERE id = ?`)
    .run(first_name, last_name, phone === undefined ? undefined : normalizePhone(phone), role, is_active === undefined ? undefined : (is_active ? 1 : 0), user.id);
  if (Array.isArray(permissions)) {
    for (const p of permissions) upsertPermission(user.id, p);
  }
  if (Array.isArray(assignments)) {
    db.prepare('DELETE FROM user_assignments WHERE user_id = ?').run(user.id);
    for (const a of assignments) assign(user.id, a.entity_type, a.entity_id);
  }
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

function upsertPermission(userId, p) {
  if (!RESOURCES.includes(p.resource)) return;
  const existing = db.prepare('SELECT id FROM permissions WHERE user_id = ? AND resource = ?').get(userId, p.resource);
  const hidden = JSON.stringify(p.hidden_fields || []);
  if (existing) {
    db.prepare(`UPDATE permissions SET can_view=?, can_edit=?, can_export=?, hidden_fields=?, scope=? WHERE id=?`)
      .run(p.can_view ? 1 : 0, p.can_edit ? 1 : 0, p.can_export ? 1 : 0, hidden, p.scope || 'all', existing.id);
  } else {
    db.prepare(`INSERT INTO permissions (id, user_id, resource, can_view, can_edit, can_export, hidden_fields, scope) VALUES (?,?,?,?,?,?,?,?)`)
      .run(uuid(), userId, p.resource, p.can_view ? 1 : 0, p.can_edit ? 1 : 0, p.can_export ? 1 : 0, hidden, p.scope || 'all');
  }
}

export default router;
