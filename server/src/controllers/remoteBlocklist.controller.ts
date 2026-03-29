import type { Request, Response, NextFunction } from 'express';
import { remoteBlocklistService } from '../services/remoteBlocklist.service';
import { AppError } from '../middleware/errorHandler';

export const remoteBlocklistController = {
  async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await remoteBlocklistService.list();
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, sourceType, url, apiKey, syncInterval } = req.body as {
        name: string; sourceType: 'oblitools' | 'url'; url: string;
        apiKey?: string; syncInterval?: number;
      };
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
      const id = parseInt(req.params.id, 10);
      const data = await remoteBlocklistService.update(id, req.body);
      if (!data) throw new AppError(404, 'Blocklist not found');
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await remoteBlocklistService.delete(id);
      if (!ok) throw new AppError(404, 'Blocklist not found');
      res.json({ success: true, message: 'Blocklist deleted' });
    } catch (err) { next(err); }
  },

  async forceSync(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await remoteBlocklistService.forceSync(id);
      res.json({ success: true, message: 'Sync completed' });
    } catch (err) { next(err); }
  },

  async listIps(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const blocklistId = req.query.blocklistId ? parseInt(req.query.blocklistId as string, 10) : undefined;
      const search = req.query.search as string | undefined;
      const enabled = req.query.enabled !== undefined ? req.query.enabled === 'true' : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
      const result = await remoteBlocklistService.listIps({ blocklistId, search, enabled, limit, offset });
      res.json({ success: true, data: result.data, total: result.total });
    } catch (err) { next(err); }
  },

  async toggleIp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { enabled } = req.body as { enabled: boolean };
      const ok = await remoteBlocklistService.toggleIp(id, enabled);
      if (!ok) throw new AppError(404, 'IP not found');
      res.json({ success: true, message: enabled ? 'IP enabled' : 'IP disabled' });
    } catch (err) { next(err); }
  },

  async stats(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await remoteBlocklistService.getStats();
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async forcePush(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await remoteBlocklistService.pushNewBans();
      res.json({ success: true, message: result ?? 'Push completed' });
    } catch (err) { next(err); }
  },
};
