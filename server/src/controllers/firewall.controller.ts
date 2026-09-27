import type { Request, Response, NextFunction } from 'express';
import { obliguardHub } from '../services/obliguardHub.service';
import { checkDeviceAccess } from '../services/deviceAccess.service';
import { AppError } from '../middleware/errorHandler';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

/**
 * Resolve the device UUID and enforce the operating-tenant rule (A5):
 * - 'read' (rule list): own tenant, or the Default tenant god view;
 * - 'write' (add/delete/toggle): own tenant only — 403 from Default
 *   (read-only god view, no platform-admin bypass), 404 elsewhere.
 * Only approved devices receive firewall commands (409 otherwise).
 */
async function getDeviceUuid(deviceId: number, req: Request, mode: 'read' | 'write'): Promise<string> {
  const r = await checkDeviceAccess(deviceId, req.tenantId, mode);
  if (!r.ok) throw new AppError(r.status, r.error);
  if (r.row.status !== 'approved') throw new AppError(409, 'Agent is not approved');
  return r.row.uuid;
}

export async function getFirewallRules(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    const uuid = await getDeviceUuid(deviceId, req, 'read');
    logger.info({ deviceId, uuid }, 'Firewall: sending firewall_list command');
    const cmdId = randomUUID();
    const result = await obliguardHub.pushAndWait(uuid, {
      type: 'firewall_list',
      id: cmdId,
      payload: {},
    });
    logger.info({ deviceId, ruleCount: (result as { rules?: unknown[] })?.rules?.length }, 'Firewall: got response');
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not connected')) {
      next(new AppError(503, 'Agent is not connected'));
    } else {
      next(err);
    }
  }
}

export async function addFirewallRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    const uuid = await getDeviceUuid(deviceId, req, 'write');
    const result = await obliguardHub.pushAndWait(uuid, {
      type: 'firewall_add',
      id: randomUUID(),
      payload: req.body,
    });
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not connected')) {
      next(new AppError(503, 'Agent is not connected'));
    } else {
      next(err);
    }
  }
}

export async function deleteFirewallRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    const ruleId = req.params.ruleId;
    const uuid = await getDeviceUuid(deviceId, req, 'write');
    const result = await obliguardHub.pushAndWait(uuid, {
      type: 'firewall_delete',
      id: randomUUID(),
      payload: { ruleId },
    });
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not connected')) {
      next(new AppError(503, 'Agent is not connected'));
    } else {
      next(err);
    }
  }
}

export async function toggleFirewallRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    const ruleId = req.params.ruleId;
    const { enabled } = req.body as { enabled: boolean };
    const uuid = await getDeviceUuid(deviceId, req, 'write');
    const result = await obliguardHub.pushAndWait(uuid, {
      type: 'firewall_toggle',
      id: randomUUID(),
      payload: { ruleId, enabled },
    });
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('not connected')) {
      next(new AppError(503, 'Agent is not connected'));
    } else {
      next(err);
    }
  }
}
