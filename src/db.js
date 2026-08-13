import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
for (const sub of ['contracts', 'uploads', 'signatures', 'logos']) {
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
    defaultOrgId, 'Shmachas Rechag - Kupat Ha\'ir', 'ecards', '#241a15', '#c9a76a', process.env.SUPPORT_EMAIL || 'admin@everythingshul.com'
  );
  const seasonId = randomUUID();
  db.prepare(`INSERT INTO seasons (id, org_id, name, is_active, default_card_amount) VALUES (?,?,?,1,0)`)
    .run(seasonId, defaultOrgId, 'Season ' + new Date().getFullYear());

  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@everythingshul.com';
  const adminPass = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  db.prepare(`INSERT INTO users (id, org_id, email, password_hash, first_name, last_name, role)
    VALUES (?,?,?,?,?,?,?)`).run(
    randomUUID(), defaultOrgId, adminEmail, bcrypt.hashSync(adminPass, 10), 'Super', 'Admin', 'super_admin'
  );
  console.log(`[db] Seeded default org + super admin (${adminEmail} / ${adminPass}) — CHANGE THIS PASSWORD IMMEDIATELY.`);

  // Default field requirement settings mirroring the spec.
  const shulFields = ['name_en','name_he','address','city','state','zip','ruv_first_name','ruv_last_name','ruv_phone','ruv_address','gabai_first_name','gabai_last_name','gabai_cell','gabai_email','gabai_address'];
  const applicantFields = ['first_name','last_name','marital_status','home_phone','husband_cell','wife_cell','email','address','shul_id','preferred_contact_method','num_children','home_for_yomtov'];
  const insSetting = db.prepare(`INSERT OR IGNORE INTO form_field_settings (id, org_id, form_type, field_key, is_required, is_visible) VALUES (?,?,?,?,1,1)`);
  for (const f of shulFields) insSetting.run(randomUUID(), defaultOrgId, 'shul', f);
  for (const f of applicantFields) insSetting.run(randomUUID(), defaultOrgId, 'applicant', f);
} else {
  defaultOrgId = db.prepare('SELECT id FROM organizations ORDER BY created_at LIMIT 1').get().id;
}

export const DEFAULT_ORG_ID = defaultOrgId;
export function uuid() { return randomUUID(); }
