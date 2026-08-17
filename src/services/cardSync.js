import { db, uuid } from '../db.js';
import * as giftcard from './giftcard.js';
import { resolveStoreId } from './storeMatch.js';

// Pulls new transactions for a single card from disccardpromos and inserts
// them into the ledger, resolving each to a known store where possible.
// Shared by the manual per-card "Sync Now" button and the automatic
// background sweep below.
export async function syncOneCard(orgId, card) {
  const txns = await giftcard.listTransactions(orgId, { providerCardId: card.provider_card_id, since: card.last_synced_at });
  const insert = db.prepare(`INSERT OR IGNORE INTO card_transactions (id, card_id, provider_txn_id, type, amount, balance_after, store_name, store_id, occurred_at, raw_payload)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const t of txns) {
    const storeName = t.store_name || t.merchant || '';
    insert.run(uuid(), card.id, t.id || t.transaction_id, t.type || (t.amount < 0 ? 'purchase' : 'refund'), t.amount, t.balance_after ?? null, storeName, resolveStoreId(orgId, storeName), t.occurred_at || t.date, JSON.stringify(t));
  }
  db.prepare(`UPDATE cards SET last_synced_at = datetime('now') WHERE id = ?`).run(card.id);
  return txns.length;
}

// Locks an applicant's disccardpromos customer — used when an applicant is
// rejected or moved back to pending (spec: "rejecting or making a customer
// pending should trigger a lock on the card by disccard"), so their card(s)
// can't keep being spent once they're no longer approved. Per disccardpromos'
// real Customer API, `is_active` is a field on the CUSTOMER, not on an
// individual card — there is no per-card lock/deactivate endpoint at all —
// so this deactivates the whole customer record rather than any specific
// card, and every local card row for them is marked deactivated to match
// (an applicant only ever has one disccardpromos customer regardless of how
// many cards they hold). unlockApplicantCustomer (called on approval) is the
// inverse. Best-effort: a provider failure is returned to the caller to
// surface, but never blocks the status change that triggered it — the local
// rows are still marked deactivated either way, since "no longer approved"
// should never show as still-active in our own UI regardless of whether the
// provider call succeeded.
export async function lockApplicantCards(orgId, applicant) {
  db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=datetime('now') WHERE applicant_id = ? AND status IN ('assigned','activated')`).run(applicant.id);
  if (!applicant.provider_account_id) return { errors: [] };
  try {
    await giftcard.updateCustomer(orgId, applicant.provider_account_id, { isActive: false });
    return { errors: [] };
  } catch (e) {
    console.error('[cardSync] failed to lock disccardpromos customer for applicant', applicant.id, ':', e.message);
    return { errors: [e.message] };
  }
}

// Reactivates the disccardpromos customer on (re-)approval, undoing
// lockApplicantCards above for an applicant who was previously
// rejected/pending and is now approved again.
export async function unlockApplicantCustomer(orgId, providerAccountId) {
  if (!providerAccountId) return;
  try { await giftcard.updateCustomer(orgId, providerAccountId, { isActive: true }); }
  catch (e) { console.error('[cardSync] failed to reactivate disccardpromos customer', providerAccountId, ':', e.message); }
}

// Sweeps every assigned/activated card in an org. Used by the automatic
// background interval (see index.js) and the "Sync All" button — this is
// what makes card activity/store spend "live" without someone having to
// click into each card individually. No-ops instantly per card in mock mode.
export async function syncAllCards(orgId) {
  const cards = db.prepare(`SELECT * FROM cards WHERE org_id = ? AND status IN ('assigned','activated') AND provider_card_id IS NOT NULL`).all(orgId);
  let totalSynced = 0;
  for (const card of cards) {
    try { totalSynced += await syncOneCard(orgId, card); }
    catch (e) { console.error('[cardSync] failed for card', card.id, e.message); }
  }
  return { cardsChecked: cards.length, transactionsSynced: totalSynced };
}
