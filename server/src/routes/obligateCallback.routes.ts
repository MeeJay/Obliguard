import { Router } from 'express';
import type { Request } from 'express';
import type { Knex } from 'knex';
import crypto from 'crypto';
import { MASTER_TENANT_ID, TENANT_ROLE_ADMIN, TENANT_ROLE_VIEWER, normalizeTenantRole } from '@obliview/shared';
import { db } from '../db';
import { requireAuth } from '../middleware/auth';
import { obligateService } from '../services/obligate.service';
import { tenantService } from '../services/tenant.service';
import { permissionSetService } from '../services/permissionSet.service';
import { appConfigService } from '../services/appConfig.service';
import { userSessionsService } from '../services/userSessions.service';
import { logger } from '../utils/logger';
import { auditService } from '../services/audit.service';
import { regenerateSession } from '../utils/regenerateSession';
import { invalidateUserState } from '../middleware/sessionUserGuard';
import { requireTenant, invalidateTenantAccess, invalidateUserTenantCache } from '../middleware/tenant';
import { isDeviceUuidFormat } from '../utils/agentIdentity';
import { deviceAccessVerdict } from '../utils/tenantWriteRules';
import { configuredPublicOrigins, requestAuthority, requestProto } from '../utils/publicOrigin';

const router = Router();

// Origins of the Obliguard apps registered in Obligate (connected_apps
// base_url), used when no origin is configured locally. Obligate does not say
// which entry is the caller, so a registration is only trusted as "this
// instance" when it is the ONLY Obliguard registered. Cached (5 min, or 30 s
// for an empty/failed answer), one lookup in flight at a time.
let registeredOriginsCache: { at: number; ttl: number; origins: string[] } | null = null;
let registeredOriginsInFlight: Promise<string[]> | null = null;

async function registeredObliguardOrigins(): Promise<string[]> {
  if (registeredOriginsCache && Date.now() - registeredOriginsCache.at < registeredOriginsCache.ttl) {
    return registeredOriginsCache.origins;
  }
  if (!registeredOriginsInFlight) {
    registeredOriginsInFlight = obligateService.getConnectedApps(null, { timeoutMs: 3000 })
      .then((apps) => {
        const origins = apps
          .filter((a) => a.appType === 'obliguard')
          .map((a) => { try { const u = new URL(a.baseUrl); return /^https?:$/.test(u.protocol) && u.hostname ? u.origin : null; } catch { return null; } })
          .filter((o): o is string => !!o);
        registeredOriginsCache = { at: Date.now(), ttl: origins.length > 0 ? 5 * 60_000 : 30_000, origins };
        return origins;
      })
      .finally(() => { registeredOriginsInFlight = null; });
  }
  return registeredOriginsInFlight;
}

let ssoConfigErrorLogged = false;
let ssoAmbiguityLogged = false;
let ssoRegisteredMismatchLogged = false;

/**
 * Public origin of this app for the OAuth redirect_uri and post-logout
 * redirects. `origin` is null when the request's host is not acceptable;
 * `canonical` is then the single origin the browser can be sent to instead
 * (operator-configured or registered in Obligate), when there is one.
 *
 * Never echoes the request: a Host forged through a reachable nginx / container
 * port (the bundled nginx has `server_name _` and forwards the client's Host)
 * must not end up in a redirect_uri, or an authorization code stolen through
 * that foreign redirect_uri could be replayed here (one-click SSO account
 * takeover). X-Forwarded-Host is never used. Resolution:
 *   1. APP_URL / CLIENT_ORIGIN / SSO_ALLOWED_HOSTS configured: the request's
 *      hostname must match one, the CONFIGURED origin is returned; a malformed
 *      entry fails closed (the operator meant to pin something).
 *   2. Otherwise: when exactly ONE Obliguard app is registered in Obligate
 *      (base_url — only Obligate admins can register apps; Obligate answers
 *      /connected only to an active calling app, so a single Obliguard entry is
 *      this instance), the hostname must be its hostname and that registered
 *      origin is returned. Several registered Obliguards are ambiguous (another
 *      instance's callback must never become our redirect_uri): refused, set
 *      APP_URL.
 */
async function resolveSsoOrigin(req: Request): Promise<{ origin: string | null; canonical: string | null }> {
  const { entries, invalid } = configuredPublicOrigins();
  if (invalid.length > 0) {
    if (!ssoConfigErrorLogged) {
      ssoConfigErrorLogged = true;
      logger.error({ invalid }, 'SSO: malformed public-origin configuration — SSO refused until it is fixed (APP_URL=https://host[:port], SSO_ALLOWED_HOSTS=host[:port],https://host[:port])');
    }
    return { origin: null, canonical: null };
  }
  const reqAuth = requestAuthority(req);
  const proto = requestProto(req);

  if (entries.length > 0) {
    // Prefer the configured entry whose host:port is exactly the one in use,
    // then any entry for that hostname (the value is always a configured one).
    const exact = reqAuth
      ? entries.find((e) => { try { return new URL(e.build(proto)).host === reqAuth.authority.toLowerCase(); } catch { return false; } })
      : undefined;
    const match = exact ?? (reqAuth ? entries.find((e) => e.hostname === reqAuth.hostname) : undefined);
    if (match) return { origin: match.build(proto), canonical: null };
    logger.warn({ host: req.headers.host }, 'SSO: request host is not in APP_URL / CLIENT_ORIGIN / SSO_ALLOWED_HOSTS');
    return { origin: null, canonical: entries[0].build(proto) };
  }

  const registered = await registeredObliguardOrigins();
  if (registered.length > 1) {
    if (!ssoAmbiguityLogged) {
      ssoAmbiguityLogged = true;
      logger.error({ registered }, 'SSO: several Obliguard apps are registered in Obligate and no APP_URL is set — SSO refused; set APP_URL to the public URL of this instance');
    }
    return { origin: null, canonical: null };
  }
  const self = registered[0];
  if (!self) {
    logger.warn({ host: req.headers.host }, 'SSO: no APP_URL and no Obliguard app registered in Obligate (or Obligate unreachable) — SSO refused; set APP_URL');
    return { origin: null, canonical: null };
  }
  const selfUrl = new URL(self);
  if (reqAuth && selfUrl.hostname.toLowerCase() === reqAuth.hostname) {
    if (!ssoRegisteredMismatchLogged && (selfUrl.protocol !== `${proto}:`)) {
      ssoRegisteredMismatchLogged = true;
      logger.warn({ registered: self, requestProto: proto }, 'SSO: the base_url registered in Obligate differs from the address in use — the redirect_uri uses the registered one; set APP_URL to the browser-facing URL if SSO lands on the wrong address');
    }
    return { origin: self, canonical: null };
  }
  logger.warn({ host: req.headers.host, registered: self }, 'SSO: request host is not the base_url registered in Obligate for this instance');
  return { origin: null, canonical: self };
}

