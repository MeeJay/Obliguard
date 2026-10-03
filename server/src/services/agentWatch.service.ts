import { AGENT_WATCH_MAX, AGENT_WATCH_TTL_SECONDS } from '@obliview/shared';
import type { AgentWatchFailure } from '@obliview/shared';
import { db } from '../db';
import { canUseTenant } from '../middleware/tenant';
import { agentWatchRoom } from '../utils/socketRooms';
import { parseRequestAgentId, resolveAgentAccess } from './agentScope.service';

export { agentWatchRoom } from '../utils/socketRooms';

/**
 * Live IP activity of ONE agent for a socket that does not get it from its
 * tenant feed (`tenant:<id>:ipfeed`, utils/socketRooms.ts), mirroring Obliance
 * deviceMetricsWatch.service: the socket asks AGENT_WATCH {deviceId}; once
 * authorized it joins `agentwatch:<id>`, which the activity emitters address
 * too (socket.io sends one copy to a socket in several target rooms).
 *
 * Authorization, like reading the agent over REST (agentScope.service
 * resolveAgentAccess): an active user who may still use the socket's tenant,
 * and the agent readable from that tenant (own tenant, or any from Default)
 * within the user's team scope. A watch lasts AGENT_WATCH_TTL_SECONDS: the
 * client renews it or the socket leaves the room, so a right taken away stops
 * the stream within that time. At most AGENT_WATCH_MAX agents per socket.
 *
 * Team-restricted sockets do not join their tenant feed: socket.ts joins them
 * to the watch rooms of their granted agents at connect (scopeJoin). Those
 * rooms have no TTL (the grant set is re-read on the next connection, e.g.
 * after a tenant switch) and an explicit unwatch or a TTL never leaves them.
 */
export const AGENT_WATCH_TTL_MS = AGENT_WATCH_TTL_SECONDS * 1000;

export type { AgentWatchFailure };

export interface AgentWatchViewer {
  userId: number;
  /** The socket's tenant (validated at the handshake), null when it has none. */
  tenantId: number | null;
}

export async function authorizeAgentWatch(
  viewer: AgentWatchViewer,
  rawDeviceId: unknown,
): Promise<{ ok: true; deviceId: number; tenantId: number } | { ok: false; code: AgentWatchFailure }> {
  const deviceId = parseRequestAgentId(rawDeviceId);
  if (deviceId === null) return { ok: false, code: 'invalid' };
  // Live user state (role and activity from the DB, not from the handshake).
  const user = await db('users').where({ id: viewer.userId }).first('is_active', 'role') as
    { is_active: boolean; role: string } | undefined;
  if (!user || user.is_active === false) return { ok: false, code: 'session' };
  if (viewer.tenantId === null) return { ok: false, code: 'not_found' };
  if (!(await canUseTenant(viewer.userId, user.role, viewer.tenantId))) return { ok: false, code: 'session' };

  const r = await resolveAgentAccess(
    { tenantId: viewer.tenantId, userId: viewer.userId, isAdmin: user.role === 'admin' },
    deviceId,
    'read',
  );
  // 403 cannot happen on a read; existence is never revealed either way.
  if (!r.ok) return { ok: false, code: r.status === 400 ? 'invalid' : 'not_found' };
  return { ok: true, deviceId: r.agent.id, tenantId: r.agent.tenant_id };
}

type WatchSocket = { id: string; join(room: string): unknown; leave(room: string): unknown };

// socket id -> agent id -> expiry timer
const watches = new Map<string, Map<number, ReturnType<typeof setTimeout>>>();
// socket id -> agents granted by team scope (joined at connect, no TTL)
const scoped = new Map<string, Set<number>>();

/**
 * 'watch' requests still being checked (the checks await the DB), per socket
 * and agent. An 'unwatch' — or a newer 'watch' — that arrives meanwhile takes
 * the agent's ticket away, so the late 'watch' never joins (an 'unwatch' is
 * handled at once, and would otherwise run BEFORE the 'watch' it follows).
 * Entries live only while a check runs; at most AGENT_WATCH_PENDING_MAX per
 * socket.
 */
