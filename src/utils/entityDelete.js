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
