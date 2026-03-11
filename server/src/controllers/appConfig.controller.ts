import type { Request, Response, NextFunction } from 'express';
import { appConfigService } from '../services/appConfig.service';
import { AppError } from '../middleware/errorHandler';

const ALLOWED_KEYS = ['allow_2fa', 'force_2fa', 'otp_smtp_server_id', 'enable_foreign_sso'] as const;

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
      const updated = await appConfigService.setAgentGlobal(patch);
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ── Obliview integration ────────────────────────────────────────────────

  /** GET /admin/config/obliview — returns { url, apiKeySet } (admin only) */
  async getObliview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getObliviewConfig();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  /** PATCH /admin/config/obliview — sets url and/or apiKey (admin only) */
  async patchObliview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const patch: { url?: string | null; apiKey?: string | null } = {};
      if ('url'    in req.body) patch.url    = (req.body as { url?: string | null }).url ?? null;
      if ('apiKey' in req.body) patch.apiKey = (req.body as { apiKey?: string | null }).apiKey ?? null;
      const updated = await appConfigService.setObliviewConfig(patch);
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /**
   * GET /admin/config/obliview/agent-link/:uuid
   * Server-side proxy: asks Obliview if a device with this UUID exists.
   * Returns { url: string } (full URL to Obliview agent page) or { url: null }.
   */
  async proxyObliviewAgentLink(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { uuid } = req.params as { uuid: string };
      const { url: obliviewUrl, apiKey } = await appConfigService.getObliviewRaw();
      if (!obliviewUrl || !apiKey) {
        res.json({ success: true, data: null });
        return;
      }
      const endpoint = `${obliviewUrl.replace(/\/$/, '')}/api/obliguard/link?uuid=${encodeURIComponent(uuid)}`;
      const resp = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        res.json({ success: true, data: null });
        return;
      }
      const body = await resp.json() as { success: boolean; data?: { path: string } };
      if (!body.success || !body.data?.path) {
        res.json({ success: true, data: null });
        return;
      }
      const fullUrl = `${obliviewUrl.replace(/\/$/, '')}${body.data.path}`;
      res.json({ success: true, data: { url: fullUrl } });
    } catch (err) { next(err); }
  },
};
