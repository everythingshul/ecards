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
// Their docs host (docs.disccardpromos.com) blocked automated fetching from
// this build environment, so the exact endpoint paths/payloads below are a
// best-guess placeholder pending confirmation with their team.
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
      'Authorization': `Bearer ${cfg.apiKey}`,
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
// Accounts & groups — written at applicant-approval time (routes/applicants.js
// POST /:id/approve), separate from assignCard() above (which happens later,
// when an actual card gets handed out). "Account" here means a disccardpromos
// user/member record — the org confirmed the shape as: look the applicant up
// by their external_id; if it already exists, just add the current season to
// it; if it's new, create a fresh account for the current season, filed under
// a "group" matching the applicant's shul (by English name), creating that
// group first if it doesn't already exist.
//
// Endpoint paths/payloads below are still an unverified best guess, same
// caveat as the rest of this file (their docs host blocked automated
// fetching) — the *behavior* (idempotent-by-external_id, group-by-shul-name)
// is now confirmed by the org, but the exact wire format isn't. Confirm
// against their team before this runs live for real.
// ---------------------------------------------------------------------------

// Finds a disccardpromos group by name, creating it if it doesn't exist.
// Returns { groupId }.
export async function findOrCreateGroup(orgId, groupName) {
  if (isMockMode(orgId)) return { groupId: `mock_group_${groupName}` };
  const found = await call(orgId, `/groups?name=${encodeURIComponent(groupName)}`).catch(() => null);
  const existing = (found?.groups || found?.data || [])[0];
  if (existing?.id) return { groupId: existing.id };
  const created = await call(orgId, '/groups', { method: 'POST', body: JSON.stringify({ name: groupName }) });
  return { groupId: created.id || created.group_id };
}

// Looks up an existing disccardpromos account by our applicant's external_id.
// Returns null if not found (a 404 from the provider) or in mock mode.
async function findAccountByExternalId(orgId, externalId) {
  if (isMockMode(orgId)) return null;
  try {
    return await call(orgId, `/accounts/${encodeURIComponent(externalId)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Idempotent upsert used at applicant-approval time: creates the shul's
// group first if needed, then either links the existing account to the
// current season or creates a brand-new one under that group. Returns
// { created, accountId, groupId }.
export async function upsertAccountForApproval(orgId, { externalId, firstName, lastName, groupName, seasonName }) {
  if (isMockMode(orgId)) return { created: true, accountId: `mock_acct_${externalId}`, groupId: `mock_group_${groupName}` };
  const { groupId } = await findOrCreateGroup(orgId, groupName);
  const existing = await findAccountByExternalId(orgId, externalId);
  if (existing) {
    await call(orgId, `/accounts/${encodeURIComponent(externalId)}/seasons`, { method: 'POST', body: JSON.stringify({ season: seasonName }) });
    return { created: false, accountId: existing.id || existing.account_id || externalId, groupId };
  }
  const created = await call(orgId, '/accounts', { method: 'POST', body: JSON.stringify({
    external_ref: externalId, first_name: firstName, last_name: lastName, group_id: groupId, season: seasonName,
  }) });
  return { created: true, accountId: created.id || created.account_id, groupId };
}
