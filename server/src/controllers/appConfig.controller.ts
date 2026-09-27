import type { Request, Response, NextFunction } from 'express';
import { appConfigService } from '../services/appConfig.service';
import { AppError } from '../middleware/errorHandler';
import { TENANT_HEADER, TENANT_CHANGED } from '../middleware/tenant';
import { isAgentUpdatePolicy } from '../utils/agentUpdate';
import { logger } from '../utils/logger';
import type { AgentUpdatePolicy } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';

const ALLOWED_KEYS = [
  'allow_2fa', 'force_2fa', 'otp_smtp_server_id',
  'obligate_enabled',
  'oblitools_push_enabled', 'oblitools_instance_name', 'oblitools_api_key',
] as const;

export const appConfigController = {
  async getAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAll();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  async set(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const key = req.params.key as typeof ALLOWED_KEYS[number];
      if (!ALLOWED_KEYS.includes(key)) throw new AppError(400, `Unknown config key: ${key}`);
      const { value } = req.body;
      if (value === undefined) throw new AppError(400, 'Missing value');
      await appConfigService.set(key, String(value));
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** GET /admin/config/agent-global */
  async getAgentGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAgentGlobal();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  /** PATCH /admin/config/agent-global */
  async patchAgentGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { checkIntervalSeconds, heartbeatMonitoring, maxMissedPushes, notificationTypes } = req.body;
      const patch: Record<string, unknown> = {};
      if ('checkIntervalSeconds' in req.body) patch.checkIntervalSeconds = checkIntervalSeconds;
      if ('heartbeatMonitoring' in req.body) patch.heartbeatMonitoring = heartbeatMonitoring;
      if ('maxMissedPushes' in req.body) patch.maxMissedPushes = maxMissedPushes;
      if ('notificationTypes' in req.body) patch.notificationTypes = notificationTypes;

      // Global agent update policy (C17-1): platform admin (route guard) operating
      // in the Default tenant only. The route has no requireTenant, so the tab's
      // operating-tenant header is checked against the session here.
      let before: AgentUpdatePolicy | null | undefined;
      const hasPolicy = 'updatePolicy' in req.body;
      if (hasPolicy) {
        const claimedRaw = req.get(TENANT_HEADER);
        const claimed = claimedRaw !== undefined ? Number(claimedRaw) : NaN;
        if (Number.isSafeInteger(claimed) && claimed > 0 && claimed !== req.session.currentTenantId) {
          throw new AppError(409, 'Workspace changed in another tab', TENANT_CHANGED);
        }
        if (!isMasterTenant(req.session.currentTenantId)) {
          throw new AppError(403, 'Switch to the Default tenant to change the global update policy');
        }
        const v = req.body.updatePolicy;
        if (v !== null && !isAgentUpdatePolicy(v)) throw new AppError(400, 'Invalid updatePolicy');
        patch.updatePolicy = v;
        before = (await appConfigService.getAgentGlobal()).updatePolicy;
      }

      const updated = await appConfigService.setAgentGlobal(patch);
      if (hasPolicy && (before ?? null) !== (updated.updatePolicy ?? null)) {
        logger.info({
          event: 'agent_update_global_policy', userId: req.session.userId, from: before ?? null, to: updated.updatePolicy ?? null,
        }, 'Global agent update policy changed');
      }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ── Obligate SSO gateway ────────────────────────────────────────────────

  /** GET /admin/config/obligate — returns { url, apiKeySet, enabled } (admin only) */
  async getObligateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getObligateConfig();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  /** PUT /admin/config/obligate — sets url and/or apiKey and/or enabled (admin only) */
  async setObligateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const patch: { url?: string | null; apiKey?: string | null; enabled?: boolean } = {};
      if ('url'     in req.body) patch.url     = (req.body as { url?: string | null }).url ?? null;
      if ('apiKey'  in req.body) patch.apiKey  = (req.body as { apiKey?: string | null }).apiKey ?? null;
      if ('enabled' in req.body) patch.enabled = !!(req.body as { enabled?: boolean }).enabled;
      const updated = await appConfigService.patchObligateConfig(patch);
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },
};
