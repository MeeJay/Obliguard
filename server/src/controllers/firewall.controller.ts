import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { obliguardHub } from '../services/obliguardHub.service';
import { AppError } from '../middleware/errorHandler';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

async function getDeviceUuid(deviceId: number): Promise<string> {
  const row = await db('agent_devices').where({ id: deviceId }).select('uuid').first();
  if (!row) throw new AppError(404, 'Device not found');
  return row.uuid;
}

export async function getFirewallRules(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    const uuid = await getDeviceUuid(deviceId);
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
    const uuid = await getDeviceUuid(deviceId);
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
    const uuid = await getDeviceUuid(deviceId);
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
    const uuid = await getDeviceUuid(deviceId);
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
