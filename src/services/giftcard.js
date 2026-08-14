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
  if (!cfg.apiBase || !cfg.apiKey) throw new Error('disccardpromos not configured — running in mock mode, this should not be reached');
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

// Assign the next available card to an applicant. Returns { providerCardId, maskedNumber }.
export async function assignCard(orgId, { applicantId, amount }) {
  if (isMockMode(orgId)) {
    const last4 = String(Math.floor(1000 + Math.random() * 9000));
    return { providerCardId: `mock_${randomUUID()}`, maskedNumber: `**** **** **** ${last4}`, amount };
  }
  const body = await call(orgId, '/cards/assign', { method: 'POST', body: JSON.stringify({ external_ref: applicantId, amount }) });
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
