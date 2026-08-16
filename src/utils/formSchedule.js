import { db } from '../db.js';

// Every form type's non-negotiable minimum field set — required regardless
// of which form is currently the live default for that section (see
// is_current_default below). Mirrors what each section's own dedicated
// public route already enforces by hand (shuls.js POST /apply's
// REQUIRED_SHUL_FIELDS, stores.js POST /apply, applicants.js POST
// /apply-ezras-habayis) — kept here too so routes/forms.js's
// PUT /:id/set-default can check a candidate form's schema against it
// *before* switching the live section over to it, instead of only finding
// out a required field is missing when a real submission fails.
export const REQUIRED_MINIMUM_FIELDS = {
  shul_application: ['name_en', 'address', 'ruv_first_name', 'ruv_last_name', 'ruv_phone', 'gabai_first_name', 'gabai_last_name', 'gabai_cell', 'gabai_email'],
  store_application: ['name', 'owner_email'],
  applicant_application: ['first_name', 'last_name'],
};

// Looks up the scheduling/active state for whichever form is CURRENTLY the
// live default for a section (shul_application/store_application/
// applicant_application — see forms.is_current_default, set via
// routes/forms.js PUT /:id/set-default) — not a specific pinned row, so
// switching which form is "the" one for a section takes effect here
// automatically. These built-in pages (apply.html, apply-store.html,
// apply-ezras-habayis.html) submit through their own dedicated routes
// (shuls.js POST /apply, etc.), not the generic form builder's /submit —
// this is purely how admins schedule/toggle/switch them from the same Form
// Builder UI used for custom forms, without a separate screen.
export function getFormWindow(orgId, type) {
  return db.prepare('SELECT is_active, opens_at, closes_at FROM forms WHERE org_id = ? AND type = ? AND is_current_default = 1').get(orgId, type);
}

// Which season a submission through this form should land in — the season
// pinned to the form itself, not whichever season happens to be "active"
// right now (a link someone already has open shouldn't silently start
// landing in a different season if the active one changes underneath it).
// Falls back to the current active season only if the form row is somehow
// missing or has no season pinned yet (e.g. a fresh env before the seed/
// backfill migration in db.js has run) — a missing link must never block a
// real submission outright.
export function getFormSeasonId(orgId, type) {
  const form = db.prepare('SELECT season_id FROM forms WHERE org_id = ? AND type = ? AND is_current_default = 1').get(orgId, type);
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