/**
 * The OAuth browser endpoints are served only on the top-level /auth mount,
 * never through the /api/auth mount of the same router (whose nginx location
 * historically forwarded a client-supplied X-Forwarded-Host).
 */
function isAuthMount(req: Request): boolean {
  return req.baseUrl === '/auth';
}

/**
 * Owner decision 9: Obligate is the exclusive source of the tenant / team
 * memberships of og_ accounts — what an assertion no longer grants is removed
 * at sign-in. OBLIGATE_PRUNE_MEMBERSHIPS=false (or 0 / no / off) restores the
 * additive-only sync. Read on every sign-in.
 */
function pruneMembershipsEnabled(): boolean {
  const raw = (process.env.OBLIGATE_PRUNE_MEMBERSHIPS ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}

/**
 * Tenant role of an asserted tenant (RBAC-5). Obligate sends the slug of a
 * permission set: it is stored as-is when known locally ('admin' or an
 * existing permission_sets slug; the legacy 'member' reads as 'user'). A
 * missing or unknown slug fails closed to 'viewer' (logged): it must never
 * grant more than read-only access.
 */
async function ssoTenantRole(trx: Knex.Transaction, raw: unknown, userId: number, tenantSlug: string): Promise<string> {
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= 64) {
    const role = normalizeTenantRole(raw);
    if (role === TENANT_ROLE_ADMIN) return role;
    if (await trx('permission_sets').where({ slug: role }).first('id')) return role;
  }
  logger.warn({ userId, tenant: tenantSlug, assertedRole: typeof raw === 'string' ? raw.slice(0, 64) : raw ?? null },
    `Obligate SSO: unknown tenant role — mapped to '${TENANT_ROLE_VIEWER}'`);
  return TENANT_ROLE_VIEWER;
}

/**
 * Tenant + team memberships of an SSO identity as the verified assertion
 * grants them (port of Obliance's applySsoMemberships).
 *
 * Upserts a user_tenants row for each asserted tenant known locally (by slug)
 * and adds the asserted teams of that tenant, matched by NAME within the
 * tenant (Obligate sends a flat list of team names across the user's tenants,
 * so the same name in another tenant must not cross-contaminate).
 *
 * With `prune` (og_ accounts, whose access Obligate owns) it also removes what
 * Obligate no longer grants: in each asserted tenant the team memberships not
 * asserted, then the user_tenants rows and team memberships of every tenant
 * that is not asserted. Accounts linked to a local account are never pruned:
 * their memberships are managed here.
 *
 * The tenant role is the asserted permission-set slug (ssoTenantRole). A
 * platform admin also gets an 'admin' membership of the Default tenant (as in
 * Obliance), so it shows in Default's member list; it is kept by the prune.
 * A demoted platform admin loses that membership unless Default is asserted.
 *
 * Returns true when anything was removed (the caller drops the cached
 * tenant-access decisions and closes the live sockets).
 */
/** What a membership sync removed (audit trail of the prune). */
interface MembershipRemovals {
  tenantIds: number[];
  teams: Array<{ tenantId: number; teamId: number }>;
}

