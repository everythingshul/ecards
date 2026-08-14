// ---------------------------------------------------------------------------
// SMS provider — generic REST adapter, single-org platform (mirrors the
// disccardpromos gift card adapter's shape). MOCK MODE (logged only, nothing
// actually sent) until SMS_API_BASE / SMS_API_KEY are set — the user has not
// picked a provider yet and will supply the real API key + endpoint later.
//
// The exact request shape below (Authorization: Bearer + JSON {to, from,
// body}) is a reasonable default matching most REST SMS providers (Twilio,
// Vonage, Plivo, etc. all differ slightly), but is a best-guess placeholder:
// once the real provider is known, only this file should need to change.
// ---------------------------------------------------------------------------

import { db, uuid, DEFAULT_ORG_ID } from '../db.js';

const CONFIG = {
  apiBase: process.env.SMS_API_BASE || '',
  apiKey: process.env.SMS_API_KEY || '',
  fromNumber: process.env.SMS_FROM_NUMBER || '',
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
      const res = await fetch(`${CONFIG.apiBase}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CONFIG.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, from: CONFIG.fromNumber, body }),
      });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok) { status = 'failed'; error = resBody?.message || `SMS send failed (${res.status})`; }
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
