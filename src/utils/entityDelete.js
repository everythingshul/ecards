// Shared cleanup for the polymorphic entity_type/entity_id (or
// related_entity_type/related_entity_id) columns used across the app —
// documents, tasks, duplicate_flags, sms_messages, emails_sent, and
// form_responses all reference a shul/applicant/store this way instead of a
// real foreign key, so deleting the parent record never trips SQLite's FK
// enforcement, but would otherwise leave orphaned rows a list/detail page
// might still try to render. entityType is 'shul' | 'applicant' | 'store',
// matching the values those tables were actually written with.
import { db } from '../db.js';

export function deletePolymorphicRefs(entityType, entityId) {
  db.prepare(`DELETE FROM documents WHERE entity_type = ? AND entity_id = ?`).run(entityType, entityId);
  db.prepare(`DELETE FROM tasks WHERE entity_type = ? AND entity_id = ?`).run(entityType, entityId);
  db.prepare(`DELETE FROM duplicate_flags WHERE entity_type = ? AND (entity_id = ? OR matched_entity_id = ?)`).run(entityType, entityId, entityId);
  db.prepare(`DELETE FROM sms_messages WHERE related_entity_type = ? AND related_entity_id = ?`).run(entityType, entityId);
  db.prepare(`DELETE FROM emails_sent WHERE related_entity_type = ? AND related_entity_id = ?`).run(entityType, entityId);
  db.prepare(`DELETE FROM form_responses WHERE entity_type = ? AND entity_id = ?`).run(entityType, entityId);
}

// The full hard-delete cascade for one shul — shared by routes/shuls.js's
// single and mass "delete permanent" routes and by services/audit.js's
// mass-import undo (deleting a row a mass upload just created). Callers
// still own their own db.transaction() wrapper and any pre-delete side
// effects; deactivating a portal login is handled here since it's a plain
// column update, but locking a disccardpromos card is a network call and
// stays the caller's responsibility, same as before this was extracted.
export function hardDeleteShul(shul) {
  db.prepare('UPDATE applicants SET shul_id = NULL WHERE shul_id = ?').run(shul.id);
  db.prepare('UPDATE shuls SET duplicate_of_shul_id = NULL WHERE duplicate_of_shul_id = ?').run(shul.id);
  db.prepare('DELETE FROM contracts WHERE shul_id = ?').run(shul.id);
  db.prepare('DELETE FROM shul_notes WHERE shul_id = ?').run(shul.id);
  if (shul.portal_user_id) db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(shul.portal_user_id);
  deletePolymorphicRefs('shul', shul.id);
  db.prepare('DELETE FROM shuls WHERE id = ?').run(shul.id);
}

// Same as hardDeleteShul but for an applicant — card locking (a
// disccardpromos network call) is likewise left to the caller; this is
// DB-only.
export function hardDeleteApplicant(applicant) {
  db.prepare('DELETE FROM card_transactions WHERE card_id IN (SELECT id FROM cards WHERE applicant_id = ?)').run(applicant.id);
  db.prepare('DELETE FROM cards WHERE applicant_id = ?').run(applicant.id);
  db.prepare('DELETE FROM applicant_notes WHERE applicant_id = ?').run(applicant.id);
  db.prepare('UPDATE applicants SET duplicate_of_applicant_id = NULL WHERE duplicate_of_applicant_id = ?').run(applicant.id);
  deletePolymorphicRefs('applicant', applicant.id);
  db.prepare('DELETE FROM applicants WHERE id = ?').run(applicant.id);
}