async function reconcileTenantsAndTeams(
  localUserId: number,
  assertion: { tenants: unknown; teams: unknown },
  prune: boolean,
  platformAdmin = false,
  platformDemoted = false,
  removals: MembershipRemovals = { tenantIds: [], teams: [] },
): Promise<boolean> {
  const tenants = Array.isArray(assertion.tenants)
    ? assertion.tenants as Array<{ slug?: unknown; role?: unknown } | null>
    : [];
  const teams = Array.isArray(assertion.teams)
    ? (assertion.teams as unknown[]).filter((n): n is string => typeof n === 'string' && n.length > 0)
    : [];

  return db.transaction(async (trx) => {
    const keep = new Set<number>();
    let removed = false;

    for (const t of tenants) {
      if (!t || typeof t.slug !== 'string') continue;
      const tenant = await trx('tenants').where({ slug: t.slug }).first('id') as { id: number } | undefined;
      if (!tenant) {
        logger.warn({ userId: localUserId, slug: t.slug }, 'Obligate SSO: asserted tenant has no local tenant with this slug — skipped');
        continue;
      }
      keep.add(tenant.id);
      const role = await ssoTenantRole(trx, t.role, localUserId, t.slug);
      await trx('user_tenants')
        .insert({ user_id: localUserId, tenant_id: tenant.id, role })
        .onConflict(['user_id', 'tenant_id'])
        .merge({ role });

      // Capabilities are NOT synced: they derive from the tenant role
      // (permission.service.getTenantCapabilities) and team permissions.
      const wantedTeamIds = teams.length > 0
        ? await trx('user_teams').where({ tenant_id: tenant.id }).whereIn('name', teams).pluck('id') as number[]
        : [];
      const currentTeamIds = await trx('team_memberships')
        .join('user_teams', 'user_teams.id', 'team_memberships.team_id')
        .where({ 'team_memberships.user_id': localUserId, 'user_teams.tenant_id': tenant.id })
        .pluck('team_memberships.team_id') as number[];
      const toAdd = wantedTeamIds.filter((id) => !currentTeamIds.includes(id));
      if (toAdd.length > 0) {
        await trx('team_memberships')
          .insert(toAdd.map((team_id) => ({ team_id, user_id: localUserId })))
          .onConflict(['team_id', 'user_id'])
          .ignore();
        logger.info({ userId: localUserId, tenant: t.slug, teamIds: toAdd }, 'Obligate SSO: synced team membership(s)');
      }
      if (prune) {
        const toRemove = currentTeamIds.filter((id) => !wantedTeamIds.includes(id));
        if (toRemove.length > 0) {
          await trx('team_memberships').where({ user_id: localUserId }).whereIn('team_id', toRemove).del();
          removed = true;
          for (const teamId of toRemove) {
            removals.teams.push({ tenantId: tenant.id, teamId });
            logger.info({ userId: localUserId, tenantId: tenant.id, teamId },
              'Obligate SSO: team membership no longer granted by Obligate — removed');
          }
        }
      }
      if (teams.length > 0 && wantedTeamIds.length === 0) {
        logger.debug({ userId: localUserId, tenant: t.slug, asserted: teams },
          'Obligate SSO: no local team of this tenant matches the asserted team names');
      }
    }

    // Platform admin: Default-tenant 'admin' membership (Obliance parity).
    if (platformAdmin) {
      keep.add(MASTER_TENANT_ID);
      await trx('user_tenants')
        .insert({ user_id: localUserId, tenant_id: MASTER_TENANT_ID, role: TENANT_ROLE_ADMIN })
        .onConflict(['user_id', 'tenant_id'])
        .merge({ role: TENANT_ROLE_ADMIN });
    } else if (platformDemoted && !keep.has(MASTER_TENANT_ID)) {
      // Demoted from platform admin: the Default membership this sync granted
      // must not outlive the role (Default = god view), even without prune
      // (accounts linked to a local account). An asserted Default stays.
      const n = await trx('user_tenants').where({ user_id: localUserId, tenant_id: MASTER_TENANT_ID }).del();
      if (n > 0) {
        removed = true;
        removals.tenantIds.push(MASTER_TENANT_ID);
        logger.info({ userId: localUserId }, 'Obligate SSO: platform admin role revoked — Default tenant membership removed');
      }
    }

    if (!prune) return removed;

    // Tenants Obligate no longer grants: their team memberships, then the
    // tenant rows themselves.
    const keepIds = [...keep];
    const staleTeamIds = await trx('team_memberships')
      .join('user_teams', 'user_teams.id', 'team_memberships.team_id')
      .where({ 'team_memberships.user_id': localUserId })
      .modify((q) => { if (keepIds.length > 0) q.whereNotIn('user_teams.tenant_id', keepIds); })
      .select('team_memberships.team_id', 'user_teams.tenant_id') as Array<{ team_id: number; tenant_id: number }>;
    if (staleTeamIds.length > 0) {
      await trx('team_memberships').where({ user_id: localUserId }).whereIn('team_id', staleTeamIds.map((r) => r.team_id)).del();
      removed = true;
      for (const r of staleTeamIds) {
        removals.teams.push({ tenantId: r.tenant_id, teamId: r.team_id });
        logger.info({ userId: localUserId, tenantId: r.tenant_id, teamId: r.team_id },
          'Obligate SSO: team membership of a tenant no longer granted by Obligate — removed');
      }
    }
    const staleTenantIds = await trx('user_tenants')
      .where({ user_id: localUserId })
      .modify((q) => { if (keepIds.length > 0) q.whereNotIn('tenant_id', keepIds); })
      .pluck('tenant_id') as number[];
    if (staleTenantIds.length > 0) {
      await trx('user_tenants').where({ user_id: localUserId }).whereIn('tenant_id', staleTenantIds).del();
      removed = true;
      for (const tenantId of staleTenantIds) {
        removals.tenantIds.push(tenantId);
        logger.info({ userId: localUserId, tenantId },
          'Obligate SSO: tenant access no longer granted by Obligate — removed');
      }
    }
    return removed;
  });
}

/**
 * GET /auth/callback?code=xxx&state=xxx
 * Called by Obligate after successful authentication.
 * Exchanges the code for user info, auto-provisions, creates session, redirects.
 */
