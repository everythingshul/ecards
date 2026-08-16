import { db } from '../db.js';

// The org's currently-configured required fields for a form type (shul |
// applicant), from Settings > Required Fields. Falls back to an empty list
// if nothing has been configured yet.
export function getRequiredFields(orgId, formType) {
  return db.prepare(`SELECT field_key FROM form_field_settings WHERE org_id = ? AND form_type = ? AND is_required = 1`)
    .all(orgId, formType).map(r => r.field_key);
}

// Checks every row in a bulk-upload sheet against the required fields before
// anything is inserted — spec: "only allow bulk upload if all required
// criteria are filled out in the sheet for everyone." Returns an array of
// { row, error } for every missing value across every row (empty = all rows
// pass). `rowNumberOffset` accounts for the header row (+1) and 1-indexing (+1).
export function validateRequiredFields(rows, requiredFields, rowNumberOffset = 2) {
  const errors = [];
  if (!requiredFields.length) return errors;
  rows.forEach((row, i) => {
    const missing = requiredFields.filter(f => row[f] === undefined || row[f] === null || String(row[f]).trim() === '');
    if (missing.length) errors.push({ row: i + rowNumberOffset, error: `Missing required field(s): ${missing.join(', ')}` });
  });
  return errors;
}
