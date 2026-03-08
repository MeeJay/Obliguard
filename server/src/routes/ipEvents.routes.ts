import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listEvents,
  getEventsByIp,
} from '../controllers/ipEvents.controller';

const router = Router();

// NOTE: /:ip must come after any literal sub-paths if they are added in future.
// The IP param may contain dots (e.g. 1.2.3.4) which Express handles correctly.
router.get('/', requireAuth, listEvents);
router.get('/:ip', requireAuth, getEventsByIp);

export default router;
