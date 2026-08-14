# everythingshul e-cards platform

## What this is
Season-based gift card assistance management: shuls register + e-sign a contract,
admin approves and allocates applicant slots, shuls submit applicants, admin
approves applicants and issues gift cards via disccardpromos.com, and
participating stores apply/onboard and get a self-service portal with billing.
Multi-org from one account — each org can run its own branding, and its own
email (Brevo) AND gift card (disccardpromos.com) accounts. Deploy target:
`ecards.everythingshul.com`.

## Stack (mirrors the existing "Mamudem" product's conventions in this org)
- **Backend:** Node.js + Express (ES modules), SQLite via `better-sqlite3`
- **Frontend:** Vanilla HTML/CSS/JS, no framework/build step
- **PDF contracts:** `pdf-lib` (generated + signature-stamped in-process)
- **Email:** Brevo transactional API (platform default + optional per-org account)
- **Gift cards:** disccardpromos.com is the only vendor, but every org has its
  own merchant account/API key (platform default + optional per-org override —
  same pattern as email; see below)
- **Spreadsheet import:** `xlsx` (reads both .csv and .xlsx)
- **Auth:** JWT, bcrypt password hashing

## Project structure
```
src/
  index.js               — Express entry, route mounting, static frontend serving
  db.js                  — Full SQLite schema + seed (default org + super admin)
  middleware/
    auth.js               — JWT auth, role guards
    permissions.js         — Field-level + page-level RBAC (see "Permissions" below)
  services/
    mail.js                — Brevo send + branded templates, per-org sender resolution
    pdf.js                  — Contract PDF generation + e-signature stamping
    giftcard.js              — disccardpromos.com adapter, per-org account resolution (MOCK MODE until keys set)
    duplicates.js             — Duplicate detection + account pause/unpause
    importer.js                — CSV/XLSX parsing + template generation
    reminders.js               — Due-date task reminder emails (in-process interval, see index.js)
  routes/
    auth.js, users.js, orgs.js, seasons.js, settings.js,
    shuls.js, applicants.js, cards.js, stores.js, forms.js, dashboard.js, tasks.js
frontend/
  css/theme.css           — Brand tokens (deep espresso brown + antique gold, from the org logo)
  js/app.js                — Auth/api/toast/modal/sidebar/signature-pad/compare-table/quick-task helpers, shared by every page
  index.html, apply.html, apply-store.html, login.html, sign-contract.html,
  accept-invite.html, forgot-password.html, reset-password.html,
  form.html (generic public form renderer)
  admin/                  — Internal staff/admin app (dashboard, shuls, applicants, cards, stores, tasks,
                             forms, users, settings, organizations [super_admin only])
  shul-portal/            — Shul login: their own applicants, bulk upload, contract status
  store-portal/           — Store login: onboarding wizard, overview, billing
```

## Data model highlights
- **Multi-tenant**: every table is `org_id`-scoped. `organizations.subdomain` /
  `custom_domain` let one account run several orgs, each with its own branding
  and (once DNS is pointed) its own domain — see `GET /api/orgs/resolve`.
- **Seasons**: `seasons` table with `default_card_amount`; shuls/applicants/cards
  all carry a `season_id` so re-running a season never requires re-uploading
  existing shuls/applicants — only new ones need to be added.
- **Duplicate detection** (`services/duplicates.js`): on every shul/applicant
  create (form, admin, or mass upload) the org is checked for name+location /
  phone / email collisions. A match creates a `duplicate_flags` row and pauses
  **both** records' accounts (`is_paused=1`) — logins are blocked (HTTP 423) and
  shul/applicant actions are rejected until an admin resolves or bypasses the
  flag. The Shuls/Applicants > Duplicates panel lists open flags and can open a
  **full side-by-side comparison** (`renderCompareTable()` in `app.js`, fed by
  `GET /shuls|applicants/duplicates/open` which returns the complete record for
  both sides, differing fields highlighted) before bypassing or resolving.
- **Field-level RBAC** (`middleware/permissions.js`): each internal user gets a
  `permissions` row per resource (`shuls`, `applicants`, `cards`, `stores`,
  `forms`, `users`, `settings`, `dashboard`) with `can_view`/`can_edit`/
  `can_export`, a `scope` (`all` vs `assigned`-only), and a `hidden_fields` JSON
  array — e.g. a user can be granted view access to applicants with
  `first_name`/`last_name` in `hidden_fields` so they see everything except who
  the person is. Enforced server-side in every route via `redact()`; the Admin
  > Users & Permissions page is the UI for it.
