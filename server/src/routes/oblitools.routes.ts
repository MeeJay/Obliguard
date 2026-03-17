/**
 * ObliTools manifest endpoint.
 * GET /api/oblitools/manifest   (requires session auth)
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { appConfigService } from '../services/appConfig.service';

const router = Router();

const SELF = { name: 'Obliguard', color: '#f97316' };

const LINKED: Record<string, { name: string; color: string }> = {
  obliview: { name: 'Obliview', color: '#6366f1' },
  oblimap:  { name: 'Oblimap',  color: '#10b981' },
  obliance: { name: 'Obliance', color: '#8b5cf6' },
};

router.get('/manifest', requireAuth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [ov, om, oa] = await Promise.all([
      appConfigService.getObliviewRaw(),
      appConfigService.getOblimapRaw(),
      appConfigService.getOblianceRaw(),
    ]);

    type LinkedApp = { name: string; url: string; color: string };
    const linkedApps: LinkedApp[] = [];
    if (ov?.url) linkedApps.push({ ...LINKED.obliview, url: ov.url });
    if (om?.url) linkedApps.push({ ...LINKED.oblimap,  url: om.url });
    if (oa?.url) linkedApps.push({ ...LINKED.obliance, url: oa.url });

    res.json({
      success: true,
      data: {
        ...SELF,
        ssoPath: '/api/sso/generate-token',
        linkedApps,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
