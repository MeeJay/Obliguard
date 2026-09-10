import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { banService } from '../services/ban.service';
import { verifyDelegationToken, verifyFailureToHttp } from '../services/delegationAuth.service';
import { logger } from '../utils/logger';

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
    logger.warn({ code, headers: { hasAuth: !!req.headers.authorization } }, 'external-bans: token rejected');
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
const ALLOWED_SOURCE_APPS = ['oblihub']; // extend when more apps push bans (e.g. 'obliview')

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
    let expiresAt: Date | null = null;
    if (body.banned_until != null && typeof body.banned_until === 'string') {
      const d = new Date(body.banned_until);
      if (!isNaN(d.getTime())) expiresAt = d;
    }

    // Master tenant id — the platform-level tenant that owns bans not tied to a specific
    // customer tenant. Cross-suite bans always land at this level so they enforce globally.
    const masterTenant = await db('tenants').where({ is_master: true }).first('id') as { id: number } | undefined;
    if (!masterTenant) {
      res.status(500).json({ success: false, error: 'Master tenant not configured' });
      return;
    }

    const { ban, isNew } = await banService.createFromExternal({
      ip,
      reason,
      sourceApp: delegated.sourceAppType,
      expiresAt,
      masterTenantId: masterTenant.id,
    });

    logger.info({ ip, sourceApp: delegated.sourceAppType, banId: ban.id, isNew }, 'external ban recorded');
    res.status(isNew ? 201 : 200).json({ success: true, data: { banId: ban.id, isNew, ip: ban.ip } });
  } catch (err) { next(err); }
}