router.get('/callback', async (req, res) => {
  try {
    if (!isAuthMount(req)) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const { code, state } = req.query as { code?: string; state?: string };
    if (typeof code !== 'string' || !code) {
      res.status(400).json({ success: false, error: 'Missing code' });
      return;
    }

    // Validate OAuth state parameter to prevent login CSRF (RFC 6749 §10.12)
    const expectedState = req.session.oauthState;
    const storedRedirectUri = req.session.oauthRedirectUri;
    delete req.session.oauthState;
    delete req.session.oauthRedirectUri;
    if (!expectedState || typeof state !== 'string' || !state || state !== expectedState) {
      logger.warn({ receivedState: state, hasExpected: !!expectedState }, 'Obligate callback: state mismatch — possible CSRF');
      await auditService.logReq(req, { action: 'auth.sso_login', tenantId: null, userId: null, username: null, success: false, details: { reason: 'state_mismatch' } });
      res.redirect('/login?error=sso_failed');
      return;
    }

    // Replay the exact redirect_uri /auth/sso-redirect sent to Obligate for
    // this session (sessions created before this change: rebuild it from the
    // checked origin — never from X-Forwarded-Host).
    const fallbackOrigin = storedRedirectUri ? null : (await resolveSsoOrigin(req)).origin;
    const redirectUri = storedRedirectUri ?? (fallbackOrigin ? `${fallbackOrigin}/auth/callback` : null);
    if (!redirectUri) {
      res.redirect('/login?error=sso_misconfigured');
      return;
    }

    // Exchange code with Obligate
    logger.info({ redirectUri }, 'Obligate callback: exchanging code');
    const assertion = await obligateService.exchangeCode(code, redirectUri);
    if (!assertion) {
      logger.warn('Obligate callback: exchange returned null — code invalid/expired or redirect_uri mismatch');
      await auditService.logReq(req, { action: 'auth.sso_login', tenantId: null, userId: null, username: null, success: false, details: { reason: 'exchange_failed' } });
      res.redirect('/login?error=sso_failed');
      return;
    }
    logger.info({ obligateUserId: assertion.obligateUserId, username: assertion.username }, 'Obligate callback: exchange OK');
    if (!Number.isInteger(assertion.obligateUserId) || assertion.obligateUserId <= 0) {
      logger.warn({ obligateUserId: assertion.obligateUserId }, 'Obligate callback: invalid obligateUserId in assertion');
      res.redirect('/login?error=sso_failed');
      return;
    }

    // Find or create local user.
    // The local account is resolved from OUR link records only. Obligate's
    // linkedLocalUserId is just its copy of the id we reported through
    // report-provision — which any holder of the (browser-exposed) API key can
    // rewrite — so it is cross-checked, never trusted on its own: a stale or
    // rewritten value must not open a session on an unrelated local account
    // (e.g. a local admin).
    let localUserId = await obligateService.getLinkedLocalUserId(assertion.obligateUserId) ?? 0;
    /** Platform role before this login (undefined for a new account). */
    let prevRole: string | undefined;
    const needsProvision = localUserId === 0;

    if (assertion.linkedLocalUserId && assertion.linkedLocalUserId !== localUserId) {
      logger.warn(
        { obligateUserId: assertion.obligateUserId, claimedLocalUserId: assertion.linkedLocalUserId, linkedLocalUserId: localUserId || null },
        'Obligate callback: linkedLocalUserId does not match the local SSO link — ignored',
      );
    }

    if (!needsProvision) {
      // Obligate is the authority on whether an SSO account is active: it only
      // issues an assertion for an active user whose app link is enabled. A
      // successful exchange therefore re-enables the local account — a disable
      // pushed through sso-user-sync (legitimate, missed 'reactivate', or forged
      // with the browser-exposed key) can't lock the user out for good.
      prevRole = (await db('users').where({ id: localUserId }).first('role') as { role: string } | undefined)?.role;
      await db('users').where({ id: localUserId }).update({
        is_active: true,
        role: assertion.role === 'admin' ? 'admin' : 'user',
        email: assertion.email,
        display_name: assertion.displayName,
        updated_at: new Date(),
      });
      // Socket rooms (role:admin, tenant:X:admin) are fixed at connect time:
      // a platform-role change closes the live sockets so they reconnect with
      // the new role (HTTP is already covered by sessionUserGuard).
      if (prevRole && prevRole !== (assertion.role === 'admin' ? 'admin' : 'user')) {
        userSessionsService.disconnectSockets(localUserId);
      }
      // Make sure the link row exists and points to this account (idempotent;
      // repairs accounts that were resolved through users.foreign_id).
      await db('sso_foreign_users')
        .insert({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId, local_user_id: localUserId })
        .onConflict(['foreign_source', 'foreign_user_id'])
        .merge({ local_user_id: localUserId });
      // Repair Obligate's pointer when it drifted (missing, stale or tampered).
      if (assertion.linkedLocalUserId !== localUserId) {
        obligateService.reportProvision(assertion.obligateUserId, localUserId).catch(() => {});
      }
    } else {
      // Username for the new account. A disabled og_ account keeps its row when
      // its Obligate user is deleted (sso-user-sync 'delete'); if the same
      // username is re-created in Obligate (new id), move the stale account's
      // name aside instead of failing on the unique constraint. Any other clash
      // (active account, local account) gets a suffixed name.
      let username = `og_${assertion.username}`.slice(0, 64);
      const clash = await db('users').where({ username }).first('id', 'foreign_source', 'is_active') as
        { id: number; foreign_source: string | null; is_active: boolean } | undefined;
      if (clash) {
        if (clash.foreign_source === 'obligate' && !clash.is_active) {
          const aside = `${username.slice(0, 64 - `~${clash.id}`.length)}~${clash.id}`;
          await db('users').where({ id: clash.id }).update({ username: aside, updated_at: new Date() });
          logger.warn({ staleUserId: clash.id, renamedTo: aside, obligateUserId: assertion.obligateUserId },
            'Obligate SSO: username held by a disabled SSO account — renamed it aside');
        } else {
          const suffix = `_${assertion.obligateUserId}`;
          username = `${username.slice(0, 64 - suffix.length)}${suffix}`;
          logger.warn({ clashUserId: clash.id, username, obligateUserId: assertion.obligateUserId },
            'Obligate SSO: username already taken — provisioning with a suffixed username');
        }
      }
      const [newUser] = await db('users')
        .insert({
          username,
          display_name: assertion.displayName || assertion.username,
          email: assertion.email,
          role: assertion.role === 'admin' ? 'admin' : 'user',
          is_active: true,
          foreign_source: 'obligate',
          foreign_id: assertion.obligateUserId,
          enrollment_version: 999,
        })
        .returning('id') as Array<{ id: number }>;
      localUserId = newUser.id;

      await db('sso_foreign_users')
        .insert({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId, local_user_id: localUserId })
        .onConflict(['foreign_source', 'foreign_user_id'])
        .merge({ local_user_id: localUserId });

      obligateService.reportProvision(assertion.obligateUserId, localUserId).catch(() => {});
    }

    // Sync tenant + team memberships from Obligate (every SSO login). For an
    // og_ account Obligate is the source of truth: memberships it no longer
    // grants are removed (OBLIGATE_PRUNE_MEMBERSHIPS=false keeps them). An
    // account linked to a local account keeps the additive sync.
    const ssoOwned = (await db('users').where({ id: localUserId }).first('foreign_source') as
      { foreign_source: string | null } | undefined)?.foreign_source === 'obligate';
    const removals: MembershipRemovals = { tenantIds: [], teams: [] };
    const membershipsRemoved = await reconcileTenantsAndTeams(
      localUserId, { tenants: assertion.tenants, teams: assertion.teams }, ssoOwned && pruneMembershipsEnabled(),
      assertion.role === 'admin', prevRole === 'admin' && assertion.role !== 'admin', removals,
    );
    if (membershipsRemoved) {
      // One row per tenant that lost something (filed in that tenant), actor = Obligate.
      const touched = new Set<number>([...removals.tenantIds, ...removals.teams.map((t) => t.tenantId)]);
      await auditService.logReqMany(req, [...touched].map((tenantId) => ({
        action: 'sso.memberships_pruned', targetType: 'user', targetId: localUserId, tenantId,
        userId: null, username: 'app:obligate',
        details: {
          account: assertion.username,
          tenantAccessRemoved: removals.tenantIds.includes(tenantId),
          teamsRemoved: removals.teams.filter((t) => t.tenantId === tenantId).map((t) => t.teamId),
        },
      })));
      // Other sessions of this user may sit on a removed tenant: requireTenant
      // re-checks membership (once the cached decisions are dropped) and
      // /auth/me moves them to a remaining tenant. Live sockets keep their
      // tenant / team rooms until they reconnect: close them.
      invalidateUserTenantCache(localUserId);
      userSessionsService.disconnectSockets(localUserId);
    }

    // Sync preferences from Obligate (theme, language, toast settings)
    if (assertion.preferences) {
      const prefUpdate: Record<string, unknown> = {};
      if (assertion.preferences.preferredLanguage) prefUpdate.preferred_language = assertion.preferences.preferredLanguage;
      if (assertion.preferences.profilePhotoUrl !== undefined) prefUpdate.avatar = assertion.preferences.profilePhotoUrl;
      if (Object.keys(prefUpdate).length > 0) {
        await db('users').where({ id: localUserId }).update(prefUpdate);
      }
      const uiPrefs: Record<string, unknown> = {};
      if (assertion.preferences.preferredTheme) uiPrefs.preferredTheme = assertion.preferences.preferredTheme;
      if (assertion.preferences.toastEnabled !== undefined) uiPrefs.toastEnabled = assertion.preferences.toastEnabled;
      if (assertion.preferences.toastPosition) uiPrefs.toastPosition = assertion.preferences.toastPosition;
      if (assertion.preferences.anonymousMode !== undefined) uiPrefs.anonymousMode = assertion.preferences.anonymousMode;
      if (Object.keys(uiPrefs).length > 0) {
        const existingRow = await db('users').where({ id: localUserId }).select('preferences').first() as { preferences: unknown } | undefined;
        const existing = (typeof existingRow?.preferences === 'string' ? JSON.parse(existingRow.preferences) : existingRow?.preferences) ?? {};
        await db('users').where({ id: localUserId }).update({
          preferences: JSON.stringify({ ...existing, ...uiPrefs }),
        });
      }
    }

    // Establish session — on a FRESH session id (anti session-fixation: the
    // state / redirect_uri checks above live inside the incoming session, so a
    // planted cookie would otherwise become the victim's authenticated session).
    const requestedSlug = req.session.requestedTenantSlug;
    await regenerateSession(req);
    invalidateUserState(localUserId); // is_active / role were just (re)written
    invalidateTenantAccess(localUserId); // memberships may have just been added
    // The account may have been disabled meanwhile (sso-user-sync racing this
    // sign-in): never open a session on it, and tell the login page why.
    const user = await db('users').where({ id: localUserId }).first() as { username: string; role: string; is_active: boolean } | undefined;
    if (!user?.is_active) {
      logger.warn({ userId: localUserId, obligateUserId: assertion.obligateUserId }, 'Obligate callback: local account is disabled — no session');
      await auditService.logReq(req, {
        action: 'auth.sso_login', tenantId: null, userId: localUserId, username: user?.username ?? assertion.username,
        targetType: 'user', targetId: localUserId, success: false, details: { reason: 'account_disabled' },
      });
      res.redirect('/login?error=account_disabled');
      return;
    }
    req.session.userId = localUserId;
    if (user) {
      req.session.username = user.username;
      // Platform role straight from the verified assertion (already written to
      // users.role above) — not re-read, so a concurrent sso-user-sync call
      // can't slip a different role into this new session.
      req.session.role = assertion.role === 'admin' ? 'admin' : 'user';
    }

    // Cross-app handoff: prefer the tenant slug requested by the source app
    // when the user has access to a tenant with that slug. Otherwise fall
    // back to the first available tenant (existing behaviour).
    //
    // Platform admins (assertion.role === 'admin') have implicit access to
    // every tenant but no user_tenants rows — so the regular JOIN misses for
    // them. They only need a tenant-existence check. Tenant admins / members
    // keep the strict JOIN to preserve access control. Detection uses the
    // assertion role, never the local user.role.
    let resolvedTenantId: number | null = null;
    if (requestedSlug) {
      const isPlatformAdmin = assertion.role === 'admin';
      let match: { id: number } | undefined;
      if (isPlatformAdmin) {
        match = await db('tenants')
          .where({ slug: requestedSlug })
          .select('id')
          .first() as { id: number } | undefined;
      } else {
        match = await db('tenants as t')
          .join('user_tenants as ut', 'ut.tenant_id', 't.id')
          .where({ 't.slug': requestedSlug, 'ut.user_id': localUserId })
          .select('t.id')
          .first() as { id: number } | undefined;
      }
      if (match) {
        resolvedTenantId = match.id;
        logger.info({ userId: localUserId, slug: requestedSlug, isPlatformAdmin }, 'Cross-app handoff: tenant matched');
      } else {
        logger.info({ userId: localUserId, slug: requestedSlug, isPlatformAdmin },
          'Cross-app handoff: requested tenant not accessible, falling back');
      }
      // Always clear so the value does not leak into a subsequent login that did
      // not originate from a cross-app pill click.
      delete req.session.requestedTenantSlug;
    }

    if (resolvedTenantId === null) {
      resolvedTenantId = await tenantService.resolveLoginTenant(localUserId, assertion.role === 'admin' ? 'admin' : 'user');
    }
    if (resolvedTenantId !== null) req.session.currentTenantId = resolvedTenantId;
    else {
      logger.warn(
        { userId: localUserId, asserted: (Array.isArray(assertion.tenants) ? assertion.tenants : []).map((t) => t.slug) },
        'Obligate SSO: user has no local tenant membership — no tenant access until one is assigned',
      );
    }

    logger.info(`Obligate SSO: user ${assertion.username} (obligate #${assertion.obligateUserId}) → local #${localUserId}`);
    await auditService.logReq(req, {
      action: 'auth.sso_login', targetType: 'user', targetId: localUserId,
      details: { method: 'obligate', obligateUserId: assertion.obligateUserId, platformRole: assertion.role === 'admin' ? 'admin' : 'user' },
    });

    // Save session, then redirect via HTML meta refresh to ensure Set-Cookie header
    // is fully processed by the browser before navigation occurs.
    req.session.save((err) => {
      if (err) { logger.error(err, 'Session save failed'); res.redirect('/login?error=sso_failed'); return; }
      logger.info({ sessionId: req.sessionID, userId: req.session.userId }, 'Session saved, redirecting to /');
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#8b949e;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.s{text-align:center}.d{width:28px;height:28px;border:2.5px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:r .6s linear infinite;margin:0 auto 14px}@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class="s"><div class="d"></div><div>Signing in...</div></div></body></html>`);
    });
  } catch (err) {
    logger.error(err, 'Obligate callback error');
    res.redirect('/login?error=sso_failed');
  }
});

