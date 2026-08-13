import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(auth);

router.get('/', (req, res) => {
  res.json({ seasons: db.prepare('SELECT * FROM seasons WHERE org_id = ? ORDER BY created_at DESC').all(req.user.org_id) });
});

router.post('/', requireAdmin, (req, res) => {
  const { name, start_date, end_date, default_card_amount } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const id = uuid();
  db.prepare(`INSERT INTO seasons (id, org_id, name, start_date, end_date, default_card_amount, is_active)
    VALUES (?,?,?,?,?,?,1)`).run(id, req.user.org_id, name, start_date || null, end_date || null, default_card_amount || 0);
  res.status(201).json({ season: db.prepare('SELECT * FROM seasons WHERE id = ?').get(id) });
});

router.put('/:id', requireAdmin, (req, res) => {
  const season = db.prepare('SELECT * FROM seasons WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!season) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  db.prepare(`UPDATE seasons SET name=COALESCE(?,name), start_date=COALESCE(?,start_date), end_date=COALESCE(?,end_date),
    default_card_amount=COALESCE(?,default_card_amount), is_active=COALESCE(?,is_active) WHERE id=?`)
    .run(f.name, f.start_date, f.end_date, f.default_card_amount, f.is_active === undefined ? undefined : (f.is_active ? 1 : 0), season.id);
  res.json({ season: db.prepare('SELECT * FROM seasons WHERE id = ?').get(season.id) });
});

export default router;
