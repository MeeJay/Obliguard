import type { Server as SocketIOServer } from 'socket.io';
import { db } from '../db';
import type { IpBan, CreateBanRequest, BanScope } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { serviceTemplateService } from './serviceTemplate.service';
import { ipReputationService } from './ipReputation.service';
import { canUseTenant } from '../middleware/tenant';
import { parseBanTarget, banTargetRawFromRow, RESERVED_OR_PROTECTED_MESSAGE } from '../utils/ipValidation';
import type { BanTarget } from '../utils/ipValidation';
import { findProtectedConflict, checkBanTarget } from '../utils/protectedIps';
import { applyBanVisibility, canSeeBan, canSeeBanAuthor } from './banVisibility';
import { isUnsafeBanId, startBanSafetyAudit, stopBanSafetyAudit } from './banSafetyAudit';

/**
 * Manual subnet bans are refused until the agents enforce CIDR targets.
 * D4.1 flips this once CIDR delivery is gated by agent capability. The subnet
 * storage form (network address in ip + cidr_prefix) and D4.3's unique key,
 * which must include COALESCE(cidr_prefix, masklen(ip)), must then agree.
 */
const MANUAL_SUBNET_BANS_ENABLED = false;

const BAN_SCOPES = ['global', 'tenant', 'group', 'agent'] as const;

// ── Socket.io instance (injected from index.ts) ─────────────────────────────
let _io: SocketIOServer | null = null;
export function setBanServiceIO(io: SocketIOServer): void {
  _io = io;
}

// ── Row helpers ──────────────────────────────────────────────────────────────

interface BanRow {
  id: number;
  ip: string;
  cidr_prefix: number | null;
  reason: string | null;
  ban_type: string;
  scope: string;
  scope_id: number | null;
  tenant_id: number | null;
  origin_tenant_id: number | null;
  origin_tenant_name?: string;
  /** Set when the ban came from an external Obli app via /api/external-bans. Nullable. */
  origin_app: string | null;
  banned_by_user_id: number | null;
  banned_at: Date;
  expires_at: Date | null;
  is_active: boolean;
}

function rowToBan(row: BanRow, isAdmin = false, callerTenantId?: number): IpBan {
  return {
    id: row.id,
    ip: row.ip,
    cidrPrefix: row.cidr_prefix,
    reason: row.reason,
    banType: row.ban_type as IpBan['banType'],
    scope: row.scope as BanScope,
    scopeId: row.scope_id,
    tenantId: row.tenant_id,
    // Only expose WHICH tenant the ban came from to platform admins (god view).
    originTenantId: isAdmin ? row.origin_tenant_id : null,
    originTenantName: isAdmin ? row.origin_tenant_name : undefined,
    // Safe for every tenant: "this ban is mine" without naming any other tenant.
    // Drives whether the UI offers Lift (global) or Exclude (local override).
    isOriginTenant:
      callerTenantId != null &&
      row.origin_tenant_id != null &&
      row.origin_tenant_id === callerTenantId,
    // The author is only shown to the owning/origin tenant, Default and platform admins.
    bannedByUserId: canSeeBanAuthor(row, callerTenantId, isAdmin) ? row.banned_by_user_id : null,
    bannedAt: row.banned_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    isActive: row.is_active,
  };
}

// ── BanService ───────────────────────────────────────────────────────────────

class BanService {