- **Configurable required fields**: `form_field_settings` + Settings > Required
  Fields lets the admin toggle which shul/applicant fields are required, which
  are admin-only overridable, and which are visible at all.
- **Audit trail**: `audit_log` records create/update/approve/esign/etc with
  before/after JSON; nothing is ever hard-deleted (deactivate/reject flags only).

## Gift cards — disccardpromos.com, per-org accounts
`src/services/giftcard.js` is the only file that talks to disccardpromos.com —
**one vendor for the whole platform, but every organization runs its own
merchant account/API key** (different orgs, different disccardpromos
accounts). Every exported function (`assignCard`, `activateCard`,
`deactivateCard`, `getCardStatus`, `listTransactions`, `listAllTransactions`,
`isMockMode`) takes `orgId` as its first argument and resolves that org's
credentials from `org_giftcard_settings` first, falling back to the
platform-wide `DISCCARDPROMOS_API_BASE`/`DISCCARDPROMOS_API_KEY` env vars, and
to **MOCK MODE** (simulated card ids, activation, empty transaction feed) if
neither exists — so the rest of the product is fully usable per-org today
regardless of whether that org has real credentials yet. Configured by a
super_admin under Admin > Organizations > Gift Cards. The admin Cards page
shows a banner whenever mock mode is active for the logged-in org.

This is intentionally the SAME per-org pattern as email (below) — every org
gets independent credentials for both integrations, unlike an earlier version
of this build which made gift cards platform-wide only. Don't collapse this
back to a single global account without checking first.

Their docs host (docs.disccardpromos.com) blocked automated fetching from the
build environment, so the exact endpoint paths/payloads in `giftcard.js` are a
best-guess placeholder pending confirmation with their team — once confirmed,
only that one file's request/response mapping changes; nothing else in the
app (routes/cards.js, the UI, the per-org resolution) needs to.

## Email — Brevo, per-org sending accounts
`src/services/mail.js` sends via the Brevo transactional API
(`https://api.brevo.com/v3/smtp/email`). The platform default sends from
`everythingshul.com` (`BREVO_API_KEY` / `EMAIL_DEFAULT_SENDER` /
`EMAIL_DEFAULT_SENDER_NAME` env vars). Any org can be given its **own** Brevo
account + verified sender identity — configured by a super_admin under Admin >
Organizations > Email Settings (`org_email_settings` table). Every
`sendMail(orgId, to, subject, html)` call resolves that org's settings first,
falling back to the platform default; email branding (name/colors in the
template wrapper) also follows the org. No API key configured anywhere →
dry-run mode, emails are logged to console instead of sent (so the app is
fully testable without credentials).

**A live platform-default Brevo API key has been provided by the user** — it
must be set as the `BREVO_API_KEY` environment variable on the deployment
platform (e.g. Render dashboard). It is never committed to this repo (`.env`
is gitignored); this sandbox's network policy also blocks outbound requests to
`api.brevo.com`, so the key could not be live-verified from here — it should
work once the app is actually deployed with normal internet access.

## Tasks / to-do list
Internal-team feature (staff/org_admin/super_admin only — not exposed to shul
or store portal logins). `tasks` table: title, description, `assigned_to`
(any internal user in the org), `due_date`, `priority`, `status`
(open/in_progress/done), and an optional link to a shul/applicant/store
(`entity_type`/`entity_id`) so follow-ups can be created directly from a
record's detail view ("+ Add Task" button — `openQuickTaskModal()` in
`app.js`, used by both Shuls and Applicants detail modals). Full management
UI at Admin > Tasks (filter by assignee/status/overdue); the dashboard also
shows a "My Open Tasks" widget for the logged-in user.

**Reminders**: `services/reminders.js` runs on a 30-minute in-process
interval (plus once ~15s after boot) and emails the assignee — via the same
per-org `sendMail()` used everywhere else, so it respects each org's Brevo
account/branding — for any non-done task due today, tomorrow, or overdue,
throttled to at most one reminder per task per 20 hours (`last_reminded_at`).
Changing a task's due date resets that clock so a rescheduled task doesn't
immediately re-fire. This is a single-instance in-process timer, not an
external cron job — fine for one Render web dyno; if this ever scales to
multiple instances, move it to a dedicated scheduled job so reminders don't
fire once per instance.