/**
 * GET /auth/sso-redirect
 * Server-side redirect to Obligate authorize endpoint (browser redirect).
 * client_id is the PUBLIC id sha256(apiKey) whenever the Obligate instance
 * accepts it (obligateService.getAuthorizeClientId). Older Obligate builds
 * only know the raw key: until they are updated the key still reaches the
 * browser here, so it must not be relied on as a confidential secret — the
 * Bearer-authenticated endpoints below only ever act on accounts linked to
 * Obligate and never grant privileges.
 */
router.get('/sso-redirect', async (req, res) => {
  try {
    if (!isAuthMount(req)) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    // Cross-app tenant handoff: the source Obli* app appends ?tenant=<slug>
    // when the user clicks the topbar switcher pill. Stash it in the session
    // so /auth/callback can apply it once the user comes back from Obligate.
    // Validate against the same regex the tenants table enforces — anything
    // else is dropped silently (defence-in-depth, untrusted query input).
    const requestedTenant = req.query.tenant;
    if (typeof requestedTenant === 'string' && /^[a-z0-9-]{1,64}$/.test(requestedTenant)) {
      req.session.requestedTenantSlug = requestedTenant;
    }

    const raw = await appConfigService.getObligateRaw();
    const obligateCfg = await appConfigService.getObligateConfig();
    if (!raw.url || !raw.apiKey || !obligateCfg.enabled) {
      res.redirect('/login');
      return;
    }
    // Verify Obligate is reachable before redirecting (prevents redirect loop when Gate is down)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const healthRes = await fetch(`${raw.url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!healthRes.ok) { res.redirect('/login?error=sso_failed'); return; }
    } catch {
      res.redirect('/login?error=sso_failed');
      return;
    }
    const resolved = await resolveSsoOrigin(req);
    const selfUrl = resolved.origin;
    if (!selfUrl) {
      // Not an allowed SSO address. When there is a single canonical origin
      // (configured, or the one registered in Obligate), continue SSO there —
      // it is operator/Obligate-defined, so it can't be steered by the request.
      // The hop is marked (canon=1) and never repeated: behind a proxy that
      // rewrites Host the canonical URL would otherwise redirect to itself.
      const here = requestAuthority(req)?.hostname;
      const alreadyHopped = req.query.canon === '1';
      if (resolved.canonical && !alreadyHopped && new URL(resolved.canonical).hostname.toLowerCase() !== here) {
        const tenantQs = typeof requestedTenant === 'string' && /^[a-z0-9-]{1,64}$/.test(requestedTenant)
          ? `&tenant=${encodeURIComponent(requestedTenant)}` : '';
        res.redirect(`${resolved.canonical}/auth/sso-redirect?canon=1${tenantQs}`);
        return;
      }
      if (alreadyHopped) {
        logger.warn({ host: req.headers.host, canonical: resolved.canonical }, 'SSO: the canonical URL does not reach this server with its own Host — check the reverse proxy (ProxyPreserveHost On / proxy_set_header Host $host) and APP_URL');
      }
      res.redirect('/login?error=sso_misconfigured');
      return;
    }
    // Safety: never redirect to ourselves (misconfigured obligate_url pointing to this app)
    if (raw.url.replace(/\/$/, '') === selfUrl.replace(/\/$/, '')) {
      logger.error({ obligateUrl: raw.url, selfUrl }, 'sso-redirect: obligate_url points to this app — aborting to prevent loop');
      res.redirect('/login?error=sso_misconfigured');
      return;
    }
    const redirectUri = `${selfUrl}/auth/callback`;

    // Generate cryptographic state token to prevent login CSRF (RFC 6749 §10.12).
    // The redirect_uri is stored with it so the callback exchanges the code with
    // exactly this value instead of rebuilding it from request headers.
    const oauthState = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = oauthState;
    req.session.oauthRedirectUri = redirectUri;

    const clientId = await obligateService.getAuthorizeClientId(raw.url, raw.apiKey, redirectUri);
    if (!clientId) {
      // Obligate's support for public client ids could not be determined
      // (never probed conclusively): fail closed rather than put the raw key
      // in the browser. The next attempt probes again.
      res.redirect('/login?error=sso_failed');
      return;
    }
    const obligateUrl = `${raw.url}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(oauthState)}`;
    logger.info({ obligateUrl: raw.url, redirectUri }, 'sso-redirect: redirecting to Obligate');

    // Save session before redirecting to ensure state is persisted
    req.session.save((err) => {
      if (err) { logger.error(err, 'sso-redirect: session save failed'); res.redirect('/login?error=sso_failed'); return; }
      res.redirect(obligateUrl);
    });
  } catch {
    res.redirect('/login?error=sso_failed');
  }
});