export const AGENT_WATCH_PENDING_MAX = 16;
const pending = new Map<string, Map<number, symbol>>();

/** A 'watch' starts its checks: its ticket, or null when the socket has too many in flight. */
export function watchIntent(socketId: string, deviceId: number): symbol | null {
  let mine = pending.get(socketId);
  if (!mine) { mine = new Map(); pending.set(socketId, mine); }
  if (!mine.has(deviceId) && mine.size >= AGENT_WATCH_PENDING_MAX) return null;
  const ticket = Symbol('agent-watch');
  mine.set(deviceId, ticket);
  return ticket;
}

/** True while no 'unwatch' / newer 'watch' for this agent came in since the ticket was taken. */
export function watchIntentCurrent(socketId: string, deviceId: number, ticket: symbol): boolean {
  return pending.get(socketId)?.get(deviceId) === ticket;
}

/** The 'watch' is finished (joined, refused or superseded): its ticket goes, if still its own. */
export function watchIntentDone(socketId: string, deviceId: number, ticket: symbol): void {
  const mine = pending.get(socketId);
  if (mine?.get(deviceId) !== ticket) return;
  mine.delete(deviceId);
  if (mine.size === 0) pending.delete(socketId);
}

function dropIntent(socketId: string, deviceId: number): void {
  const mine = pending.get(socketId);
  if (!mine) return;
  mine.delete(deviceId);
  if (mine.size === 0) pending.delete(socketId);
}

/** Joins (or renews) the watch; false when the socket already watches too many agents. */
export function watchJoin(socket: WatchSocket, deviceId: number): boolean {
  let mine = watches.get(socket.id);
  if (!mine) { mine = new Map(); watches.set(socket.id, mine); }
  const prev = mine.get(deviceId);
  if (prev) clearTimeout(prev);
  else if (mine.size >= AGENT_WATCH_MAX) return false;
  socket.join(agentWatchRoom(deviceId));
  const timer = setTimeout(() => { watchLeave(socket, deviceId); }, AGENT_WATCH_TTL_MS);
  (timer as { unref?: () => void }).unref?.();
  mine.set(deviceId, timer);
  return true;
}

/** Ends an explicit watch (unwatch or TTL). A team-scope room is kept. */
export function watchLeave(socket: WatchSocket, deviceId: number): void {
  dropIntent(socket.id, deviceId); // a 'watch' still being checked must not join after this
  const mine = watches.get(socket.id);
  const t = mine?.get(deviceId);
  if (t) clearTimeout(t);
  mine?.delete(deviceId);
  if (mine && mine.size === 0) watches.delete(socket.id);
  if (scoped.get(socket.id)?.has(deviceId)) return;
  try { socket.leave(agentWatchRoom(deviceId)); } catch { /* socket gone */ }
}

/**
 * Team-restricted socket: joins the watch rooms of the agents its grants
 * cover, for the life of the connection (no TTL, not counted in
 * AGENT_WATCH_MAX).
 */
export function scopeJoin(socket: WatchSocket, deviceIds: Iterable<number>): void {
  let mine = scoped.get(socket.id);
  for (const id of deviceIds) {
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (!mine) { mine = new Set(); scoped.set(socket.id, mine); }
    mine.add(id);
    socket.join(agentWatchRoom(id));
  }
}

/** The socket is gone: its timers and bookkeeping go (socket.io drops its rooms itself). */
export function watchForget(socketId: string): void {
  pending.delete(socketId);
  scoped.delete(socketId);
  const mine = watches.get(socketId);
  if (!mine) return;
  for (const t of mine.values()) clearTimeout(t);
  watches.delete(socketId);
}

/** Tests: how many agents a socket watches explicitly. */
export function watchCount(socketId: string): number {
  return watches.get(socketId)?.size ?? 0;
}