## Store onboarding
Mirrors the shul flow: `apply-store.html` is a public application form
(`POST /api/stores/apply`, no auth) that creates a `pending` store with
`source='application'` (vs. `'admin'` for ones the admin adds directly from
Admin > Stores). Either way, an admin invites the store to its portal
(`POST /stores/:id/invite`) the same way shuls are invited. On first login, a
store with an incomplete onboarding (`onboarding_step < 3`) is routed to
`store-portal/onboarding.html`, a 3-step wizard (confirm store/contact info →
owner/billing contact + agree to program terms → done) that
`PUT /stores/:id/onboarding` persists; completing it flips `setup_status` from
`pending` to `in_progress` (final `active` status remains an admin call, since
that typically also means the admin finished setting them up on the card
processor side). The Admin > Stores list/detail shows source and onboarding
progress; a dashboard banner nags an incomplete store until they finish.

## Required external setup to go fully live
1. **Brevo** — `BREVO_API_KEY` for the platform default sender (already
   provided, needs to be set in the deploy environment); individual orgs can
   set their own key in Admin > Organizations. Without any key, email is
   dry-run (console only) — the app is fully usable for testing regardless.
2. **Google Maps** — `GOOGLE_MAPS_API_KEY` (restrict to your domain in Google
   Cloud Console; Places API + Maps JavaScript API enabled). Without it, address
   fields fall back to plain manual text entry — nothing breaks.
3. **disccardpromos.com** — `DISCCARDPROMOS_API_BASE` / `DISCCARDPROMOS_API_KEY`
   as the platform-wide fallback; individual orgs set their own account in
   Admin > Organizations > Gift Cards (see above).
4. **DNS** — point `ecards.everythingshul.com` (and any per-org custom domain)
   at the Render service; `organizations.custom_domain` / `.subdomain` resolve
   branding per-host via `/api/orgs/resolve`.
5. Change the seeded super admin password immediately (`SEED_ADMIN_EMAIL` /
   `SEED_ADMIN_PASSWORD` env vars control the seed; default is printed to logs
   on first boot).

## Key architecture decisions
- **SQLite on persistent disk** — `render.yaml` mounts `/data`; schema is
  create-if-not-exists / guarded `ALTER TABLE`, never destructive.
- **ES modules** everywhere, matching the sibling Mamudem product.
- **No build step** — plain HTML files under `frontend/`, one shared
  `js/app.js` with an `api()` fetch wrapper, `Auth` (JWT in localStorage),
  `renderShell()` (sidebar app shell), `openModal()`, `renderCompareTable()`,
  and a small canvas-based signature pad used by both the public contract flow
  and any future e-sign need.
- **Contract signing flow**: a shul filling the public form (`apply.html`)
  generates + signs the contract in the same sitting; shuls added by admin or
  mass-upload get emailed a signing link instead (`send-contract` /
  `import?send_contracts=true`) — both paths converge on the same
  `contracts` table and `sign-contract.html` page.
- **Permissions are enforced server-side**, not just hidden in the UI — every
  protected route runs through `requirePermission()` and `redact()`.
- **Both email and gift cards are per-org configurable, with a platform-wide
  fallback and mock/dry-run mode below that** — same resolution pattern in
  both `mail.js` and `giftcard.js`. Gift cards stick to disccardpromos.com as
  the only vendor (no multi-vendor registry — that was tried and explicitly
  reverted); email has no vendor lock-in beyond Brevo either, by choice.

## Not yet built / explicitly out of scope this pass
- Real disccardpromos.com endpoint confirmation (mock mode — see above).
- Logo file upload UI (organizations.logo_url exists; no upload endpoint yet).
- Scheduled/cron polling of disccardpromos transactions (manual "Sync Now"
  button exists per card; a periodic job would call the same `giftcard.js`
  functions on a timer once the real API is live).
- A dedicated audit-log viewer UI (data is fully captured in `audit_log`, just
  no page renders it yet).
- Store e-signature/contract (stores currently just check an "I agree" box in
  the onboarding wizard — no PDF, unlike the shul contract flow. Say the word
  if you want the same e-sign treatment stores get as shuls).
- CSV template for XCLS specifically — `xlsx` reads both `.xlsx` and `.csv`;
  "XCLS" wasn't a recognized format so it's treated as a possible typo for XLS/XLSX.

## Deployment
1. `npm install`
2. Set env vars from `render.yaml` (BREVO_API_KEY, JWT_SECRET, APP_URL,
   DISCCARDPROMOS_API_BASE/KEY, etc.)
3. `npm start` (or `render.yaml` on Render — same pattern as the Mamudem service)
