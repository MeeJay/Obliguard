import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import { tenantService } from '../services/tenant.service';

// Extend Express.Request to carry the resolved tenantId
declare global {
  namespace Express {
    interface Request {
      tenantId: number;
    }
  }
}

/** Error code: the session has no usable tenant (403). */
export const NO_TENANT_ACCESS = 'noTenantAccess';
/** Error code: a write was sent by a tab that believes it works in another tenant (409). */
export const TENANT_CHANGED = 'tenantChanged';
/**
 * Operating-tenant header. Sent by the SPA with the tenant the tab is showing;
 * echoed on every validated response with the session tenant.
 */
export const TENANT_HEADER = 'X-Obliguard-Tenant';

const TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;

/** Non-admin access decisions, keyed `${userId}:${tenantId}`. */
const accessCache = new Map<string, { ok: boolean; at: number }>();
/** Tenant existence, for platform admins (implicit access to every tenant). */
const existsCache = new Map<number, { ok: boolean; at: number }>();

function remember<K>(map: Map<K, { ok: boolean; at: number }>, key: K, ok: boolean): void {
  if (map.size >= MAX_ENTRIES) map.clear();
  map.set(key, { ok, at: Date.now() });
}

/** Drop every cached access decision of a user (membership or role changed). */
export function invalidateTenantAccess(userId: number): void {
  const prefix = `${userId}:`;
  for (const key of accessCache.keys()) {
    if (key.startsWith(prefix)) accessCache.delete(key);
  }
}

/** Drop every cached decision about a tenant (created or deleted). */
export function invalidateTenant(tenantId: number): void {
  existsCache.delete(tenantId);
  const suffix = `:${tenantId}`;
  for (const key of accessCache.keys()) {
    if (key.endsWith(suffix)) accessCache.delete(key);
  }
}

/**
 * Can this user operate in this tenant? Platform admins need the tenant to
 * exist; everyone else needs a user_tenants row. 5 s cache, invalidated
 * explicitly on membership / tenant changes.
 *
 * `role` must be fresh: sessionUserGuard refreshes req.session.role on each
 * request, /auth/me aligns it with the DB, and socket.ts passes the DB role.
 */
export async function canUseTenant(userId: number, role: string | null | undefined, tenantId: unknown): Promise<boolean> {
  if (typeof tenantId !== 'number' || !Number.isSafeInteger(tenantId) || tenantId <= 0) return false;
  if (role === 'admin') {
    const hit = existsCache.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
    const ok = await tenantService.exists(tenantId);
    remember(existsCache, tenantId, ok);
    return ok;
  }
  const key = `${userId}:${tenantId}`;
  const hit = accessCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  const ok = await tenantService.userHasAccess(userId, tenantId);
  remember(accessCache, key, ok);
  return ok;
}

/**
 * Resolves req.tenantId from the session, re-validated on every request.
 * Must be applied after requireAuth on all routes that operate on tenant-scoped data.
 *
 *   - no usable session tenant → 403 { code: 'noTenantAccess' };
 *   - a write (non GET/HEAD/OPTIONS) whose X-Obliguard-Tenant header names
 *     another tenant than the session → 409 { code: 'tenantChanged' } (a tab
 *     still showing tenant X must not write into the tenant another tab moved
 *     the shared session to — e.g. a global Lift from Default);
 *   - otherwise the session tenant is echoed in X-Obliguard-Tenant.
 * A malformed or absent header is ignored (old bundles, external callers).
 *
 * READ-ONLY: never mutates req.session. express-session saves the whole
 * object when modified, so a stale in-flight request would overwrite a
 * concurrent /tenant/switch or /auth/me write; silently moving the session
 * (to Default in particular) would change the scope of the next write. The
 * only repair point is /auth/me.
 */
export async function requireTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.session?.userId;
    if (!userId) { next(new AppError(401, 'Authentication required')); return; }
    const tid = req.session.currentTenantId;
    if (tid == null || !(await canUseTenant(userId, req.session.role, tid))) {
      next(new AppError(403, 'No tenant access', NO_TENANT_ACCESS));
      return;
    }
    const claimedRaw = req.get(TENANT_HEADER);
    if (claimedRaw !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const claimed = Number(claimedRaw);
      if (Number.isSafeInteger(claimed) && claimed > 0 && claimed !== tid) {
        next(new AppError(409, 'Workspace changed in another tab', TENANT_CHANGED));
        return;
      }
    }
    res.setHeader(TENANT_HEADER, String(tid));
    req.tenantId = tid;
    next();
  } catch (err) {
    next(err);
  }
}
