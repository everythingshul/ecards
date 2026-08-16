import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireRole } from '../middleware/auth.js';
import { assign, unassign } from '../middleware/permissions.js';
import { sendMailChecked, renderSystemTemplate } from '../services/mail.js';
import { normalizePhone } from '../utils/phone.js';

const router = Router();
const RESOURCES = ['dashboard', 'shuls', 'applicants', 'cards', 'stores', 'forms', 'users', 'settings'];

// A person/account is exactly one of: an internal team member (staff/
// org_admin/super_admin) or a portal login (shul/store) — never both, and
// never switchable from one family to the other via this route. Portal
// accounts are only ever created by the shul/store approval flows
// (routes/shuls.js, routes/stores.js), never through Users & Permissions.
const INTERNAL_ROLES = ['staff', 'org_admin', 'super_admin'];
const PORTAL_ROLES = ['shul', 'store'];

router.use(auth, requireRole('super_admin', 'org_admin'));

// Internal team members only — shul/store portal accounts are managed from
// the Shuls/Stores pages themselves, not here (see INTERNAL_ROLES above).
router.get('/', (req, res) => {
  const users = db.prepare(`SELECT id, email, first_name, last_name, phone, role, is_active, is_paused, last_login_at, created_at FROM users WHERE org_id = ? AND role IN ('staff','org_admin','super_admin') ORDER BY created_at DESC`).all(req.user.org_id);
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
  if (!INTERNAL_ROLES.includes(role)) return res.status(400).json({ error: `Invalid role: ${role}. Shul/store accounts are created from the shul/store approval flow, not here.` });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'A user with this email already exists' });
  const id = uuid();
  const token = uuid();
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO users (id, org_id, email, first_name, last_name, phone, role, invite_token, invite_expires, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,0)`).run(id, req.user.org_id, String(email).trim().toLowerCase(), first_name, last_name || '', normalizePhone(phone || ''), role, token, expires);
  for (const p of permissions) upsertPermission(id, p);
  const inviteUrl = `${process.env.APP_URL || ''}/accept-invite.html?token=${token}`;
  const tmpl = renderSystemTemplate(req.user.org_id, 'userInvite', { role: role.replace('_', ' '), inviteUrl });
  const { emailError } = await sendMailChecked(req.user.org_id, email, tmpl.subject, tmpl.body);
  if (emailError) console.error('[mail] user invite email failed:', emailError);
  res.status(201).json({ user: db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id), emailError });
});

router.put('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const { first_name, last_name, phone, role, is_active, permissions, assignments } = req.body || {};
  if (role !== undefined && role !== user.role) {
    if (PORTAL_ROLES.includes(user.role) || PORTAL_ROLES.includes(role)) {
      return res.status(400).json({ error: 'A shul/store portal account cannot be changed to or from an internal team role. Manage the shul/store record itself instead.' });
    }
    if (!INTERNAL_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role: ${role}` });
    }
  }
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

// Permanent deletion — distinct from the deactivate above. Blocked for your
// own account (avoid accidental self-lockout) and for the org's last
// super_admin (avoid an org with nobody able to manage it). Every other
// table's reference to this user is cleared first (permissions/assignments
// deleted outright since they're meaningless without the user; every other
// "who did this" column — notes, sent emails/sms, approvals, task
// assignment, portal_user_id on a shul/store, etc. — is set to NULL so the
// underlying record and its history survive).
router.delete('/:id/permanent', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (user.role === 'super_admin') {
    const otherSuperAdmins = db.prepare(`SELECT COUNT(*) c FROM users WHERE org_id = ? AND role = 'super_admin' AND id != ? AND is_active = 1`).get(req.user.org_id, user.id).c;
    if (!otherSuperAdmins) return res.status(400).json({ error: 'Cannot delete the last active super admin' });
  }
  const nullOut = (table, column) => db.prepare(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = ?`).run(user.id);
  db.prepare('DELETE FROM permissions WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM user_assignments WHERE user_id = ?').run(user.id);
  nullOut('shuls', 'portal_user_id');
  nullOut('shul_notes', 'user_id');
  nullOut('season_notes', 'user_id');
  nullOut('documents', 'created_by');
  nullOut('emails_sent', 'sent_by');
  nullOut('email_templates', 'created_by');
  nullOut('sms_messages', 'sent_by');
  nullOut('sms_templates', 'created_by');
  nullOut('updates', 'created_by');
  nullOut('applicants', 'approved_by');
  nullOut('applicant_notes', 'user_id');
  nullOut('stores', 'portal_user_id');
  nullOut('import_jobs', 'created_by');
  nullOut('duplicate_flags', 'resolved_by');
  nullOut('tasks', 'assigned_to');
  nullOut('tasks', 'created_by');
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
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