  /** List active bans visible to the caller */
  async list(opts: {
    tenantId: number;
    isAdmin: boolean;
    onlyActive?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: IpBan[]; total: number }> {
    const { tenantId, isAdmin, onlyActive = true, search, limit = 50, offset = 0 } = opts;

    // Join with exclusions for the calling tenant so we can expose isExcludedByTenant
    let q = db('ip_bans')
      .leftJoin('tenants as origin_tenant', 'ip_bans.origin_tenant_id', 'origin_tenant.id')
      .leftJoin('ip_ban_exclusions as ex', function () {
        this.on('ex.ban_id', '=', 'ip_bans.id')
          .andOnVal('ex.tenant_id', '=', tenantId);
      })
      .select(
        'ip_bans.*',
        'origin_tenant.name as origin_tenant_name',
        db.raw('ex.id IS NOT NULL AS is_excluded_by_tenant'),
      );

    // Default / platform admins see every ban; other tenants: global + their own.
    q = applyBanVisibility(q, tenantId, isAdmin, 'ip_bans');

    if (onlyActive) q = q.where('ip_bans.is_active', true);
    if (search) q = q.whereRaw("ip_bans.ip::text ILIKE ?", [`%${search}%`]);

    const countQ = q.clone().clearSelect().count('ip_bans.id as count');
    const [{ count }] = await countQ as unknown as [{ count: string }];

    const rows = await q.orderBy('ip_bans.banned_at', 'desc').limit(limit).offset(offset) as (BanRow & { is_excluded_by_tenant: boolean })[];
    return {
      data: rows.map((r) => ({ ...rowToBan(r, isAdmin, tenantId), isExcludedByTenant: r.is_excluded_by_tenant ?? false })),
      total: Number(count),
    };
  }

  /**
   * Defence in depth behind requireTenant: a non-admin must be a member of the
   * operating tenant to create, promote, lift or exclude a ban (stale session,
   * legacy team capability). Platform admins are exempt.
   */
  async assertOperatingMembership(userId: number, tenantId: number, isAdmin: boolean): Promise<void> {
    if (isAdmin) return;
    if (!(userId > 0) || !(await canUseTenant(userId, 'user', tenantId))) {
      throw new AppError(403, 'You are not a member of this tenant');
    }
  }

  /** A single ban by id, when the caller may see it (null otherwise). */
  async getById(id: number, tenantId: number, isAdmin: boolean): Promise<{
    id: number; ip: string; cidrPrefix: number | null; banType: string; reason: string | null;
    scope: string; scopeId: number | null; bannedByUserId: number | null; bannedByUsername: string | null;
    bannedAt: Date; expiresAt: Date | null; isActive: boolean;
  } | null> {
    const row = await db('ip_bans').where({ id }).first() as BanRow | undefined;
    if (!row || !canSeeBan(row, tenantId, isAdmin)) return null;
    let bannedByUserId: number | null = null;
    let bannedByUsername: string | null = null;
    if (row.banned_by_user_id && canSeeBanAuthor(row, tenantId, isAdmin)) {
      bannedByUserId = row.banned_by_user_id;
      const user = await db('users').where({ id: row.banned_by_user_id }).select('username', 'display_name').first() as
        { username: string; display_name: string | null } | undefined;
      bannedByUsername = user?.display_name || user?.username || null;
    }
    return {
      id: row.id,
      ip: row.ip,
      cidrPrefix: row.cidr_prefix,
      banType: row.ban_type,
      reason: row.reason,
      scope: row.scope,
      scopeId: row.scope_id,
      bannedByUserId,
      bannedByUsername,
      bannedAt: row.banned_at,
      expiresAt: row.expires_at,
      isActive: row.is_active,
    };
  }

  /** Active / created-today counts, with the same visibility as the list. */
  async stats(tenantId: number, isAdmin: boolean): Promise<{ active: number; today: number }> {
    const [[activeRow], [todayRow]] = await Promise.all([
      applyBanVisibility(
        db('ip_bans')
          .where('ip_bans.is_active', true)
          .whereRaw('(ip_bans.expires_at IS NULL OR ip_bans.expires_at > NOW())'),
        tenantId, isAdmin, 'ip_bans',
      ).count<Array<{ count: string }>>({ count: '*' }),
      applyBanVisibility(
        db('ip_bans').whereRaw('ip_bans.banned_at >= CURRENT_DATE'),
        tenantId, isAdmin, 'ip_bans',
      ).count<Array<{ count: string }>>({ count: '*' }),
    ]);
    return { active: Number(activeRow?.count ?? 0), today: Number(todayRow?.count ?? 0) };
  }

  /**
   * Create a manual ban. The scope follows the OPERATING tenant, never the
   * platform role: Default → global, any other tenant → tenant-local. A group
   * or agent scope is accepted only on a target the operating tenant owns. An
   * explicit scope that contradicts the rule is refused, never widened.
   *
   * `isAdmin` only drives rowToBan's admin display fields (and the membership
   * exemption), never the scope.
   */
  async create(
    data: CreateBanRequest,
    userId: number,
    tenantId: number,
    isAdmin: boolean,
    opts: { deferMikrotik?: boolean; membershipChecked?: boolean } = {},
  ): Promise<IpBan> {
    if (!opts.membershipChecked) await this.assertOperatingMembership(userId, tenantId, isAdmin);

    // 1) Target
    const rawIp: unknown = (data as { ip?: unknown }).ip;
    if (typeof rawIp !== 'string') throw new AppError(400, 'ip is required');
    const rawPrefix: unknown = (data as { cidrPrefix?: unknown }).cidrPrefix;
    let raw: string = rawIp;
    if (rawPrefix != null && rawPrefix !== '') {
      const n = Number(rawPrefix);
      if (!Number.isInteger(n)) throw new AppError(400, 'Invalid CIDR prefix');
      if (rawIp.includes('/')) throw new AppError(400, 'Give the prefix either in ip or in cidrPrefix, not both');
      raw = `${rawIp.trim()}/${n}`;
    }
    const r = parseBanTarget(raw, { allowCidr: true });
    if (!r.ok) throw new AppError(400, r.message);
    const t: BanTarget = r.target;
    if (t.isNetwork && !MANUAL_SUBNET_BANS_ENABLED) {
      throw new AppError(400, 'Subnet bans are not enforced by the agents yet: ban single addresses');
    }

    // 2) Scope
    const requested = (data as { scope?: unknown }).scope ?? null;
    if (requested !== null && !(BAN_SCOPES as readonly unknown[]).includes(requested)) {
      throw new AppError(400, 'Invalid scope');
    }
    const derived: BanScope = isMasterTenant(tenantId) ? 'global' : 'tenant';
    let scope: BanScope;
    let scopeId: number | null = null;
    let rowTenantId: number | null;
    if (requested === 'group' || requested === 'agent') {
      const sid = Number((data as { scopeId?: unknown }).scopeId);
      if (!Number.isInteger(sid) || sid <= 0) throw new AppError(400, 'scopeId is required for group/agent scope');
      const owner = await (requested === 'agent' ? db('agent_devices') : db('monitor_groups'))
        .where({ id: sid }).first('tenant_id') as { tenant_id: number | null } | undefined;
      // No admin / Default bypass: the god view is read-only for writes.
      if (!owner || Number(owner.tenant_id) !== tenantId) {
        throw new AppError(404, requested === 'agent' ? 'Agent not found' : 'Group not found');
      }
      scope = requested;
      scopeId = sid;
      rowTenantId = tenantId;
    } else if (requested === 'global' && derived === 'tenant') {
      throw new AppError(403, 'Global bans can only be created from the Default tenant');
    } else if (requested === 'tenant' && derived === 'global') {
      throw new AppError(400, 'Bans created from the Default tenant are global: omit the scope, or use a group or agent scope');
    } else {
      scope = derived;
      rowTenantId = derived === 'global' ? null : tenantId;
    }

    // 3) Protected set (interface addresses matter for global bans only)
    if (await findProtectedConflict(t, { includeInterfaces: scope === 'global' })) {
      throw new AppError(400, RESERVED_OR_PROTECTED_MESSAGE);
    }

    // 4) Expiry and reason
    let expiresAt: Date | null = null;
    const rawExpires: unknown = (data as { expiresAt?: unknown }).expiresAt;
    if (rawExpires != null && rawExpires !== '') {
      const d = new Date(String(rawExpires));
      if (isNaN(d.getTime())) throw new AppError(400, 'Invalid expiresAt');
      if (d.getTime() <= Date.now()) throw new AppError(400, 'expiresAt must be in the future');
      expiresAt = d;
    }
    const rawReason: unknown = (data as { reason?: unknown }).reason;
    const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim().slice(0, 500) : null;

    // 5) Whitelist check, duplicate check and insert, atomic per target
    const row = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`ip_bans:${t.cidr}`]);

