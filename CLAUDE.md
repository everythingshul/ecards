# everythingshul e-cards platform

## What this is
Single-org season-based gift card assistance platform: shuls register + e-sign
a contract, admin approves and allocates applicant slots, shuls submit
applicants, admin approves applicants and issues gift cards via
disccardpromos.com, and participating stores apply/onboard and get a
self-service portal with billing. Deploy target: `ecards.everythingshul.com`.

This is a single-organization deployment — not a multi-tenant SaaS. An
earlier pass built (and then reverted) multi-org support; the `org_id`
columns remain in the schema for internal consistency but there is exactly
one row in `organizations`, seeded at first boot, and no UI to create more.

## Stack (mirrors the existing "Mamudem" product's conventions in this org)
- **Backend:** Node.js + Express (ES modules), SQLite via `better-sqlite3`
- **Frontend:** Vanilla HTML/CSS/JS, no framework/build step
- **PDF contracts:** `pdf-lib` — either a generated text-based PDF or an
  admin-uploaded PDF used as-is, with a signature stamped onto the last page
- **Email:** Brevo transactional API — one platform account, no per-org config
- **Gift cards:** disccardpromos.com — one platform account, no per-org config
- **Spreadsheet import/export:** `xlsx` (reads .csv/.xlsx; full system export
  writes a multi-sheet .xlsx)
- **Auth:** JWT, bcrypt password hashing

## Project structure
```
src/
  index.js               — Express entry, route mounting, static frontend serving,
                            background intervals (task reminders, card sync)
  db.js                  — Full SQLite schema + seed (default org + super admin)
  middleware/
    auth.js               — JWT auth, role guards
    permissions.js         — Field-level + page-level RBAC (see below)
  services/
    mail.js                — Brevo send + branded templates (footer: "Powered by everythingshul.com")
    pdf.js                  — Contract PDF generation/upload + e-signature stamping
    giftcard.js              — disccardpromos.com adapter (MOCK MODE until keys set)
    cardSync.js               — Shared sync logic (single card + sweep-all), used by the
                                 manual "Sync Now"/"Sync All Now" buttons AND the
                                 automatic 15-min background interval
    storeMatch.js              — Resolves a transaction's raw store name to a known store record
    duplicates.js               — Duplicate detection + account pause/unpause
    importer.js                  — CSV/XLSX parsing + template generation
    csv.js                        — Generic CSV writer used by every /export endpoint
    reminders.js                   — Due-date task reminder emails (in-process interval)
  routes/
    auth.js, users.js, orgs.js, seasons.js, settings.js,
    shuls.js, applicants.js, cards.js, stores.js, forms.js, dashboard.js, tasks.js,
    systemExport.js (GET /api/system-export — full multi-sheet .xlsx of everything)
frontend/
  css/theme.css           — Brand tokens (deep espresso brown + antique gold, from the org logo)
  js/app.js                — Auth/api/toast/modal/sidebar/signature-pad/compare-table/
                              quick-task/downloadAuthed helpers, shared by every page
  index.html, apply.html, apply-store.html, login.html, sign-contract.html,
  accept-invite.html, forgot-password.html, reset-password.html,
  form.html (generic public form renderer)
  admin/                  — Internal staff/admin app (dashboard, shuls, applicants, cards,
                             stores, tasks, forms, users, settings)
  shul-portal/            — Shul login: their own applicants, bulk upload, contract status
  store-portal/           — Store login: onboarding wizard, overview, billing
```

## Data model highlights
- **Seasons**: `seasons` table with `default_card_amount`; shuls/applicants/cards
  all carry a `season_id` so re-running a season never requires re-uploading
  existing shuls/applicants — only new ones need to be added.
