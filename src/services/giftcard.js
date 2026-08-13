// ---------------------------------------------------------------------------
// disccardpromos.com gift card provider adapter
// ---------------------------------------------------------------------------
// This module is the ONLY place in the app that talks to disccardpromos.com.
// Every call site in routes/cards.js goes through the functions below, so if/when
// the real API contract differs (or they add an endpoint we need), only this
// file changes.
//
// Set these env vars to go live:
//   DISCCARDPROMOS_API_BASE   e.g. https://api.disccardpromos.com/v1
//   DISCCARDPROMOS_API_KEY
//
// Until both are set, this adapter runs in MOCK MODE: it simulates realistic
// responses (card ids, activation, transactions) so the rest of the product —
// UI, ledger, balances, refunds — is fully buildable/demoable today. Swap
// MOCK_MODE off the moment real credentials + confirmed endpoint paths are
// available; the shape of what each function returns is documented per method
// and is what routes/cards.js expects regardless of mode.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';

const API_BASE = process.env.DISCCARDPROMOS_API_BASE;
const API_KEY = process.env.DISCCARDPROMOS_API_KEY;
export const MOCK_MODE = !API_BASE || !API_KEY;

async function call(path, opts = {}) {
  if (MOCK_MODE) throw new Error('disccardpromos not configured — running in mock mode, this should not be reached');
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
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
export async function assignCard({ applicantId, amount }) {
  if (MOCK_MODE) {
    const last4 = String(Math.floor(1000 + Math.random() * 9000));
    return { providerCardId: `mock_${randomUUID()}`, maskedNumber: `**** **** **** ${last4}`, amount };
  }
  // NOTE: exact path/payload TBD once we confirm the real endpoint with disccardpromos.
  const body = await call('/cards/assign', { method: 'POST', body: JSON.stringify({ external_ref: applicantId, amount }) });
  return { providerCardId: body.card_id, maskedNumber: body.masked_number, amount: body.amount ?? amount };
}

// Activate a card by the phone number the recipient provides — this is what
// "writes" the card onto their account per the spec. Returns { activatedAt }.
export async function activateCard({ providerCardId, phone }) {
  if (MOCK_MODE) return { activatedAt: new Date().toISOString() };
  const body = await call(`/cards/${providerCardId}/activate`, { method: 'POST', body: JSON.stringify({ phone }) });
  return { activatedAt: body.activated_at || new Date().toISOString() };
}

export async function deactivateCard({ providerCardId, reason }) {
  if (MOCK_MODE) return { deactivatedAt: new Date().toISOString() };
  const body = await call(`/cards/${providerCardId}/deactivate`, { method: 'POST', body: JSON.stringify({ reason }) });
  return { deactivatedAt: body.deactivated_at || new Date().toISOString() };
}

// Returns { balance, activatedAt, status }
export async function getCardStatus({ providerCardId }) {
  if (MOCK_MODE) return { balance: null, activatedAt: null, status: 'unknown (mock mode)' };
  return call(`/cards/${providerCardId}`);
}

// Returns an array of raw transactions: { id, type, amount, store_name, occurred_at, ... }
// Used both for a manual "sync now" action and a scheduled poll (see index.js cron).
export async function listTransactions({ providerCardId, since }) {
  if (MOCK_MODE) return [];
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const body = await call(`/cards/${providerCardId}/transactions${qs}`);
  return body.transactions || body.data || [];
}

// Pull transactions across ALL cards since a timestamp, if the provider supports
// a bulk feed (cheaper than per-card polling). Falls back to null so the caller
// knows to loop per-card instead.
export async function listAllTransactions({ since }) {
  if (MOCK_MODE) return null;
  try {
    const body = await call(`/transactions?since=${encodeURIComponent(since || '')}`);
    return body.transactions || body.data || null;
  } catch {
    return null; // endpoint may not exist — caller falls back to per-card polling
  }
}
