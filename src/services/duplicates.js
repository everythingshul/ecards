import { db, uuid } from '../db.js';

const norm = (s) => (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');

// Freezes both the newly-created record's owning account AND the matched record's
// owning account (per spec: "pause both accounts from doing any action or using
// the card until the duplicate is fixed or bypassed").
function pauseAccountsFor(entityType, entityId, matchedId) {
  if (entityType === 'shul') {
    db.prepare('UPDATE shuls SET is_paused = 1 WHERE id IN (?, ?)').run(entityId, matchedId);
    db.prepare(`UPDATE users SET is_paused = 1 WHERE shul_id IN (?, ?)`).run(entityId, matchedId);
  } else {
    db.prepare('UPDATE applicants SET is_paused = 1 WHERE id IN (?, ?)').run(entityId, matchedId);
    // Applicants don't log in directly, but pause their card use.
    db.prepare(`UPDATE cards SET status = 'deactivated' WHERE applicant_id IN (?, ?) AND status != 'deactivated'`).run(entityId, matchedId);
  }
}

// Checks a shul against existing shuls in the same org (any season — "shouldn't
// need to upload everyone again", so duplicates are detected across seasons too).
// Matches on: normalized name+city, or same Rav phone, or same Gabai email.
// excludeIds lets a caller rule out a specific candidate that's known to be
// the same record on purpose (e.g. carry-forward's own source shul, which
// necessarily matches every field of the row it just generated) rather than
// a genuine second entry of the same real-world shul.
export function checkShulDuplicate(orgId, shul, excludeIds = []) {
  const ids = [shul.id, ...excludeIds];
  const candidates = db.prepare(`SELECT * FROM shuls WHERE org_id = ? AND id NOT IN (${ids.map(() => '?').join(',')})`).all(orgId, ...ids);
  for (const c of candidates) {
    let reason = null;
    if (norm(c.name_en) === norm(shul.name_en) && norm(c.city) === norm(shul.city) && norm(shul.name_en)) reason = 'Same shul name + city';
    else if (shul.ruv_phone && norm(c.ruv_phone) === norm(shul.ruv_phone)) reason = 'Same Rav phone number';
    else if (shul.gabai_email && norm(c.gabai_email) === norm(shul.gabai_email)) reason = 'Same Gabai email';
    if (reason) return { matchedId: c.id, reason };
  }
  return null;
}

// A full first+last name match is a duplicate on its own — no longer
// requires a matching zip too — and so is a match on any single phone
// number (home, husband cell, or wife cell), the email address, or the
// full mailing address (street+city+state+zip together, not just zip
// alone — two applicants sharing a zip code isn't meaningful, but sharing
// an actual street address is).
const fullAddress = (a) => norm([a.address, a.city, a.state, a.zip].filter(Boolean).join('|'));
// Scoped to the applicant's own season, unlike checkShulDuplicate above —
// a shul only exists once and reuses the same row across seasons via
// carry-forward, so matching it against its own past self would be a false
// positive worth catching; an applicant legitimately reapplies fresh every
// season (a new row each time), so matching last season's version of the
// same person is expected, normal behavior, not a duplicate.
export function checkApplicantDuplicate(orgId, applicant) {
  const candidates = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ? AND id != ?`).all(orgId, applicant.season_id, applicant.id);
  const applicantAddress = fullAddress(applicant);
  for (const c of candidates) {
    let reason = null;
    const sameName = norm(applicant.first_name) && norm(applicant.last_name)
      && norm(c.first_name) === norm(applicant.first_name) && norm(c.last_name) === norm(applicant.last_name);
    if (sameName) reason = 'Same first and last name';
    else if (applicant.home_phone && norm(c.home_phone) === norm(applicant.home_phone)) reason = 'Same home phone number';
    else if (applicant.husband_cell && norm(c.husband_cell) === norm(applicant.husband_cell)) reason = 'Same husband cell number';
    else if (applicant.wife_cell && norm(c.wife_cell) === norm(applicant.wife_cell)) reason = 'Same wife cell number';
    else if (applicant.email && norm(c.email) === norm(applicant.email)) reason = 'Same email address';
    else if (applicant.address && applicantAddress === fullAddress(c)) reason = 'Same address';
    if (reason) return { matchedId: c.id, reason };
  }
  return null;
}

// Runs the appropriate check, and if found: flags it, pauses both accounts, returns the flag row.
// If not found: returns null and leaves the record active. excludeIds (shul only,
// see checkShulDuplicate) lets a caller rule out a record known to be the same
// entity on purpose, like carry-forward's own source shul.
export function detectAndFlag(orgId, entityType, entity, excludeIds = []) {
  const match = entityType === 'shul' ? checkShulDuplicate(orgId, entity, excludeIds) : checkApplicantDuplicate(orgId, entity);
  if (!match) return null;
  const id = uuid();
  db.prepare(`INSERT INTO duplicate_flags (id, org_id, entity_type, entity_id, matched_entity_id, reason, status)
    VALUES (?,?,?,?,?,?,'open')`).run(id, orgId, entityType, entity.id, match.matchedId, match.reason);
  if (entityType === 'shul') db.prepare(`UPDATE shuls SET duplicate_status = 'flagged', duplicate_of_shul_id = ? WHERE id = ?`).run(match.matchedId, entity.id);
  else db.prepare(`UPDATE applicants SET duplicate_status = 'flagged', duplicate_of_applicant_id = ? WHERE id = ?`).run(match.matchedId, entity.id);
  pauseAccountsFor(entityType, entity.id, match.matchedId);
  return db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(id);
}

// Admin resolves: 'bypass' clears the flag but leaves both records as-is (paused
// records get un-paused); 'merge_keep_existing' removes the new/duplicate record's
// pause and marks it resolved after the admin has manually reconciled data.
export function resolveFlag(flagId, resolvedByUserId, action) {
  const flag = db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId);
  if (!flag) return null;
  db.prepare(`UPDATE duplicate_flags SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`)
    .run(action === 'bypass' ? 'bypassed' : 'resolved', resolvedByUserId, flagId);
  if (flag.entity_type === 'shul') {
    db.prepare('UPDATE shuls SET is_paused = 0, duplicate_status = ? WHERE id IN (?, ?)')
      .run(action === 'bypass' ? 'bypassed' : 'resolved', flag.entity_id, flag.matched_entity_id);
    db.prepare(`UPDATE users SET is_paused = 0 WHERE shul_id IN (?, ?)`).run(flag.entity_id, flag.matched_entity_id);
  } else {
    db.prepare('UPDATE applicants SET is_paused = 0, duplicate_status = ? WHERE id IN (?, ?)')
      .run(action === 'bypass' ? 'bypassed' : 'resolved', flag.entity_id, flag.matched_entity_id);
  }
  return db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId);
}