/**
 * GET /api/auth/app-info
 * Called by Obligate (Bearer auth) to discover teams + tenants for mapping UI.
 */
router.get('/app-info', async (req, res) => {
  try {
    // Validate Bearer token = our Obligate API key (reverse auth: Obligate calls us)
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Missing Bearer token' });
      return;
    }
    if (!(await obligateService.verifyInboundBearer(authHeader))) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }

    // Fetch all teams across all tenants
    const teams = await db('user_teams')
      .join('tenants', 'user_teams.tenant_id', 'tenants.id')
      .select('user_teams.id', 'user_teams.name', 'tenants.slug as tenant_slug', 'tenants.name as tenant_name')
      .orderBy('tenants.name')
      .orderBy('user_teams.name') as Array<{ id: number; name: string; tenant_slug: string; tenant_name: string }>;

    // Fetch all tenants
    const tenants = await db('tenants')
      .select('id', 'name', 'slug')
      .orderBy('name') as Array<{ id: number; name: string; slug: string }>;

    // Permission sets: Obligate offers them as tenant-role choices (the slug
    // is what comes back as the asserted tenant role; RBAC-5).
    const permissionSets = (await permissionSetService.getAll())
      .map((p) => ({ slug: p.slug, name: p.name, isDefault: p.isDefault }));

    res.json({
      success: true,
      data: {
        roles: ['admin', 'user'],
        teams: teams.map(t => ({ id: t.id, name: t.name, tenantSlug: t.tenant_slug, tenantName: t.tenant_name })),
        tenants: tenants.map(t => ({ slug: t.slug, name: t.name })),
        permissionSets,
      },
    });
  } catch (err) {
    logger.error(err, 'app-info error');
    res.status(500).json({ success: false, error: 'Failed to fetch app info' });
  }
});

