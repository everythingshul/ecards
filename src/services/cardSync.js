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
