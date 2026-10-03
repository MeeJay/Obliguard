import type { Request, Response, NextFunction } from 'express';
import type { CapabilityKey } from '@obliview/shared';
import { holdsCapability, isMasterTenant } from '@obliview/shared';
import { AppError } from './errorHandler';
import { permissionService } from '../services/permission.service';

/**
 * Route-to-capability matrix (RBAC-15 / RBAC-19).
 *
 * Every non-GET route of the API (and every guarded GET) is listed here with
 * the ONE thing that authorises it. The table documents the RBAC model and is
 * enforced by the harness (suite 67 walks the express router and fails on a
 * write route without an entry, an entry without a route, or a guarded route
 * that answers anything but 403 to a caller without the capability).
 *
 * Access kinds:
 *   - a capability, or a list of capabilities (any-of; with `byBody`, the
 *     request body picks which ones are required, see the resolvers below);
 *     platform admins always pass, others through their tenant role
 *     (permission set) in the operating tenant;
 *   - 'platform'    platform admin (users.role = 'admin') only;
 *   - 'public-read' any authenticated member of the operating tenant; the
 *                   route never writes (a POST that only reads, e.g. /geo/batch);
 *   - 'self'        any authenticated user, acting on their own account or
 *                   session (profile, 2FA, tenant switch, own alert state);
 *   - 'public'      no session: authenticated by another credential (agent API
 *                   key, ingest token, delegation token, one-time enrolment
 *                   token, Obligate API key) or by none (login, password reset).
 *
 * `defaultTenantOnly`: on top of the guard, the route only acts from the
 * Default (master) tenant (instance-wide effect); 403 from any other tenant.
 *
 * Paths are the express paths as declared, prefixed with their mount point,
 * without a trailing slash ('/api/bans/:id/exclude').
 */
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteAccessKind = 'platform' | 'public-read' | 'self' | 'public';

export type RouteGuard = CapabilityKey | readonly CapabilityKey[] | RouteAccessKind;

export interface RoutePermission {
  method: RouteMethod;
  path: string;
  guard: RouteGuard;
  /** The capability required depends on the request body (byBody resolvers). */
  byBody?: true;
  /** Only acts from the Default tenant (403 elsewhere). */
  defaultTenantOnly?: true;
  note?: string;
}

const ACCESS_KINDS: readonly string[] = ['platform', 'public-read', 'self', 'public'];

export function isAccessKind(guard: RouteGuard): guard is RouteAccessKind {
  return typeof guard === 'string' && ACCESS_KINDS.includes(guard);
}

/** Capabilities named by a guard ([] for an access kind). */
export function guardCapabilities(guard: RouteGuard): CapabilityKey[] {
  if (isAccessKind(guard)) return [];
  return typeof guard === 'string' ? [guard as CapabilityKey] : [...guard];
}

type Opts = Pick<RoutePermission, 'byBody' | 'defaultTenantOnly' | 'note'>;

function route(method: RouteMethod, path: string, guard: RouteGuard, opts: Opts = {}): RoutePermission {
  return { method, path, guard, ...opts };
}

/** Same entry under both mounts of tenant.routes (/tenants and its /tenant alias). */
function tenantMounts(method: RouteMethod, sub: string, guard: RouteGuard, opts: Opts = {}): RoutePermission[] {
  return ['/api/tenants', '/api/tenant'].map((base) => route(method, `${base}${sub}`, guard, opts));
}

const DEFAULT_ONLY = { defaultTenantOnly: true } as const;

