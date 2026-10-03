import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listEvents,
  getEventStats,
  getEventsByIp,
  exportEvents,
} from '../controllers/ipEvents.controller';

const router = Router();

// Literal sub-paths (/stats, /export) must come BEFORE /:ip, otherwise 'stats' is
// treated as an IP address. The IP param may contain dots (e.g. 1.2.3.4).
router.get('/', requireAuth, listEvents);
router.get('/stats', requireAuth, getEventStats);
// CSV of the filtered log (same scope as the list, capped, audited).
router.get('/export', requireAuth, exportEvents);
router.get('/:ip', requireAuth, getEventsByIp);

export default router;
