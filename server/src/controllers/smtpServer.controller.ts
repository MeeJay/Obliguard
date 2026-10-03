import type { Request, Response, NextFunction } from 'express';
import { smtpServerService } from '../services/smtpServer.service';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';

/** 404 unless the operating tenant owns the server (Default owns all). */
async function assertOwned(req: Request): Promise<number> {
  const id = Number(req.params.id);
  const row = await smtpServerService.getOwned(id, req.tenantId);
  if (!row) throw new AppError(404, 'SMTP server not found');
  return row.id;
}

export const smtpServerController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const servers = await smtpServerService.list(req.tenantId);
      res.json({ success: true, data: servers });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, host, port, secure, username, password, fromAddress } = req.body;
      if (!name || !host || !port || !username || !password || !fromAddress) {
        throw new AppError(400, 'Missing required fields');
      }
      const server = await smtpServerService.create({ name, host, port: Number(port), secure: Boolean(secure), username, password, fromAddress, tenantId: req.tenantId });
      // Never the password.
      await auditService.logReq(req, {
        action: 'smtp_server.created', targetType: 'smtp_server', targetId: server.id,
        details: { name, host, port: Number(port), secure: Boolean(secure), username, fromAddress },
      });
      res.status(201).json({ success: true, data: server });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = await assertOwned(req);
      const { name, host, port, secure, username, password, fromAddress } = req.body;
      const server = await smtpServerService.update(id, {
        ...(name !== undefined && { name }),
        ...(host !== undefined && { host }),
        ...(port !== undefined && { port: Number(port) }),
        ...(secure !== undefined && { secure: Boolean(secure) }),
        ...(username !== undefined && { username }),
        ...(password !== undefined && { password }),
        ...(fromAddress !== undefined && { fromAddress }),
      });
      if (!server) throw new AppError(404, 'SMTP server not found');
      await auditService.logReq(req, {
        action: 'smtp_server.updated', targetType: 'smtp_server', targetId: id,
        details: {
          fields: Object.entries({ name, host, port, secure, username, password, fromAddress })
            .filter(([, v]) => v !== undefined).map(([k]) => k),
          ...(name !== undefined ? { name } : {}),
          ...(host !== undefined ? { host } : {}),
          ...(port !== undefined ? { port: Number(port) } : {}),
          ...(username !== undefined ? { username } : {}),
          ...(fromAddress !== undefined ? { fromAddress } : {}),
        },
      });
      res.json({ success: true, data: server });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = await assertOwned(req);
      const removed = await smtpServerService.delete(id);
      if (!removed) throw new AppError(404, 'SMTP server not found');
      await auditService.logReq(req, { action: 'smtp_server.deleted', targetType: 'smtp_server', targetId: id });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async test(req: Request, res: Response, next: NextFunction): Promise<void> {
    let id: number;
    try {
      id = await assertOwned(req);
    } catch (err) { next(err); return; }
    try {
      await smtpServerService.test(id);
      res.json({ success: true, message: 'Connection successful' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      next(new AppError(400, `SMTP test failed: ${msg}`));
    }
  },
};
