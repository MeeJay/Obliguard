import type { Request, Response, NextFunction } from 'express';
import net from 'net';
import { isMasterTenant } from '@obliview/shared';
import { ipDisplayNamesService } from '../services/ipDisplayNames.service';
import { AppError } from '../middleware/errorHandler';

/** Longest label accepted (NetMap / tables display it inline). */
const MAX_LABEL_LENGTH = 128;

/**
 * Scope of a label write (ip.labels, route), the whitelist rule: the Default
 * tenant writes global labels (tenant_id NULL, seen by every tenant), any other
 * tenant writes its own labels (which override the global ones for it).
 */
function labelTenant(req: Request): number | null {
  return isMasterTenant(req.tenantId) ? null : req.tenantId;
}

/**
 * Drop the Default tenant's global label for an IP. Before W7-2 the Default
 * tenant wrote rows with tenant_id = its own id; such a legacy row overrides
 * the global label in list() and could no longer be edited or deleted, so it
 * goes with the global one.
 */
async function deleteDefaultLabel(ip: string, req: Request): Promise<void> {
  await ipDisplayNamesService.delete(ip, null);
  await ipDisplayNamesService.delete(ip, req.tenantId);
}

export async function listLabels(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await ipDisplayNamesService.list(req.tenantId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

export async function upsertLabel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ip: rawIp, label } = (req.body ?? {}) as { ip?: unknown; label?: unknown };
    if (typeof rawIp !== 'string' || !rawIp.trim() || typeof label !== 'string') {
      res.status(400).json({ success: false, message: 'ip and label are required' });
      return;
    }
    const ip = rawIp.trim();
    if (net.isIP(ip) === 0) throw new AppError(400, 'Invalid IP address');
    if (label.trim().length > MAX_LABEL_LENGTH) {
      throw new AppError(400, `label must be at most ${MAX_LABEL_LENGTH} characters`);
    }
    const tenantId = labelTenant(req);
    // UNIQUE(ip, tenant_id) never conflicts on NULL: replace a global label
    // explicitly instead of relying on the service's ON CONFLICT merge.
    if (tenantId === null) await deleteDefaultLabel(ip, req);
    await ipDisplayNamesService.upsert(ip, label, tenantId, req.session?.userId);
    res.json({ success: true });
  } catch (err) { next(err); }
}

export async function deleteLabel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ip = decodeURIComponent(req.params.ip);
    const tenantId = labelTenant(req);
    if (tenantId === null) await deleteDefaultLabel(ip, req);
    else await ipDisplayNamesService.delete(ip, tenantId);
    res.json({ success: true });
  } catch (err) { next(err); }
}