export const ROUTE_PERMISSIONS: readonly RoutePermission[] = [
  // ── Cross-suite (delegation token) ────────────────────────────────────────
  route('POST', '/api/external-bans', 'public', { note: 'Obligate delegation token (requireExternalAppDelegation)' }),
  route('DELETE', '/api/external-bans/:ip', 'public', { note: 'Obligate delegation token' }),

  // ── Authentication ────────────────────────────────────────────────────────
  route('POST', '/api/auth/login', 'public'),
  route('POST', '/api/auth/logout', 'self'),
  route('POST', '/api/auth/enrollment', 'self'),
  route('POST', '/api/auth/forgot-password', 'public'),
  route('POST', '/api/auth/reset-password/validate', 'public'),
  route('POST', '/api/auth/reset-password', 'public'),
  route('POST', '/api/auth/sso-user-sync', 'public', { note: 'Obligate API key' }),

  // ── Agents (agent channel + fleet management) ─────────────────────────────
  route('POST', '/api/agent/push', 'public', { note: 'agent API key (agentAuth)' }),
  route('POST', '/api/agent/notifying-update', 'public', { note: 'agent API key (agentAuth)' }),
  route('POST', '/api/agent/mikrotik/ingest', 'public', { note: 'per-device ingest token' }),
  route('GET', '/api/agent/keys', 'agents.keys'),
  route('POST', '/api/agent/keys', 'agents.keys'),
  route('GET', '/api/agent/keys/:id/reveal', 'agents.keys', { note: 'full value of an active enrolment key' }),
  route('PUT', '/api/agent/keys/:id', 'agents.keys', { note: 'rename, disable / re-enable (closes live sessions), default group' }),
  route('DELETE', '/api/agent/keys/:id', 'agents.keys'),
  route('GET', '/api/agent/installer/wizard.exe', 'agents.keys', { note: 'embeds an enrolment key' }),
  route('GET', '/api/agent/installer/wizard-linux-amd64', 'agents.keys', { note: 'embeds an enrolment key' }),
  route('POST', '/api/agent/devices/bulk-request-update', 'agents.update'),
  route('DELETE', '/api/agent/devices/bulk', 'agents.delete'),
  route('PATCH', '/api/agent/devices/bulk', ['agents.manage', 'agents.approve'], { byBody: true, note: 'status → agents.approve, other fields → agents.manage' }),
  route('POST', '/api/agent/devices/bulk-command', ['agents.manage', 'agents.update', 'agents.delete'], { byBody: true, note: 'uninstall → agents.delete, update → agents.update' }),
  route('PATCH', '/api/agent/update-policy/tenant', 'platform', { note: 'update policy writes stay platform-admin only (owner directive)' }),
  route('PATCH', '/api/agent/devices/:id', ['agents.manage', 'agents.approve'], { byBody: true, note: 'status → agents.approve, other fields → agents.manage' }),
  route('DELETE', '/api/agent/devices/:id', 'agents.delete'),
  route('POST', '/api/agent/devices/:id/command', ['agents.manage', 'agents.update', 'agents.delete'], { byBody: true, note: 'uninstall → agents.delete, update → agents.update' }),
  route('POST', '/api/agent/devices/:id/commands', ['agents.manage', 'agents.update', 'agents.delete'], { byBody: true, note: 'body.type: uninstall → agents.delete (+ step-up agents.uninstall), update → agents.update (update policy decides), restart / firewall_resync → agents.manage (W14-1)' }),
  route('GET', '/api/agent/devices/:id/commands', 'public-read', { note: 'agent read scope (agentScope): command history (W14-1)' }),
  route('POST', '/api/agent/devices/:id/agent-update', 'agents.update'),
  route('DELETE', '/api/agent/devices/:id/agent-update', 'agents.update'),
  route('POST', '/api/agent/devices/:id/update/retry', 'agents.update'),
  route('POST', '/api/agent/groups/:groupId/agent-update', 'agents.update'),
  route('GET', '/api/agent/updates/preview', 'agents.update', { note: 'rollout preview (W12-4): targets, frozen agents by level, progress, pace' }),
  route('POST', '/api/agent/updates/all', 'agents.update', { note: 'paced fleet rollout (W12-4); Default = every tenant; frozen agents never requested' }),
  route('POST', '/api/agent/updates/cancel-all', 'agents.update', { note: 'clears every pending update request of the scope (W12-4)' }),
  route('GET', '/api/agent/devices/:id/firewall/rules', 'firewall.rules.read'),
  route('POST', '/api/agent/devices/:id/firewall/rules', 'firewall.rules.write'),
  route('DELETE', '/api/agent/devices/:id/firewall/rules/:ruleId', 'firewall.rules.write'),
  route('PATCH', '/api/agent/devices/:id/firewall/rules/:ruleId', 'firewall.rules.write'),
  route('GET', '/api/agent/devices/:id/timeline', 'public-read', { note: 'agent read scope (agentScope); audit-backed kinds need audit.read (W13-2)' }),

  // ── Instance configuration (platform) ─────────────────────────────────────
  route('GET', '/api/admin/config/agent-global', 'platform'),
  route('PATCH', '/api/admin/config/agent-global', 'platform', { note: 'the global update policy only from the Default tenant (controller)' }),
  route('GET', '/api/admin/config/obligate', 'platform'),
  route('PUT', '/api/admin/config/obligate', 'platform'),
  route('GET', '/api/admin/config/retention', 'platform'),
  route('PUT', '/api/admin/config/retention', 'platform', { ...DEFAULT_ONLY, note: 'data retention windows (W12-1); step-up appConfig.secrets' }),
  route('GET', '/api/admin/config/ban-policy', 'public-read', { note: 'read-only summary on the Policies hub' }),
  route('PUT', '/api/admin/config/ban-policy', 'platform', { ...DEFAULT_ONLY, note: 'auto-ban duration policy (W12-3)' }),
  route('PUT', '/api/admin/config/:key', 'platform'),
  route('GET', '/api/system', 'platform'),
  route('POST', '/api/permission-sets', 'platform'),
  route('PUT', '/api/permission-sets/:id', 'platform'),
  route('DELETE', '/api/permission-sets/:id', 'platform'),

  // ── Audit log ─────────────────────────────────────────────────────────────
  route('GET', '/api/audit-log', 'audit.read'),
  route('GET', '/api/audit-log/distinct-actions', 'audit.read'),
  route('GET', '/api/audit-log/device/:deviceId', 'audit.read', { note: 'also checks access to the agent (agentScope)' }),
  route('DELETE', '/api/audit-log', 'platform', { ...DEFAULT_ONLY, note: 'purge; leaves an audit.purged row' }),

  // ── Own account ───────────────────────────────────────────────────────────
  route('POST', '/api/profile/2fa/totp/setup', 'self'),
  route('POST', '/api/profile/2fa/totp/enable', 'self'),
  route('DELETE', '/api/profile/2fa/totp', 'self'),
  route('POST', '/api/profile/2fa/email/setup', 'self'),
  route('POST', '/api/profile/2fa/email/enable', 'self'),
  route('DELETE', '/api/profile/2fa/email', 'self'),
  route('POST', '/api/profile/2fa/verify', 'self'),
  route('POST', '/api/profile/2fa/resend-email', 'self'),
  route('POST', '/api/profile/2fa/step-up', 'self', { note: 'step-up proof (password / TOTP / e-mail code), sends the e-mail code too' }),
  route('PUT', '/api/profile', 'self'),
  route('PATCH', '/api/profile', 'self'),
  route('PUT', '/api/profile/password', 'self'),
  route('POST', '/api/live-alerts/read-all', 'self'),
  route('DELETE', '/api/live-alerts', 'self'),
  route('PATCH', '/api/live-alerts/:id/read', 'self'),
  route('DELETE', '/api/live-alerts/:id', 'self'),

  // ── M365 enrolment (one-time token, no session) ───────────────────────────
  route('POST', '/api/m365/enrol/plan', 'public', { note: 'one-time enrolment token' }),
  route('POST', '/api/m365/enrol/complete', 'public', { note: 'one-time enrolment token' }),

  // ── Tenants (CRUD platform; members delegated through users.manage) ───────
  ...tenantMounts('POST', '/switch', 'self'),
  ...tenantMounts('POST', '/default', 'self'),
  ...tenantMounts('POST', '', 'platform'),
  ...tenantMounts('PUT', '/:id', 'platform'),
  ...tenantMounts('DELETE', '/:id', 'platform'),
  ...tenantMounts('GET', '/:id/agents-summary', 'platform'),
  ...tenantMounts('POST', '/:id/uninstall-agents', 'platform', { note: 'queue uninstall on every approved agent of the tenant (C13, step-up agents.uninstall)' }),
  ...tenantMounts('GET', '/:id/members', 'users.manage'),
  ...tenantMounts('POST', '/:id/members', 'users.manage'),
  ...tenantMounts('PUT', '/:id/members/:uid', 'users.manage'),
  ...tenantMounts('DELETE', '/:id/members/:uid', 'users.manage'),

  // ── Groups ────────────────────────────────────────────────────────────────
  route('POST', '/api/groups', 'groups.manage', { note: 'and team canCreate or RW on the parent (controller)' }),
  route('PUT', '/api/groups/:id', 'groups.manage', { note: 'and RW on the group (requireGroupWrite)' }),
  route('POST', '/api/groups/reorder', 'groups.manage', { note: 'groups of the operating tenant only' }),
  route('POST', '/api/groups/:id/move', 'groups.manage', { note: 'and RW on the group and its new parent' }),
  route('DELETE', '/api/groups/:id', 'groups.manage', { note: 'and RW on the group (requireGroupWrite)' }),
  route('PATCH', '/api/groups/:id/agent-config', 'groups.manage', { note: 'operating tenant only; updatePolicy stays platform-admin only' }),

  // ── Settings: IPS cascade, tenant-scoped rows (W13-1) ─────────────────────
  // global: platform (writes from Default); tenant: 'settings'; group / agent:
  // groups.manage / agents.manage plus RW on the target (controller). Reads
  // below global: any member, scope access checked by the controller.
  route('GET', '/api/settings/global/resolved', 'platform'),
  route('GET', '/api/settings/tenant/resolved', 'public-read', { note: 'the operating tenant' }),
  route('GET', '/api/settings/group/:scopeId/resolved', 'public-read', { note: 'group of the operating tenant (Default: god view), team read scope' }),
  route('GET', '/api/settings/agent/:scopeId/resolved', 'public-read', { note: 'agent read scope (agentScope.service)' }),
  route('PUT', '/api/settings/global/:scopeId', 'platform', DEFAULT_ONLY),
  route('PUT', '/api/settings/global/:scopeId/bulk', 'platform', DEFAULT_ONLY),
  route('DELETE', '/api/settings/global/:scopeId/:key', 'platform', DEFAULT_ONLY),
  route('PUT', '/api/settings/tenant/:scopeId', 'settings', { note: 'the operating tenant only' }),
  route('PUT', '/api/settings/tenant/:scopeId/bulk', 'settings', { note: 'the operating tenant only' }),
  route('DELETE', '/api/settings/tenant/:scopeId/:key', 'settings', { note: 'the operating tenant only' }),
  route('PUT', '/api/settings/group/:scopeId', 'groups.manage', { note: 'and RW on the group, operating tenant only (controller)' }),
  route('PUT', '/api/settings/group/:scopeId/bulk', 'groups.manage', { note: 'and RW on the group, operating tenant only (controller)' }),
  route('DELETE', '/api/settings/group/:scopeId/:key', 'groups.manage', { note: 'and RW on the group, operating tenant only (controller)' }),
  route('PUT', '/api/settings/agent/:scopeId', 'agents.manage', { note: 'and RW on the agent, operating tenant only (controller)' }),
  route('PUT', '/api/settings/agent/:scopeId/bulk', 'agents.manage', { note: 'and RW on the agent, operating tenant only (controller)' }),
  route('DELETE', '/api/settings/agent/:scopeId/:key', 'agents.manage', { note: 'and RW on the agent, operating tenant only (controller)' }),

  // ── Notifications ─────────────────────────────────────────────────────────
  route('GET', '/api/notifications/plugins', 'notifications.manage'),
  route('GET', '/api/notifications/channels', 'notifications.manage'),
  route('GET', '/api/notifications/channels/:id', 'notifications.manage'),
  route('POST', '/api/notifications/channels', 'notifications.manage'),
  route('PUT', '/api/notifications/channels/:id', 'notifications.manage'),
  route('DELETE', '/api/notifications/channels/:id', 'notifications.manage'),
  route('POST', '/api/notifications/channels/:id/test', 'notifications.manage'),
  route('GET', '/api/notifications/channels/:id/tenants', 'notifications.manage'),
  route('PUT', '/api/notifications/channels/:id/tenants', 'notifications.manage', { note: 'owner shares its channel with other tenants (W5-1)' }),
  route('GET', '/api/notifications/bindings/resolved', 'notifications.manage'),
  route('GET', '/api/notifications/bindings', 'notifications.manage'),
  route('POST', '/api/notifications/bindings', 'notifications.manage'),
  route('DELETE', '/api/notifications/bindings', 'notifications.manage'),

  // ── Users and teams (delegated user management) ───────────────────────────
  route('GET', '/api/users', 'users.manage'),
  route('POST', '/api/users', 'users.manage'),
  route('PUT', '/api/users/:id', 'users.manage'),
  route('PUT', '/api/users/:id/password', 'users.manage'),
  route('DELETE', '/api/users/:id/2fa', 'users.manage'),
  route('DELETE', '/api/users/:id', 'users.manage'),
  route('PUT', '/api/users/:id/tenants', 'users.manage'),
  route('GET', '/api/teams', 'users.manage'),
  route('POST', '/api/teams', 'users.manage'),
  route('PUT', '/api/teams/:id', 'users.manage'),
  route('DELETE', '/api/teams/:id', 'users.manage'),
  route('PUT', '/api/teams/:id/members', 'users.manage'),
  route('PUT', '/api/teams/:id/permissions', 'users.manage'),
  route('DELETE', '/api/teams/:id/permissions/:permId', 'users.manage'),

  // ── SMTP servers (instance) ───────────────────────────────────────────────
  route('GET', '/api/admin/smtp-servers', 'platform'),
  route('POST', '/api/admin/smtp-servers', 'platform'),
  route('PUT', '/api/admin/smtp-servers/:id', 'platform'),
  route('DELETE', '/api/admin/smtp-servers/:id', 'platform'),
  route('POST', '/api/admin/smtp-servers/:id/test', 'platform'),

  // ── Bans ──────────────────────────────────────────────────────────────────
  route('POST', '/api/bans/wipe-bans', 'platform', { ...DEFAULT_ONLY, note: 'and bans.wipe' }),
  route('POST', '/api/bans/wipe-reputation', 'platform', { ...DEFAULT_ONLY, note: 'and bans.wipe' }),
  route('POST', '/api/bans/bulk-ban', 'bans.create'),
  route('POST', '/api/bans/bulk-whitelist', 'whitelist.write'),
  route('POST', '/api/bans/bulk-lift', 'bans.lift'),
  route('POST', '/api/bans', 'bans.create'),
  route('DELETE', '/api/bans/:id', 'bans.lift'),
  route('POST', '/api/bans/:id/promote-global', 'bans.promote', DEFAULT_ONLY),
  route('POST', '/api/bans/:id/exclude', 'bans.lift'),
  route('DELETE', '/api/bans/:id/exclude', 'bans.lift'),
  route('GET', '/api/bans/export', 'public-read', { note: 'CSV of the visible bans (same scope as GET /api/bans), capped 50 000, audited (W14-3)' }),

  // ── Whitelist ─────────────────────────────────────────────────────────────
  route('POST', '/api/whitelist', 'whitelist.write'),
  route('POST', '/api/whitelist/bulk-delete', 'whitelist.write'),
  route('DELETE', '/api/whitelist/:id', 'whitelist.write'),
  route('GET', '/api/whitelist/export', 'public-read', { note: 'CSV, same scope as GET /api/whitelist, capped 50 000, audited (W14-3)' }),

  // ── IP intelligence ───────────────────────────────────────────────────────
  route('POST', '/api/ip-reputation', ['bans.create', 'whitelist.write', 'ip.reputation.clear'], { byBody: true, note: 'banned → bans.create, whitelisted → whitelist.write, clean/suspicious → ip.reputation.clear' }),
  route('POST', '/api/ip-reputation/:ip/clear', 'ip.reputation.clear', { note: 'tenant clear; global clear only for a platform admin on Default' }),
  route('POST', '/api/ip-labels', 'ip.labels', { note: 'Default → global label, other tenants → tenant label' }),
  route('DELETE', '/api/ip-labels/:ip', 'ip.labels'),
  route('POST', '/api/geo/batch', 'public-read', { note: 'country lookup for the NetMap; reads only' }),
  route('GET', '/api/dashboard/summary', 'public-read'),
  route('GET', '/api/ip-events/stats', 'public-read'),
  route('GET', '/api/ip-reputation/export', 'public-read', { note: 'CSV, same scope as GET /api/ip-reputation, capped 50 000, audited (W14-3)' }),
  route('GET', '/api/ip-events/export', 'public-read', { note: 'CSV, tenant + team scope as GET /api/ip-events, capped 50 000, audited (W14-3)' }),

  // ── Service templates ─────────────────────────────────────────────────────
  route('POST', '/api/service-templates', 'templates.write'),
  route('PUT', '/api/service-templates/:id', 'templates.write', { note: 'platform templates: platform admin or Default only' }),
  route('DELETE', '/api/service-templates/:id', 'templates.write', { note: 'platform templates: platform admin or Default only' }),
  route('PUT', '/api/service-templates/:id/assign/:scope/:scopeId', 'templates.write', { note: 'scope owned by the operating tenant' }),
  route('DELETE', '/api/service-templates/:id/assign/:scope/:scopeId', 'templates.write', { note: 'scope owned by the operating tenant' }),
  route('POST', '/api/service-templates/:id/sample/:deviceId', 'templates.write', { note: 'device owned by the operating tenant' }),

  // ── Integrations ──────────────────────────────────────────────────────────
  route('POST', '/api/mikrotik', 'integrations.mikrotik'),
  route('GET', '/api/mikrotik/:id/credentials', 'integrations.mikrotik'),
  route('PUT', '/api/mikrotik/:id/credentials', 'integrations.mikrotik'),
  route('POST', '/api/mikrotik/:id/test', 'integrations.mikrotik'),
  route('POST', '/api/mikrotik/:id/sync-bans', 'integrations.mikrotik'),
  route('POST', '/api/mikrotik/:id/clear-log-cache', 'integrations.mikrotik'),
  route('GET', '/api/mikrotik/:id/debug-logs', 'integrations.mikrotik'),
  route('POST', '/api/mikrotik/import/poll', 'platform', { note: 'polls the routers of every tenant' }),
  route('POST', '/api/m365', 'integrations.m365'),
  route('GET', '/api/m365/:id', 'integrations.m365'),
  route('PATCH', '/api/m365/:id', 'integrations.m365'),
  route('POST', '/api/m365/:id/enrol', 'integrations.m365'),
  route('POST', '/api/m365/:id/verify', 'integrations.m365'),
  route('POST', '/api/m365/:id/rotate-certificate', 'integrations.m365'),

  // ── Remote blocklists: instance setting (owner decision 6) ────────────────
  route('POST', '/api/remote-blocklists', 'platform', DEFAULT_ONLY),
  route('PUT', '/api/remote-blocklists/:id', 'platform', DEFAULT_ONLY),
  route('DELETE', '/api/remote-blocklists/:id', 'platform', DEFAULT_ONLY),
  route('POST', '/api/remote-blocklists/:id/sync', 'platform', DEFAULT_ONLY),
  route('PUT', '/api/remote-blocklists/ips/:id/toggle', 'platform', DEFAULT_ONLY),
  route('POST', '/api/remote-blocklists/ips/:id/toggle', 'platform', DEFAULT_ONLY),
  route('POST', '/api/remote-blocklists/push-now', 'platform', DEFAULT_ONLY),

  // ── Rate limit policies ───────────────────────────────────────────────────
  route('POST', '/api/rate-limit-policies', 'rate_limit.write'),
  route('PUT', '/api/rate-limit-policies/enforcement', 'platform', { ...DEFAULT_ONLY, note: 'instance-wide enforcement switch' }),
  route('PATCH', '/api/rate-limit-policies/:id', 'rate_limit.write'),
  route('DELETE', '/api/rate-limit-policies/:id', 'rate_limit.write'),
];

