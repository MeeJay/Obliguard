import type { Request, Response, NextFunction } from 'express';
import { obliguardHub } from '../services/obliguardHub.service';
import { resolveRequestAgent } from '../services/agentScope.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { auditService } from '../services/audit.service';
import type { ScopedAgent } from '../services/agentScope.service';
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
 * Resolve the device UUID through agentScope.resolveRequestAgent:
 * - tenant rule (A5): 'read' (rule list) own tenant, or the Default tenant
 *   god view; 'write' (add/delete/toggle) own tenant only — 403 from Default
 *   (read-only god view, no platform-admin bypass), 404 elsewhere;
 * - team rule (RBAC-8): an agent no team grant covers answers 404; a write
 *   needs 'rw' on the agent (403 on a read-only one). The tenant capability
 *   is the route guard's.
 * Only approved devices receive firewall commands (409 otherwise).
 */
async function getDeviceUuid(deviceId: unknown, req: Request, mode: 'read' | 'write'): Promise<string> {
  return (await getDevice(deviceId, req, mode)).uuid;
}

async function getDevice(deviceId: unknown, req: Request, mode: 'read' | 'write'): Promise<ScopedAgent> {
  const r = await resolveRequestAgent(req, deviceId, mode);
  if (!r.ok) throw new AppError(r.status, r.error);
  if (r.agent.status !== 'approved') throw new AppError(409, 'Agent is not approved');
  return r.agent;
}

/** A rule write that reached the point of being sent to the agent (audited either way). */
interface PendingRuleAudit {
  agent: ScopedAgent;
  action: 'firewall.rule_added' | 'firewall.rule_deleted' | 'firewall.rule_toggled';
  details: Record<string, unknown>;
}

/**
 * Audit row of a firewall rule write, filed in the agent's tenant and linked to
 * the agent. success = the agent applied it (an offline agent, a timeout or an
 * agent-side refusal is recorded as a failed attempt).
 */
async function auditRuleWrite(req: Request, pending: PendingRuleAudit, result: unknown, error?: unknown): Promise<void> {
  const agentOk = error === undefined && (result as { success?: unknown } | null)?.success !== false;
  const agentError = error instanceof Error ? error.message
    : typeof (result as { error?: unknown } | null)?.error === 'string' ? (result as { error: string }).error
    : undefined;
  await auditService.logReq(req, {
    action: pending.action,
    targetType: 'firewall_rule',
    targetId: typeof pending.details.ruleId === 'string' ? pending.details.ruleId : null,
    deviceId: pending.agent.id,
    tenantId: pending.agent.tenant_id,
    success: agentOk,
    details: { ...pending.details, ...(agentOk || !agentError ? {} : { error: agentError.slice(0, 300) }) },
  });
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
    const deviceId = req.params.id;
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
  let pending: PendingRuleAudit | null = null;
  try {
    const deviceId = req.params.id;
    const agent = await getDevice(deviceId, req, 'write');
    const uuid = agent.uuid;
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
    pending = { agent, action: 'firewall.rule_added', details: { rule: payload } };
    const result = await obliguardHub.pushAndWait(uuid, {
      type: 'firewall_add',
      id: randomUUID(),
      payload,
    });
    await auditRuleWrite(req, pending, result);
    pending = null;
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    if (pending) await auditRuleWrite(req, pending, null, err);
    if (err instanceof Error && err.message.includes('not connected')) {
      next(new AppError(503, 'Agent is not connected'));
    } else {
      next(err);
    }
  }
}

export async function deleteFirewallRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  let pending: PendingRuleAudit | null = null;
  try {
    const deviceId = req.params.id;
    const agent = await getDevice(deviceId, req, 'write');
    const ruleId = parseRuleId(req, res);
    if (ruleId == null) return;
    pending = { agent, action: 'firewall.rule_deleted', details: { ruleId } };
    const result = await obliguardHub.pushAndWait(agent.uuid, {
      type: 'firewall_delete',
      id: randomUUID(),
      payload: { ruleId },
    });
    await auditRuleWrite(req, pending, result);
    pending = null;
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    if (pending) await auditRuleWrite(req, pending, null, err);
    if (err instanceof Error && err.message.includes('not connected')) {
      next(new AppError(503, 'Agent is not connected'));
    } else {
      next(err);
    }
  }
}

export async function toggleFirewallRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  let pending: PendingRuleAudit | null = null;
  try {
    const deviceId = req.params.id;
    const agent = await getDevice(deviceId, req, 'write');
    const uuid = agent.uuid;
    const ruleId = parseRuleId(req, res);
    if (ruleId == null) return;
    const body = firewallToggleSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ success: false, ...firewallValidationError(body.error) });
      return;
    }
    pending = { agent, action: 'firewall.rule_toggled', details: { ruleId, enabled: body.data.enabled } };
    const result = await obliguardHub.pushAndWait(uuid, {
      type: 'firewall_toggle',
      id: randomUUID(),
      payload: { ruleId, enabled: body.data.enabled },
    });
    await auditRuleWrite(req, pending, result);
    pending = null;
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    if (pending) await auditRuleWrite(req, pending, null, err);
    if (err instanceof Error && err.message.includes('not connected')) {
      next(new AppError(503, 'Agent is not connected'));
    } else {
      next(err);
    }
  }
}
