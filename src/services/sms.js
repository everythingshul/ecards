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
