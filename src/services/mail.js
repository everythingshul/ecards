import { db, uuid, DEFAULT_ORG_ID } from '../db.js';

// ---------------------------------------------------------------------------
// Email — Brevo (https://api.brevo.com) transactional email API.
//
// Single-org platform: one Brevo sending account for everything, set via
// BREVO_API_KEY / EMAIL_DEFAULT_SENDER / EMAIL_DEFAULT_SENDER_NAME env vars.
// (This app previously supported per-org Brevo accounts; that was reverted —
// the whole platform now runs as one organization, one sending identity.)
//
// IMPORTANT — most common cause of "emails aren't sending": Brevo requires
// the sender email (EMAIL_DEFAULT_SENDER) to be a verified sender identity
// (or verified domain) in your Brevo account. If it isn't, every send fails
// with an auth/sender error — which now surfaces as `emailError` in the API
// response and a `[mail] Brevo send failed` log line, instead of failing
// silently. Verify your sender at app.brevo.com > Senders & IP.
// ---------------------------------------------------------------------------

const CONFIG = {
  apiKey: process.env.BREVO_API_KEY || '',
  senderEmail: process.env.EMAIL_DEFAULT_SENDER || 'noreply@example.com',
  senderName: process.env.EMAIL_DEFAULT_SENDER_NAME || "Kipas Hair BP Platform",
};

export function initMail() {
  if (!CONFIG.apiKey) {
    console.warn('[mail] BREVO_API_KEY not set — emails will be logged to console (dry-run) instead of sent.');
  }
}

function brandFor() {
  const org = db.prepare('SELECT name, primary_color, accent_color FROM organizations WHERE id = ?').get(DEFAULT_ORG_ID);
  return {
    name: org?.name || CONFIG.senderName,
    color: org?.primary_color || '#241a15',
    accent: org?.accent_color || '#c9a76a',
  };
}

function wrap(bodyHtml, brand) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3ede2;font-family:Georgia,'Times New Roman',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3ede2;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5dcc8;">
        <tr><td style="background:${brand.color};padding:24px 32px;">
          <span style="color:${brand.accent};font-size:20px;font-weight:bold;letter-spacing:.5px;">${brand.name}</span>
        </td></tr>
        <tr><td style="padding:32px;color:#2a231d;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="background:#f3ede2;padding:18px 32px;color:#8a7c63;font-size:12px;border-top:1px solid #e5dcc8;text-align:center;">
          This is an automated message from ${brand.name}.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// orgId param kept for call-site compatibility but no longer used to look up
// per-org credentials — see note above. Every email uses the single platform account.
export async function sendMail(orgId, to, subject, bodyHtml) {
  const cfg = CONFIG;
  const brand = brandFor();
  const html = wrap(bodyHtml, brand);
  if (!cfg.apiKey) {
    console.log(`[mail:DRY-RUN org=${orgId || 'platform'}] To: ${to} | Subject: ${subject}\n${bodyHtml.replace(/<[^>]+>/g, ' ')}`);
    return { dryRun: true };
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { email: cfg.senderEmail, name: cfg.senderName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      ...(cfg.replyTo ? { replyTo: { email: cfg.replyTo } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error('[mail] Brevo send failed', res.status, body);
    throw new Error(body?.message || `Email send failed (${res.status})`);
  }
  return res.json();
}

// Wraps sendMail() so every call site gets a single, consistent emailError
// string to show/return — including the "no provider configured" case.
// That case matters because dry-run mode (no BREVO_API_KEY) resolves
// successfully with { dryRun: true } rather than throwing, so without this
// wrapper it looks identical to a real send in the API response: nothing
// gets emailed, but no error surfaces anywhere, and the recipient just
// reports "I never got the email" with no clue why.
//
// Also the single choke point every email in the app passes through, so
// it's where every send gets logged to emails_sent for the Email Center's
// "view sent emails" list — `meta` is optional and lets callers attach
// which record this email was about (Email Center's own compose flow uses
// it; automatic system emails don't bother).
export async function sendMailChecked(orgId, to, subject, bodyHtml, meta = {}) {
  let status = 'sent', emailError = null;
  try {
    const result = await sendMail(orgId, to, subject, bodyHtml);
    if (result?.dryRun) { status = 'dry_run'; emailError = 'Email provider not configured (BREVO_API_KEY missing). No email was actually sent.'; }
  } catch (e) {
    status = 'failed'; emailError = e.message;
  }
  try {
    db.prepare(`INSERT INTO emails_sent (id, org_id, to_email, subject, body_html, status, error_message, related_entity_type, related_entity_id, sent_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), orgId || DEFAULT_ORG_ID, to, subject, bodyHtml, status, emailError, meta.relatedEntityType || null, meta.relatedEntityId || null, meta.sentBy || null);
  } catch (e) { console.error('[mail] failed to log sent email:', e.message); }
  return { emailError };
}

export const templates = {
  contractReady: (shulName, signUrl) => ({
    subject: `Contract ready to sign: ${shulName}`,
    body: `<p>Shalom,</p><p>Thank you for registering <strong>${shulName}</strong>. Please review and sign your contract to complete onboarding:</p>
      <p style="text-align:center;margin:28px 0;"><a href="${signUrl}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Review & Sign Contract</a></p>
      <p>If the button doesn't work, copy this link: ${signUrl}</p>`
  }),
  accountApproved: (shulName, loginUrl, slots) => ({
    subject: `You're approved! Set up your account: ${shulName}`,
    body: `<p>Mazal tov. <strong>${shulName}</strong> has been approved with <strong>${slots} slot(s)</strong> for this season.</p>
      <p>Create your account password to begin submitting applicants:</p>
      <p style="text-align:center;margin:28px 0;"><a href="${loginUrl}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Set Up Account</a></p>`
  }),
  duplicateHold: (name) => ({
    subject: `Action required: duplicate record detected for ${name}`,
    body: `<p>A duplicate record was detected involving <strong>${name}</strong>. Both accounts have been temporarily paused until this is resolved by an administrator.</p>`
  }),
  applicantApproved: (name) => ({
    subject: `Applicant approved: ${name}`,
    body: `<p><strong>${name}</strong> has been approved and a gift card will be issued.</p>`
  }),
  storeSetup: (storeName, portalUrl) => ({
    subject: `Welcome, ${storeName}`,
    body: `<p>Your store <strong>${storeName}</strong> has been added as a participating location.</p>
      <p style="text-align:center;margin:28px 0;"><a href="${portalUrl}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Go to Store Portal</a></p>
      <p>If the button doesn't work, copy this link: ${portalUrl}</p>`
  }),
};
