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
