import type { Request } from 'express';
import { resolveAgentAccess, requestViewer } from './agentScope.service';
import type { ScopedAgentOutcome } from './agentScope.service';

export interface DeviceAccessRow {
  id: number;
  uuid: string;
  tenant_id: number;
  status: string;
  device_type: string | null;
}

export type DeviceAccessResult =
  | { ok: true; row: DeviceAccessRow }
  | { ok: false; status: 400 | 403 | 404; error: string };

function toResult(r: ScopedAgentOutcome): DeviceAccessResult {
  if (!r.ok) return r;
  const { id, uuid, tenant_id, status, device_type } = r.agent;
  return { ok: true, row: { id, uuid, tenant_id, status, device_type } };
}

/**
 * Shared device access guard (A5), delegating to agentScope.resolveAgentAccess.
 * Reads may cross tenants from the Default tenant (god view); writes follow
 * the operating tenant, with NO platform-admin bypass (an admin switches
 * tenant to edit):
 *   - own tenant → ok;
 *   - Default tenant, read → ok; write → 403 (read-only god view);
 *   - any other tenant → 404 (existence never revealed).
 * With a `viewer` (the session user), team grants apply too (RBAC-8): an agent
 * the user is not granted answers 404, a read-only one 403 on a write.
 *
 * Callers: agent.controller and firewall.controller (through agentScope),
 * mikrotik.controller and m365.controller.
 */
export async function checkDeviceAccess(
  deviceId: unknown,
  tenantId: number,
  mode: 'read' | 'write',
  viewer?: { userId: number | null; isAdmin: boolean },
): Promise<DeviceAccessResult> {
  return toResult(await resolveAgentAccess({ tenantId, ...(viewer ?? {}) }, deviceId, mode));
}

/** checkDeviceAccess for the session user of `req` (tenant rule + team grants). */
export async function checkRequestDeviceAccess(
  req: Request,
  deviceId: unknown,
  mode: 'read' | 'write',
): Promise<DeviceAccessResult> {
  return toResult(await resolveAgentAccess(requestViewer(req), deviceId, mode));
}
