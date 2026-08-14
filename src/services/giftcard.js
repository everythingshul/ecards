// ---------------------------------------------------------------------------
// disccardpromos.com gift card provider — this platform only ever talks to
// disccardpromos (single vendor), but every ORGANIZATION runs its own
// disccardpromos account/API key (different orgs have different merchant
// accounts). Configured by a super_admin under Admin > Organizations > Gift
// Cards (org_giftcard_settings table). Falls back to the platform-wide
// DISCCARDPROMOS_API_BASE/DISCCARDPROMOS_API_KEY env vars if an org hasn't
// set its own, and to MOCK MODE if neither exists.
//
// This module is the only place in the app that talks to disccardpromos.com.
// Every call site in routes/cards.js passes orgId through, so if the real API
// contract differs once confirmed (or they add an endpoint we need), only
// this file changes — nothing about the per-org account resolution does.
//
// Their docs host (docs.disccardpromos.com) blocked automated fetching from
// this build environment, so the exact endpoint paths/payloads below are a
// best-guess placeholder pending confirmation with their team.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import { db } from '../db.js';

const PLATFORM_DEFAULT = {
  apiBase: process.env.DISCCARDPROMOS_API_BASE || '',
  apiKey: process.env.DISCCARDPROMOS_API_KEY || '',
};

function resolveConfig(orgId) {
  const row = orgId ? db.prepare('SELECT * FROM org_giftcard_settings WHERE org_id = ?').get(orgId) : null;
  if (row?.api_base && row?.api_key) return { apiBase: row.api_base, apiKey: row.api_key };
  return PLATFORM_DEFAULT;
}

export function isMockMode(orgId) {
  const cfg = resolveConfig(orgId);
  return !cfg.apiBase || !cfg.apiKey;
}

async function call(orgId, path, opts = {}) {
  const cfg = resolveConfig(orgId);
  if (!cfg.apiBase || !cfg.apiKey) throw new Error('disccardpromos not configured for this org — running in mock mode, this should not be reached');
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
