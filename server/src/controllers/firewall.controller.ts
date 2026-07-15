import type { Request, Response, NextFunction } from 'express';
import { isMasterTenant } from '@obliview/shared';
import { db } from '../db';
import { obliguardHub } from '../services/obliguardHub.service';
import { AppError } from '../middleware/errorHandler';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

/**
 * Resolve the device UUID and enforce tenant ownership (master sees all).
 * A 404 (not 403) is used for a wrong-tenant device so we never reveal that it
 * exists — these routes are reachable by non-admin members with 'monitor_rw'.
 */
async function getDeviceUuid(deviceId: number, req: Request): Promise<string> {
  const row = await db('agent_devices').where({ id: deviceId }).select('uuid', 'tenant_id').first() as
    { uuid: string; tenant_id: number } | undefined;
  if (!row) throw new AppError(404, 'Device not found');
  if (!isMasterTenant(req.tenantId) && row.tenant_id !== req.tenantId) {
    throw new AppError(404, 'Device not found');
  }
  return row.uuid;
}

export async function getFirewallRules(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    const uuid = await getDeviceUuid(deviceId, req);
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
    const uuid = await getDeviceUuid(deviceId, req);
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
    const uuid = await getDeviceUuid(deviceId, req);
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
    const uuid = await getDeviceUuid(deviceId, req);
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