/** The entry of a route, or undefined. */
export function findRoutePermission(method: string, path: string): RoutePermission | undefined {
  const m = method.toUpperCase();
  return ROUTE_PERMISSIONS.find((r) => r.method === m && r.path === path);
}

// ── Guards used by the route files ───────────────────────────────────────────

/**
 * The route only acts from the Default (master) tenant: instance-wide effects
 * (promote to global, sharing across tenants, ...). Mount after requireTenant.
 */
export function requireMasterTenant(message = 'Only available from the Default tenant') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!isMasterTenant(req.tenantId)) {
      next(new AppError(403, message));
      return;
    }
    next();
  };
}

/**
 * Like requireCapability, for routes whose capability depends on the request
 * (byBody entries): ALL the capabilities `resolve` returns are required.
 * Platform admins always pass; an empty list refuses (nothing writes without
 * a capability).
 */
export function requireCapabilitiesFor(resolve: (req: Request) => readonly CapabilityKey[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.session?.userId) {
        next(new AppError(401, 'Authentication required'));
        return;
      }
      if (req.session.role === 'admin') { next(); return; }

      const needed = resolve(req);
      const tenantId = req.tenantId ?? req.session.currentTenantId;
      const held = await permissionService.getTenantCapabilities(req.session.userId, false, tenantId);
      if (needed.length === 0 || !needed.every((c) => holdsCapability(held, c))) {
        next(new AppError(403, 'Insufficient permissions'));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

/** Agent commands and the capability each needs (anything else: agents.manage). */
export const DEVICE_COMMAND_CAPABILITIES: Readonly<Record<string, CapabilityKey>> = {
  uninstall: 'agents.delete',
  update: 'agents.update',
};

/** POST /devices/:id/command and /devices/bulk-command. */
export function deviceCommandCapabilities(req: Request): CapabilityKey[] {
  const command = bodyOf(req).command;
  const cap = typeof command === 'string' && Object.prototype.hasOwnProperty.call(DEVICE_COMMAND_CAPABILITIES, command)
    ? DEVICE_COMMAND_CAPABILITIES[command]
    : 'agents.manage';
  return [cap];
}

/**
 * PATCH /devices/:id and /devices/bulk: a status change (approve, refuse,
 * suspend, back to pending) is approval (agents.approve); any other field is
 * device management (agents.manage). Both when both are sent.
 */
export function deviceEditCapabilities(req: Request): CapabilityKey[] {
  const body = bodyOf(req);
  const keys = Object.keys(body).filter((k) => k !== 'deviceIds');
  const caps: CapabilityKey[] = [];
  if (keys.includes('status')) caps.push('agents.approve');
  if (keys.length === 0 || keys.some((k) => k !== 'status')) caps.push('agents.manage');
  return caps;
}

/** IP reputation statuses and the capability each manual write needs. */
export const IP_STATUS_CAPABILITIES: Readonly<Record<string, CapabilityKey>> = {
  banned: 'bans.create',
  whitelisted: 'whitelist.write',
  clean: 'ip.reputation.clear',
  suspicious: 'ip.reputation.clear',
};

/** POST /ip-reputation: by target status (an unknown status only reaches the 400). */
export function ipReputationAddCapabilities(req: Request): CapabilityKey[] {
  const status = bodyOf(req).status;
  if (typeof status === 'string' && Object.prototype.hasOwnProperty.call(IP_STATUS_CAPABILITIES, status)) {
    return [IP_STATUS_CAPABILITIES[status]];
  }
  return ['ips.view'];
}
