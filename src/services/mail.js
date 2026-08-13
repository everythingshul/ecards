import { db } from '../db.js';

// ---------------------------------------------------------------------------
// Email — Brevo (https://api.brevo.com) transactional email API.
//
// The platform has one default sending account (from everythingshul.com), set
// via BREVO_API_KEY / EMAIL_DEFAULT_SENDER env vars. Any organization can be
// given its OWN Brevo account (API key + verified sender) so its emails send
// from its own identity instead — configured per-org by a super_admin only,
// via org_email_settings (see routes/orgs.js email-settings endpoints and
// admin/organizations.html). Every sendMail() call resolves org -> its own
// settings if present, else falls back to the platform default.
// ---------------------------------------------------------------------------

const PLATFORM_DEFAULT = {
  apiKey: process.env.BREVO_API_KEY || '',
  senderEmail: process.env.EMAIL_DEFAULT_SENDER || 'noreply@everythingshul.com',
  senderName: process.env.EMAIL_DEFAULT_SENDER_NAME || 'everythingshul',
};

export function initMail() {
  if (!PLATFORM_DEFAULT.apiKey) {
    console.warn('[mail] BREVO_API_KEY not set — platform-default emails will be logged to console (dry-run) instead of sent. Orgs with their own Brevo account configured in Organizations settings will still send normally.');
  }
}

function resolveEmailConfig(orgId) {
  if (orgId) {
    const row = db.prepare('SELECT * FROM org_email_settings WHERE org_id = ?').get(orgId);
    if (row?.api_key) {
      return {
        apiKey: row.api_key,
        senderEmail: row.sender_email || PLATFORM_DEFAULT.senderEmail,
        senderName: row.sender_name || PLATFORM_DEFAULT.senderName,
        replyTo: row.reply_to || null,
      };
    }
  }
  return { apiKey: PLATFORM_DEFAULT.apiKey, senderEmail: PLATFORM_DEFAULT.senderEmail, senderName: PLATFORM_DEFAULT.senderName, replyTo: null };
}

function brandFor(orgId) {
  const org = orgId ? db.prepare('SELECT name, primary_color, accent_color FROM organizations WHERE id = ?').get(orgId) : null;
  return {
    name: org?.name || PLATFORM_DEFAULT.senderName,
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
        <tr><td style="background:#f3ede2;padding:16px 32px;color:#8a7c63;font-size:12px;">This is an automated message from ${brand.name}.</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// orgId may be null for platform-level mail (e.g. a super_admin invite). Always
// pass the org whose branding/sending account should be used when known.
export async function sendMail(orgId, to, subject, bodyHtml) {
  const cfg = resolveEmailConfig(orgId);
  const brand = brandFor(orgId);
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

export const templates = {
  contractReady: (shulName, signUrl) => ({
    subject: `Contract ready to sign — ${shulName}`,
    body: `<p>Shalom,</p><p>Thank you for registering <strong>${shulName}</strong>. Please review and sign your contract to complete onboarding:</p>
      <p style="text-align:center;margin:28px 0;"><a href="${signUrl}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Review & Sign Contract</a></p>
      <p>If the button doesn't work, copy this link: ${signUrl}</p>`
  }),
  accountApproved: (shulName, loginUrl, slots) => ({
    subject: `You're approved! Set up your account — ${shulName}`,
    body: `<p>Mazal tov — <strong>${shulName}</strong> has been approved with <strong>${slots} slot(s)</strong> for this season.</p>
      <p>Create your account password to begin submitting applicants:</p>
      <p style="text-align:center;margin:28px 0;"><a href="${loginUrl}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Set Up Account</a></p>`
  }),
  duplicateHold: (name) => ({
    subject: `Action required: duplicate record detected — ${name}`,
    body: `<p>A duplicate record was detected involving <strong>${name}</strong>. Both accounts have been temporarily paused until this is resolved by an administrator.</p>`
  }),
  applicantApproved: (name) => ({
    subject: `Applicant approved — ${name}`,
    body: `<p><strong>${name}</strong> has been approved and a gift card will be issued.</p>`
  }),
  storeSetup: (storeName, portalUrl) => ({
    subject: `Welcome — ${storeName} setup`,
    body: `<p>Your store <strong>${storeName}</strong> has been added as a participating location.</p>
      <p style="text-align:center;margin:28px 0;"><a href="${portalUrl}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Go to Store Portal</a></p>
      <p>If the button doesn't work, copy this link: ${portalUrl}</p>`
  }),
};
