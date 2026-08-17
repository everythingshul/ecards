// ---------------------------------------------------------------------------
// disccardpromos.com gift card provider — single-org platform, single
// disccardpromos account for the whole system. Set DISCCARDPROMOS_API_BASE /
// DISCCARDPROMOS_API_KEY to go live; MOCK MODE (simulated card ids,
// activation, empty transaction feed) until both are set.
//
// (This app previously supported a per-org disccardpromos account per
// organization; that was reverted along with per-org email — the whole
// platform now runs as one organization, one merchant account. Function
// signatures still take an unused orgId first argument to avoid touching
// every call site in routes/cards.js.)
//
// This module is the only place in the app that talks to disccardpromos.com —
// if the real API contract differs once confirmed (or they add an endpoint we
// need), only this file changes.
//
// CONFIRMED against real API docs (2026-08-16/17): base
// https://api.disccardpromos.com, auth header is `Authorization: Token <key>`
// — NOT Bearer. Two resource groups are now confirmed against real docs
// pasted in by the user (docs.disccardpromos.com itself is blocked by this
// environment's network egress policy, so we only ever see what gets pasted
// in directly):
//   - Customers: /org/customers/... — see the block further down.
//   - Card ops: /v1/balances/, /v1/charge/, /v1/refund/, /v1/add-funds/ —
//     see getCardBalance/chargeCard/refundCard/addFunds below.
//
// IMPORTANT — this changes the mental model of "assigning a card":
// /v1/add-funds/ credits a customer's balance against one of their
// `packages` (their term for what we'd call a season's Discount), identified
// by discount_id, and takes the customer by our external_id directly. There
// is no confirmed "assign/activate a card to an applicant" endpoint at all —
// every real endpoint we've seen operates on an existing customer (who
// already carries `active_cards`), not on a card being provisioned fresh.
// assignCard/activateCard/deactivateCard/getCardStatus/listTransactions
// below are the OLD unverified best-guess placeholder (paths like
// /cards/assign, /cards/:id/activate) and almost certainly do NOT match the
// real API — real confirmed paths all live under /v1/ or /org/, never
// /cards/. They're left in place (and still used by routes/cards.js /
// services/cardSync.js) because pulling them without a confirmed
// replacement would break the app; treat them as known-wrong pending real
// docs for card provisioning/activation and a transaction-history endpoint.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';

const CONFIG = {
  // Every call below does `${apiBase}${path}` with a path that already
  // starts with '/' (e.g. '/org/customers/') — a trailing slash on the
  // configured base (a very easy copy-paste mistake, e.g.
  // 'https://api.disccardpromos.com/') would silently double it up into
  // '...com//org/customers/', which many API gateways 404 on. Stripped here
  // once so every caller is safe regardless of how the env var was entered.
  apiBase: (process.env.DISCCARDPROMOS_API_BASE || '').replace(/\/+$/, ''),
  apiKey: process.env.DISCCARDPROMOS_API_KEY || '',
};

export function isMockMode() {
  return !CONFIG.apiBase || !CONFIG.apiKey;
}

// Loud, unmissable startup log — every mock-mode function below returns a
// fake success silently (no error, no thrown exception), so a half-set
// config (e.g. the API key deployed but not the base URL, or vice versa)
// otherwise looks identical to a fully-working live integration: approvals
// "succeed", accounts "get created", funds "get added" — nothing on
// disccardpromos' side ever actually happens, and there is no other signal
// that anything is wrong. This runs once at process start so it's the first
// thing visible in the deploy's server logs.
if (isMockMode()) {
  const missing = [!CONFIG.apiBase && 'DISCCARDPROMOS_API_BASE', !CONFIG.apiKey && 'DISCCARDPROMOS_API_KEY'].filter(Boolean);
  console.warn(`[giftcard] MOCK MODE — disccardpromos calls are simulated, nothing is sent to the real API. Missing env var(s): ${missing.join(', ')}.`);
} else {
  console.log(`[giftcard] disccardpromos LIVE mode — base ${CONFIG.apiBase}`);
}

