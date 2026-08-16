// ---------------------------------------------------------------------------
// SMS provider — SimpleSender (https://simplesender.com) REST API. MOCK MODE
// (logged only, nothing actually sent) until SMS_API_BASE / SMS_API_KEY are
// set in the deploy environment.
//
// SimpleSender's API takes a bare 10-digit `to` and a `message` field (no
// `from` — the account has a single dedicated sending number), and considers
// a "queued" response a successful hand-off, not a delivery guarantee (mirrors
// how every other status here — "sent" — is really just "accepted by the
// provider"). Base URL + key: Developer > Docs & Keys in the SimpleSender
// dashboard.
// ---------------------------------------------------------------------------

import { db, uuid, DEFAULT_ORG_ID } from '../db.js';

const CONFIG = {
  apiBase: process.env.SMS_API_BASE || '',
  apiKey: process.env.SMS_API_KEY || '',
};

export function isSmsMockMode() {
  return !CONFIG.apiBase || !CONFIG.apiKey;
}

// Sends one SMS and returns { emailError: null } on success or
// { emailError: <reason> } on failure/mock — named to match sendMailChecked's
// return shape so frontend toast-handling code can treat them identically.
// Always logs to sms_messages regardless of outcome, which is what backs
// the SMS Center's "Sent Messages" list.
export async function sendSmsChecked(orgId, to, body, meta = {}) {
  let status = 'sent', error = null;
  if (isSmsMockMode()) {
    status = 'mock';
    error = 'SMS provider not configured (SMS_API_BASE/SMS_API_KEY missing). No message was actually sent.';
    console.log(`[sms:MOCK org=${orgId || 'platform'}] To: ${to}\n${body}`);
  } else {
    try {
      const res = await fetch(`${CONFIG.apiBase}/v1/messages/send`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CONFIG.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: String(to).replace(/\D/g, ''), message: body }),
      });
      const resBody = await res.json().catch(() => ({}));
      // A 2xx response is treated as success by default — SimpleSender's
      // documented success-status wording ("queued") isn't the only value
      // seen in practice, and requiring an exact allowlist match previously
      // caused real, successfully-sent messages to be logged as "failed"
      // whenever the provider used different wording. Only an explicit
      // failure signal in the body (or a non-2xx HTTP status) counts as a
      // real failure now.
      if (!res.ok || resBody?.status === 'failed' || resBody?.success === false || resBody?.error) {
        status = 'failed'; error = resBody?.error || resBody?.message || `SMS send failed (${res.status})`;
      }
    } catch (e) {
      status = 'failed'; error = e.message;
    }
  }
  try {
    db.prepare(`INSERT INTO sms_messages (id, org_id, direction, phone, body, status, error_message, related_entity_type, related_entity_id, sent_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), orgId || DEFAULT_ORG_ID, 'outbound', to, body, status, error, meta.relatedEntityType || null, meta.relatedEntityId || null, meta.sentBy || null);
  } catch (e) { console.error('[sms] failed to log sent message:', e.message); }
  return { emailError: error };
}

// Logs an inbound message (called from the public webhook route). Provider
// payload shapes vary; the webhook route normalizes to {from, body} before
// calling this.
export function logInboundSms(orgId, from, body) {
  db.prepare(`INSERT INTO sms_messages (id, org_id, direction, phone, body, status) VALUES (?,?,?,?,?,'received')`)
    .run(uuid(), orgId || DEFAULT_ORG_ID, 'inbound', from, body);
}

// ---------------------------------------------------------------------------
// Inbound sync via polling GET /v1/messages — SimpleSender doesn't support
// inbound webhooks yet, so this is the only way to see incoming replies for
// now (the webhook route above stays in place for whenever they add that).
//
// The only confirmed shape of that endpoint's response is
// `{ messages: [...], total: N }` — no sample message object and no docs
// were available when this was built. Field names below are therefore a
// best guess covering the conventions most REST SMS providers use, same
// spirit as the webhook's field-name matching. Critically, `total` (456 in
// the one response seen) suggests this returns the FULL message history,
// sent and received mixed — importing everything blindly would duplicate
// every outbound send this app already logs at send time in
// sendSmsChecked(). So a message is only ever imported when it can be
// confidently classified as inbound via an explicit direction/type field;
// anything ambiguous is skipped and counted, never guessed into either
// bucket. If a sync run finds messages but classifies none of them,
// it logs one sample item's raw JSON so the real field names are visible
// in the server log the moment this runs against production credentials.
// ---------------------------------------------------------------------------
const INBOUND_DIRECTION_VALUES = ['inbound', 'in', 'received', 'incoming', 'mo'];
const OUTBOUND_DIRECTION_VALUES = ['outbound', 'out', 'sent', 'outgoing', 'mt'];

function classifyDirection(m) {
  const raw = String(m.direction ?? m.type ?? m.message_type ?? m.messageType ?? '').toLowerCase();
  if (INBOUND_DIRECTION_VALUES.includes(raw)) return 'inbound';
  if (OUTBOUND_DIRECTION_VALUES.includes(raw)) return 'outbound';
  return null;
}

export async function syncInboundSms(orgId) {
  if (isSmsMockMode()) return { imported: 0, skipped: 0, total: 0 };
  const res = await fetch(`${CONFIG.apiBase}/v1/messages`, { headers: { Authorization: `Bearer ${CONFIG.apiKey}` } });
  if (!res.ok) throw new Error(`SimpleSender /v1/messages failed (${res.status})`);
  const data = await res.json().catch(() => ({}));
  const messages = Array.isArray(data.messages) ? data.messages : [];

  let imported = 0, skipped = 0, classified = 0;
  const insert = db.prepare(`INSERT INTO sms_messages (id, org_id, direction, phone, body, status, provider_message_id) VALUES (?,?,?,?,?,'received',?)`);
  const findByProviderId = db.prepare(`SELECT 1 FROM sms_messages WHERE org_id = ? AND provider_message_id = ?`);
  const findByPhoneBody = db.prepare(`SELECT 1 FROM sms_messages WHERE org_id = ? AND direction = 'inbound' AND phone = ? AND body = ? AND created_at > datetime('now', '-2 days')`);

  for (const m of messages) {
    const direction = classifyDirection(m);
    if (direction !== 'inbound') { skipped++; continue; }
    classified++;
    const phone = m.from || m.sender || m.phone || m.msisdn || m.source;
    const body = m.body || m.text || m.message || m.content;
    if (!phone || typeof body !== 'string') { skipped++; continue; }
    const providerId = m.id != null ? String(m.id) : (m.message_id || m.sid || m.uuid || null);
    if (providerId) {
      if (findByProviderId.get(orgId, providerId)) continue;
    } else if (findByPhoneBody.get(orgId, phone, body)) {
      continue;
    }
    insert.run(uuid(), orgId, 'inbound', phone, body, providerId);
    imported++;
  }
  // Diagnostics for whichever failure mode is actually happening in
  // production, surfaced all the way to the admin's "Check Now" click
  // (see routes/sms.js) instead of sitting only in a server log the admin
  // has no access to — nobody here has ever seen a real response from this
  // endpoint, so the two most likely blind spots are: the array itself isn't
  // under `data.messages` (rawKeys catches that — messages.length would be
  // 0 even though the provider has messages, per `total`), or it is, but the
  // per-message field names guessed in classifyDirection()/phone/body above
  // don't match the provider's real ones (sample catches that).
  const diagnostics = {};
  if (!messages.length && (data.total || Object.keys(data).length)) diagnostics.rawKeys = Object.keys(data);
  if (messages.length && classified === 0) {
    diagnostics.sample = messages[0];
    console.warn(`[sms] synced ${messages.length} message(s) from /v1/messages but classified 0 as inbound — sample item for review:`, JSON.stringify(messages[0]));
  }
  return { imported, skipped, total: data.total ?? messages.length, ...diagnostics };
}