- **Duplicate detection** (`services/duplicates.js`): on every shul/applicant
  create (form, admin, or mass upload), checked for name+location / phone /
  email collisions. A match creates a `duplicate_flags` row and pauses
  **both** records' accounts (`is_paused=1`) — logins are blocked (HTTP 423)
  and shul/applicant actions are rejected until an admin resolves or bypasses
  the flag. Shuls/Applicants > Duplicates panel can open a **full side-by-side
  comparison** (`renderCompareTable()` in `app.js`) before deciding.
- **Field-level RBAC** (`middleware/permissions.js`): each internal user gets a
  `permissions` row per resource (`shuls`, `applicants`, `cards`, `stores`,
  `forms`, `users`, `settings`, `dashboard`) with `can_view`/`can_edit`/
  `can_export`, a `scope` (`all` vs `assigned`-only), and a `hidden_fields`
  JSON array — e.g. a user can see applicants with `first_name`/`last_name`
  hidden. Enforced server-side via `redact()`, including on export endpoints.
  Admin > Users & Permissions is the UI.
- **Configurable required fields**: `form_field_settings` + Settings >
  Required Fields lets the admin toggle which shul/applicant fields are
  required, admin-only overridable, or visible at all.
- **Audit trail**: `audit_log` records create/update/approve/esign/etc with
  before/after JSON; nothing is ever hard-deleted (deactivate/reject flags only).
- **Tasks / to-do list**: internal-team only (staff/org_admin/super_admin).
  Assign to any user, due date + priority, optional link to a shul/applicant/
  store (`entity_type`/`entity_id` — "+ Add Task" from those detail views).
  Automatic email reminders (`services/reminders.js`, 30-min interval) for
  anything due today/tomorrow/overdue, throttled to one per task per 20h.

## Gift cards — disccardpromos.com (single platform account)
`src/services/giftcard.js` is the only file that talks to disccardpromos.com.
Set `DISCCARDPROMOS_API_BASE` / `DISCCARDPROMOS_API_KEY` to go live; until
both are set it runs in **MOCK MODE** (simulated card ids, activation, empty
transaction feed) so the rest of the product is fully usable today. The admin
Cards page shows a banner whenever mock mode is active.

**Sync is automatic**, not just manual: `services/cardSync.js` sweeps every
assigned/activated card every 15 minutes in the background (`index.js`),
pulling new transactions and resolving each one's store name to a known
store record (`storeMatch.js`) so per-store spend stays live without anyone
clicking in. A "Sync All Now" button on Admin > Cards triggers an immediate
sweep; "Sync Now" on the card detail modal does one card. `assignCard()` also
pushes the applicant's internal ID as `external_ref` when a card is created —
disccardpromos only ever learns the card/applicant *reference*, not personal
details; **this app remains the system of record for all applicant data**.

Their docs host (docs.disccardpromos.com) blocked automated fetching from the
build environment, so the exact endpoint paths/payloads in `giftcard.js` are
a best-guess placeholder pending confirmation with their team — once
confirmed, only that file's request/response mapping changes.

## Email — Brevo (single platform account)
`src/services/mail.js` sends via the Brevo transactional API
(`https://api.brevo.com/v3/smtp/email`), using `BREVO_API_KEY` /
`EMAIL_DEFAULT_SENDER` / `EMAIL_DEFAULT_SENDER_NAME`. No API key → dry-run
mode (logged to console, not sent) — fully testable without credentials.
Every email template footer reads "Powered by everythingshul.com" linking to
the site, matching the site's own footer treatment.

**Every `sendMail()` call site is awaited and wrapped in try/catch** — a
failure is logged server-side (`[mail] ... failed: <reason>`) and returned to
the frontend as `emailError` in the response, surfaced as a toast, instead of
failing silently. **Most common real-world cause of send failures**: Brevo
requires the sender identity (`EMAIL_DEFAULT_SENDER`) to be a verified sender
or domain in your Brevo account (Senders & IP) — an unverified sender fails
every send with an auth/sender error, which will now show up as that toast.

