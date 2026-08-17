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

// Locks every active card an applicant holds — used when an applicant is
// rejected or moved back to pending (spec: "rejecting or making a customer
// pending should trigger a lock on the card by disccard"), so a card can't
// keep being spent once the person behind it is no longer approved.
// Best-effort per card, same pattern as the disccard account/funds writes
// in routes/applicants.js's approve flow: a provider failure is collected
// and returned to the caller to surface, but never blocks the status change
// that triggered it (the local card row is still marked deactivated either
// way, since "no longer approved" should never show a still-active card in
// our own UI regardless of whether the provider call succeeded).
export async function lockApplicantCards(orgId, applicantId) {
  const cards = db.prepare(`SELECT * FROM cards WHERE applicant_id = ? AND status IN ('assigned','activated')`).all(applicantId);
  const errors = [];
  for (const card of cards) {
    try {
      const result = await giftcard.deactivateCard(orgId, { providerCardId: card.provider_card_id, reason: 'applicant no longer approved' });
      db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=? WHERE id=?`).run(result.deactivatedAt, card.id);
    } catch (e) {
      console.error('[cardSync] failed to lock card', card.id, 'for applicant', applicantId, ':', e.message);
      errors.push(e.message);
      db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=datetime('now') WHERE id=?`).run(card.id);
    }
  }
  return { lockedCount: cards.length, errors };
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
