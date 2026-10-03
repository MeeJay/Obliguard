import type { Request, Response, NextFunction } from 'express';
import { isIP } from 'net';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { banService } from '../services/ban.service';
import { verifyDelegationToken, verifyFailureToHttp } from '../services/delegationAuth.service';
import { logger } from '../utils/logger';
import { auditService } from '../services/audit.service';

/**
 * Middleware — verifies the incoming Bearer JWT is a valid Obligate delegation token whose
 * audience is 'obliguard'. Rejects everything else. On success attaches `req.delegated` with
 * the parsed context (subjectType, sourceAppType, subjectUserId, claims).
 *
 * Kept next to the route it protects because these endpoints are the only ones on Obliguard
 * that expect a delegation token today — a broader middleware surface can be extracted when
 * a second endpoint appears.
 */
export async function requireExternalAppDelegation(req: Request, res: Response, next: NextFunction): Promise<void> {
  const result = await verifyDelegationToken(req.headers.authorization, 'obliguard');
  if (!result.ok) {
    const { status, code, message } = verifyFailureToHttp(result.failure);
    logger.warn(
      { reason: code, kid: result.kid, ip: req.ip, method: req.method, path: req.originalUrl, hasAuth: !!req.headers.authorization },
      'external-bans: delegation token rejected',
    );
    res.status(status).json({ success: false, code, error: message });
    return;
  }
  (req as unknown as { delegated: typeof result.result }).delegated = result.result;
  next();
}

/**
 * POST /api/external-bans
 *
 * Body: { ip, source?, reason?, proxy_host_domain?, source_type?, first_seen_at?, hit_count?, banned_until? }
 * Auth: Bearer <delegation JWT>, subjectType='app', source_app allowlisted below.
 *
 * Idempotent: same IP posted twice merges into one row.
 *
 * Only accepts tokens minted for app-scoped delegation ('app:oblihub' etc). A regular user
 * token (numeric sub) is refused — an end-user should not be able to push cross-suite bans by
 * mistake or intent; global bans through this endpoint are always a system decision.
 */
// Owner decision 8: a constant list reviewed in code, never configurable at runtime.
export const ALLOWED_SOURCE_APPS: readonly string[] = ['oblihub'];

/** Default cap on an external ban's duration (7 days, owner decision 8). */
const EXTERNAL_BAN_MAX_SECONDS_DEFAULT = 7 * 24 * 3600;

/**
 * Maximum duration of a ban pushed by a sibling app, from EXTERNAL_BAN_MAX_SECONDS (positive
 * integer seconds). A missing or invalid value falls back to the 7-day default. Read per call.
 */
export function externalBanMaxSeconds(): number {
  const raw = process.env.EXTERNAL_BAN_MAX_SECONDS?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return EXTERNAL_BAN_MAX_SECONDS_DEFAULT;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : EXTERNAL_BAN_MAX_SECONDS_DEFAULT;
}

export async function postExternalBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const delegated = (req as unknown as { delegated: { subjectType: 'user' | 'app'; sourceAppType: string | null } }).delegated;
    if (delegated.subjectType !== 'app' || !delegated.sourceAppType) {
      res.status(403).json({ success: false, code: 'user_token_refused', error: 'External bans require an app-scoped delegation token' });
      return;
    }
    if (!ALLOWED_SOURCE_APPS.includes(delegated.sourceAppType)) {
      res.status(403).json({ success: false, code: 'source_app_not_allowed', error: `App ${delegated.sourceAppType} is not allowed to push bans` });
      return;
    }

    const body = req.body as {
      ip?: unknown; reason?: unknown; source_type?: unknown;
      proxy_host_domain?: unknown; hit_count?: unknown;
      banned_until?: unknown; first_seen_at?: unknown;
    };
    if (typeof body.ip !== 'string' || body.ip.length === 0 || body.ip.length > 45) {
      res.status(400).json({ success: false, error: 'ip required (string, ≤ 45 chars)' });
      return;
    }
    const ip = body.ip;
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;

    // Duration: never longer than EXTERNAL_BAN_MAX_SECONDS. A request without banned_until
    // (permanent) gets the maximum too — a sibling app cannot create a permanent global ban.
    const now = Date.now();
    const maxExpiresAt = new Date(now + externalBanMaxSeconds() * 1000);
    let expiresAt = maxExpiresAt;
    if (body.banned_until != null) {
      const d = typeof body.banned_until === 'string' ? new Date(body.banned_until) : null;
      if (!d || isNaN(d.getTime())) {
        res.status(400).json({ success: false, error: 'banned_until must be an ISO 8601 date' });
        return;
      }
      if (d.getTime() <= now) {
        res.status(400).json({ success: false, error: 'banned_until must be in the future' });
        return;
      }
      if (d < maxExpiresAt) expiresAt = d;
    }

    const { ban, isNew } = await banService.createFromExternal({
      ip,
      reason,
      sourceApp: delegated.sourceAppType,
      expiresAt,
      // Cross-suite bans are owned by the master (Default) tenant — positional id, there is
      // no is_master column — and always land at global scope so they enforce everywhere.
      masterTenantId: MASTER_TENANT_ID,
    });

    logger.info({ ip, sourceApp: delegated.sourceAppType, banId: ban.id, isNew, expiresAt }, 'external ban recorded');
    // Actor = the sibling app (no session user); filed in the Default tenant that owns the ban.
    await auditService.logReq(req, {
      action: 'bans.external_created', targetType: 'ban', targetId: ban.id,
      tenantId: MASTER_TENANT_ID, userId: null, username: `app:${delegated.sourceAppType}`,
      details: { ip: ban.ip, sourceApp: delegated.sourceAppType, isNew, reason, expiresAt: expiresAt.toISOString() },
    });
    res.status(isNew ? 201 : 200).json({ success: true, data: { banId: ban.id, isNew, ip: ban.ip } });
  } catch (err) { next(err); }
}

