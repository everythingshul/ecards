import { db, uuid } from '../db.js';

const norm = (s) => (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');

// Fields an admin can pick a per-field winner for when merging a confirmed
// applicant duplicate (see mergeApplicants below) — real identity/contact/
// demographic data only, not status/shul/source/system fields, which aren't
// something to "merge" (each member keeps its own shul_id, approval_status,
// etc. — only the primary's copy of these actual data fields changes).
const MERGE_FIELDS = ['first_name', 'last_name', 'marital_status', 'home_phone', 'husband_cell', 'wife_cell', 'email',
  'address', 'city', 'state', 'zip', 'preferred_contact_method', 'preferred_number', 'num_children', 'home_for_yomtov',
  'comments', 'card_amount'];

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

// Which fields count as "a phone number" for the never-bypass-if-matched
// rule below — checked as a set against a set, so a cell on one side
// matching the OTHER side's home phone (not just the same field) still
// counts; only an actual phone-to-phone match blocks bypass, never an
// address/name coincidence.
const PHONE_FIELDS = ['home_phone', 'husband_cell', 'wife_cell'];
function phoneSet(a) { return new Set(PHONE_FIELDS.map(f => norm(a[f])).filter(Boolean)); }
export function applicantsSharePhone(a, b) {
  const setA = phoneSet(a);
  for (const p of phoneSet(b)) if (setA.has(p)) return true;
  return false;
}

// Admin resolves an applicant duplicate flag one of two ways:
//  - bypass: these are actually two different people who happened to share
//    one non-phone detail (address, name, ...) — un-pauses both, leaves
//    both records exactly as they are. Refused outright if the two records
//    share an actual phone number — that's never a coincidence, so bypass
//    isn't offered as an option; mergeApplicants() below is the only path.
//  - shul duplicates (entity_type 'shul') keep the original simple
//    bypass/resolve behavior — shuls are a single persistent record per
//    real shul, not something that spans multiple "accounts" the way an
//    applicant can span several shuls, so there's no merge concept for them.
export function resolveFlag(flagId, resolvedByUserId, action) {
  const flag = db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId);
  if (!flag) return null;
  if (flag.status !== 'open') throw new Error('This flag was already resolved');
  if (flag.entity_type === 'applicant') {
    if (action !== 'bypass') throw new Error('Applicant duplicates can only be bypassed here — resolving one as the same person is done through the merge action instead');
    const a = db.prepare('SELECT * FROM applicants WHERE id = ?').get(flag.entity_id);
    const b = db.prepare('SELECT * FROM applicants WHERE id = ?').get(flag.matched_entity_id);
    if (a && b && applicantsSharePhone(a, b)) throw new Error('These records share a phone number, so they can\'t be bypassed as different people — resolve this as a merge instead.');
    db.prepare(`UPDATE duplicate_flags SET status = 'bypassed', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`).run(resolvedByUserId, flagId);
    db.prepare('UPDATE applicants SET is_paused = 0, duplicate_status = ? WHERE id IN (?, ?)').run('bypassed', flag.entity_id, flag.matched_entity_id);
    return db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId);
  }
  db.prepare(`UPDATE duplicate_flags SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`)
    .run(action === 'bypass' ? 'bypassed' : 'resolved', resolvedByUserId, flagId);
  db.prepare('UPDATE shuls SET is_paused = 0, duplicate_status = ? WHERE id IN (?, ?)')
    .run(action === 'bypass' ? 'bypassed' : 'resolved', flag.entity_id, flag.matched_entity_id);
  db.prepare(`UPDATE users SET is_paused = 0 WHERE shul_id IN (?, ?)`).run(flag.entity_id, flag.matched_entity_id);
  return db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId);
}

