# everythingshul e-cards platform

## What this is
Season-based gift card assistance management: shuls register + e-sign a contract,
admin approves and allocates applicant slots, shuls submit applicants, admin
approves applicants and issues disccardpromos.com gift cards, and participating
stores have a self-service billing portal. Deploy target: `ecards.everythingshul.com`.

## Stack (mirrors the existing "Mamudem" product's conventions in this org)
- **Backend:** Node.js + Express (ES modules), SQLite via `better-sqlite3`
- **Frontend:** Vanilla HTML/CSS/JS, no framework/build step
- **PDF contracts:** `pdf-lib` (generated + signature-stamped in-process)
- **Email:** Nodemailer (Gmail SMTP by default — same pattern as Mamudem)
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
    mail.js                — Branded email templates + send
    pdf.js                  — Contract PDF generation + e-signature stamping
    giftcard.js              — disccardpromos.com adapter (MOCK MODE until keys set — see below)
    duplicates.js             — Duplicate detection + account pause/unpause
    importer.js                — CSV/XLSX parsing + template generation
  routes/
    auth.js, users.js, orgs.js, seasons.js, settings.js,
    shuls.js, applicants.js, cards.js, stores.js, forms.js, dashboard.js
frontend/
  css/theme.css           — Brand tokens (deep espresso brown + antique gold, from the org logo)
  js/app.js                — Auth/api/toast/modal/sidebar/signature-pad helpers, shared by every page
  index.html, apply.html, login.html, sign-contract.html, accept-invite.html,
  forgot-password.html, reset-password.html, form.html (generic public form renderer)
  admin/                  — Internal staff/admin app (dashboard, shuls, applicants, cards, stores, forms, users, settings)
  shul-portal/            — Shul login: their own applicants, bulk upload, contract status
  store-portal/           — Store login: overview + billing
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
  flag from the Shuls/Applicants > Duplicates panel.
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

## disccardpromos.com integration — IMPORTANT
`src/services/giftcard.js` is the **only** file that talks to disccardpromos.
It runs in **MOCK MODE** (simulated card ids/activation, empty transaction
feed) until both `DISCCARDPROMOS_API_BASE` and `DISCCARDPROMOS_API_KEY` are
set — the admin Cards page shows a banner whenever mock mode is active. Their
real endpoint paths/payloads weren't available to confirm at build time (their
docs host blocked automated fetching from this environment); the function
signatures (`assignCard`, `activateCard`, `deactivateCard`, `getCardStatus`,
`listTransactions`, `listAllTransactions`) already match what `routes/cards.js`
needs — wire the real paths into that one file once confirmed with their team,
nothing else in the app has to change.

## Required external setup to go fully live
1. **SMTP** — `SMTP_USER` / `SMTP_PASS` (Gmail app password). Without it, emails
   just log to console (dry-run) so the app is still fully usable for testing.
2. **Google Maps** — `GOOGLE_MAPS_API_KEY` (restrict to your domain in Google
   Cloud Console; Places API + Maps JavaScript API enabled). Without it, address
   fields fall back to plain manual text entry — nothing breaks.
3. **disccardpromos.com** — see above.
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
  `renderShell()` (sidebar app shell), `openModal()`, and a small canvas-based
  signature pad used by both the public contract flow and any future e-sign need.
- **Contract signing flow**: a shul filling the public form (`apply.html`)
  generates + signs the contract in the same sitting; shuls added by admin or
  mass-upload get emailed a signing link instead (`send-contract` /
  `import?send_contracts=true`) — both paths converge on the same
  `contracts` table and `sign-contract.html` page.
- **Permissions are enforced server-side**, not just hidden in the UI — every
  protected route runs through `requirePermission()` and `redact()`.

## Not yet built / explicitly out of scope this pass
- Real disccardpromos.com wiring (mock mode — see above).
- Logo file upload UI (organizations.logo_url exists; no upload endpoint yet).
- Scheduled/cron polling of disccardpromos transactions (manual "Sync Now"
  button exists per card; a periodic job would call the same `giftcard.js`
  functions on a timer once the real API is live).
- Multi-file "which pages a user can see" is implemented; a dedicated
  audit-log viewer UI is not (data is fully captured in `audit_log`, just no
  page renders it yet).
- CSV template for XCLS specifically — `xlsx` reads both `.xlsx` and `.csv`;
  "XCLS" wasn't a recognized format so it's treated as a possible typo for XLS/XLSX.

## Deployment
1. `npm install`
2. Set env vars from `render.yaml` (SMTP, JWT_SECRET, APP_URL, etc.)
3. `npm start` (or `render.yaml` on Render — same pattern as the Mamudem service)
