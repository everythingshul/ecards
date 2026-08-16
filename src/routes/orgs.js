import { Router } from 'express';
import { db, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { normalizePhone } from '../utils/phone.js';

const router = Router();

// Public: org branding for the public pages (apply form, store signup, etc).
// Single-org platform, so this always resolves to the one organization.
router.get('/resolve', (req, res) => {
  const org = db.prepare('SELECT id, name, logo_url, primary_color, accent_color, support_email, support_phone, address FROM organizations WHERE id = ?').get(DEFAULT_ORG_ID);
  res.json({ org });
});

router.use(auth, requireAdmin);

// The single organization's branding/settings — editable from Admin > Settings.
router.get('/me', (req, res) => {
  res.json({ organization: db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id) });
});

router.put('/me', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
  if (!org) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  if (f.support_phone !== undefined) f.support_phone = normalizePhone(f.support_phone);
  db.prepare(`UPDATE organizations SET name=COALESCE(?,name), logo_url=COALESCE(?,logo_url),
    primary_color=COALESCE(?,primary_color), accent_color=COALESCE(?,accent_color),
    support_email=COALESCE(?,support_email), support_phone=COALESCE(?,support_phone), address=COALESCE(?,address) WHERE id=?`)
    .run(f.name, f.logo_url, f.primary_color, f.accent_color, f.support_email, f.support_phone, f.address, org.id);
  res.json({ organization: db.prepare('SELECT * FROM organizations WHERE id = ?').get(org.id) });
});

export default router;