// Finds every applicant that's part of the same real-world-person cluster as
// any of `startIds` — a duplicate isn't always just a pair; the same family
// can get submitted by three, four, five different shuls in one season.
// Chains through open flags (a flag A<->B plus a separate flag B<->C
// surfaces A, B, and C together) and through any merge_group_id an id
// already carries (so flagging a new 5th shul's applicant against one
// member of an already-merged group pulls in the whole existing group).
export function getMergeGroupIds(orgId, startIds) {
  const ids = new Set(startIds);
  let grew = true;
  while (grew) {
    grew = false;
    const list = [...ids];
    const placeholders = list.map(() => '?').join(',');
    const groupRows = db.prepare(`SELECT merge_group_id FROM applicants WHERE id IN (${placeholders}) AND merge_group_id IS NOT NULL`).all(...list);
    const groupIds = [...new Set(groupRows.map(r => r.merge_group_id))];
    if (groupIds.length) {
      const gp = groupIds.map(() => '?').join(',');
      for (const m of db.prepare(`SELECT id FROM applicants WHERE merge_group_id IN (${gp})`).all(...groupIds)) {
        if (!ids.has(m.id)) { ids.add(m.id); grew = true; }
      }
    }
    for (const f of db.prepare(`SELECT entity_id, matched_entity_id FROM duplicate_flags
        WHERE org_id = ? AND entity_type='applicant' AND status='open' AND (entity_id IN (${placeholders}) OR matched_entity_id IN (${placeholders}))`)
        .all(orgId, ...list, ...list)) {
      if (!ids.has(f.entity_id)) { ids.add(f.entity_id); grew = true; }
      if (!ids.has(f.matched_entity_id)) { ids.add(f.matched_entity_id); grew = true; }
    }
  }
  return [...ids];
}

// Forced resolution for an applicant duplicate: admin has confirmed these
// really are the same person across however many shuls submitted them.
// `values` is the admin's chosen composite (per-field, mixed and matched
// from whichever member's data is correct) — written onto the primary
// record only; every other member's own row is left completely untouched,
// so each shul still sees exactly what THEY submitted (shul-blind, per
// spec — a shul only ever sees its own applicant, never that the same
// person is enrolled elsewhere). Every member gets merge_group_id set to
// the primary's id (== how a "is this the primary" check works elsewhere),
// duplicate_status='merged', and unpaused. Every open flag connecting two
// members of the resolved group is marked resolved.
export function mergeApplicants(orgId, userId, { primaryId, values } = {}) {
  if (!primaryId) throw new Error('primaryId is required');
  const groupIds = getMergeGroupIds(orgId, [primaryId]);
  const placeholders = groupIds.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM applicants WHERE id IN (${placeholders}) AND org_id = ?`).all(...groupIds, orgId);
  if (members.length < 2) throw new Error('Need at least two related records to merge');
  if (!members.some(m => m.id === primaryId)) throw new Error('Primary record not found in this group');

  const sets = Object.keys(values || {}).filter(k => MERGE_FIELDS.includes(k));
  const setSql = sets.length ? `, ${sets.map(k => `${k} = ?`).join(', ')}` : '';
  db.prepare(`UPDATE applicants SET merge_group_id = ?, duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now')${setSql} WHERE id = ?`)
    .run(primaryId, ...sets.map(k => values[k]), primaryId);
  for (const m of members) {
    if (m.id === primaryId) continue;
    db.prepare(`UPDATE applicants SET merge_group_id = ?, duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now') WHERE id = ?`).run(primaryId, m.id);
  }
  const flagIds = db.prepare(`SELECT id FROM duplicate_flags WHERE org_id = ? AND entity_type='applicant' AND status='open'
      AND entity_id IN (${placeholders}) AND matched_entity_id IN (${placeholders})`).all(orgId, ...groupIds, ...groupIds).map(r => r.id);
  if (flagIds.length) {
    const fp = flagIds.map(() => '?').join(',');
    db.prepare(`UPDATE duplicate_flags SET status='resolved', resolved_by=?, resolved_at=datetime('now') WHERE id IN (${fp})`).run(userId, ...flagIds);
  }
  return { primaryId, memberIds: groupIds };
}
