import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { getPermission } from '../middleware/permissions.js';

const router = Router();
router.use(auth);

router.get('/stats', (req, res) => {
  const orgId = req.user.org_id;
  const shulPerm = getPermission(req.user, 'shuls');
  const applicantPerm = getPermission(req.user, 'applicants');
  const cardPerm = getPermission(req.user, 'cards');
  const stats = {};

  if (shulPerm.can_view) {
    stats.shuls = {
      total: db.prepare('SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0').get(orgId).c,
      pending: db.prepare(`SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0 AND status IN ('submitted','contract_sent','contract_signed')`).get(orgId).c,
      approved: db.prepare(`SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0 AND status = 'approved'`).get(orgId).c,
      paused: db.prepare('SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0 AND is_paused = 1').get(orgId).c,
    };
  }
  if (applicantPerm.can_view) {
    stats.applicants = {
      total: db.prepare('SELECT COUNT(*) c FROM applicants WHERE org_id = ?').get(orgId).c,
      pending: db.prepare(`SELECT COUNT(*) c FROM applicants WHERE org_id = ? AND approval_status = 'pending'`).get(orgId).c,
      approved: db.prepare(`SELECT COUNT(*) c FROM applicants WHERE org_id = ? AND approval_status = 'approved'`).get(orgId).c,
      paused: db.prepare('SELECT COUNT(*) c FROM applicants WHERE org_id = ? AND is_paused = 1').get(orgId).c,
    };
  }
  if (cardPerm.can_view) {
    stats.cards = {
      total: db.prepare(`SELECT COUNT(*) c FROM cards WHERE org_id = ?`).get(orgId).c,
      activated: db.prepare(`SELECT COUNT(*) c FROM cards WHERE org_id = ? AND status='activated'`).get(orgId).c,
      totalLoaded: db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM cards WHERE org_id = ?`).get(orgId).t,
    };
  }
  stats.duplicates = {
    open: db.prepare(`SELECT COUNT(*) c FROM duplicate_flags WHERE org_id = ? AND status = 'open'`).get(orgId).c,
  };
  const storePerm = getPermission(req.user, 'stores');
  if (storePerm.can_view) {
    stats.topStores = db.prepare(`SELECT s.id, s.name, COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) total_purchases
      FROM stores s LEFT JOIN card_transactions t ON t.store_id = s.id
      WHERE s.org_id = ? GROUP BY s.id ORDER BY total_purchases DESC LIMIT 5`).all(orgId).filter(s => s.total_purchases > 0);
    stats.totalStoreSpend = db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) total
      FROM card_transactions t JOIN stores s ON s.id = t.store_id WHERE s.org_id = ?`).get(orgId).total;
  }
  res.json({ stats });
});

export default router;
