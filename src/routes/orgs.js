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

export default router;