      const wl = await trx('ip_whitelist')
        .whereRaw('ip && ?::inet', [t.cidr])
        .where((q) => {
          q.where('scope', 'global');
          if (scope !== 'global') q.orWhere((s) => s.where('scope', 'tenant').where('tenant_id', rowTenantId));
          if (scope === 'group' || scope === 'agent') {
            q.orWhere((s) => s.where('scope', scope).where('scope_id', scopeId).where('tenant_id', rowTenantId));
          }
        })
        .first('id');
      if (wl) throw new AppError(409, 'This IP is whitelisted');

      // Duplicate: only active global rows and the caller's own scope (no
      // oracle on other tenants' local bans).
      const dup = await trx('ip_bans')
        .where('is_active', true)
        .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', trx.fn.now()))
        .whereRaw('ip = ?::inet', [t.address])
        .whereRaw('COALESCE(cidr_prefix, CASE WHEN family(ip) = 4 THEN 32 ELSE 128 END) = ?', [t.prefix])
        .where((q) => {
          q.where('scope', 'global');
          if (scope !== 'global') {
            q.orWhere((s) => s.where('scope', scope)
              .whereRaw('COALESCE(scope_id, 0) = ?', [scopeId ?? 0])
              .where('tenant_id', rowTenantId));
          }
        })
        .orderByRaw("(scope = 'global') DESC")
        .first() as BanRow | undefined;
      if (dup) {
        if (dup.scope === 'global' && scope !== 'global') {
          const excluded = await trx('ip_ban_exclusions').where({ ban_id: dup.id, tenant_id: tenantId }).first('id');
          if (excluded) throw new AppError(409, 'This IP is banned globally but lifted on your tenant: use Re-enable instead');
          throw new AppError(409, 'This IP is already banned globally');
        }
        throw new AppError(409, 'This IP is already banned');
      }

