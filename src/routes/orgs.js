import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

// Public: resolve org branding by hostname (subdomain or connected custom domain)
// so public pages (apply form, store signup) can render the right logo/colors
// before any auth exists. Powers "several orgs on one account, each connects
// their own domain."
router.get('/resolve', (req, res) => {
  const host = (req.query.host || req.headers.host || '').split(':')[0].toLowerCase();
  const subdomain = host.split('.')[0];
  let org = db.prepare('SELECT id, name, logo_url, primary_color, accent_color, support_email FROM organizations WHERE custom_domain = ?').get(host)
    || db.prepare('SELECT id, name, logo_url, primary_color, accent_color, support_email FROM organizations WHERE subdomain = ?').get(subdomain)
    || db.prepare('SELECT id, name, logo_url, primary_color, accent_color, support_email FROM organizations ORDER BY created_at LIMIT 1').get();
  res.json({ org });
});

router.use(auth, requireRole('super_admin'));

router.get('/', (req, res) => {
  res.json({ organizations: db.prepare('SELECT * FROM organizations ORDER BY created_at').all() });
});

router.post('/', (req, res) => {
  const { name, subdomain, custom_domain, primary_color, accent_color, support_email } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const id = uuid();
  db.prepare(`INSERT INTO organizations (id, name, subdomain, custom_domain, primary_color, accent_color, support_email)
    VALUES (?,?,?,?,?,?,?)`).run(id, name, subdomain || null, custom_domain || null, primary_color || '#241a15', accent_color || '#c9a76a', support_email || null);
  res.status(201).json({ organization: db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) });
});

router.put('/:id', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  db.prepare(`UPDATE organizations SET name=COALESCE(?,name), subdomain=COALESCE(?,subdomain), custom_domain=COALESCE(?,custom_domain),
    logo_url=COALESCE(?,logo_url), primary_color=COALESCE(?,primary_color), accent_color=COALESCE(?,accent_color),
    support_email=COALESCE(?,support_email), support_phone=COALESCE(?,support_phone), address=COALESCE(?,address) WHERE id=?`)
    .run(f.name, f.subdomain, f.custom_domain, f.logo_url, f.primary_color, f.accent_color, f.support_email, f.support_phone, f.address, org.id);
  res.json({ organization: db.prepare('SELECT * FROM organizations WHERE id = ?').get(org.id) });
});

// ---- Per-org email account (Brevo) — super_admin only. The API key is never
// echoed back once saved; the UI shows only whether one is configured. ----
router.get('/:id/email-settings', (req, res) => {
  const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare('SELECT * FROM org_email_settings WHERE org_id = ?').get(org.id);
  res.json({
    settings: {
      provider: row?.provider || 'brevo',
      has_api_key: !!row?.api_key,
      sender_email: row?.sender_email || '',
      sender_name: row?.sender_name || '',
      reply_to: row?.reply_to || '',
      using_platform_default: !row?.api_key,
    },
  });
});

router.put('/:id/email-settings', (req, res) => {
  const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Not found' });
  const { api_key, sender_email, sender_name, reply_to, clear } = req.body || {};
  if (clear) {
    db.prepare('DELETE FROM org_email_settings WHERE org_id = ?').run(org.id);
    return res.json({ ok: true, using_platform_default: true });
  }
  const existing = db.prepare('SELECT * FROM org_email_settings WHERE org_id = ?').get(org.id);
  const finalKey = api_key || existing?.api_key || null;
  db.prepare(`INSERT INTO org_email_settings (org_id, provider, api_key, sender_email, sender_name, reply_to, updated_at)
    VALUES (?,'brevo',?,?,?,?,datetime('now'))
    ON CONFLICT(org_id) DO UPDATE SET api_key=excluded.api_key, sender_email=excluded.sender_email,
      sender_name=excluded.sender_name, reply_to=excluded.reply_to, updated_at=datetime('now')`)
    .run(org.id, finalKey, sender_email || null, sender_name || null, reply_to || null);
  res.json({ ok: true, using_platform_default: !finalKey });
});

export default router;
