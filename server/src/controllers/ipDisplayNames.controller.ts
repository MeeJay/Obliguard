import type { Request, Response, NextFunction } from 'express';
import { ipDisplayNamesService } from '../services/ipDisplayNames.service';

export async function listLabels(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await ipDisplayNamesService.list(req.tenantId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

export async function upsertLabel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ip, label } = req.body as { ip: string; label: string };
    if (!ip || typeof label !== 'string') {
      res.status(400).json({ success: false, message: 'ip and label are required' });
      return;
    }
    const isAdmin = req.session?.role === 'admin';
    // Admins with no tenant context set global labels; others set tenant labels.
    const tenantId = req.tenantId ?? (isAdmin ? null : null);
    await ipDisplayNamesService.upsert(ip, label, tenantId ?? null, req.session?.userId);
    res.json({ success: true });
  } catch (err) { next(err); }
}

export async function deleteLabel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ip = decodeURIComponent(req.params.ip);
    const isAdmin = req.session?.role === 'admin';
    const tenantId = req.tenantId ?? (isAdmin ? null : null);
    await ipDisplayNamesService.delete(ip, tenantId ?? null);
    res.json({ success: true });
  } catch (err) { next(err); }
}