      const [inserted] = await trx('ip_bans')
        .insert({
          ip: trx.raw('?::inet', [t.address]),
          cidr_prefix: t.isNetwork ? t.prefix : null,
          reason,
          ban_type: 'manual',
          scope,
          scope_id: scopeId,
          tenant_id: rowTenantId,
          // Record who created it, so the creating tenant can lift its own ban
          // (same origin rule as auto-bans).
          origin_tenant_id: tenantId,
          banned_by_user_id: userId > 0 ? userId : null,
          expires_at: expiresAt,
          is_active: true,
        })
        .returning('*') as BanRow[];
      return inserted;
    });

    _io?.emit('ban:created', rowToBan(row, isAdmin));

    // Push ban to MikroTik devices (fire-and-forget): only the tenant's routers
    // for a tenant/group/agent ban.
    if (!opts.deferMikrotik) {
      const audience = scope === 'global' ? undefined : { tenantId: rowTenantId };
      import('./mikrotik/mikrotikBanSync.service')
        .then(({ mikrotikBanSync }) => mikrotikBanSync.pushBanToAll(row.ip, 'ban', audience))
        .catch(() => {});
    }

    return rowToBan(row, isAdmin, tenantId);
  }

  /**
   * Promote a tenant/group/agent ban to global. The authority action of the
   * Default tenant (like the global Lift): Default only, for any Default
   * member holding 'bans' — platform admins included, never from elsewhere.
   * The address is rewritten in canonical form; the reason is kept (it becomes
   * visible to every tenant).
   */
  async promoteToGlobal(banId: number, tenantId: number, userId: number, isAdmin: boolean): Promise<IpBan> {
    if (!isMasterTenant(tenantId)) throw new AppError(403, 'Promote to global is only available from the Default tenant');
    await this.assertOperatingMembership(userId, tenantId, isAdmin);

    const ban = await db('ip_bans').where('id', banId).first() as BanRow | undefined;
    if (!ban) throw new AppError(404, 'Ban not found');
    if (!ban.is_active || (ban.expires_at && new Date(ban.expires_at).getTime() <= Date.now())) {
      throw new AppError(409, 'Ban is no longer active');
    }
    if (ban.scope === 'global') throw new AppError(409, 'Ban is already global');

    const r = parseBanTarget(banTargetRawFromRow(String(ban.ip), ban.cidr_prefix), { allowCidr: true });
    if (!r.ok) throw new AppError(400, `Cannot promote this ban: ${r.message}`);
    const t = r.target;
    if (t.isNetwork && !MANUAL_SUBNET_BANS_ENABLED) {
      throw new AppError(400, 'Cannot promote a subnet ban: subnet bans are not enforced by the agents yet');
    }
    if (await findProtectedConflict(t, { includeInterfaces: true })) {
      throw new AppError(400, RESERVED_OR_PROTECTED_MESSAGE);
    }

    const row = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`ip_bans:${t.cidr}`]);
      const wl = await trx('ip_whitelist').where('scope', 'global').whereRaw('ip && ?::inet', [t.cidr]).first('id');
      if (wl) throw new AppError(409, 'This IP is whitelisted');
      const dup = await trx('ip_bans')
        .where('is_active', true)
        .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', trx.fn.now()))
        .whereRaw('ip = ?::inet', [t.address])
        .whereRaw('COALESCE(cidr_prefix, CASE WHEN family(ip) = 4 THEN 32 ELSE 128 END) = ?', [t.prefix])
        .where('scope', 'global')
        .first('id');
      if (dup) throw new AppError(409, 'This IP is already banned globally');
      const [updated] = await trx('ip_bans')
        .where({ id: banId, is_active: true })
        .whereNot('scope', 'global')
        .update({
          scope: 'global',
          scope_id: null,
          tenant_id: null,
          ip: trx.raw('?::inet', [t.address]),
          cidr_prefix: null,
        })
        .returning('*') as BanRow[];
      if (!updated) throw new AppError(409, 'Ban is no longer active');
      return updated;
    });

    _io?.emit('ban:updated', rowToBan(row, true));

    // A global ban reaches every router (fire-and-forget).
    import('./mikrotik/mikrotikBanSync.service')
      .then(({ mikrotikBanSync }) => mikrotikBanSync.pushBanToAll(row.ip, 'ban'))
      .catch(() => {});

    return rowToBan(row, isAdmin, tenantId);
  }

  /**
   * Lift a ban. Authority is TENANT-based (the route already gates on the
   * 'bans' capability), and the SCOPE of the lift is decided here so the client
   * only ever needs one "Lift" button:
   *
   *   - Default/master tenant (god view) → an AUTHORITATIVE GLOBAL lift: the ban
   *     is deactivated for every tenant, in all cases.
   *   - Any OTHER tenant → a LOCAL lift, always. It never removes the ban for
   *     everyone, even a ban its own agents triggered:
   *       • global ban  → a per-tenant exclusion (ban stays active elsewhere);
   *       • its own tenant/group/agent-scoped ban → deactivated (it was only
   *         ever enforced on this tenant anyway).
   *     A ban belonging to another tenant is never enforced here and cannot be
   *     lifted from this tenant.
   */
  async lift(banId: number, tenantId: number, userId: number, isAdmin = false): Promise<void> {
    await this.assertOperatingMembership(userId, tenantId, isAdmin);
    const ban = await db('ip_bans').where('id', banId).first() as BanRow | undefined;
    if (!ban) throw new AppError(404, 'Ban not found');

    const deactivateGlobally = async (): Promise<void> => {
      await db('ip_bans').where('id', banId).update({ is_active: false });
      _io?.emit('ban:lifted', { id: banId });
      // Push unban to MikroTik devices (fire-and-forget)
      import('./mikrotik/mikrotikBanSync.service')
        .then(({ mikrotikBanSync }) => mikrotikBanSync.pushBanToAll(ban.ip, 'unban'))
        .catch(() => {});
    };

    // Default tenant: authoritative global lift, whatever the scope.
    if (isMasterTenant(tenantId)) {
      if (!ban.is_active) throw new AppError(409, 'Ban is no longer active');
      await deactivateGlobally();
      return;
    }

    // Non-Default tenant: a ban the caller cannot see does not exist for it.
    if (!canSeeBan(ban, tenantId, isAdmin)) throw new AppError(404, 'Ban not found');

    // Non-Default tenant: the lift is ALWAYS local to this tenant.
    if (ban.scope === 'global') {
      if (!ban.is_active) throw new AppError(409, 'Ban is no longer active');
      // Neutralise locally via a per-tenant exclusion; other tenants keep it.
      await db('ip_ban_exclusions')
        .insert({ ban_id: banId, tenant_id: tenantId, created_by: userId })
        .onConflict(['ban_id', 'tenant_id'])
        .ignore();
      _io?.emit('ban:excluded', { banId, tenantId });
      return;
    }

    // Non-global ban: only its owning tenant may lift it. Since it is only ever
    // enforced on that tenant, deactivating it IS the local action. Only a
    // platform admin (who can see the row) reaches this refusal.
    if (ban.tenant_id !== tenantId) {
      throw new AppError(403, 'This ban belongs to another tenant');
    }
    if (!ban.is_active) throw new AppError(409, 'Ban is no longer active');
    await deactivateGlobally();
  }

  /**
   * Create a per-tenant exclusion for a global ban.
   * The ban stays active globally; agents of this tenant will not enforce it.
   */
  async excludeForTenant(banId: number, tenantId: number, userId: number, isAdmin = false): Promise<void> {
    await this.assertOperatingMembership(userId, tenantId, isAdmin);
    const ban = await db('ip_bans').where('id', banId).first() as BanRow | undefined;
    if (!ban || !canSeeBan(ban, tenantId, isAdmin)) throw new AppError(404, 'Ban not found');
    if (ban.scope !== 'global') throw new AppError(400, 'Only global bans can be excluded per-tenant');
    if (!ban.is_active) throw new AppError(409, 'Ban is no longer active');

    // Insert — ignore duplicate (already excluded)
    await db('ip_ban_exclusions')
      .insert({ ban_id: banId, tenant_id: tenantId, created_by: userId })
      .onConflict(['ban_id', 'tenant_id'])
      .ignore();

    _io?.emit('ban:excluded', { banId, tenantId });
  }

  /**
   * Remove a per-tenant exclusion (re-enable enforcement for this tenant).
   */
  async removeExclusion(banId: number, tenantId: number): Promise<void> {
    const deleted = await db('ip_ban_exclusions')
      .where({ ban_id: banId, tenant_id: tenantId })
      .delete();
    if (!deleted) throw new AppError(404, 'No exclusion found for this ban and tenant');
    _io?.emit('ban:exclusionRemoved', { banId, tenantId });
  }

  /**
   * Compute the ban list delta for an agent:
   * IPs that should be banned but aren't in agentCurrentBans,
   * and IPs in agentCurrentBans that are no longer banned.
   */
  async computeBanDelta(
    deviceId: number,
    groupIds: number[],
    tenantId: number,
    agentCurrentBans: string[],
    resolvedWhitelist: string[],
  ): Promise<{ add: string[]; remove: string[] }> {
    // Fetch all active bans applicable to this agent
    const bans = await db('ip_bans')
      .where('is_active', true)
      .where((b) => {
        b.where('scope', 'global')
          .orWhere('tenant_id', tenantId)
          .orWhere((c) => c.where('scope', 'group').whereIn('scope_id', groupIds))
          .orWhere((c) => c.where('scope', 'agent').where('scope_id', deviceId));
      })
      .select('ip_bans.id', 'ip_bans.ip') as Array<{ id: number; ip: string }>;

    // Fetch IPs of global bans that this tenant has excluded
    const excludedBanIds = new Set<number>(
      (await db('ip_ban_exclusions')
        .where({ tenant_id: tenantId })
        .pluck('ban_id') as number[]),
    );

    // Filter out whitelisted and tenant-excluded IPs
    const shouldBeBanned = new Set<string>();
    for (const ban of bans) {
      // Unsafe legacy rows (reserved / too broad / protected, see banSafetyAudit)
      // are never delivered: the agent receives a 'remove' for them.
      // D4.1 must keep this exclusion when it rewrites this query.
      if (isUnsafeBanId(ban.id)) continue;
      if (excludedBanIds.has(ban.id)) continue; // tenant opted out of this global ban

      const banIp = ban.ip;
      const isWhitelisted = resolvedWhitelist.some((cidr) => {
        // Simple check — the full CIDR containment is done in whitelistService.isWhitelisted
        // Here we do exact match for performance; the agent will apply its own whitelist anyway
        return banIp === cidr || banIp.startsWith(cidr.split('/')[0]);
      });
      if (!isWhitelisted) shouldBeBanned.add(banIp);
    }

    const currentSet = new Set(agentCurrentBans);
    const add = [...shouldBeBanned].filter((ip) => !currentSet.has(ip));
    const remove = [...currentSet].filter((ip) => !shouldBeBanned.has(ip));

    return { add, remove };
  }

  /**
   * Create (or refresh) a ban received from another Obli suite app via `/api/external-bans`.
   *
   * The caller is authenticated via a delegation token whose `sub` starts with `app:` — this
   * function trusts the source app's identity to record `origin_app`, but is idempotent:
   *   - New IP → INSERT with ban_type='external', scope='global'
   *   - Existing active ban → keep the row, extend expires_at if the new window is longer
   *     (null = permanent absorbs any timestamp). Preserves the audit trail (banned_at,
   *     original reason) but bumps the record so downstream sync workers pick up the refresh.
   *
   * Non-active existing row (previously lifted) is REACTIVATED — the source app pushed it
   * again, presumably after a fresh hit. If an operator manually unbanned this IP, that hit
   * will re-ban it; the operator can add it to the whitelist to make the lift stick.
   */
  async createFromExternal(args: {
    ip: string;
    reason: string | null;
    sourceApp: string;                  // 'oblihub' etc.
    expiresAt: Date | null;             // null = permanent
    masterTenantId: number;             // the platform tenant that owns cross-suite bans
  }): Promise<{ ban: IpBan; isNew: boolean }> {
    // Same contract as every ban path: strict single address, not reserved/protected.
    const chk = await checkBanTarget(args.ip, { allowCidr: false, includeInterfaces: true });
    if (!chk.ok) throw new AppError(400, chk.message);
    const ip = chk.target.address;

    const existing = await db('ip_bans').whereRaw('ip = ?::inet', [ip]).first() as BanRow | undefined;
    if (existing) {
      // Reconcile expires_at (null = permanent wins).
      let nextExpires: Date | null = existing.expires_at ? new Date(existing.expires_at as unknown as string) : null;
      if (args.expiresAt == null) nextExpires = null;
      else if (nextExpires != null && args.expiresAt > nextExpires) nextExpires = args.expiresAt;
      const [row] = await db('ip_bans').where({ id: existing.id }).update({
        is_active: true,
        expires_at: nextExpires,
        // Keep the original ban_type ('auto'/'manual') if it existed — don't demote it to
        // 'external'. If ban_type was previously 'external' and origin_app was NULL, backfill.
        origin_app: existing.ban_type === 'external' ? args.sourceApp : existing.ban_type === 'auto' || existing.ban_type === 'manual' ? existing.origin_app : args.sourceApp,
      }).returning('*') as BanRow[];
      _io?.emit('ban:updated', rowToBan(row));
      return { ban: rowToBan(row), isNew: false };
    }

    const [row] = await db('ip_bans').insert({
      ip,
      cidr_prefix: null,
      reason: args.reason,
      ban_type: 'external',
      scope: 'global',
      scope_id: null,
      tenant_id: null,
      origin_tenant_id: args.masterTenantId,
      origin_app: args.sourceApp,
      banned_by_user_id: null,
      expires_at: args.expiresAt,
      is_active: true,
    }).returning('*') as BanRow[];
    _io?.emit('ban:created', rowToBan(row));

    // Sync downstream (MikroTik + remote blocklists) — same fire-and-forget as manual bans.
    import('./mikrotik/mikrotikBanSync.service')
      .then(({ mikrotikBanSync }) => mikrotikBanSync.pushBanToAll(ip, 'ban'))
      .catch(() => {});

    return { ban: rowToBan(row), isNew: true };
  }
}

