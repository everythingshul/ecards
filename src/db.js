import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { normalizePhone } from './utils/phone.js';
import { generateApplicantExternalId } from './utils/externalId.js';

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
for (const sub of ['contracts', 'uploads', 'signatures', 'logos', 'updates']) {
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
safeAlter(`ALTER TABLE forms ADD COLUMN opens_at TEXT`);
safeAlter(`ALTER TABLE forms ADD COLUMN closes_at TEXT`);
safeAlter(`ALTER TABLE forms ADD COLUMN is_default INTEGER DEFAULT 0`);
safeAlter(`ALTER TABLE audit_log ADD COLUMN undone_at TEXT`);

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

  // Default field requirement settings mirroring the spec.
  const shulFields = ['name_en','name_he','address','city','state','zip','ruv_first_name','ruv_last_name','ruv_phone','ruv_address','gabai_first_name','gabai_last_name','gabai_cell','gabai_email','gabai_address'];
  const applicantFields = ['first_name','last_name','marital_status','home_phone','husband_cell','wife_cell','email','address','shul_id','preferred_contact_method','num_children','home_for_yomtov'];
  const insSetting = db.prepare(`INSERT OR IGNORE INTO form_field_settings (id, org_id, form_type, field_key, is_required, is_visible) VALUES (?,?,?,?,1,1)`);
  for (const f of shulFields) insSetting.run(randomUUID(), defaultOrgId, 'shul', f);
  for (const f of applicantFields) insSetting.run(randomUUID(), defaultOrgId, 'applicant', f);
} else {
  defaultOrgId = db.prepare('SELECT id FROM organizations ORDER BY created_at LIMIT 1').get().id;
}

// ---------------------------------------------------------------------------
// Seed a `forms` row for each of the three built-in public application pages
// (apply.html, apply-store.html, apply-ezras-habayis.html) so they show up
// in Form Builder like any custom form and can be scheduled (opens_at/
// closes_at) or deactivated from there. These pages keep their own
// specialized submit routes (shuls.js POST /apply, etc. — contract signing,
// Places autocomplete, the locked-shul auto-attach) rather than going
// through the generic /forms/public/:slug/submit; this row is purely the
// schedule/active-state record those routes check (see utils/formSchedule.js),
// not a submission target. INSERT OR IGNORE on a UNIQUE slug makes this safe
// to run on every boot, including for orgs that existed before this existed.
const insDefaultForm = db.prepare(`INSERT OR IGNORE INTO forms (id, org_id, name, type, slug, schema_json, is_default) VALUES (?,?,?,?,?,?,1)`);
insDefaultForm.run(randomUUID(), defaultOrgId, 'Shul Registration', 'shul_application', 'shul-application', JSON.stringify([
  { key: 'name_en', label: 'Shul Name', type: 'text', required: true }, { key: 'address', label: 'Address', type: 'text', required: true },
  { key: 'ruv_first_name', label: 'Rav First Name', type: 'text', required: true }, { key: 'ruv_last_name', label: 'Rav Last Name', type: 'text', required: true },
  { key: 'ruv_phone', label: 'Rav Phone', type: 'tel', required: true },
  { key: 'gabai_first_name', label: 'Gabai First Name', type: 'text', required: true }, { key: 'gabai_last_name', label: 'Gabai Last Name', type: 'text', required: true },
  { key: 'gabai_cell', label: 'Gabai Cell', type: 'tel', required: true }, { key: 'gabai_email', label: 'Gabai Email', type: 'email', required: true },
]));
insDefaultForm.run(randomUUID(), defaultOrgId, 'Store Application', 'store_application', 'store-application', JSON.stringify([
  { key: 'name', label: 'Store Name', type: 'text', required: true }, { key: 'owner_name', label: 'Owner Name', type: 'text', required: false },
  { key: 'owner_email', label: 'Owner Email', type: 'email', required: true }, { key: 'owner_phone', label: 'Owner Phone', type: 'tel', required: false },
]));
insDefaultForm.run(randomUUID(), defaultOrgId, 'Ezras Habayis Application', 'applicant_application', 'ezras-habayis-application', JSON.stringify([
  { key: 'first_name', label: 'First Name', type: 'text', required: true }, { key: 'last_name', label: 'Last Name', type: 'text', required: true },
  { key: 'home_phone', label: 'Home Phone', type: 'tel', required: false }, { key: 'email', label: 'Email', type: 'email', required: false },
]));

export const DEFAULT_ORG_ID = defaultOrgId;
export function uuid() { return randomUUID(); }