/**
 * GET /api/auth/dashboard-stats
 * Called by Obligate (Bearer auth) to display stats on the Obligate dashboard.
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) { res.status(401).json({ success: false }); return; }

    const [agents, activeBans, threats] = await Promise.all([
      db('agent_devices').where({ status: 'approved' }).count('id as c').first(),
      db('ip_bans').where({ is_active: true }).count('id as c').first(),
      db('ip_events').count('id as c').first(),
    ]);
    res.json({ success: true, data: { stats: [
      { label: 'Agents', value: Number((agents as any)?.c ?? 0), color: '#58a6ff' },
      { label: 'Active Bans', value: Number((activeBans as any)?.c ?? 0), color: '#f85149' },
      { label: 'Events Logged', value: Number((threats as any)?.c ?? 0), color: '#d29922' },
    ] } });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/sso-config
 * Returns Obligate SSO config for the LoginPage (public, no auth required).
 */
router.get('/sso-config', async (_req, res) => {
  try {
    const config = await obligateService.getSsoConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false } });
  }
});

/**
 * GET /api/auth/sso-logout-url
 * Returns Obligate logout URL so the client can redirect after local logout.
 */
router.get('/sso-logout-url', async (req, res) => {
  try {
    const cfg = await appConfigService.getObligateRaw();
    if (!cfg.url) {
      res.json({ success: true, data: null });
      return;
    }
    const resolved = await resolveSsoOrigin(req);
    const origin = resolved.origin ?? resolved.canonical;
    if (!origin) {
      res.json({ success: true, data: null });
      return;
    }
    const redirectUri = `${origin}/login`;
    const logoutUrl = `${cfg.url}/logout?redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ success: true, data: logoutUrl });
  } catch {
    res.json({ success: true, data: null });
  }
});

/**
 * GET /api/auth/connected-apps
 * Returns list of connected apps from Obligate (for cross-app nav buttons).
 */
router.get('/connected-apps', requireAuth, async (req, res) => {
  try {
    // Scope the app switcher to the caller's Obligate entitlements. Local
    // (non-SSO) users have no Obligate id → pass null (unfiltered fallback);
    // SSO-provisioned users get only the apps they can actually reach.
    const row = await db('users')
      .where({ id: req.session.userId })
      .select('foreign_source', 'foreign_id')
      .first() as { foreign_source: string | null; foreign_id: number | null } | undefined;
    const obligateUserId = row?.foreign_source === 'obligate' && row.foreign_id ? row.foreign_id : null;
    const apps = await obligateService.getConnectedApps(obligateUserId);
    res.json({ success: true, data: apps });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

/**
 * GET /api/auth/device-links?uuid=xxx
 * Returns cross-app links for a device UUID via Obligate. Tenant-scoped: only
 * for a device of the operating tenant (Default keeps its god-view read).
 */
router.get('/device-links', requireAuth, requireTenant, async (req, res) => {
  try {
    const uuid = typeof req.query.uuid === 'string' ? req.query.uuid : '';
    if (!isDeviceUuidFormat(uuid)) { res.json({ success: true, data: [] }); return; }
    const row = await db('agent_devices').where({ uuid }).first('tenant_id') as { tenant_id: number } | undefined;
    if (!row || deviceAccessVerdict(row.tenant_id, req.tenantId, 'read') !== 'ok') { res.json({ success: true, data: [] }); return; }
    const links = await obligateService.getDeviceLinks(uuid);
    res.json({ success: true, data: links });
  } catch {
    res.json({ success: true, data: [] });
  }
});

/**
 * POST /api/auth/sso-user-sync
 * Called by Obligate (Bearer auth) when an SSO user is deactivated, reactivated,
 * deleted, role-changed, or when their Obligate credentials changed.
 *
 * The Bearer key may be browser-exposed (see /auth/sso-redirect), so this
 * endpoint must be harmless on its own. Every action is a REVOCATION HINT:
 *   - the target is the local account OUR link records tie to obligateUserId
 *     (foreign_source='obligate'); Obligate's remoteUserId is only its copy of
 *     our id (rewritable through report-provision) and is used as a hint only,
 *     so a tampered pointer can't make a revocation miss its target, and a
 *     local-only account can never be reached;
 *   - it never GRANTS anything: no promotion, and a disable only holds until
 *     the next successful SSO sign-in (Obligate, the authority, re-enables the
 *     account there) — at worst a forged call logs the user out;
 *   - it never destroys data: 'delete' disables the account and revokes its
 *     sessions; an admin can then remove the disabled account from Users.
 */
router.post('/sso-user-sync', async (req, res) => {
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) { res.status(401).json({ success: false }); return; }

    const { obligateUserId, remoteUserId, action, role } = (req.body ?? {}) as {
      obligateUserId?: number; obligateUsername?: string; remoteUserId?: number;
      action?: string; role?: string;
    };

    const obligateId = Number(obligateUserId);
    if (!Number.isInteger(obligateId) || obligateId <= 0 || typeof action !== 'string' || !action) {
      res.status(400).json({ success: false, error: 'Missing fields' });
      return;
    }

    const localId = await obligateService.getLinkedLocalUserId(obligateId);
    if (!localId) { res.json({ success: true }); return; } // Never provisioned here / already gone
    if (remoteUserId !== undefined && Number(remoteUserId) !== localId) {
      logger.warn({ obligateUserId: obligateId, remoteUserId, linkedLocalUserId: localId, action },
        'SSO sync: Obligate pointer differs from the local SSO link — acting on the linked account');
    }

    const user = await db('users').where({ id: localId, foreign_source: 'obligate' }).first('role') as { role: string } | undefined;
    if (!user) { res.json({ success: true }); return; } // Already gone

    switch (action) {
      case 'deactivate':
        await db('users').where({ id: localId }).update({ is_active: false, updated_at: new Date() });
        await userSessionsService.destroyForUser(localId);
        logger.info(`SSO sync: deactivated user #${localId}`);
        break;
      case 'reactivate':
        await db('users').where({ id: localId }).update({ is_active: true, updated_at: new Date() });
        invalidateUserState(localId);
        logger.info(`SSO sync: reactivated user #${localId}`);
        break;
      case 'delete':
        // Obligate sends this before deleting the user, and the call may be
        // forged: disable + revoke instead of dropping the row and its data.
        await db('users').where({ id: localId }).update({ is_active: false, updated_at: new Date() });
        await userSessionsService.destroyForUser(localId);
        logger.info(`SSO sync: user #${localId} deleted in Obligate — local account disabled and sessions revoked (remove it from Users if needed)`);
        break;
      case 'update-role': {
        // The Obliguard platform role comes from the Obligate permission-group
        // mapping for this app ("Admin on All tenants"), carried by the verified
        // assertion at the next SSO sign-in — not from this pushed value, which
        // is only used to demote at once. Sessions cache the role: revoke them.
        const requested = role === 'admin' ? 'admin' : 'user';
        if (requested === 'user' && user.role !== 'user') {
          await db('users').where({ id: localId }).update({ role: 'user', updated_at: new Date() });
        }
        if (requested !== user.role) await userSessionsService.destroyForUser(localId);
        logger.info(`SSO sync: role change for user #${localId} (${user.role} → ${requested}; sessions revoked, the role is re-read from Obligate at next SSO sign-in)`);
        break;
      }
      case 'credentials-changed':
        // Password / MFA changed in Obligate: force a fresh SSO sign-in here.
        await userSessionsService.destroyForUser(localId);
        logger.info(`SSO sync: credentials changed in Obligate for user #${localId} — sessions revoked`);
        break;
      default:
        logger.warn({ action, localUserId: localId }, 'SSO sync: unknown action — ignored');
        break;
    }
    // Instance-level row: pushed by Obligate (bearer-authenticated), no session.
    await auditService.logReq(req, {
      action: 'sso.user_sync', targetType: 'user', targetId: localId, tenantId: null,
      userId: null, username: 'app:obligate',
      details: { syncAction: action.slice(0, 64), obligateUserId: obligateId, ...(action === 'update-role' ? { role: role === 'admin' ? 'admin' : 'user' } : {}) },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'sso-user-sync error');
    res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

export default router;
