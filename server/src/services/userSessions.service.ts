import type { Server as SocketIOServer } from 'socket.io';
import { db } from '../db';
import { logger } from '../utils/logger';
import { invalidateUserState } from '../middleware/sessionUserGuard';

let _io: SocketIOServer | null = null;

export function setUserSessionsIO(io: SocketIOServer): void {
  _io = io;
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
    const id = String(userId);
    const deleted = await db('session')
      .whereRaw(`sess->>'userId' = ?`, [id])
      .orWhereRaw(`sess->>'pendingMfaUserId' = ?`, [id])
      .del();
    try {
      _io?.in(`user:${userId}`).disconnectSockets(true);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to disconnect sockets of a revoked user');
    }
    return deleted;
  },
};
