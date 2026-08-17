import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { normalizePhone } from './utils/phone.js';
import { generateApplicantExternalId } from './utils/externalId.js';

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
for (const sub of ['contracts', 'uploads', 'signatures', 'logos', 'updates', 'forms']) {
  const p = join(DATA_DIR, sub);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export const db = new Database(join(DATA_DIR, 'ecards.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Never destructive — every migration is CREATE IF NOT EXISTS or a guarded ALTER TABLE.
db.exec(`
-- ===================== Core tenancy =====================
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE,          -- e.g. "shul" -> shul.everythingshul.com (this deploy = ecards.everythingshul.com)
  custom_domain TEXT UNIQUE,      -- org connects their own domain
  logo_url TEXT,
  primary_color TEXT DEFAULT '#2b1f1a',
  accent_color TEXT DEFAULT '#c9a76a',
  support_email TEXT,
  support_phone TEXT,
  address TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,               -- e.g. "5786 / 2025-26"
  start_date TEXT,
  end_date TEXT,
  is_active INTEGER DEFAULT 1,
  default_card_amount REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Single-org platform: one Brevo account, one disccardpromos account for the
-- whole system (see services/mail.js and services/giftcard.js). No per-org
-- credential tables — that was tried and explicitly reverted.

-- ===================== Users / RBAC =====================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  role TEXT NOT NULL DEFAULT 'staff', -- super_admin | org_admin | staff | shul | store
  shul_id TEXT,                        -- set when role = shul (portal login)
  store_id TEXT,                       -- set when role = store (portal login)
  is_active INTEGER DEFAULT 1,
  is_paused INTEGER DEFAULT 0,         -- frozen due to duplicate-hold on linked shul/applicant
  token_version INTEGER DEFAULT 0,
  invite_token TEXT,
  invite_expires TEXT,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Field-level + page-level permission grants. A user with no rows for a resource
-- falls back to role defaults (see middleware/permissions.js).
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  resource TEXT NOT NULL,      -- 'shuls' | 'applicants' | 'cards' | 'stores' | 'forms' | 'users' | 'settings' | 'dashboard'
  can_view INTEGER DEFAULT 1,
  can_edit INTEGER DEFAULT 0,
  can_export INTEGER DEFAULT 0,
  hidden_fields TEXT DEFAULT '[]',   -- JSON array of field keys hidden from this user (e.g. ["first_name","last_name"])
  scope TEXT DEFAULT 'all',          -- 'all' | 'assigned' (only shuls/applicants explicitly assigned)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, resource)
);

CREATE TABLE IF NOT EXISTS user_assignments ( -- for scope='assigned'
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL, -- 'shul' | 'store'
  entity_id TEXT NOT NULL
);

-- ===================== Shuls =====================
CREATE TABLE IF NOT EXISTS shuls (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  season_id TEXT REFERENCES seasons(id),
  name_en TEXT NOT NULL,
  name_he TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT, lat REAL, lng REAL, place_id TEXT,
  ruv_first_name TEXT, ruv_last_name TEXT, ruv_phone TEXT,
  ruv_address TEXT, ruv_city TEXT, ruv_state TEXT, ruv_zip TEXT, ruv_place_id TEXT,
  gabai_first_name TEXT, gabai_last_name TEXT, gabai_cell TEXT, gabai_email TEXT,
  gabai_address TEXT, gabai_city TEXT, gabai_state TEXT, gabai_zip TEXT, gabai_place_id TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted | contract_sent | contract_signed | approved | rejected
  slots_allocated INTEGER DEFAULT 0,
  is_paused INTEGER DEFAULT 0,       -- duplicate hold freeze
  duplicate_of_shul_id TEXT REFERENCES shuls(id),
  duplicate_status TEXT,             -- NULL | 'flagged' | 'bypassed' | 'resolved'
  portal_user_id TEXT REFERENCES users(id),
  source TEXT DEFAULT 'form',        -- form | mass_upload | admin
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shul_notes (
  id TEXT PRIMARY KEY,
  shul_id TEXT NOT NULL REFERENCES shuls(id),
  user_id TEXT REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS season_notes (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  user_id TEXT REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  shul_id TEXT NOT NULL REFERENCES shuls(id),
  season_id TEXT REFERENCES seasons(id),
  template_id TEXT,
  pdf_path TEXT,               -- unsigned generated PDF
  signed_pdf_path TEXT,        -- final PDF w/ signature stamped
  signature_data TEXT,         -- base64 PNG of signature or typed name
  signer_name TEXT,
  signer_title TEXT,
  signed_at TEXT,
  ip_address TEXT,
  status TEXT DEFAULT 'pending', -- pending | sent | signed | void
  sign_token TEXT UNIQUE,
  sign_token_expires TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Generic e-signable documents for applicants and stores (shuls keep using
-- the 'contracts' table above -- that flow is older, well-tested, and left
-- alone; this table is the same idea generalized to the other two entity
-- types so "customize docs for applicants/shuls/stores" covers all three).
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  entity_type TEXT NOT NULL,   -- applicant | store
  entity_id TEXT NOT NULL,
  title TEXT DEFAULT 'Agreement',
  pdf_path TEXT,
  signed_pdf_path TEXT,
  signature_data TEXT,
  signer_name TEXT,
  signer_title TEXT,
  signed_at TEXT,
  ip_address TEXT,
  status TEXT DEFAULT 'pending', -- pending | sent | signed | void
  sign_token TEXT UNIQUE,
  sign_token_expires TEXT,
  sent_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id);

-- ===================== Email Center =====================
-- Every email this platform sends (system notifications and admin-composed
-- ones alike) is logged here so admins have somewhere to actually see what
-- went out, whether it really sent, and why it didn't when it failed.
CREATE TABLE IF NOT EXISTS emails_sent (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  to_email TEXT NOT NULL,
  subject TEXT,
  body_html TEXT,
  status TEXT NOT NULL,          -- sent | failed | dry_run
  error_message TEXT,
  related_entity_type TEXT,      -- shul | applicant | store | task | user | null (admin-composed)
  related_entity_id TEXT,
  sent_by TEXT REFERENCES users(id), -- null for automatic system emails
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emails_sent_org ON emails_sent(org_id, created_at);

-- Per-user account preferences (e.g. which list columns to show and in what
-- order) — follows the admin across devices/browsers, unlike localStorage.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

-- Admin overrides for system-triggered emails (services/mail.js's
-- SYSTEM_EMAIL_TEMPLATES). A missing row for a given key means "use the
-- built-in default" — this table only ever holds the customized ones.
CREATE TABLE IF NOT EXISTS system_email_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, key)
);

-- Reusable subject/body templates for the admin-composed "Email Builder"
-- (Email Center > Templates). Body supports {{variable}} placeholders,
-- substituted at send time.
CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  category TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_templates_org ON email_templates(org_id);

-- ===================== SMS Center =====================
-- Every SMS this platform sends or receives, provider-agnostic — see
-- services/sms.js (mirrors the disccardpromos mock-mode pattern: runs in
-- mock mode, logging only, until SMS_API_BASE/SMS_API_KEY are set).
CREATE TABLE IF NOT EXISTS sms_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  direction TEXT NOT NULL,       -- outbound | inbound
  phone TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL,          -- sent | failed | mock | received
  error_message TEXT,
  related_entity_type TEXT,
  related_entity_id TEXT,
  sent_by TEXT REFERENCES users(id), -- null for inbound or automatic sends
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_messages_org ON sms_messages(org_id, created_at);

-- Reusable SMS body templates, same idea as email_templates.
CREATE TABLE IF NOT EXISTS sms_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  category TEXT,
  body TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_templates_org ON sms_templates(org_id);

-- ===================== Updates =====================
-- Admin-broadcast updates to specific shuls/stores or whole groups — the
-- shul/store portal "Updates" section (formerly just a contract-status
-- viewer). Every recipient gets an email and a portal notification.
CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  attachments_json TEXT DEFAULT '[]', -- [{filename, path, mime_type}]
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_updates_org ON updates(org_id);

CREATE TABLE IF NOT EXISTS update_recipients (
  id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL REFERENCES updates(id),
  entity_type TEXT NOT NULL, -- shul | store
  entity_id TEXT NOT NULL,
  email_status TEXT,         -- sent | failed | dry_run
  email_error TEXT,
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_update_recipients_update ON update_recipients(update_id);
CREATE INDEX IF NOT EXISTS idx_update_recipients_entity ON update_recipients(entity_type, entity_id);

-- ===================== Applicants =====================
CREATE TABLE IF NOT EXISTS applicants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  shul_id TEXT REFERENCES shuls(id),
  season_id TEXT REFERENCES seasons(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  marital_status TEXT,            -- single | married | widowed | divorced
  home_phone TEXT, husband_cell TEXT, wife_cell TEXT, email TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT, place_id TEXT,
  preferred_contact_method TEXT,  -- phone | text | email
  preferred_number TEXT,          -- home | husband | wife (when method is phone/text)
  num_children INTEGER DEFAULT 0,
  home_for_yomtov INTEGER,        -- 0/1
  approval_status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  card_amount REAL,
  comments TEXT,
  is_paused INTEGER DEFAULT 0,
  duplicate_of_applicant_id TEXT REFERENCES applicants(id),
  duplicate_status TEXT,
  source TEXT DEFAULT 'shul_upload', -- shul_upload | mass_upload | admin | public_form
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applicant_notes (
  id TEXT PRIMARY KEY,
  applicant_id TEXT NOT NULL REFERENCES applicants(id),
  user_id TEXT REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== Cards / gift card provider (disccardpromos.com) =====================
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  applicant_id TEXT REFERENCES applicants(id),
  season_id TEXT REFERENCES seasons(id),
  card_number_masked TEXT,     -- last 4 only, ever displayed
  provider_card_id TEXT,       -- disccardpromos internal id/token
  status TEXT NOT NULL DEFAULT 'unassigned', -- unassigned | assigned | activated | deactivated | lost
  amount REAL DEFAULT 0,
  activation_phone TEXT,       -- phone used to activate, written to account
  activated_at TEXT,
  assigned_at TEXT,
  deactivated_at TEXT,
  last_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS card_transactions (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  provider_txn_id TEXT UNIQUE,
  type TEXT NOT NULL,          -- activation | purchase | refund | load | adjustment
  amount REAL NOT NULL,
  balance_after REAL,
  store_name TEXT,
  store_id TEXT REFERENCES stores(id),
  occurred_at TEXT,
  raw_payload TEXT,            -- full JSON response from provider, kept for audit
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== Stores =====================
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  address TEXT, city TEXT, state TEXT, zip TEXT, place_id TEXT,
  phone TEXT,
  manager_name TEXT, manager_phone TEXT, manager_email TEXT,
  owner_name TEXT, owner_phone TEXT, owner_email TEXT,
  comments TEXT,
  setup_status TEXT DEFAULT 'pending', -- pending | in_progress | active | inactive
  has_provider_account INTEGER DEFAULT 0, -- already had a disccardpromos account
  provider_store_id TEXT,
  portal_user_id TEXT REFERENCES users(id),
  source TEXT DEFAULT 'admin',        -- admin | application (self-submitted)
  onboarding_step INTEGER DEFAULT 0,  -- 0=not started .. 3=complete, driven by the store's own portal wizard
  onboarding_completed_at TEXT,
  agreed_terms_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS store_billing (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  period TEXT NOT NULL,        -- e.g. "2026-08"
  amount_owed REAL DEFAULT 0,
  amount_paid REAL DEFAULT 0,
  status TEXT DEFAULT 'open',  -- open | invoiced | paid | disputed
  invoice_ref TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== Forms (form builder) =====================
CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- shul_application | applicant_application
  visibility TEXT DEFAULT 'public', -- public | group | individual
  slug TEXT UNIQUE,
  schema_json TEXT NOT NULL,    -- ordered field list: [{key,label,type,required,admin_override,visible}]
  target_json TEXT DEFAULT '[]',-- shul ids / group tags this form is limited to, when visibility != public
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Superseded by per-field required/admin_override living directly on
-- forms.schema_json (see utils/formValidation.js) — kept only so an
-- upgrading deploy doesn't lose the table out from under any lingering
-- reference; nothing in the app writes or reads this anymore.
CREATE TABLE IF NOT EXISTS form_field_settings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  form_type TEXT NOT NULL,      -- shul | applicant
  field_key TEXT NOT NULL,
  is_required INTEGER DEFAULT 0,
  is_admin_override INTEGER DEFAULT 0, -- admin can fill/edit even if normally locked
  is_visible INTEGER DEFAULT 1,
  UNIQUE(org_id, form_type, field_key)
);

-- Every form submission, whether or not the form is currently the "default"
-- one feeding the Shuls/Applicants/Stores lists — a raw, exportable record
-- of what was actually submitted, independent of whatever entity row it may
-- also have created. form_name/form_type are denormalized (not just a FK)
-- so a response stays meaningful even if the form itself is later edited or
-- deleted. entity_type/entity_id are set when the submission also created a
-- real shul/applicant/store record; null for a form that's just collecting
-- responses.
CREATE TABLE IF NOT EXISTS form_responses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  form_id TEXT REFERENCES forms(id),
  form_name TEXT,
  form_type TEXT,
  data_json TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_form_responses_org ON form_responses(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_form_responses_form ON form_responses(form_id);

-- ===================== Imports / duplicate detection / audit =====================
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  entity_type TEXT NOT NULL,    -- shuls | applicants
  file_name TEXT,
  status TEXT DEFAULT 'processing', -- processing | completed | failed
  total_rows INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  duplicate_count INTEGER DEFAULT 0,
  error_log TEXT DEFAULT '[]',
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS duplicate_flags (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  entity_type TEXT NOT NULL,    -- shul | applicant
  entity_id TEXT NOT NULL,
  matched_entity_id TEXT NOT NULL,
  reason TEXT,                  -- e.g. "same name + zip", "same email"
  status TEXT DEFAULT 'open',   -- open | bypassed | resolved
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,         -- create | update | delete | approve | pause | login | esign | ...
  entity_type TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (org_id, key)
);

-- Anonymous pageview log for the public-facing site (home, apply forms,
-- FAQ, contact, etc.) — powers the admin Analytics page. visitor_id is a
-- random id the browser generates and stores in localStorage (see app.js's
-- trackPageview()), not tied to any account, just enough to tell "one
-- visitor, several pageviews" apart from "several different visitors."
CREATE TABLE IF NOT EXISTS page_views (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  path TEXT NOT NULL,
  referrer TEXT,
  visitor_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_page_views_org ON page_views(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(org_id, path);

-- Public "Contact Us" form submissions.
CREATE TABLE IF NOT EXISTS contact_submissions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== To-Do / Tasks =====================
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  description TEXT,
  assigned_to TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  entity_type TEXT,          -- 'shul' | 'applicant' | 'store' | NULL (standalone task)
  entity_id TEXT,
  due_date TEXT,              -- ISO date, e.g. "2026-08-20"
  priority TEXT DEFAULT 'normal', -- low | normal | high
  status TEXT DEFAULT 'open',      -- open | in_progress | done
  completed_at TEXT,
  last_reminded_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE INDEX IF NOT EXISTS idx_shuls_org ON shuls(org_id);
CREATE INDEX IF NOT EXISTS idx_shuls_status ON shuls(status);
CREATE INDEX IF NOT EXISTS idx_applicants_org ON applicants(org_id);
CREATE INDEX IF NOT EXISTS idx_applicants_shul ON applicants(shul_id);
CREATE INDEX IF NOT EXISTS idx_applicants_status ON applicants(approval_status);
CREATE INDEX IF NOT EXISTS idx_cards_applicant ON cards(applicant_id);
CREATE INDEX IF NOT EXISTS idx_txn_card ON card_transactions(card_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
`);

// Guarded additive migrations (safe to re-run; never destructive).
function safeAlter(sql) { try { db.exec(sql); } catch (e) { /* column already exists */ } }
safeAlter(`ALTER TABLE users ADD COLUMN phone TEXT`);
safeAlter(`ALTER TABLE stores ADD COLUMN source TEXT DEFAULT 'admin'`);
safeAlter(`ALTER TABLE stores ADD COLUMN onboarding_step INTEGER DEFAULT 0`);
safeAlter(`ALTER TABLE stores ADD COLUMN onboarding_completed_at TEXT`);
safeAlter(`ALTER TABLE stores ADD COLUMN agreed_terms_at TEXT`);
safeAlter(`ALTER TABLE seasons ADD COLUMN max_accepted_applicants INTEGER`);
safeAlter(`ALTER TABLE shuls ADD COLUMN is_locked INTEGER DEFAULT 0`);
safeAlter(`ALTER TABLE applicants ADD COLUMN external_id TEXT`);
// The disccardpromos account created for this applicant on approval (see
// services/giftcard.js's upsertAccountForApproval) — distinct from
// cards.provider_card_id, which is the actual gift card assigned later.
safeAlter(`ALTER TABLE applicants ADD COLUMN provider_account_id TEXT`);
safeAlter(`ALTER TABLE forms ADD COLUMN opens_at TEXT`);
safeAlter(`ALTER TABLE forms ADD COLUMN closes_at TEXT`);
safeAlter(`ALTER TABLE forms ADD COLUMN is_default INTEGER DEFAULT 0`);
// Which form is the CURRENTLY ACTIVE one for its section (shul_application/
// store_application/applicant_application) — the fixed public pages
// (apply.html, apply-store.html, apply-ezras-habayis.html) render whichever
// form has this flag set for their type, not one permanently-pinned row, so
// any form of the right type — built-in or admin-created — can be switched
// in as "the" form for that section (routes/forms.js PUT /:id/set-default)
// without breaking those pages (see utils/formSchedule.js). Exactly one form
// per (org, type) can have this set at a time. One-time backfill below makes
// the three originally-seeded forms (is_default=1) the current default for
// their type, since nothing else could have been chosen before this existed.
safeAlter(`ALTER TABLE forms ADD COLUMN is_current_default INTEGER DEFAULT 0`);
db.prepare(`UPDATE forms SET is_current_default = 1 WHERE is_default = 1 AND is_current_default = 0`).run();
// Every form is pinned to one season, so which season a submission lands in
// is determined by the form the applicant/shul/store actually used — not by
// whichever season happens to be "active" at the moment they hit submit
// (which could change out from under a link someone already has open).
safeAlter(`ALTER TABLE forms ADD COLUMN season_id TEXT REFERENCES seasons(id)`);
// SimpleSender doesn't support inbound webhooks yet, so inbound SMS is
// pulled by polling GET /v1/messages instead (see services/sms.js
// syncInboundSms) — this is how re-polling the same messages is recognized
// as already-imported instead of creating duplicate rows every sweep.
safeAlter(`ALTER TABLE sms_messages ADD COLUMN provider_message_id TEXT`);
// Per-template Reply-To override — falls back to the org-wide default
// (settings key email_reply_to) when null, and to no Reply-To header at all
// when neither is set. See services/mail.js renderSystemTemplate().
safeAlter(`ALTER TABLE system_email_templates ADD COLUMN reply_to TEXT`);
safeAlter(`ALTER TABLE audit_log ADD COLUMN undone_at TEXT`);
// Points an undone entry at the fresh 'undo' entry that reversed it, so the
// UI can offer a one-click "Redo" right on that same row instead of making
// the admin go find the separate "Reversed a change to..." log entry.
safeAlter(`ALTER TABLE audit_log ADD COLUMN undo_entry_id TEXT`);
// Full multi-field signing payload ({fieldId: value/dataUrl}) for documents
// that use more than one fillable item (multiple signatures, initials, date,
// text fields). signature_data/signer_name etc. above still get populated
// from the primary signature field for backward compatibility with existing
// "already signed" displays; field_values is the complete record.
safeAlter(`ALTER TABLE contracts ADD COLUMN field_values TEXT`);
safeAlter(`ALTER TABLE documents ADD COLUMN field_values TEXT`);
// Marks an applicant as permanently exempt from every disccardpromos write
// (account create/update, add-funds, lock/unlock on reject/approve) — for a
// one-time bulk import of a past/other season's real-world data that must
// never touch the live gift-card provider, regardless of what happens to
// the record afterward (approved, rejected, re-approved, etc.). Set at
// import time (routes/applicants.js POST /import) and editable afterward by
// an admin as a safety net.
safeAlter(`ALTER TABLE applicants ADD COLUMN provider_exempt INTEGER DEFAULT 0`);

// One-time normalization of pre-existing phone numbers to the canonical
// 123-456-7890 display format (see utils/phone.js). Cheap and idempotent —
// re-running it on already-normalized numbers is a no-op — so it's safe to
// leave running on every boot rather than tracking a "have we run this" flag.
function normalizePhoneColumn(table, column) {
  const rows = db.prepare(`SELECT id, ${column} AS val FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`).all();
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
  for (const row of rows) {
    const normalized = normalizePhone(row.val);
    if (normalized !== row.val) update.run(normalized, row.id);
  }
}
normalizePhoneColumn('shuls', 'ruv_phone');
normalizePhoneColumn('shuls', 'gabai_cell');
normalizePhoneColumn('applicants', 'home_phone');
normalizePhoneColumn('applicants', 'husband_cell');
normalizePhoneColumn('applicants', 'wife_cell');
normalizePhoneColumn('stores', 'phone');
normalizePhoneColumn('stores', 'manager_phone');
normalizePhoneColumn('stores', 'owner_phone');
normalizePhoneColumn('users', 'phone');
normalizePhoneColumn('organizations', 'support_phone');

// Backfill a 4-digit external_id for any applicant that predates this
// column (see routes/applicants.js, which assigns one on every new create).
{
  const missing = db.prepare(`SELECT id FROM applicants WHERE external_id IS NULL OR external_id = ''`).all();
  const setExternalId = db.prepare('UPDATE applicants SET external_id = ? WHERE id = ?');
  for (const row of missing) setExternalId.run(generateApplicantExternalId(db), row.id);
}

// ---------------------------------------------------------------------------
// Seed a default organization + super admin on first boot so the app is usable
// immediately. Idempotent.
// ---------------------------------------------------------------------------
const orgCount = db.prepare('SELECT COUNT(*) c FROM organizations').get().c;
let defaultOrgId;
if (orgCount === 0) {
  defaultOrgId = randomUUID();
  db.prepare(`INSERT INTO organizations (id, name, subdomain, primary_color, accent_color, support_email)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    defaultOrgId, 'Shmachas Rechag - Kupat Ha\'ir', 'ecards', '#241a15', '#c9a76a', process.env.SUPPORT_EMAIL || ''
  );
  const seasonId = randomUUID();
  db.prepare(`INSERT INTO seasons (id, org_id, name, is_active, default_card_amount) VALUES (?,?,?,1,0)`)
    .run(seasonId, defaultOrgId, 'Season ' + new Date().getFullYear());

  // Never fall back to a hardcoded password here — "ChangeMe123!" was a
  // fixed, publicly-known default (visible in this repo's history), so any
  // environment that unexpectedly re-seeds (e.g. a persistent disk that
  // failed to attach) would silently stand up a super-admin account anyone
  // could log into. A random one is only ever visible in this boot's server
  // log, which only whoever runs the deploy can see.
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@everythingshul.com';
  const adminPass = process.env.SEED_ADMIN_PASSWORD || randomUUID();
  db.prepare(`INSERT INTO users (id, org_id, email, password_hash, first_name, last_name, role)
    VALUES (?,?,?,?,?,?,?)`).run(
    randomUUID(), defaultOrgId, adminEmail, bcrypt.hashSync(adminPass, 10), 'Super', 'Admin', 'super_admin'
  );
  console.log(`[db] Seeded default org + super admin (${adminEmail} / ${adminPass}) — CHANGE THIS PASSWORD IMMEDIATELY.`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.warn('[db] SEED_ADMIN_PASSWORD was not set — a random one-time password was generated above. Set SEED_ADMIN_PASSWORD (and SEED_ADMIN_EMAIL) in your deploy environment so re-seeding is intentional and predictable, not automatic.');
  }

} else {
  defaultOrgId = db.prepare('SELECT id FROM organizations ORDER BY created_at LIMIT 1').get().id;
}

// ---------------------------------------------------------------------------
// Seed a `forms` row for each of the three built-in public application pages
// (apply.html, apply-store.html, apply-ezras-habayis.html) so they show up
// in Form Builder like any custom form and can be scheduled (opens_at/
// closes_at) or deactivated from there. Unlike before, these pages now
// render their fields directly from this schema_json (see form-render.js,
// shared by apply.html/apply-store.html/apply-ezras-habayis.html/form.html)
// — an admin who edits the current-default form's fields here is editing
// exactly what the public page shows, the same as any custom form. The
// dedicated submit routes (shuls.js POST /apply, etc.) still handle the
// entity-specific side effects (contract generation, the locked-shul
// auto-attach, duplicate detection) that a generic form submission
// wouldn't know how to do. INSERT OR IGNORE on a UNIQUE slug makes this
// safe to run on every boot, including for orgs that existed before this did.
const SEEDED_SHUL_SCHEMA = [
  { key: 'name_en', label: 'Shul Name (English)', type: 'text', required: true },
  { key: 'name_he', label: 'Shul Name (Hebrew)', type: 'text', required: false },
  { key: 'address', label: 'Shul Address', type: 'text', required: true },
  { key: 'city', label: 'City', type: 'text', required: true }, { key: 'state', label: 'State', type: 'text', required: true }, { key: 'zip', label: 'Zip', type: 'text', required: true },
  { key: 'ruv_first_name', label: 'Rav First Name', type: 'text', required: true }, { key: 'ruv_last_name', label: 'Rav Last Name', type: 'text', required: true },
  { key: 'ruv_phone', label: 'Rav Phone Number', type: 'tel', required: true },
  { key: 'ruv_address', label: 'Rav Address', type: 'text', required: false }, { key: 'ruv_city', label: 'Rav City', type: 'text', required: false },
  { key: 'ruv_state', label: 'Rav State', type: 'text', required: false }, { key: 'ruv_zip', label: 'Rav Zip', type: 'text', required: false },
  { key: 'gabai_first_name', label: 'Gabai First Name', type: 'text', required: true }, { key: 'gabai_last_name', label: 'Gabai Last Name', type: 'text', required: true },
  { key: 'gabai_cell', label: 'Gabai Cell Number', type: 'tel', required: true }, { key: 'gabai_email', label: 'Gabai Email', type: 'email', required: true },
  { key: 'gabai_address', label: 'Gabai Address', type: 'text', required: false }, { key: 'gabai_city', label: 'Gabai City', type: 'text', required: false },
  { key: 'gabai_state', label: 'Gabai State', type: 'text', required: false }, { key: 'gabai_zip', label: 'Gabai Zip', type: 'text', required: false },
];
const SEEDED_STORE_SCHEMA = [
  { key: 'name', label: 'Store Name', type: 'text', required: true },
  { key: 'address', label: 'Address', type: 'text', required: false }, { key: 'city', label: 'City', type: 'text', required: false },
  { key: 'state', label: 'State', type: 'text', required: false }, { key: 'zip', label: 'Zip', type: 'text', required: false },
  { key: 'phone', label: 'Store Phone', type: 'tel', required: false },
  { key: 'manager_name', label: 'Manager Name', type: 'text', required: false }, { key: 'manager_phone', label: 'Manager Phone', type: 'tel', required: false },
  { key: 'manager_email', label: 'Manager Email', type: 'email', required: false },
  { key: 'owner_name', label: 'Owner Name', type: 'text', required: false }, { key: 'owner_phone', label: 'Owner Phone', type: 'tel', required: false },
  { key: 'owner_email', label: 'Owner Email', type: 'email', required: true },
  { key: 'has_provider_account', label: 'We already have a disccardpromos.com (or equivalent) merchant account', type: 'checkbox', required: false },
  { key: 'comments', label: 'Comments', type: 'textarea', required: false },
];
const SEEDED_APPLICANT_SCHEMA = [
  { key: 'first_name', label: 'First Name', type: 'text', required: true }, { key: 'last_name', label: 'Last Name', type: 'text', required: true },
  { key: 'marital_status', label: 'Marital Status', type: 'select', required: false, options: [
    { value: 'single', label: 'Single' }, { value: 'married', label: 'Married' }, { value: 'widowed', label: 'Widowed' }, { value: 'divorced', label: 'Divorced' } ] },
  { key: 'home_phone', label: 'Home Phone', type: 'tel', required: false }, { key: 'email', label: 'Email', type: 'email', required: false },
  { key: 'husband_cell', label: 'Husband Cell', type: 'tel', required: false }, { key: 'wife_cell', label: 'Wife Cell', type: 'tel', required: false },
  { key: 'preferred_contact_method', label: 'Preferred Contact Method', type: 'select', required: false, options: [
    { value: 'phone', label: 'Phone' }, { value: 'text', label: 'Text' }, { value: 'email', label: 'Email' } ] },
  { key: 'preferred_number', label: 'Number To Use', type: 'select', required: false, options: [
    { value: 'home', label: 'Home' }, { value: 'husband', label: 'Husband' }, { value: 'wife', label: 'Wife' } ] },
  { key: 'address', label: 'Address', type: 'text', required: false }, { key: 'city', label: 'City', type: 'text', required: false },
  { key: 'state', label: 'State', type: 'text', required: false }, { key: 'zip', label: 'Zip', type: 'text', required: false },
  { key: 'num_children', label: 'Number of Children', type: 'number', required: false, min: 0 },
  { key: 'home_for_yomtov', label: 'Home for Yom Tov', type: 'select', required: false, options: [ { value: '1', label: 'Yes' }, { value: '0', label: 'No' } ] },
  { key: 'comments', label: 'Comments', type: 'textarea', required: false },
];
const insDefaultForm = db.prepare(`INSERT OR IGNORE INTO forms (id, org_id, name, type, slug, schema_json, is_default, is_current_default) VALUES (?,?,?,?,?,?,1,1)`);
insDefaultForm.run(randomUUID(), defaultOrgId, 'Shul Registration', 'shul_application', 'shul-application', JSON.stringify(SEEDED_SHUL_SCHEMA));
insDefaultForm.run(randomUUID(), defaultOrgId, 'Store Application', 'store_application', 'store-application', JSON.stringify(SEEDED_STORE_SCHEMA));
insDefaultForm.run(randomUUID(), defaultOrgId, 'Ezras Habayis Application', 'applicant_application', 'ezras-habayis-application', JSON.stringify(SEEDED_APPLICANT_SCHEMA));

// One-time upgrade for deploys that already had these three seeded rows
// from before this schema became the source of truth for the public pages'
// actual fields (they used to only carry a handful of fields since nothing
// read them beyond scheduling) — matched by exact equality against the old,
// smaller seed content, so a row is only touched here if it was NEVER
// edited through Form Builder. Anything an admin already customized is left
// completely alone.
{
  const OLD_SHUL_SEED = JSON.stringify([
    { key: 'name_en', label: 'Shul Name', type: 'text', required: true }, { key: 'address', label: 'Address', type: 'text', required: true },
    { key: 'ruv_first_name', label: 'Rav First Name', type: 'text', required: true }, { key: 'ruv_last_name', label: 'Rav Last Name', type: 'text', required: true },
    { key: 'ruv_phone', label: 'Rav Phone', type: 'tel', required: true },
    { key: 'gabai_first_name', label: 'Gabai First Name', type: 'text', required: true }, { key: 'gabai_last_name', label: 'Gabai Last Name', type: 'text', required: true },
    { key: 'gabai_cell', label: 'Gabai Cell', type: 'tel', required: true }, { key: 'gabai_email', label: 'Gabai Email', type: 'email', required: true },
  ]);
  const OLD_STORE_SEED = JSON.stringify([
    { key: 'name', label: 'Store Name', type: 'text', required: true }, { key: 'owner_name', label: 'Owner Name', type: 'text', required: false },
    { key: 'owner_email', label: 'Owner Email', type: 'email', required: true }, { key: 'owner_phone', label: 'Owner Phone', type: 'tel', required: false },
  ]);
  const OLD_APPLICANT_SEED = JSON.stringify([
    { key: 'first_name', label: 'First Name', type: 'text', required: true }, { key: 'last_name', label: 'Last Name', type: 'text', required: true },
    { key: 'home_phone', label: 'Home Phone', type: 'tel', required: false }, { key: 'email', label: 'Email', type: 'email', required: false },
  ]);
  const upgrade = db.prepare(`UPDATE forms SET schema_json = ?, updated_at = datetime('now') WHERE id = ?`);
  for (const row of db.prepare(`SELECT id, type, schema_json FROM forms WHERE is_default = 1`).all()) {
    if (row.type === 'shul_application' && row.schema_json === OLD_SHUL_SEED) upgrade.run(JSON.stringify(SEEDED_SHUL_SCHEMA), row.id);
    else if (row.type === 'store_application' && row.schema_json === OLD_STORE_SEED) upgrade.run(JSON.stringify(SEEDED_STORE_SCHEMA), row.id);
    else if (row.type === 'applicant_application' && row.schema_json === OLD_APPLICANT_SEED) upgrade.run(JSON.stringify(SEEDED_APPLICANT_SCHEMA), row.id);
  }
}

// One-time-per-boot backfill: any form (built-in seed rows above, or an
// older custom form created before season_id existed) that still has no
// season pinned gets its org's current active season. Runs every boot but
// is a no-op once every form has one, since new forms are required to set
// season_id going forward (see routes/forms.js).
db.prepare(`UPDATE forms SET season_id = (
    SELECT id FROM seasons WHERE seasons.org_id = forms.org_id AND seasons.is_active = 1 ORDER BY seasons.created_at DESC LIMIT 1
  ) WHERE season_id IS NULL`).run();

export const DEFAULT_ORG_ID = defaultOrgId;
export function uuid() { return randomUUID(); }
