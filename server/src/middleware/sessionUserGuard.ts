import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { regenerateSession } from '../utils/regenerateSession';

const TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;
const cache = new Map<number, { active: boolean; role: string | null; at: number }>();

/** Forget the cached account state (call after disabling / demoting / deleting). */
export function invalidateUserState(userId: number): void {
  cache.delete(userId);
}

async function loadUserState(userId: number): Promise<{ active: boolean; role: string | null }> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const row = await db('users').where({ id: userId }).first('is_active', 'role') as
    { is_active: boolean; role: string } | undefined;
  const state = { active: !!row?.is_active, role: row?.role ?? null, at: Date.now() };
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(userId, state);
  return state;
}

/**
 * Re-validates the account behind an authenticated session on every request
 * (state-based revocation, short cache). Sessions cache userId + role, and
 * deleting session rows alone is not enough: a request that loaded the session
 * before the revocation re-saves it when it ends. So:
 *   - account disabled or deleted → the identity is dropped (fresh, empty
 *     session) and the request continues anonymous — requireAuth then answers
 *     401, public routes (login, SSO) keep working;
 *   - role changed (demotion) → the session role is refreshed from the DB.
 */
export async function sessionUserGuard(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;
  if (!userId) { next(); return; }
  try {
    const state = await loadUserState(userId);
    if (!state.active || !state.role) {
      await regenerateSession(req);
      next();
      return;
    }
    if (req.session.role !== state.role) req.session.role = state.role;
    next();
  } catch (err) {
    next(err);
  }
}
