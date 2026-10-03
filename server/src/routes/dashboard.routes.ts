import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { dashboardService } from '../services/dashboard.service';
import { requestAgentScope, scopeAgentIds } from '../services/agentScope.service';
import { groupsController } from '../controllers/groups.controller';

const router = Router();

/** Integer query parameter clamped to [min, max] (fallback when missing or invalid). */
function intParam(raw: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// GET /api/dashboard/summary: tenant-scoped KPIs (Default = whole install),
// with day-over-day deltas. Agent counters, events and top IPs follow the
// caller's team scope (RBAC-8).
router.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const data = await dashboardService.getSummary(req.tenantId, scopeAgentIds(await requestAgentScope(req)));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/timeseries?days=30: one point per day (2..90), the last
// one live. Feeds the hero sparklines and the activity chart.
router.get('/timeseries', requireAuth, async (req, res, next) => {
  try {
    const days = intParam(req.query.days, 30, 2, 90);
    const data = await dashboardService.getSeries(req.tenantId, 'daily', days, scopeAgentIds(await requestAgentScope(req)));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/hourly?hours=48: one point per hour (2..168), the last one live.
router.get('/hourly', requireAuth, async (req, res, next) => {
  try {
    const hours = intParam(req.query.hours, 48, 2, 168);
    const data = await dashboardService.getSeries(req.tenantId, 'hourly', hours, scopeAgentIds(await requestAgentScope(req)));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/breakdown?hours=24: top services, countries and bans per
// agent over the window (1..720 hours).
router.get('/breakdown', requireAuth, async (req, res, next) => {
  try {
    const hours = intParam(req.query.hours, 24, 1, 720);
    const data = await dashboardService.getBreakdown(req.tenantId, hours, scopeAgentIds(await requestAgentScope(req)));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/groups: per-group cards (visible groups, team scope).
router.get('/groups', requireAuth, groupsController.stats);

export default router;
