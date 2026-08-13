// ---------------------------------------------------------------------------
// Generic REST gift-card adapter factory. Every provider currently registered
// (see index.js) is built from this same factory — it implements a
// conventional REST contract (POST /cards/assign, POST /cards/:id/activate,
// GET /cards/:id/transactions, etc). Real vendor docs (disccardpromos.com's
// included) weren't reachable from this build environment to confirm exact
// paths/payloads, so this is a best-guess placeholder shape.
//
// If a specific vendor turns out to need a genuinely different API shape
// (different auth scheme, different payload structure, etc.), add a new
// factory function here and register it under a new key in index.js —
// nothing in routes/cards.js has to change, since every adapter exposes the
// same method signatures.
// ---------------------------------------------------------------------------
import { randomUUID } from 'crypto';

export function makeRestAdapter({ apiBase, apiKey }) {
  const mockMode = !apiBase || !apiKey;

  async function call(path, opts = {}) {
    if (mockMode) throw new Error('Provider not configured — running in mock mode, this should not be reached');
    const res = await fetch(`${apiBase}${path}`, {
      ...opts,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body?.message || `Gift card provider API error ${res.status}`);
      err.status = res.status; err.body = body;
      throw err;
    }
    return body;
  }

  return {
    mockMode,

    async assignCard({ applicantId, amount }) {
      if (mockMode) {
        const last4 = String(Math.floor(1000 + Math.random() * 9000));
        return { providerCardId: `mock_${randomUUID()}`, maskedNumber: `**** **** **** ${last4}`, amount };
      }
      const body = await call('/cards/assign', { method: 'POST', body: JSON.stringify({ external_ref: applicantId, amount }) });
      return { providerCardId: body.card_id, maskedNumber: body.masked_number, amount: body.amount ?? amount };
    },

    async activateCard({ providerCardId, phone }) {
      if (mockMode) return { activatedAt: new Date().toISOString() };
      const body = await call(`/cards/${providerCardId}/activate`, { method: 'POST', body: JSON.stringify({ phone }) });
      return { activatedAt: body.activated_at || new Date().toISOString() };
    },

    async deactivateCard({ providerCardId, reason }) {
      if (mockMode) return { deactivatedAt: new Date().toISOString() };
      const body = await call(`/cards/${providerCardId}/deactivate`, { method: 'POST', body: JSON.stringify({ reason }) });
      return { deactivatedAt: body.deactivated_at || new Date().toISOString() };
    },

    async getCardStatus({ providerCardId }) {
      if (mockMode) return { balance: null, activatedAt: null, status: 'unknown (mock mode)' };
      return call(`/cards/${providerCardId}`);
    },

    async listTransactions({ providerCardId, since }) {
      if (mockMode) return [];
      const qs = since ? `?since=${encodeURIComponent(since)}` : '';
      const body = await call(`/cards/${providerCardId}/transactions${qs}`);
      return body.transactions || body.data || [];
    },

    async listAllTransactions({ since }) {
      if (mockMode) return null;
      try {
        const body = await call(`/transactions?since=${encodeURIComponent(since || '')}`);
        return body.transactions || body.data || null;
      } catch {
        return null; // endpoint may not exist on this vendor — caller falls back to per-card polling
      }
    },
  };
}
