import type { Request, Response } from 'express';
import { agentKeyService, AgentKeyError } from '../services/agentKey.service';
import { obliguardHub } from '../services/obliguardHub.service';
import { logger } from '../utils/logger';
import { auditService } from '../services/audit.service';
import { db } from '../db';

/**
 * Agent enrolment keys (W10-2). Routes: agent.routes.ts, all behind
 * requireAuth + requireTenant + agents.keys. Every call is scoped to the
 * operating tenant with no master bypass: credentials are never god-viewed.
 *
 *   GET    /agent/keys             masked list
 *   POST   /agent/keys             create {name, defaultGroupId?} → full key, once
 *   PUT    /agent/keys/:id         {name?, isActive?, defaultGroupId?}
 *   GET    /agent/keys/:id/reveal  full value of an active key (install commands)
 *   DELETE /agent/keys/:id         delete (releases its devices; prefer disabling)
 *
 * Disabling (or deleting) a key closes its live agent channels at once; the
 * agents' next attempts get the 401 of an unknown key.
 */

function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof AgentKeyError) {
    res.status(err.status).json({
      success: false,
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.params ? { params: err.params } : {}),
    });
    return;
  }
  logger.error({ err }, `Agent API key ${what} failed`);
  res.status(500).json({ success: false, error: 'Internal server error' });
}

export async function listKeys(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await agentKeyService.list(req.tenantId) });
  } catch (err) {
    fail(res, err, 'list');
  }
}

export async function createKey(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { name?: unknown; defaultGroupId?: unknown };
    const key = await agentKeyService.create(
      req.tenantId,
      { name: body.name, defaultGroupId: body.defaultGroupId },
      req.session?.userId ?? null,
    );
    // Never the key value: its name and id only.
    await auditService.logReq(req, {
      action: 'agent_key.created', targetType: 'agent_key', targetId: key.id,
      details: { name: key.name, defaultGroupId: key.defaultGroupId ?? null },
    });
    res.status(201).json({ success: true, data: key });
  } catch (err) {
    fail(res, err, 'create');
  }
}

export async function updateKey(req: Request, res: Response): Promise<void> {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ success: false, error: 'Invalid API key ID' });
    return;
  }
  try {
    const body = (req.body ?? {}) as { name?: unknown; isActive?: unknown; defaultGroupId?: unknown };
    const { key, disabled, enabled } = await agentKeyService.update(
      id,
      req.tenantId,
      { name: body.name, isActive: body.isActive, defaultGroupId: body.defaultGroupId },
      req.session?.userId ?? null,
    );
    let closedSessions = 0;
    if (disabled) {
      closedSessions = obliguardHub.closeByApiKey(id);
      logger.info({ apiKeyId: id, tenantId: req.tenantId, closedSessions }, 'Agent API key disabled — live sessions closed');
    } else if (enabled) {
      obliguardHub.allowApiKey(id);
    }
    await auditService.logReq(req, {
      action: disabled ? 'agent_key.disabled' : enabled ? 'agent_key.enabled' : 'agent_key.updated',
      targetType: 'agent_key', targetId: id,
      details: {
        name: key.name,
        fields: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined),
        ...(body.defaultGroupId !== undefined ? { defaultGroupId: key.defaultGroupId ?? null } : {}),
        ...(disabled ? { closedSessions } : {}),
      },
    });
    res.json({ success: true, data: { ...key, closedSessions } });
  } catch (err) {
    fail(res, err, 'update');
  }
}

export async function revealKey(req: Request, res: Response): Promise<void> {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ success: false, error: 'Invalid API key ID' });
    return;
  }
  try {
    const value = await agentKeyService.reveal(id, req.tenantId);
    if (value === null) {
      // Unknown, other tenant or disabled: a disabled key has no install command.
      res.status(404).json({ success: false, error: 'API key not found or disabled' });
      return;
    }
    logger.info({ apiKeyId: id, tenantId: req.tenantId, userId: req.session?.userId ?? null }, 'Agent API key revealed');
    await auditService.logReq(req, { action: 'agent_key.revealed', targetType: 'agent_key', targetId: id });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { id, key: value } });
  } catch (err) {
    fail(res, err, 'reveal');
  }
}

export async function deleteKey(req: Request, res: Response): Promise<void> {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ success: false, error: 'Invalid API key ID' });
    return;
  }
  try {
    const before = await db('agent_api_keys').where({ id, tenant_id: req.tenantId }).first('name') as { name: string } | undefined;
    const ok = await agentKeyService.remove(id, req.tenantId);
    if (!ok) {
      res.status(404).json({ success: false, error: 'API key not found' });
      return;
    }
    const closed = obliguardHub.closeByApiKey(id);
    logger.info({ apiKeyId: id, tenantId: req.tenantId, closed }, 'Agent API key deleted — live sessions closed');
    await auditService.logReq(req, {
      action: 'agent_key.deleted', targetType: 'agent_key', targetId: id,
      details: { name: before?.name ?? null, closedSessions: closed },
    });
    res.json({ success: true, data: { closedSessions: closed } });
  } catch (err) {
    fail(res, err, 'delete');
  }
}
