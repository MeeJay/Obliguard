/**
 * Audience helpers for every server → browser Socket.io emit.
 *
 * Rooms (joined in socket.ts from the server-side session only):
 *   - `tenant:<id>`        sockets whose current tenant is <id>;
 *   - `tenant:<id>:admin`  platform admins operating <id>;
 *   - `general`            every authenticated socket;
 *   - `tenant:<id>:ipfeed` sockets of <id> without a team restriction: the
 *                          tenant's IP activity (ip:events / ip:flow);
 *   - `agentwatch:<dev>`   sockets watching agent <dev> (agent:watch, TTL,
 *                          services/agentWatch.service.ts) or granted it by
 *                          a team (team-restricted sockets, joined at connect).
 *
 * Operational events go to the OWNING tenant's room plus the Default tenant's
 * room (the god view of operational reads), like Obliance's metricsRooms /
 * device.service owning-tenant emits. Socket.io de-duplicates a socket that is
 * in several target rooms, and a socket holds exactly one `tenant:<id>` room
 * (its current tenant), so per-tenant payload variants never double-deliver.
 * No bare `io.emit(` is allowed outside this file.
 *
 * No service imports: emitters (agent.service, ban.service, obliguardHub,
 * controllers) use it without creating an import cycle.
 */
import type { Server as SocketIOServer } from 'socket.io';
import { MASTER_TENANT_ID } from '@obliview/shared';

type IO = SocketIOServer | null | undefined;

const DEFAULT_ROOM = `tenant:${MASTER_TENANT_ID}`;

/** A positive integer tenant id, or null (room names are built from it). */
function validTenant(tenantId: unknown): number | null {
  const n = typeof tenantId === 'string' ? Number(tenantId) : tenantId;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Rooms of the members of `tenantId` plus the Default god view. */
export function tenantAudienceRooms(tenantId: number): string[] {
  return tenantId === MASTER_TENANT_ID ? [DEFAULT_ROOM] : [`tenant:${tenantId}`, DEFAULT_ROOM];
}

/**
 * Emit to the members of `tenantId` and to the Default tenant. An unknown
 * tenant (null) reaches Default only — never every socket. With
 * `defaultPayload`, Default sockets receive it instead of `payload` (god-view
 * fields the owning tenant must not see, or the reverse).
 */
export function emitToTenantAudience(
  io: IO,
  tenantId: number | null | undefined,
  event: string,
  payload: unknown,
  defaultPayload?: unknown,
): void {
  if (!io) return;
  const tid = validTenant(tenantId);
  if (defaultPayload === undefined) {
    io.to(tid === null ? [DEFAULT_ROOM] : tenantAudienceRooms(tid)).emit(event, payload);
    return;
  }
  if (tid !== null && tid !== MASTER_TENANT_ID) io.to(`tenant:${tid}`).emit(event, payload);
  io.to(DEFAULT_ROOM).emit(event, defaultPayload);
}

/** Emit to the platform admins operating `tenantId` and those operating Default. */
export function emitToTenantAdmins(io: IO, tenantId: number | null | undefined, event: string, payload: unknown): void {
  if (!io) return;
  const tid = validTenant(tenantId);
  const rooms = [`${DEFAULT_ROOM}:admin`];
  if (tid !== null && tid !== MASTER_TENANT_ID) rooms.unshift(`tenant:${tid}:admin`);
  io.to(rooms).emit(event, payload);
}

/**
 * Emit an instance-wide event (e.g. a global ban) to every authenticated
 * socket. `publicPayload` must not name another tenant or user. `perTenant`
 * maps a tenant id to the payload its sockets receive INSTEAD of the public
 * one (e.g. Default's god-view fields, or the origin tenant's own flags);
 * nobody receives two variants.
 */
export function emitGlobal(
  io: IO,
  event: string,
  publicPayload: unknown,
  perTenant?: ReadonlyMap<number, unknown>,
): void {
  if (!io) return;
  const variants = [...(perTenant ?? new Map<number, unknown>()).entries()]
    .filter(([tid]) => validTenant(tid) !== null);
  if (variants.length === 0) {
    io.to('general').emit(event, publicPayload);
    return;
  }
  io.to('general').except(variants.map(([tid]) => `tenant:${tid}`)).emit(event, publicPayload);
  for (const [tid, payload] of variants) io.to(`tenant:${tid}`).emit(event, payload);
}

/** Emit to platform admins only (the legacy `role:admin` room): platform-level events. */
export function emitToPlatformAdmins(io: IO, event: string, payload: unknown): void {
  if (!io) return;
  io.to('role:admin').emit(event, payload);
}

// ── Agent IP activity (W8-3) ─────────────────────────────────────────────────

/** IP activity feed of a tenant: its sockets without a team restriction. */
export function ipFeedRoom(tenantId: number): string {
  return `tenant:${tenantId}:ipfeed`;
}

/** Sockets that receive one agent's IP activity outside the tenant feed. */
export function agentWatchRoom(deviceId: number): string {
  return `agentwatch:${deviceId}`;
}

/**
 * Rooms of one agent's IP activity: the feed of its tenant, the Default feed
 * (god view) and the agent's watch room. An unknown tenant reaches the
 * Default feed and the watchers only.
 */
export function agentActivityRooms(tenantId: number | null | undefined, deviceId: number): string[] {
  const tid = validTenant(tenantId);
  const rooms = [ipFeedRoom(MASTER_TENANT_ID)];
  if (tid !== null && tid !== MASTER_TENANT_ID) rooms.unshift(ipFeedRoom(tid));
  if (Number.isSafeInteger(deviceId) && deviceId > 0) rooms.push(agentWatchRoom(deviceId));
  return rooms;
}

/** Of `rooms`, those holding at least one socket of this server (in-memory adapter). */
export function occupiedRooms(io: SocketIOServer, rooms: string[]): string[] {
  const all = io.sockets?.adapter?.rooms;
  if (!all) return rooms;
  return rooms.filter((r) => (all.get(r)?.size ?? 0) > 0);
}

/**
 * Emit one agent's IP activity (ip:events / ip:flow) to agentActivityRooms.
 * Nothing is built nor sent when no socket listens (`payload` is only called
 * then). A socket in several of the rooms gets one copy. Returns whether it
 * was sent.
 */
export function emitAgentActivity(
  io: IO,
  tenantId: number | null | undefined,
  deviceId: number,
  event: string,
  payload: () => unknown,
): boolean {
  if (!io) return false;
  const rooms = occupiedRooms(io, agentActivityRooms(tenantId, deviceId));
  if (rooms.length === 0) return false;
  io.to(rooms).emit(event, payload());
  return true;
}
