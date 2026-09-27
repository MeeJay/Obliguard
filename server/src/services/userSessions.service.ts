import type { Server as SocketIOServer } from 'socket.io';
import { db } from '../db';
import { logger } from '../utils/logger';
import { invalidateUserState } from '../middleware/sessionUserGuard';
import { invalidateTenantAccess } from '../middleware/tenant';

let _io: SocketIOServer | null = null;

export function setUserSessionsIO(io: SocketIOServer): void {
  _io = io;
}

/** Close every live Socket.io connection of a user (sockets join `user:<id>`). */
function disconnectSockets(userId: number): void {
  try {
    _io?.in(`user:${userId}`).disconnectSockets(true);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to disconnect sockets of a user');
  }
}

/** Close every live Socket.io connection sitting in a tenant room (tenant deleted). */
function disconnectTenantSockets(tenantId: number): void {
  try {
    _io?.in(`tenant:${tenantId}`).disconnectSockets(true);
  } catch (err) {
    logger.warn({ err, tenantId }, 'Failed to disconnect sockets of a tenant');
  }
}

/**
 * Memberships of a user changed (added / removed / role / tenant deleted):
 * drop the cached tenant-access decisions and close the live sockets. They
 * reconnect through socket.ts, which re-validates tenant rooms, and the client
 * re-syncs its session on the 'io server disconnect' reason.
 */
function onMembershipChanged(userId: number): void {
  invalidateTenantAccess(userId);
  disconnectSockets(userId);
}

export const userSessionsService = {
  /**
   * Revoke every stored session of a user — completed logins (userId) and
   * logins still waiting for 2FA (pendingMfaUserId) — and close their live
   * Socket.io connections (sockets join `user:<id>` on connect).
   *
   * Sessions cache userId + role, so this is required whenever an account is
   * disabled, deleted or demoted, or its credentials change upstream.
   */
  async destroyForUser(userId: number): Promise<number> {
    // Drop the cached account state first so sessionUserGuard re-reads the DB
    // (catches a session re-saved by a request that was in flight).
    invalidateUserState(userId);
    invalidateTenantAccess(userId);
    const id = String(userId);
    const deleted = await db('session')
      .whereRaw(`sess->>'userId' = ?`, [id])
      .orWhereRaw(`sess->>'pendingMfaUserId' = ?`, [id])
      .del();
    disconnectSockets(userId);
    return deleted;
  },

  disconnectSockets,
  disconnectTenantSockets,
  onMembershipChanged,
};
