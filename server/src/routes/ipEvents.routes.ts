import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listEvents,
  getEventStats,
  getEventsByIp,
} from '../controllers/ipEvents.controller';

const router = Router();

// Literal sub-paths (/stats) must come BEFORE /:ip, otherwise 'stats' is
// treated as an IP address. The IP param may contain dots (e.g. 1.2.3.4).
router.get('/', requireAuth, listEvents);
router.get('/stats', requireAuth, getEventStats);
router.get('/:ip', requireAuth, getEventsByIp);

export default router;
