import { db } from '../db.js';

// Looks up the scheduling/active state for one of the built-in public forms
// (shul/store/Ezras-Habayis application) by its fixed slug, or any
// custom-built form. These built-in pages submit through their own
// dedicated routes (shuls.js POST /apply, etc.), not the generic form
// builder's /submit — this is purely how admins schedule/toggle them from
// the same Form Builder UI used for custom forms, without a separate screen.
export function getFormWindow(orgId, slug) {
  return db.prepare('SELECT is_active, opens_at, closes_at FROM forms WHERE org_id = ? AND slug = ?').get(orgId, slug);
}

// Which season a submission through this form should land in — the season
// pinned to the form itself, not whichever season happens to be "active"
// right now (a link someone already has open shouldn't silently start
// landing in a different season if the active one changes underneath it).
// Falls back to the current active season only if the form row is somehow
// missing or has no season pinned yet (e.g. a fresh env before the seed/
// backfill migration in db.js has run) — a missing link must never block a
// real submission outright.
export function getFormSeasonId(orgId, slug) {
  const form = db.prepare('SELECT season_id FROM forms WHERE org_id = ? AND slug = ?').get(orgId, slug);
  if (form?.season_id) return form.season_id;
  const active = db.prepare('SELECT id FROM seasons WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(orgId);
  return active?.id || null;
}

// No row yet (e.g. a fresh env before the seed migration has run) is treated
// as always-open — a missing schedule record must never lock real applicants
// out of a form that's supposed to just work.
export function formWindowError(form) {
  if (!form) return null;
  if (!form.is_active) return 'This application is not currently being accepted.';
  const now = new Date();
  if (form.opens_at && now < new Date(form.opens_at)) return `Applications open ${new Date(form.opens_at).toLocaleDateString()}.`;
  if (form.closes_at && now > new Date(form.closes_at)) return 'Applications for this are now closed.';
  return null;
}