async function call(orgId, path, opts = {}) {
  const cfg = CONFIG;
  if (!cfg.apiBase || !cfg.apiKey) throw new Error('disccardpromos not configured (running in mock mode; this should not be reached)');
  const res = await fetch(`${cfg.apiBase}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Token ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.message || `disccardpromos API error ${res.status}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Card ops — CONFIRMED (2026-08-17) against real API docs. All four live
// under /v1/, distinct from the /org/customers/ prefix the Customers
// resource uses below.
// ---------------------------------------------------------------------------

// Live balance check for one card by its card number. Returns the raw
// provider response (docs show a balance figure keyed off cardNum) so
// callers can pick the field they need rather than this module guessing at
// a normalized shape.
export async function getCardBalance(orgId, { cardNum }) {
  if (isMockMode(orgId)) return { balance: null, mock: true };
  return call(orgId, `/v1/balances/?cardNum=${encodeURIComponent(cardNum)}`);
}

// What a store's own register/card-reader calls at checkout to deduct from a
// card's balance — this app doesn't run a POS, so nothing currently calls
// this, but it's exposed as a correct, confirmed function in case a future
// store-portal manual-charge feature needs it.
export async function chargeCard(orgId, { cardNum, amount }) {
  if (isMockMode(orgId)) return { success: true, mock: true };
  return call(orgId, '/v1/charge/', { method: 'POST', body: JSON.stringify({ cardNum, amount }) });
}

// Store-side reversal of a charge — same "not called anywhere yet" caveat as
// chargeCard above.
export async function refundCard(orgId, { cardNum, amount }) {
  if (isMockMode(orgId)) return { success: true, mock: true };
  return call(orgId, '/v1/refund/', { method: 'POST', body: JSON.stringify({ cardNum, amount }) });
}

// Credits amount onto a customer's balance against one of their `packages`
// (discountId) — this is what actually loads money onto a card, identified
// by OUR applicant's external_id rather than a disccardpromos customer id.
// Wired into applicant approval (routes/applicants.js) — per-season/package
// mapping was explicitly ruled out; there's one org-wide Package/Discount ID
// (Settings > Organization > Gift Card Loading, settings key
// disccardpromos_discount_id) used for every approval regardless of season.
export async function addFunds(orgId, { externalId, discountId, amount }) {
  if (isMockMode(orgId)) return { success: true, mock: true };
  return call(orgId, '/v1/add-funds/', { method: 'POST', body: JSON.stringify({
    external_id: externalId, discount_id: discountId, amount,
  }) });
}

// ---------------------------------------------------------------------------
// OLD unverified placeholder — see the file header note above. Kept in use
// by routes/cards.js and services/cardSync.js pending confirmed real
// endpoints for provisioning/activating a card and reading its transaction
// history.
// ---------------------------------------------------------------------------

// Assign the next available card to an applicant. externalId is the
// applicant's 4-digit external_id (see utils/externalId.js) — disccardpromos
// uses this as its own external reference for the card, in place of our
// internal UUID. Returns { providerCardId, maskedNumber }.
export async function assignCard(orgId, { applicantId, externalId, amount }) {
  if (isMockMode(orgId)) {
    const last4 = String(Math.floor(1000 + Math.random() * 9000));
    return { providerCardId: `mock_${randomUUID()}`, maskedNumber: `**** **** **** ${last4}`, amount };
  }
  const body = await call(orgId, '/cards/assign', { method: 'POST', body: JSON.stringify({ external_ref: externalId || applicantId, amount }) });
  return { providerCardId: body.card_id, maskedNumber: body.masked_number, amount: body.amount ?? amount };
}

// Activate a card by the phone number the recipient provides — this is what
// "writes" the card onto their account per the spec. Returns { activatedAt }.
export async function activateCard(orgId, { providerCardId, phone }) {
  if (isMockMode(orgId)) return { activatedAt: new Date().toISOString() };
  const body = await call(orgId, `/cards/${providerCardId}/activate`, { method: 'POST', body: JSON.stringify({ phone }) });
  return { activatedAt: body.activated_at || new Date().toISOString() };
}

export async function deactivateCard(orgId, { providerCardId, reason }) {
  if (isMockMode(orgId)) return { deactivatedAt: new Date().toISOString() };
  const body = await call(orgId, `/cards/${providerCardId}/deactivate`, { method: 'POST', body: JSON.stringify({ reason }) });
  return { deactivatedAt: body.deactivated_at || new Date().toISOString() };
}

// Returns { balance, activatedAt, status }
export async function getCardStatus(orgId, { providerCardId }) {
  if (isMockMode(orgId)) return { balance: null, activatedAt: null, status: 'unknown (mock mode)' };
  return call(orgId, `/cards/${providerCardId}`);
}

// Returns an array of raw transactions: { id, type, amount, store_name, occurred_at, ... }
export async function listTransactions(orgId, { providerCardId, since }) {
  if (isMockMode(orgId)) return [];
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const body = await call(orgId, `/cards/${providerCardId}/transactions${qs}`);
  return body.transactions || body.data || [];
}

// Pull transactions across ALL cards since a timestamp, if the provider supports
// a bulk feed (cheaper than per-card polling). Falls back to null so the caller
// knows to loop per-card instead.
export async function listAllTransactions(orgId, { since }) {
  if (isMockMode(orgId)) return null;
  try {
    const body = await call(orgId, `/transactions?since=${encodeURIComponent(since || '')}`);
    return body.transactions || body.data || null;
  } catch {
    return null; // endpoint may not exist — caller falls back to per-card polling
  }
}

// ---------------------------------------------------------------------------
// Customers — CONFIRMED against disccardpromos's real Customer Management API
// docs (2026-08-17): /org/customers/... . This is their term for what the
// rest of this app calls an "account", written at applicant-approval time
// (routes/applicants.js POST /:id/approve).
//
// Their "group" is NOT a separate resource with its own id — `group_name` is
// a plain string field directly on the customer record, just sent along on
// create/update; passing an unknown group_name creates it automatically.
//
// IMPORTANT — there is no separate "assign/provision a new card" endpoint at
// all. A customer carries a `card_number` write field ("activate a card
// number for this customer") and a read-only `active_cards` array (masked
// numbers) — disccardpromos expects the ORG to already hold real physical
// card numbers and "assigning a card" means activating one of those numbers
// against a customer via PATCH, not generating a fresh card id the way the
// old assignCard()/activateCard() below (still kept for
// deactivate/status/transactions, which their docs don't cover) guessed.
// See linkCardToCustomer() / getCustomer() further down.
//
// Still unconfirmed: how "current season" maps onto their data model —
// nothing in the Customer resource represents a season directly. The
// customer's `packages` array (each with its own id/name/amount/rate) is the
// likely place — one seeded example package was literally named "Vip Grocery
// 2025" — but which package to attach for a given season, and through which
// endpoint, needs their Packages docs to confirm. `seasonName` is threaded
// through below and intentionally unused for now rather than guessed at.
// ---------------------------------------------------------------------------

// Every writable Customer field per their docs, mapped from our applicant
// shape. house_number/street/appartment are three separate fields on their
// side but one free-text `address` on ours — sent whole as `street` (with
// house_number left unset) rather than guessing a split that would silently
// mis-parse real addresses.
function customerPayload({ firstName, lastName, groupName, homePhone, cell, email, phone2, address, city, state, zip, officeNotes, isActive, cardNumber, amount }) {
  const body = {
    first_name: firstName, last_name: lastName, group_name: groupName,
    home_phone: homePhone, cell, email, phone2,
    street: address, city, state, zip,
    office_notes: officeNotes, is_active: isActive,
    card_number: cardNumber, amount,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined || body[k] === '') delete body[k];
  return body;
}

// Looks up an existing disccardpromos customer by OUR applicant's
// external_id. Returns null if not found (a 404 from the provider) or in
// mock mode.
export async function findCustomerByExternalId(orgId, externalId) {
  if (isMockMode(orgId)) return null;
  try {
    const result = await call(orgId, `/org/customers/by-external-id/${encodeURIComponent(externalId)}/`);
    // Diagnostic for the "re-approving creates a duplicate customer instead
    // of updating" report: if this fires and shows found=false/no id on an
    // applicant that's been approved before, the by-external-id lookup
    // itself is the thing not matching what create actually stored (wrong
    // endpoint shape, or the real API doesn't echo external_id the way
    // that path assumes) — upsertAccountForApproval below has no way to
    // know that without this logged.
    console.log(`[giftcard] findCustomerByExternalId(${externalId}) -> found id=${result?.id ?? '(none in response)'}`);
    return result;
  } catch (e) {
    if (e.status === 404) { console.log(`[giftcard] findCustomerByExternalId(${externalId}) -> 404 not found`); return null; }
    console.error(`[giftcard] findCustomerByExternalId(${externalId}) -> unexpected error (status ${e.status}): ${e.message}`);
    throw e;
  }
}

export async function createCustomer(orgId, opts) {
  const { externalId } = opts;
  if (isMockMode(orgId)) return { id: `mock_${externalId}`, external_id: externalId, group_name: opts.groupName, active_cards: [] };
  return call(orgId, '/org/customers/', { method: 'POST', body: JSON.stringify({ external_id: externalId, ...customerPayload(opts) }) });
}

// Their docs show PATCH at '/org/customers/{id}' with no trailing slash —
// every other Customer endpoint (list/create/get-by-id/get-by-external-id/
// delete) documents one, so this is very possibly just a docs typo, but
// it's what's actually written, and a slash mismatch against a strict
// Django-style router is exactly the kind of thing that would 404 silently
// enough to look like "nothing happens" from our side. Matching it exactly
// rather than guessing "they probably meant consistent" — if this is wrong
// the now-loud error logging around this call will show it plainly.
export async function updateCustomer(orgId, customerId, opts) {
  if (isMockMode(orgId)) return { id: customerId, ...customerPayload(opts) };
  return call(orgId, `/org/customers/${customerId}`, { method: 'PATCH', body: JSON.stringify(customerPayload(opts)) });
}

export async function deleteCustomer(orgId, customerId) {
  if (isMockMode(orgId)) return { ok: true };
  return call(orgId, `/org/customers/${customerId}/`, { method: 'DELETE' });
}

// Full customer record including active_cards (masked numbers) and packages
// — balances/transactions are opt-in per their docs (?balances=true /
// ?transactions=true) since presumably heavier to compute. Used by
// syncCustomerCards() below to mirror what's actually on disccardpromos'
// side into our local `cards` table, which is the only way to pick up a
// card that was assigned directly in their dashboard rather than through
// this app.
export async function getCustomerByExternalId(orgId, externalId, { balances = false, transactions = false } = {}) {
  if (isMockMode(orgId)) return null;
  const qs = [balances && 'balances=true', transactions && 'transactions=true'].filter(Boolean).join('&');
  try {
    return await call(orgId, `/org/customers/by-external-id/${encodeURIComponent(externalId)}/${qs ? `?${qs}` : ''}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// "Assigning a card" on disccardpromos means activating a real physical card
// number the org already holds against a customer — there is no endpoint
// that generates/provisions a fresh card number. cardNumber must be a real
// number an admin has in hand (e.g. from a batch of physical cards).
export async function linkCardToCustomer(orgId, customerId, cardNumber) {
  if (isMockMode(orgId)) return { id: customerId, active_cards: [`****${String(cardNumber).slice(-4)}`] };
  return call(orgId, `/org/customers/${customerId}`, { method: 'PATCH', body: JSON.stringify({ card_number: cardNumber }) });
}

// Idempotent upsert used at applicant-approval time: an existing customer
// (matched by external_id) gets every field below refreshed (name, contact
// info, address, group) rather than just group_name — the "not all info
// transfers" report was this function only ever sending
// external_id/first_name/last_name/group_name even though the applicant
// record (and disccardpromos' own Customer schema) has phone/email/address
// too. A new customer gets created with the same full set. Returns
// { created, accountId }. (seasonName isn't wired to anything yet — see
// note above.)
export async function upsertAccountForApproval(orgId, opts) {
  const { externalId } = opts;
  if (isMockMode(orgId)) return { created: true, accountId: `mock_acct_${externalId}` };
  const existing = await findCustomerByExternalId(orgId, externalId);
  if (existing) {
    const updated = await updateCustomer(orgId, existing.id, opts);
    return { created: false, accountId: updated.id ?? existing.id };
  }
  const created = await createCustomer(orgId, opts);
  return { created: true, accountId: created.id };
}
