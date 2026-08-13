import { db, uuid } from '../db.js';

// Role defaults used when a user has no explicit `permissions` row for a resource.
// super_admin/org_admin/staff get full access by default; shul/store portal users
// are locked to their own record via scope handling in the routes themselves.
const ROLE_DEFAULTS = {
  super_admin: { can_view: 1, can_edit: 1, can_export: 1, hidden_fields: [], scope: 'all' },
  org_admin:   { can_view: 1, can_edit: 1, can_export: 1, hidden_fields: [], scope: 'all' },
  staff:       { can_view: 1, can_edit: 0, can_export: 0, hidden_fields: [], scope: 'all' },
  shul:        { can_view: 1, can_edit: 1, can_export: 0, hidden_fields: [], scope: 'assigned' },
  store:       { can_view: 1, can_edit: 0, can_export: 0, hidden_fields: [], scope: 'assigned' },
};

export function getPermission(user, resource) {
  if (user.role === 'super_admin') return { can_view: 1, can_edit: 1, can_export: 1, hidden_fields: [], scope: 'all' };
  const row = db.prepare('SELECT * FROM permissions WHERE user_id = ? AND resource = ?').get(user.id, resource);
  if (!row) return ROLE_DEFAULTS[user.role] || { can_view: 0, can_edit: 0, can_export: 0, hidden_fields: [], scope: 'assigned' };
  return { ...row, hidden_fields: JSON.parse(row.hidden_fields || '[]') };
}

// Route guard: 403s unless the user can at least view the resource.
export function requirePermission(resource, action = 'can_view') {
  return (req, res, next) => {
    const perm = getPermission(req.user, resource);
    if (!perm[action]) return res.status(403).json({ error: `You do not have ${action.replace('can_', '')} access to ${resource}` });
    req.permission = perm;
    next();
  };
}

// Strip hidden fields from a record (or array of records) before sending to the client.
export function redact(records, hiddenFields) {
  if (!hiddenFields || !hiddenFields.length) return records;
  const strip = (rec) => {
    const copy = { ...rec };
    for (const f of hiddenFields) delete copy[f];
    return copy;
  };
  return Array.isArray(records) ? records.map(strip) : strip(records);
}

// True if a scope='assigned' user is allowed to touch this specific entity.
export function isAssigned(userId, entityType, entityId) {
  return !!db.prepare('SELECT 1 FROM user_assignments WHERE user_id = ? AND entity_type = ? AND entity_id = ?')
    .get(userId, entityType, entityId);
}

export function assign(userId, entityType, entityId) {
  const exists = isAssigned(userId, entityType, entityId);
  if (!exists) db.prepare('INSERT INTO user_assignments (id, user_id, entity_type, entity_id) VALUES (?,?,?,?)')
    .run(uuid(), userId, entityType, entityId);
}

export function unassign(userId, entityType, entityId) {
  db.prepare('DELETE FROM user_assignments WHERE user_id = ? AND entity_type = ? AND entity_id = ?').run(userId, entityType, entityId);
}
