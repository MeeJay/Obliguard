import type { Request, Response, NextFunction } from 'express';
import { obliguardHub } from '../services/obliguardHub.service';
import { checkDeviceAccess } from '../services/deviceAccess.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import {
  firewallAddSchema,
  firewallRuleIdSchema,
  firewallToggleSchema,
  firewallValidationError,
  toFirewallAddPayload,
} from '../validators/firewall.schema';

/**
 * Heartbeat capability of agents that understand `remotePort` in
 * firewall_add (agent/firewall_rules.go capFwRemotePort). An older agent
 * would silently drop the field and create a broader rule than asked.
 */
const CAP_FW_REMOTE_PORT = 'fw_remote_port';

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

/** Validated rule id from the URL (one argv element on the agent, re-checked there). */
function parseRuleId(req: Request, res: Response): string | null {
  const parsed = firewallRuleIdSchema.safeParse(req.params.ruleId);
  if (!parsed.success) {
    res.status(400).json({ success: false, ...firewallValidationError(parsed.error) });
    return null;
  }
  return parsed.data;
}

async function deviceCapabilities(uuid: string): Promise<string[]> {
  const row = await db('agent_devices').where({ uuid }).first('capabilities') as { capabilities?: unknown } | undefined;
  let caps = row?.capabilities;
  if (typeof caps === 'string') { try { caps = JSON.parse(caps); } catch { return []; } }
  return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === 'string') : [];
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
    // The agent payload is rebuilt from the parsed fields only: unknown keys
    // are dropped and every value is canonical (SECURITY-PARITY-21).
    const parsed = firewallAddSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, ...firewallValidationError(parsed.error) });
      return;
    }
    const payload = toFirewallAddPayload(parsed.data);
    if (payload.remotePort && !(await deviceCapabilities(uuid)).includes(CAP_FW_REMOTE_PORT)) {
      throw new AppError(409, 'This agent version does not support a remote port: update the agent', 'agentUpdateRequired');
    }
    const result = await obliguardHub.pushAndWait(uuid, {
      type: 'firewall_add',
      id: randomUUID(),
      payload,
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
    const uuid = await getDeviceUuid(deviceId, req, 'write');
    const ruleId = parseRuleId(req, res);
    if (ruleId == null) return;
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
    const uuid = await getDeviceUuid(deviceId, req, 'write');
    const ruleId = parseRuleId(req, res);
    if (ruleId == null) return;
    const body = firewallToggleSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ success: false, ...firewallValidationError(body.error) });
      return;
    }
    const result = await obliguardHub.pushAndWait(uuid, {
      type: 'firewall_toggle',
      id: randomUUID(),
      payload: { ruleId, enabled: body.data.enabled },
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
