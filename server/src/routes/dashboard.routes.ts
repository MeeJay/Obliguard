import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { dashboardService } from '../services/dashboard.service';

const router = Router();

// GET /api/dashboard/summary: tenant-scoped KPIs (Default = whole install).
router.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const data = await dashboardService.getSummary(req.tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;
