// Reverse lookup: given a phone number or email address as it appears on an
// SMS/email log row, find which account it belongs to (shul, store,
// applicant, or staff user). Powers the "Account" column in the SMS/Email
// Center logs — useful because inbound messages and group/broadcast sends
// don't carry a related_entity_type/id the way a single entity-triggered
// send does, so that column alone can't answer "who is this."
//
// Matches against the same normalized phone format normalizePhone() writes
// everywhere else (see db.js's normalizePhoneColumn migration), so this
// works against existing data without a backfill.
import { db } from '../db.js';
import { normalizePhone } from './phone.js';

export function findAccountByPhone(orgId, rawPhone) {
  if (!rawPhone) return null;
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;

  const shul = db.prepare(`SELECT id, name_en AS label FROM shuls WHERE org_id = ? AND (gabai_cell = ? OR ruv_phone = ?)`).get(orgId, phone, phone);
  if (shul) return { type: 'shul', id: shul.id, label: shul.label };

  const store = db.prepare(`SELECT id, name AS label FROM stores WHERE org_id = ? AND (manager_phone = ? OR owner_phone = ? OR phone = ?)`).get(orgId, phone, phone, phone);
  if (store) return { type: 'store', id: store.id, label: store.label };

  const applicant = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label FROM applicants WHERE org_id = ? AND (husband_cell = ? OR wife_cell = ? OR home_phone = ?)`).get(orgId, phone, phone, phone);
  if (applicant) return { type: 'applicant', id: applicant.id, label: applicant.label };

  const user = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label FROM users WHERE org_id = ? AND phone = ?`).get(orgId, phone);
  if (user) return { type: 'user', id: user.id, label: user.label };

  return null;
}

export function findAccountByEmail(orgId, rawEmail) {
  if (!rawEmail) return null;
  const email = String(rawEmail).trim().toLowerCase();
  if (!email) return null;

  const shul = db.prepare(`SELECT id, name_en AS label FROM shuls WHERE org_id = ? AND LOWER(gabai_email) = ?`).get(orgId, email);
  if (shul) return { type: 'shul', id: shul.id, label: shul.label };

  const store = db.prepare(`SELECT id, name AS label FROM stores WHERE org_id = ? AND (LOWER(manager_email) = ? OR LOWER(owner_email) = ?)`).get(orgId, email, email);
  if (store) return { type: 'store', id: store.id, label: store.label };

  const applicant = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label FROM applicants WHERE org_id = ? AND LOWER(email) = ?`).get(orgId, email);
  if (applicant) return { type: 'applicant', id: applicant.id, label: applicant.label };

  const user = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label FROM users WHERE org_id = ? AND LOWER(email) = ?`).get(orgId, email);
  if (user) return { type: 'user', id: user.id, label: user.label };

  return null;
}
