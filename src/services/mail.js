import nodemailer from 'nodemailer';

let transporter = null;

export function initMail() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[mail] SMTP_USER/SMTP_PASS not set — emails will be logged to console instead of sent.');
    return;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const BRAND = {
  name: process.env.ORG_NAME || "Shmachas Rechag - Kupat Ha'ir",
  color: '#241a15',
  accent: '#c9a76a',
  fromEmail: process.env.SMTP_USER || 'noreply@everythingshul.com',
};

function wrap(bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3ede2;font-family:Georgia,'Times New Roman',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3ede2;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5dcc8;">
        <tr><td style="background:${BRAND.color};padding:24px 32px;">
          <span style="color:${BRAND.accent};font-size:20px;font-weight:bold;letter-spacing:.5px;">${BRAND.name}</span>
        </td></tr>
        <tr><td style="padding:32px;color:#2a231d;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="background:#f3ede2;padding:16px 32px;color:#8a7c63;font-size:12px;">This is an automated message from ${BRAND.name}.</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

export async function sendMail(to, subject, bodyHtml, attachments = []) {
  const html = wrap(bodyHtml);
  if (!transporter) {
    console.log(`[mail:DRY-RUN] To: ${to} | Subject: ${subject}\n${bodyHtml.replace(/<[^>]+>/g, ' ')}`);
    return { dryRun: true };
  }
  return transporter.sendMail({ from: `"${BRAND.name}" <${BRAND.fromEmail}>`, to, subject, html, attachments });
}

export const templates = {
  contractReady: (shulName, signUrl) => ({
    subject: `Contract ready to sign — ${shulName}`,
    body: `<p>Shalom,</p><p>Thank you for registering <strong>${shulName}</strong>. Please review and sign your contract to complete onboarding:</p>
      <p style="text-align:center;margin:28px 0;"><a href="${signUrl}" style="background:${BRAND.accent};color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Review & Sign Contract</a></p>
      <p>If the button doesn't work, copy this link: ${signUrl}</p>`
  }),
  accountApproved: (shulName, loginUrl, slots) => ({
    subject: `You're approved! Set up your account — ${shulName}`,
    body: `<p>Mazal tov — <strong>${shulName}</strong> has been approved with <strong>${slots} slot(s)</strong> for this season.</p>
      <p>Create your account password to begin submitting applicants:</p>
      <p style="text-align:center;margin:28px 0;"><a href="${loginUrl}" style="background:${BRAND.accent};color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Set Up Account</a></p>`
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
      <p style="text-align:center;margin:28px 0;"><a href="${portalUrl}" style="background:${BRAND.accent};color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Go to Store Portal</a></p>`
  }),
};
