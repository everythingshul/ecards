// ---------------------------------------------------------------------------
// Gift card provider registry. Each ORGANIZATION picks its own provider +
// credentials (Admin > Organizations > Gift Card Provider, super_admin only) —
// nothing in the app is wired to a single vendor. If no org-level config
// exists, falls back to the platform-wide default env vars (useful for the
// seed org / local dev), and if neither is set, runs in mock mode.
//
// routes/cards.js calls getProvider(orgId) once per request and never talks
// to a vendor API directly, so adding a new vendor (see restAdapter.js) never
// requires touching route code.
// ---------------------------------------------------------------------------
import { db } from '../../db.js';
import { makeRestAdapter } from './restAdapter.js';

// Every registered provider today shares the same REST contract shape (see
// restAdapter.js for why). Add a new entry here — pointing at a new factory —
// for any vendor whose API genuinely differs.
const PROVIDER_FACTORIES = {
  disccardpromos: makeRestAdapter,
  generic_rest: makeRestAdapter,
};

export const PROVIDER_OPTIONS = [
  { value: 'disccardpromos', label: 'disccardpromos.com' },
  { value: 'generic_rest', label: 'Generic REST provider' },
];

const PLATFORM_DEFAULT = {
  provider: 'disccardpromos',
  apiBase: process.env.DISCCARDPROMOS_API_BASE || '',
  apiKey: process.env.DISCCARDPROMOS_API_KEY || '',
};

export function getProvider(orgId) {
  const row = orgId ? db.prepare('SELECT * FROM org_card_provider_settings WHERE org_id = ?').get(orgId) : null;
  const cfg = row?.api_base && row?.api_key
    ? { provider: row.provider, apiBase: row.api_base, apiKey: row.api_key }
    : PLATFORM_DEFAULT;
  const factory = PROVIDER_FACTORIES[cfg.provider] || makeRestAdapter;
  return factory({ apiBase: cfg.apiBase, apiKey: cfg.apiKey });
}
