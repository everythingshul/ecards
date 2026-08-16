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
// CONFIRMED against real API docs (2026-08-16): base https://api.disccardpromos.com,
// auth header is `Authorization: Token <key>` — NOT Bearer. The "Customers"
// resource (/org/customers/...) below is fully confirmed. The card-level
// functions further down (assign/activate/deactivate/status/transactions)
// are still an unverified best-guess placeholder — their docs host
// (docs.disccardpromos.com) is blocked by this environment's network egress
// policy, so those are pending the same kind of confirmation the Customers
// endpoints just got.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';

const CONFIG = {
  apiBase: process.env.DISCCARDPROMOS_API_BASE || '',
  apiKey: process.env.DISCCARDPROMOS_API_KEY || '',
};

export function isMockMode() {
  return !CONFIG.apiBase || !CONFIG.apiKey;
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
// Customers — CONFIRMED (2026-08-16). This is disccardpromos's term for what
// the rest of this app calls an "account": /org/customers/... . Written at
// applicant-approval time (routes/applicants.js POST /:id/approve), separate
// from assignCard() below (which happens later, when an actual card gets
// handed out).
//
// Their "group" is NOT a separate resource with its own id — `group_name` is
// a plain string field directly on the customer record, just sent along on
// create/update. No find-or-create-group call is needed (this replaces an
// earlier guess that assumed a dedicated /groups endpoint).
//
// Still unconfirmed: how "current season" maps onto their data model —
// nothing in the Customer resource represents a season directly. The
// customer's `packages` array (each with its own id/name/amount/rate) is the
// likely place — one seeded example package was literally named "Vip Grocery
// 2025" — but which package to attach for a given season, and through which
// endpoint, needs their Packages docs to confirm. `seasonName` is threaded
// through below and intentionally unused for now rather than guessed at.
// ---------------------------------------------------------------------------

// Looks up an existing disccardpromos customer by OUR applicant's
// external_id. Returns null if not found (a 404 from the provider) or in
// mock mode.
export async function findCustomerByExternalId(orgId, externalId) {
  if (isMockMode(orgId)) return null;
  try {
    return await call(orgId, `/org/customers/by-external-id/${encodeURIComponent(externalId)}/`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function createCustomer(orgId, { externalId, firstName, lastName, groupName }) {
  if (isMockMode(orgId)) return { id: `mock_${externalId}`, external_id: externalId, group_name: groupName };
  return call(orgId, '/org/customers/', { method: 'POST', body: JSON.stringify({
    external_id: externalId, first_name: firstName, last_name: lastName, group_name: groupName,
  }) });
}

export async function updateCustomer(orgId, customerId, patch) {
  if (isMockMode(orgId)) return { id: customerId, ...patch };
  return call(orgId, `/org/customers/${customerId}/`, { method: 'PATCH', body: JSON.stringify(patch) });
}

// Idempotent upsert used at applicant-approval time: an existing customer
// (matched by external_id) gets its group_name refreshed to the shul's
// current English name; a new one gets created under that group. Returns
// { created, accountId }. (seasonName isn't wired to anything yet — see
// note above.)
export async function upsertAccountForApproval(orgId, { externalId, firstName, lastName, groupName, seasonName }) {
  if (isMockMode(orgId)) return { created: true, accountId: `mock_acct_${externalId}` };
  const existing = await findCustomerByExternalId(orgId, externalId);
  if (existing) {
    const updated = await updateCustomer(orgId, existing.id, { group_name: groupName });
    return { created: false, accountId: updated.id ?? existing.id };
  }
  const created = await createCustomer(orgId, { externalId, firstName, lastName, groupName });
  return { created: true, accountId: created.id };
}
