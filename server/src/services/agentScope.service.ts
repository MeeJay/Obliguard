import type { Request } from 'express';
import type { CapabilityKey, PermissionLevel } from '@obliview/shared';
import { db } from '../db';
import { permissionService } from './permission.service';
import type { AgentScope } from './permission.service';
import { deviceAccessVerdict, FOREIGN_DEVICE_READ_ONLY } from '../utils/tenantWriteRules';
import { isDeviceUuidFormat } from '../utils/agentIdentity';

/**
 * The agent a REST request may act on (RBAC-8), mirroring Obliance
 * deviceScope.resolveRequestDevice with Obliguard's tenant model (A5):
 *   1. tenant rule (deviceAccessVerdict): own tenant ok; from the Default
 *      tenant a foreign agent is readable (god view) but a write answers 403;
 *      any other tenant answers 404 (existence never revealed). No
 *      platform-admin bypass on writes;
 *   2. team rule (permissionService.getAgentScope, TEAM_SCOPE_MODE): platform
 *      admins and tenant admins pass; a user restricted by team grants must
 *      be granted the agent (404 otherwise, like an unknown agent) and hold
 *      'rw' on it for a write (403 'read-only' otherwise);
 *   3. optional tenant capability (403), for callers that do not check it on
 *      the route.
 */

export type AgentNeed = 'read' | 'write';

export interface ScopedAgent {
  id: number;
  uuid: string;
  tenant_id: number;
  status: string;
  device_type: string | null;
  group_id: number | null;
}

export type ScopedAgentOutcome =
  | { ok: true; agent: ScopedAgent; permission: PermissionLevel }
  | { ok: false; status: 400 | 403 | 404; error: string };

/** Who asks: the session user operating `tenantId`. No user = tenant rule only (legacy callers). */
export interface AgentViewer {
  tenantId: number;
  userId?: number | null;
  isAdmin?: boolean;
}

export const AGENT_NOT_FOUND = 'Device not found';
export const AGENT_READ_ONLY = 'Read-only access to this agent';

/** An agent id as a route or a body carries it (a number, or a digit string). */
export function parseRequestAgentId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/** The viewer of a request (session user, operating tenant). */
export function requestViewer(req: Request): AgentViewer {
  const userId = Number(req.session?.userId);
  return {
    tenantId: Number(req.tenantId),
    userId: Number.isInteger(userId) && userId > 0 ? userId : null,
    isAdmin: req.session?.role === 'admin',
  };
}

/**
 * Core of resolveRequestAgent, usable without a request (deviceAccess
 * delegates to it). `idOrUuid`: an agent id, or its uuid.
 */
export async function resolveAgentAccess(
  viewer: AgentViewer,
  idOrUuid: unknown,
  need: AgentNeed,
  opts: { capability?: CapabilityKey } = {},
): Promise<ScopedAgentOutcome> {
  const id = parseRequestAgentId(idOrUuid);
  const uuid = id === null && isDeviceUuidFormat(idOrUuid) ? idOrUuid : null;
  if (id === null && uuid === null) return { ok: false, status: 400, error: 'Invalid device ID' };

  const agent = await db('agent_devices')
    .where(id !== null ? { id } : { uuid })
    .first('id', 'uuid', 'tenant_id', 'status', 'device_type', 'group_id') as ScopedAgent | undefined;
  if (!agent) return { ok: false, status: 404, error: AGENT_NOT_FOUND };

  switch (deviceAccessVerdict(agent.tenant_id, viewer.tenantId, need)) {
    case 'ok': break;
    case 'forbidden': return { ok: false, status: 403, error: FOREIGN_DEVICE_READ_ONLY };
    default: return { ok: false, status: 404, error: AGENT_NOT_FOUND };
  }

  // Legacy callers without a user: tenant rule only.
  if (viewer.userId == null) return { ok: true, agent, permission: 'rw' };

  const permission = await permissionService.getAgentPermission(viewer.userId, viewer.tenantId, agent.id, !!viewer.isAdmin);
  if (permission === 'none') return { ok: false, status: 404, error: AGENT_NOT_FOUND };
  if (need === 'write' && permission !== 'rw') return { ok: false, status: 403, error: AGENT_READ_ONLY };

  if (opts.capability && !(await permissionService.hasCapability(viewer.userId, !!viewer.isAdmin, viewer.tenantId, opts.capability))) {
    return { ok: false, status: 403, error: 'Insufficient permissions' };
  }
  return { ok: true, agent, permission };
}

/** The agent a request may read or write (see the module comment). */
export function resolveRequestAgent(
  req: Request,
  deviceIdOrUuid: unknown,
  need: AgentNeed,
  opts: { capability?: CapabilityKey } = {},
): Promise<ScopedAgentOutcome> {
  return resolveAgentAccess(requestViewer(req), deviceIdOrUuid, need, opts);
}

/**
 * The request user's agent scope (permissionService.getAgentScope). A request
 * without a user gets no team restriction (tenant rule only).
 */
export async function requestAgentScope(req: Request): Promise<AgentScope> {
  const v = requestViewer(req);
  if (v.userId == null) return { all: true };
  return permissionService.getAgentScope(v.userId, v.tenantId, !!v.isAdmin);
}

/** The agent ids of a scope ('write': the 'rw' ones), or 'all' (no team restriction). */
export function scopeAgentIds(scope: AgentScope, need: AgentNeed = 'read'): number[] | 'all' {
  if (scope.all) return 'all';
  return [...scope.levels.entries()].filter(([, l]) => need === 'read' || l === 'rw').map(([id]) => id);
}

/** The team level of one agent in a scope ('rw' without restriction, null when not granted). */
export function scopeAgentLevel(scope: AgentScope, id: number): PermissionLevel | null {
  return scope.all ? 'rw' : scope.levels.get(id) ?? null;
}

/** The request user's agent ids ('write': the writable ones), or 'all' (no team restriction). */
export async function requestVisibleAgentIds(req: Request, need: AgentNeed = 'read'): Promise<number[] | 'all'> {
  return scopeAgentIds(await requestAgentScope(req), need);
}

/** Of `ids`, those a scope's id list allows (`allowed` from scopeAgentIds / requestVisibleAgentIds). */
export function intersectAgentIds(ids: number[], allowed: number[] | 'all'): number[] {
  if (allowed === 'all') return ids;
  const set = new Set(allowed);
  return ids.filter((id) => set.has(id));
}