A live Brevo API key has been provided by the user for `BREVO_API_KEY` — it
must be set as an environment variable on the deploy platform (Render), never
committed to the repo. This sandbox's network policy blocks outbound requests
to `api.brevo.com`, so it could not be live-verified from here.

## Downloads / exports — always use `downloadAuthed()`
This app has no cookie session, only a Bearer token in `localStorage`. A
plain `location.href = '/api/...'` navigation sends **no** Authorization
header and 401s silently — this was a real bug (found while adding exports;
"Download Import Template" had been broken since it was written). Every file
download in the frontend must go through `downloadAuthed(path, filename)` in
`app.js` (fetch with auth header → blob → save), never a raw `location.href`
or anchor `href` pointing at `/api/...`.

Every list page (Shuls, Applicants, Cards + Transactions, Stores, Tasks) has
an "Export CSV" button hitting `GET /api/<resource>/export` — full detail, no
pagination, respects current filters, gated behind `can_export` + field
redaction like everything else. `GET /api/system-export` (Settings >
Organization) downloads one Excel workbook with every table as its own sheet
— shuls, notes, contracts, applicants, notes, cards, transactions, stores,
billing, tasks, users, seasons, duplicate flags, audit log.

## Contract PDFs
Settings > Contract Template supports two modes:
1. **Uploaded PDF** (`POST/DELETE /api/settings/contract-pdf`, stored at
   `DATA_DIR/contracts/org-template.pdf`) — used verbatim as every shul's
   contract body.
2. **Generated text template** (fallback when no PDF is uploaded) — a simple
   in-process PDF built from the shul/season details + admin-editable clause
   text.

Either way, `stampSignature()` in `pdf.js` adds the signature (drawn PNG or
typed name) + signer/date/IP to the bottom of the **last page**, positioned
relative to that page's actual dimensions (works correctly for both the
generated Letter-size doc and an arbitrary uploaded PDF).

## Generic documents (applicants + stores)
Same idea as the shul contract above, generalized to any applicant or store
via a parallel `documents` table/route (`src/routes/documents.js`) — the
shul `contracts` table/flow was left untouched to avoid regressions.

- **Settings > Documents** has three sections: Shul Contract (existing),
  Applicant Agreement, Store Agreement. Each independently supports an
  uploaded PDF (`POST/DELETE /api/settings/document-pdf/:entityType`,
  `entityType` is `applicant` or `store`, stored at
  `DATA_DIR/contracts/org-template-<entityType>.pdf`) or generated template
  text (`document_template_text_applicant` / `document_template_text_store`
  keys via the generic `PUT /api/settings`).
- Admin flow, from the applicant/store detail modal's **Documents** tab:
  `POST /api/documents/generate` (builds the unsigned PDF + a `pending` row)
  → `POST /api/documents/:id/send` (emails a signing link; `email` in the
  body overrides the default so a specific document can go to a specific
  person, not just the record's own email on file — the "Send To" field on
  each row) → the recipient always gets an emailed link
  (`sign-document.html?token=...`) regardless of who they are.
- Public signing: `GET /api/documents/sign/:token`,
  `GET /api/documents/sign/:token/pdf-preview`,
  `POST /api/documents/sign/:token/sign` — mirrors the shul
  `contract/:token*` endpoints, stamped via the same `stampSignature()`.
- `GET /api/documents/:id/pdf` (admin) serves the signed PDF once available,
  else the unsigned one.

## Store onboarding
Mirrors the shul flow: `apply-store.html` is a public application form
(`POST /api/stores/apply`, no auth) creating a `pending` store with
`source='application'` (vs `'admin'` for admin-added ones). An admin invites
either kind to the portal (`POST /stores/:id/invite`). A store with
incomplete onboarding (`onboarding_step < 3`) is routed to
`store-portal/onboarding.html` on first login — a 3-step wizard (confirm
info → owner/billing contact + agree to terms → done) that flips
`setup_status` from `pending` to `in_progress` (final `active` is an admin
call). Admin > Stores shows source, onboarding progress, and **live spend**
(purchases/refunds/transaction count, computed fresh from synced
transactions on every request — not cached). Dashboard has a "Live Store
Spend" panel with total spend + top-5 breakdown.

