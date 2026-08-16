import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import { getRecentActions, undoAuditEntry } from '../services/audit.js';

const router = Router();
// Super admin only — this is a full activity feed across every entity in the
// org (every applicant/shul/store/card change, who made it, from what IP),
// plus the ability to reverse changes. That's a materially different power
// than the rest of requireAdmin's roster (staff/org_admin) normally has.
router.use(auth, requireRole('super_admin'));

router.get('/recent', (req, res) => {
  const hours = Math.min(168, Math.max(1, +req.query.hours || 48));
  res.json({ actions: getRecentActions(req.user.org_id, hours) });
});

router.post('/:id/undo', (req, res) => {
  try {
    const newEntryId = undoAuditEntry(req.params.id, req.user, req.ip);
    res.json({ ok: true, undoEntryId: newEntryId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

export default router;
