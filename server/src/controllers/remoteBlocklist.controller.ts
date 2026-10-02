import type { Request, Response, NextFunction } from 'express';
import { remoteBlocklistService } from '../services/remoteBlocklist.service';
import { AppError } from '../middleware/errorHandler';
import { parseLimitOffset } from '../utils/pagination';
import { SsrfRefusedError } from '../utils/ssrfGuard';

function parseId(raw: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new AppError(400, 'Invalid id');
  return Number(raw);
}

/** A sync or push failure is the remote side's fault: 502 (a refused URL stays a 400). */
function upstreamError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof SsrfRefusedError) return new AppError(400, err.message);
  return new AppError(502, err instanceof Error ? err.message : 'Unknown error');
}

export const remoteBlocklistController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await remoteBlocklistService.list(req.tenantId);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, sourceType, url, apiKey, syncInterval } = (req.body ?? {}) as Record<string, unknown>;
      if (!name || !sourceType || !url) throw new AppError(400, 'name, sourceType, and url are required');
      const data = await remoteBlocklistService.create({
        name, sourceType, url, apiKey,
        syncInterval, tenantId: req.tenantId,
      });
      res.status(201).json({ success: true, data });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      const { name, url, apiKey, enabled, syncInterval } = (req.body ?? {}) as Record<string, unknown>;
      const data = await remoteBlocklistService.update(id, req.tenantId, { name, url, apiKey, enabled, syncInterval });
      if (!data) throw new AppError(404, 'Blocklist not found');
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      const ok = await remoteBlocklistService.delete(id, req.tenantId);
      if (!ok) throw new AppError(404, 'Blocklist not found');
      res.json({ success: true, message: 'Blocklist deleted' });
    } catch (err) { next(err); }
  },

  async forceSync(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      let found: boolean;
      try {
        found = await remoteBlocklistService.forceSync(id, req.tenantId);
      } catch (err) {
        throw upstreamError(err);
      }
      if (!found) throw new AppError(404, 'Blocklist not found');
      res.json({ success: true, message: 'Sync completed' });
    } catch (err) { next(err); }
  },

  async listIps(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = req.query as Record<string, unknown>;
      const blocklistId = typeof q.blocklistId === 'string' && /^[1-9][0-9]{0,9}$/.test(q.blocklistId)
        ? Number(q.blocklistId)
        : undefined;
      const search = typeof q.search === 'string' && q.search ? q.search.slice(0, 64) : undefined;
      const enabled = q.enabled === 'true' ? true : q.enabled === 'false' ? false : undefined;
      const { limit, offset } = parseLimitOffset(q, { defaultLimit: 50, max: 1000 });
      const result = await remoteBlocklistService.listIps({
        tenantId: req.tenantId, blocklistId, search, enabled, limit, offset,
      });
      res.json({ success: true, data: result.data, total: result.total });
    } catch (err) { next(err); }
  },

  async toggleIp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      const { enabled } = (req.body ?? {}) as { enabled?: unknown };
      if (typeof enabled !== 'boolean') throw new AppError(400, 'enabled must be a boolean');
      const ok = await remoteBlocklistService.toggleIp(id, enabled, req.tenantId);
      if (!ok) throw new AppError(404, 'IP not found');
      res.json({ success: true, message: enabled ? 'IP enabled' : 'IP disabled' });
    } catch (err) { next(err); }
  },

  async stats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await remoteBlocklistService.getStats(req.tenantId);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async forcePush(_req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const result = await remoteBlocklistService.pushNewBans();
      res.json({ success: true, message: result ?? 'Push completed' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(502).json({ success: false, message: msg, error: msg });
    }
  },
};