## Required external setup to go fully live
1. **Brevo** — `BREVO_API_KEY` (provided by the user, needs to be set in the
   deploy environment) + a verified sender identity in the Brevo dashboard.
2. **Google Maps** — `GOOGLE_MAPS_API_KEY` (restrict to your domain; Places +
   Maps JavaScript API enabled). Without it, address autofill is skipped —
   forms remain fully usable with manual entry.
3. **disccardpromos.com** — `DISCCARDPROMOS_API_BASE` / `DISCCARDPROMOS_API_KEY`.
4. **DNS** — point `ecards.everythingshul.com` at the Render service.
5. Change the seeded super admin password immediately (`SEED_ADMIN_EMAIL` /
   `SEED_ADMIN_PASSWORD` env vars control the seed).

## Key architecture decisions
- **SQLite on persistent disk** — `render.yaml` mounts `/data`; schema is
  create-if-not-exists / guarded `ALTER TABLE`, never destructive.
- **ES modules** everywhere, matching the sibling Mamudem product.
- **No build step** — plain HTML files under `frontend/`, one shared
  `js/app.js`.
- **Single organization, single set of credentials for every integration** —
  this was tried both ways (per-org Brevo/disccardpromos, then reverted to
  platform-wide) and platform-wide is the current, intentional, final state.
  Don't reintroduce per-org credential tables without checking first.
- **Permissions are enforced server-side**, not just hidden in the UI — every
  protected route runs through `requirePermission()` and `redact()`, exports included.
- **Every `<script>` block on a page is a single parse unit** — one syntax
  error anywhere in it (e.g. a mis-escaped quote) silently blanks the entire
  page, since nothing in that block runs, not even `renderShell()`. This bit
  us twice (Applicants, Cards pages). Run the frontend syntax audit below
  after editing any `<script>` block before considering the change done.

## Not yet built / explicitly out of scope this pass
- Real disccardpromos.com endpoint confirmation (mock mode — see above).
- Logo file upload UI (organizations.logo_url exists; no upload endpoint yet;
  the actual org + everythingshul logo image files have not been obtained —
  attempts to fetch them from user-provided URLs were blocked by this
  sandbox's network policy, need the user to attach the files directly).
- A dedicated audit-log viewer UI (data is fully captured in `audit_log`, just
  no page renders it yet).
- CSV template for "XCLS" specifically — `xlsx` reads both `.xlsx` and `.csv`;
  treated as a likely typo for XLS/XLSX.
- Homepage/full visual redesign with real logo assets — blocked on the logo
  files (see above).

## Deployment
1. `npm install`
2. Set env vars from `render.yaml` (BREVO_API_KEY, JWT_SECRET, APP_URL,
   DISCCARDPROMOS_API_BASE/KEY, GOOGLE_MAPS_API_KEY, etc.)
3. `npm start` (or `render.yaml` on Render — same pattern as the Mamudem service)

## Sanity checks worth re-running after any frontend/backend edit
```bash
# Backend syntax
for f in $(find src -name '*.js'); do node --check "$f" || echo "SYNTAX ERROR in $f"; done

# Every inline <script> block on every page actually parses (catches the
# "whole page goes blank" bug class — see above)
for f in $(find frontend -name '*.html'); do
  python3 -c "
import re
content = open('$f').read()
for i, s in enumerate(re.findall(r'<script(?:\s+src=[^>]*)?>(.*?)</script>', content, re.S)):
    if s.strip(): open(f'/tmp/audit_{i}.js','w').write(s)
"
  for jsf in /tmp/audit_*.js; do [ -f "$jsf" ] && node --check "$jsf"; rm -f "$jsf"; done
done
```
