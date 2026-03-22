/**
 * ObliTools manifest endpoint.
 * GET /api/oblitools/manifest   (requires session auth)
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { obligateService } from '../services/obligate.service';

const router = Router();

const SELF = { name: 'Obliguard', color: '#f97316' };

router.get('/manifest', requireAuth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const apps = await obligateService.getConnectedApps();

    type LinkedApp = { name: string; url: string; color: string };
    const linkedApps: LinkedApp[] = apps
      .filter(a => a.appType !== 'obliguard')
      .map(a => ({
        name: a.name,
        url: a.baseUrl,
        color: a.color ?? '#6366f1',
      }));

    res.json({
      success: true,
      data: {
        ...SELF,
        ssoPath: '/auth/sso-redirect',
        linkedApps,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