export const banService = new BanService();

// ── BanEngine ────────────────────────────────────────────────────────────────
// Runs every 30s, evaluates ip_events against per-service thresholds,
// and auto-creates global bans for IPs that exceed them.

const BAN_ENGINE_INTERVAL_MS = 30_000;

/** ip → last "refused auto-ban" warning (one per IP per hour). */
const refusedAutoBanLog = new Map<string, number>();

class BanEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), BAN_ENGINE_INTERVAL_MS);
    // Unsafe legacy rows: audited now and every 10 min, skipped at delivery.
    startBanSafetyAudit();
    logger.info('BanEngine started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    stopBanSafetyAudit();
  }

  async run(): Promise<void> {
    // Re-entrancy guard: if a cycle is still working (e.g. DB contention made
    // resolveForAgent slow), skip this tick instead of stacking overlapping runs
    // that pile onto the connection pool and spiral into a hang.
    if (this.running) {
      logger.warn('BanEngine: previous cycle still running — skipping this tick');
      return;
    }
    this.running = true;
    try {
      await this.evaluateThresholds();
    } catch (err) {
      logger.error(err, 'BanEngine run failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * For each approved agent, resolve its active service templates (opt-in model),
   * then count auth_failure events in each configured window.
   * If count >= threshold AND ip is not whitelisted, create a global ban.
   *
   * Templates are opt-in: they must be explicitly enabled at group or agent level
   * (enabled_override = true) to count toward auto-bans.
   */
  private async evaluateThresholds(): Promise<void> {
    // Fetch all approved agents
    const devices = await db('agent_devices')
      .where({ status: 'approved' })
      .select('id', 'group_id', 'tenant_id', 'evaluate_only') as Array<{ id: number; group_id: number | null; tenant_id: number; evaluate_only: boolean }>;

    if (devices.length === 0) return;

    // Groups flagged evaluate-only (dry-run). A device inherits the flag if any
    // of its ancestor groups is in this set — such devices never auto-ban.
    const evalOnlyGroups = new Set(
      await db('monitor_groups').where('evaluate_only', true).pluck('id') as number[],
    );

    // Pre-fetch group ancestries for all devices in one query
    const devicesWithGroups = await Promise.all(
      devices.map(async (dev) => {
        if (!dev.group_id) return { dev, groupIds: [] as number[] };
        const rows = await db('group_closure')
          .where('descendant_id', dev.group_id)
          .select('ancestor_id')
          .orderBy('depth', 'asc') as { ancestor_id: number }[];
        return { dev, groupIds: rows.map(r => r.ancestor_id) };
      }),
    );

    // Evaluate per-device
    for (const { dev, groupIds } of devicesWithGroups) {
      // Evaluate-only (dry-run): observe events but never create auto-bans for
      // this device (own flag or inherited from an ancestor group).
      if (dev.evaluate_only || groupIds.some((g) => evalOnlyGroups.has(g))) {
        continue;
      }

      let resolved;
      try {
        resolved = await serviceTemplateService.resolveForAgent(dev.id, groupIds);
      } catch (err) {
        logger.warn({ err, deviceId: dev.id }, 'BanEngine: failed to resolve templates for device');
        continue;
      }

      // Only process enabled ban-mode templates
      const activeTemplates = resolved.filter(cfg => cfg.enabled && cfg.mode === 'ban');
      if (activeTemplates.length === 0) continue;

      for (const cfg of activeTemplates) {
        const windowStart = new Date(Date.now() - cfg.windowSeconds * 1000);

        const results = await db('ip_events')
          .select('ip', 'tenant_id')
          .count('id as failure_count')
          .where('device_id', dev.id)
          .where('service', cfg.serviceType)
          .where('event_type', 'auth_failure')
          .where('track_only', false)
          .where('timestamp', '>=', windowStart)
          .groupBy('ip', 'tenant_id')
          .havingRaw('count(id) >= ?', [cfg.threshold]) as Array<{
            ip: string;
            tenant_id: number;
            failure_count: string;
          }>;

        for (const r of results) {
          await this.createAutoBan(r.ip, r.tenant_id, cfg.serviceType, Number(r.failure_count));
        }
      }
    }
  }

  private async createAutoBan(
    ip: string,
    originTenantId: number,
    service: string,
    failureCount: number,
  ): Promise<void> {
    // Never auto-ban a reserved or protected address (throttled warning).
    const chk = await checkBanTarget(ip, { allowCidr: false, includeInterfaces: true });
    if (!chk.ok) {
      const now = Date.now();
      const last = refusedAutoBanLog.get(ip);
      if (last == null || now - last > 60 * 60 * 1000) {
        if (refusedAutoBanLog.size > 1000) refusedAutoBanLog.clear();
        refusedAutoBanLog.set(ip, now);
        logger.warn({ ip, reason: chk.code }, 'BanEngine: refusing to auto-ban a reserved/protected address');
      }
      return;
    }

    // Check if already actively banned
    const existing = await db('ip_bans')
      .where('ip', ip)
      .where('scope', 'global')
      .where('is_active', true)
      .first();

    if (existing) return; // Already banned globally

    // Check whitelist (global-scope only for now; per-tenant override handled at push time)
    const whitelisted = await db('ip_whitelist')
      .where('scope', 'global')
      .whereRaw('?::inet << ip', [ip])
      .first();

    if (whitelisted) return;

    await db('ip_bans').insert({
      ip,
      scope: 'global',
      ban_type: 'auto',
      origin_tenant_id: originTenantId,
      reason: `Auto-ban: ${failureCount} ${service} auth failures`,
      is_active: true,
    });

    // Ensure the IP has a reputation row so it appears in the IP Reputation module
    // even if ip_events were processed before the reputation upsert fix.
    await ipReputationService.ensureExists(ip).catch(() => { /* non-fatal */ });

    logger.info({ ip, service, failureCount }, 'BanEngine: auto-banned IP');
    _io?.emit('ban:auto', { ip, service, failureCount, originTenantId });

    // Push auto-ban to MikroTik devices (fire-and-forget)
    import('./mikrotik/mikrotikBanSync.service')
      .then(({ mikrotikBanSync }) => mikrotikBanSync.pushBanToAll(ip, 'ban'))
      .catch(() => {});

    // ── Mark origin agents as "under attack" ──────────────────────────────────
    // Find agent devices that had recent auth_failure events from this IP (last 10 min)
    try {
      const cutoff = new Date(Date.now() - 10 * 60 * 1000);
      const affectedDevices = await db('ip_events')
        .where({ ip, event_type: 'auth_failure', tenant_id: originTenantId })
        .where('timestamp', '>=', cutoff)
        .whereNotNull('device_id')
        .distinct('device_id')
        .pluck('device_id') as number[];

      if (affectedDevices.length > 0) {
        await db('agent_devices')
          .whereIn('id', affectedDevices)
          .update({ last_attack_at: new Date() });

        // Fire "attack" notifications for each affected device
        const { notificationService } = await import('./notification.service');
        for (const devId of affectedDevices) {
          const devRow = await db('agent_devices').where({ id: devId }).select('name', 'hostname').first() as { name: string | null; hostname: string } | undefined;
          const label = devRow?.name ?? devRow?.hostname ?? String(devId);
          notificationService.sendForAgent(devId, label, 'attack', 'ok', [`${ip} banned (${failureCount} ${service} failures)`], 'attack').catch(
            (err) => logger.warn({ err, devId, ip }, 'Failed to send attack notification'),
          );
        }
      }
    } catch (err) {
      logger.warn({ err, ip }, 'BanEngine: failed to update last_attack_at for affected devices');
    }
  }
}

export const banEngine = new BanEngine();