/**
 * DELETE /api/external-bans/:ip
 *
 * Withdraw a ban previously pushed by the calling app. Filtered by origin_app from the
 * delegation token — an admin from app A cannot delete app B's bans, even if both share this
 * Obliguard tenant. Returns 200 with { deleted: n } even when n=0 so the caller can distinguish
 * "we tried" from "auth failed". Idempotent — deleting a non-existent ban is not an error.
 */
export async function deleteExternalBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const delegated = (req as unknown as { delegated: { subjectType: 'user' | 'app'; sourceAppType: string | null } }).delegated;
    if (delegated.subjectType !== 'app' || !delegated.sourceAppType) {
      res.status(403).json({ success: false, code: 'user_token_refused', error: 'External bans require an app-scoped delegation token' });
      return;
    }
    if (!ALLOWED_SOURCE_APPS.includes(delegated.sourceAppType)) {
      res.status(403).json({ success: false, code: 'source_app_not_allowed', error: `App ${delegated.sourceAppType} is not allowed to manage bans` });
      return;
    }
    const ip = req.params.ip;
    // Validated before it reaches the inet comparison: a non-address would raise 22P02 (500).
    if (!ip || ip.length > 45 || isIP(ip) === 0) {
      res.status(400).json({ success: false, error: 'ip required (single IPv4/IPv6 address)' });
      return;
    }
    // Only the active external rows this app pushed, through the single
    // deactivation path (lifted_at, ban:lifted, MikroTik unban).
    const deleted = await banService.withdrawExternal(ip, delegated.sourceAppType);
    logger.info({ ip, sourceApp: delegated.sourceAppType, deleted }, 'external ban withdrawn');
    await auditService.logReq(req, {
      action: 'bans.external_withdrawn', targetType: 'ban',
      tenantId: MASTER_TENANT_ID, userId: null, username: `app:${delegated.sourceAppType}`,
      details: { ip, sourceApp: delegated.sourceAppType, deleted },
    });
    res.json({ success: true, data: { ip, deleted } });
  } catch (err) { next(err); }
}

/**
 * GET /api/external-bans/ping
 *
 * End-to-end auth chain probe. No side effects. Returns 200 with the calling app's identity
 * if the delegation token validates. Used by Oblihub's Settings 'Test' button to distinguish
 * 'target unreachable' from 'token invalid' from 'all good'.
 */
export async function pingExternal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const delegated = (req as unknown as { delegated: { subjectType: 'user' | 'app'; sourceAppType: string | null } }).delegated;
    if (delegated.subjectType !== 'app' || !delegated.sourceAppType) {
      res.status(403).json({ success: false, code: 'user_token_refused', error: 'External endpoints require an app-scoped delegation token' });
      return;
    }
    res.json({ success: true, data: { sourceApp: delegated.sourceAppType, allowed: ALLOWED_SOURCE_APPS.includes(delegated.sourceAppType) } });
  } catch (err) { next(err); }
}
