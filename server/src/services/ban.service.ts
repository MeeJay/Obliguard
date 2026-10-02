import type { Server as SocketIOServer } from 'socket.io';
import type { Knex } from 'knex';
import { db } from '../db';
import type { IpBan, CreateBanRequest, BanScope } from '@obliview/shared';
import { isMasterTenant, MASTER_TENANT_ID } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { serviceTemplateService } from './serviceTemplate.service';
import { ipReputationService } from './ipReputation.service';
import { canUseTenant } from '../middleware/tenant';
import { parseBanTarget, parseIpOrCidr, banTargetRawFromRow, RESERVED_OR_PROTECTED_MESSAGE } from '../utils/ipValidation';
import type { BanTarget, ParsedCidr } from '../utils/ipValidation';
import { checkBanTarget, ensureInfraFresh, findBanSafetyConflict } from '../utils/protectedIps';
import { applyBanVisibility, canSeeBan, canSeeBanAuthor } from './banVisibility';
import { isUnsafeBanId, startBanSafetyAudit, stopBanSafetyAudit } from './banSafetyAudit';
import { emitGlobal, emitToTenantAudience } from '../utils/socketRooms';
import { whitelistService, whereWhitelistApplies } from './whitelist.service';
import type { WhitelistMatchContext } from './whitelist.service';
import type { MikrotikBanAudience } from './mikrotik/mikrotikBanSync.service';

/*
 * Subnet bans (D4.1). A subnet is stored as its network address in `ip` plus
 * `cidr_prefix`; legacy rows may carry the prefix in the inet mask instead.
 * One active row per (ip, prefix, scope, scope_id, tenant_id) (migration 032).
 * Delivery: 'a.b.c.d/nn' to agents reporting the 'cidr' capability (and to
 * MikroTik routers), the network address to older agents.
 */

const BAN_SCOPES = ['global', 'tenant', 'group', 'agent'] as const;

/** Agent capability: the agent enforces 'a.b.c.d/nn' entries natively. */
export const AGENT_CAPABILITY_CIDR = 'cidr';

/** Why a ban was deactivated (logged with the actor; announced in ban:lifted). */
export type BanLiftReason = 'lift' | 'wipe' | 'expiry' | 'external_withdraw';

/** Who deactivated a ban: a user (operating tenant), an external app, or the system. */
export interface BanActor {
  userId?: number | null;
  tenantId?: number | null;
  app?: string | null;
}

/** Above this many rows, one ban:bulkLifted replaces the per-row ban:lifted. */
const LIFT_EVENT_MAX_ROWS = 500;
/** Above this many rows, one MikroTik reconciliation replaces the per-address unbans. */
const LIFT_MIKROTIK_MAX_ROWS = 50;
/** UPDATE ... WHERE id IN (...) chunk (bind parameter limit). */
const DEACTIVATE_CHUNK = 5000;

/** SQL: the effective prefix of ban row `a`. */
const prefixSql = (a: string) => `COALESCE(${a}.cidr_prefix, masklen(${a}.ip))`;
/** SQL: ban row `a` as a network (containment checks). */
const networkSql = (a: string) => `set_masklen(${a}.ip, ${prefixSql(a)})`;

function fullPrefix(p: Pick<ParsedCidr, 'family'>): number {
  return p.family === 4 ? 32 : 128;
}

/** Canonical text of a target: the bare address for /32 and /128, else 'address/prefix'. */
function targetText(p: ParsedCidr): string {
  return p.prefix === fullPrefix(p) ? p.address : `${p.address}/${p.prefix}`;
}

/** The parsed target of a stored row (null for an unparsable legacy value). */
function rowTarget(row: Pick<BanRow, 'ip' | 'cidr_prefix'>): ParsedCidr | null {
  return parseIpOrCidr(banTargetRawFromRow(String(row.ip), row.cidr_prefix));
}

/**
 * The text a ban row is delivered as: plain host for /32 and /128, else
 * 'network/prefix' — or only the network address when the receiver does not
 * enforce CIDR entries.
 */
export function deliveredBanTarget(row: Pick<BanRow, 'ip' | 'cidr_prefix'>, cidr = true): string {
  const p = rowTarget(row);
  if (!p) return String(row.ip);
  return cidr ? targetText(p) : p.address;
}

/** True when a stored capability list (jsonb array, or its JSON text) contains `cap`. */
function hasCapability(raw: unknown, cap: string): boolean {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return false; }
  }
  return Array.isArray(v) && v.includes(cap);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

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
  /** When the row was deactivated (migration 032). */
  lifted_at?: Date | null;
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

// ── Realtime audience ────────────────────────────────────────────────────────

/**
 * The sockets a ban row concerns, with the payload each one may see:
 *   - global: every socket gets the public projection (no origin tenant, no
 *     author); the origin tenant gets its own flags (isOriginTenant), Default
 *     the god view (origin tenant, author);
 *   - tenant/group/agent: the owning tenant and Default only.
 */
function emitBanRow(event: string, row: BanRow): void {
  if (!_io) return;
  if (row.scope === 'global') {
    const perTenant = new Map<number, unknown>([[MASTER_TENANT_ID, rowToBan(row, true, MASTER_TENANT_ID)]]);
    const origin = row.origin_tenant_id;
    if (origin != null && !isMasterTenant(origin)) perTenant.set(origin, rowToBan(row, false, origin));
    emitGlobal(_io, event, rowToBan(row, false), perTenant);
    return;
  }
  const owner = row.tenant_id ?? undefined;
  emitToTenantAudience(_io, owner, event, rowToBan(row, false, owner), rowToBan(row, true, MASTER_TENANT_ID));
}

/** A non-row ban event (lift) with the same audience as emitBanRow. */
function emitBanEvent(event: string, row: Pick<BanRow, 'scope' | 'tenant_id'>, payload: Record<string, unknown>): void {
  if (row.scope === 'global') emitGlobal(_io, event, payload);
  else emitToTenantAudience(_io, row.tenant_id, event, payload);
}

/**
 * MikroTik routers that must apply a change of this ban row (A3): the owning
 * tenant's for a tenant/group/agent ban; undefined = global (every router,
 * minus the tenants that excluded the address's global ban).
 */
function mikrotikAudienceOf(row: Pick<BanRow, 'scope' | 'tenant_id'>): MikrotikBanAudience | undefined {
  return row.scope === 'global' ? undefined : { tenantId: row.tenant_id };
}

/**
 * Fire-and-forget MikroTik push (dynamic import: mikrotikBanSync reads ban
 * rows). `target` is the delivered text (RouterOS address-lists take CIDR).
 */
function pushMikrotik(target: string, action: 'ban' | 'unban', audience: MikrotikBanAudience | undefined): void {
  import('./mikrotik/mikrotikBanSync.service')
    .then(({ mikrotikBanSync }) => mikrotikBanSync.pushBanToAll(target, action, audience))
    .catch((err) => logger.warn({ err, target, action }, 'MikroTik ban push failed'));
}

/** Fire-and-forget reconciliation of every router (after a mass deactivation). */
function reconcileMikrotik(): void {
  import('./mikrotik/mikrotikBanSync.service')
    .then(({ mikrotikBanSync }) => mikrotikBanSync.reconcileAll())
    .catch((err) => logger.warn({ err }, 'MikroTik reconciliation failed'));
}

/** Whitelist context of a ban scope (manual creation: the scope's own entries). */
function whitelistContextOf(scope: BanScope, scopeId: number | null, tenantId: number | null): WhitelistMatchContext {
  if (scope === 'global' || tenantId == null) return {};
  if (scope === 'group') return { tenantId, groupIds: scopeId != null ? [scopeId] : [] };
  if (scope === 'agent') return { tenantId, deviceId: scopeId };
  return { tenantId };
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

    // 3) Non-public ranges, interfaces and every tenant's infra addresses for
    //    a global ban; a scoped ban checks its own tenant's agents and routers
    await ensureInfraFresh();
    if (await findBanSafetyConflict(t, { global: scope === 'global', tenantId: rowTenantId })) {
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

    // An expired row still flagged active would hold the unique key (032).
    await this.expireStale(t);

    // 5) Whitelist check, duplicate check and insert, atomic per target
    const row = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`ip_bans:${t.cidr}`]);

      // Any overlap is refused: a range must not block a whitelisted address.
      if (await whitelistService.isWhitelisted(t.cidr, whitelistContextOf(scope, scopeId, rowTenantId), { mode: 'overlaps', trx })) {
        throw new AppError(409, 'This IP is whitelisted');
      }

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

      try {
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
      } catch (err) {
        // Unique key (032): a concurrent auto-ban or external ban won the race.
        if (isUniqueViolation(err)) throw new AppError(409, 'This IP is already banned');
        throw err;
      }
    });

    emitBanRow('ban:created', row);

    // Push ban to MikroTik devices (fire-and-forget): only the tenant's routers
    // for a tenant/group/agent ban.
    if (!opts.deferMikrotik) pushMikrotik(deliveredBanTarget(row), 'ban', mikrotikAudienceOf(row));

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
    await ensureInfraFresh();
    if (await findBanSafetyConflict(t, { global: true })) {
      throw new AppError(400, RESERVED_OR_PROTECTED_MESSAGE);
    }
    await this.expireStale(t);

    const row = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`ip_bans:${t.cidr}`]);
      if (await whitelistService.isWhitelisted(t.cidr, {}, { mode: 'overlaps', trx })) {
        throw new AppError(409, 'This IP is whitelisted');
      }
      const dup = await trx('ip_bans')
        .where('is_active', true)
        .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', trx.fn.now()))
        .whereRaw('ip = ?::inet', [t.address])
        .whereRaw('COALESCE(cidr_prefix, CASE WHEN family(ip) = 4 THEN 32 ELSE 128 END) = ?', [t.prefix])
        .where('scope', 'global')
        .first('id');
      if (dup) throw new AppError(409, 'This IP is already banned globally');
      let updated: BanRow | undefined;
      try {
        [updated] = await trx('ip_bans')
          .where({ id: banId, is_active: true })
          .whereNot('scope', 'global')
          .update({
            scope: 'global',
            scope_id: null,
            tenant_id: null,
            ip: trx.raw('?::inet', [t.address]),
            // A subnet stays a subnet.
            cidr_prefix: t.isNetwork ? t.prefix : null,
          })
          .returning('*') as BanRow[];
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'This IP is already banned globally');
        throw err;
      }
      if (!updated) throw new AppError(409, 'Ban is no longer active');
      return updated;
    });

    emitBanRow('ban:updated', row);

    // A global ban reaches every router not excluded from it (fire-and-forget).
    pushMikrotik(deliveredBanTarget(row), 'ban', mikrotikAudienceOf(row));

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

    // Deactivation stamps lifted_at: the BanEngine ignores the failures that
    // led to this ban, so the Lift is not undone by the next cycle.
    const deactivateGlobally = async (): Promise<void> => {
      const lifted = await this.deactivateBans([banId], 'lift', { userId, tenantId });
      if (lifted.length === 0) throw new AppError(409, 'Ban is no longer active');
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
      emitToTenantAudience(_io, tenantId, 'ban:excluded', { banId, tenantId });
      // Only the excluding tenant's routers drop it.
      pushMikrotik(deliveredBanTarget(ban), 'unban', { tenantId });
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

    emitToTenantAudience(_io, tenantId, 'ban:excluded', { banId, tenantId });
    // Only the excluding tenant's routers drop it.
    pushMikrotik(deliveredBanTarget(ban), 'unban', { tenantId });
  }

  /**
   * Remove a per-tenant exclusion (re-enable enforcement for this tenant).
   */
  async removeExclusion(banId: number, tenantId: number): Promise<void> {
    const deleted = await db('ip_ban_exclusions')
      .where({ ban_id: banId, tenant_id: tenantId })
      .delete();
    if (!deleted) throw new AppError(404, 'No exclusion found for this ban and tenant');
    emitToTenantAudience(_io, tenantId, 'ban:exclusionRemoved', { banId, tenantId });
    // Enforced again on this tenant: its routers re-apply the ban.
    const ban = await db('ip_bans').where({ id: banId }).first('ip', 'cidr_prefix', 'is_active') as
      Pick<BanRow, 'ip' | 'cidr_prefix' | 'is_active'> | undefined;
    if (ban?.is_active) pushMikrotik(deliveredBanTarget(ban), 'ban', { tenantId });
  }

  /**
   * The single deactivation path (Lift, wipe, expiry, external withdraw):
   * is_active=false and lifted_at=now() on the rows still active, each one
   * announced as ban:lifted to its audience and unbanned on its MikroTik
   * routers. A mass deactivation sends one ban:bulkLifted and one router
   * reconciliation instead. Returns the rows actually deactivated.
   */
  async deactivateBans(ids: number[], reason: BanLiftReason, actor: BanActor = {}): Promise<BanRow[]> {
    const unique = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const rows: BanRow[] = [];
    for (let i = 0; i < unique.length; i += DEACTIVATE_CHUNK) {
      const chunk = unique.slice(i, i + DEACTIVATE_CHUNK);
      const done = await db('ip_bans')
        .whereIn('id', chunk)
        .where('is_active', true)
        .update({ is_active: false, lifted_at: db.fn.now() })
        .returning('*') as BanRow[];
      rows.push(...done);
    }
    if (rows.length === 0) return rows;

    logger.info(
      { reason, actor, count: rows.length, ids: rows.slice(0, 20).map((r) => r.id) },
      'Bans deactivated',
    );

    if (rows.length <= LIFT_EVENT_MAX_ROWS) {
      for (const row of rows) emitBanEvent('ban:lifted', row, { id: row.id, reason });
    } else {
      // Counts only: no row detail reaches a tenant that could not see it.
      emitGlobal(_io, 'ban:bulkLifted', { count: rows.length, reason });
    }

    if (rows.length <= LIFT_MIKROTIK_MAX_ROWS) {
      // A router still covered by another active ban of the same target keeps it.
      for (const row of rows) pushMikrotik(deliveredBanTarget(row), 'unban', mikrotikAudienceOf(row));
    } else {
      reconcileMikrotik();
    }
    return rows;
  }

  /** Platform-wide wipe (Default tenant, platform admin): every active ban. Returns the count. */
  async wipeAll(actor: BanActor): Promise<number> {
    const ids = await db('ip_bans').where('is_active', true).pluck('id') as number[];
    return (await this.deactivateBans(ids, 'wipe', actor)).length;
  }

  /**
   * Deactivate expired bans (expiry job): each one is announced as lifted to
   * its audience and removed from its MikroTik routers. Returns the count.
   */
  async expireBans(): Promise<number> {
    const ids = await db('ip_bans')
      .where('is_active', true)
      .whereNotNull('expires_at')
      .where('expires_at', '<=', db.fn.now())
      .pluck('id') as number[];
    return (await this.deactivateBans(ids, 'expiry')).length;
  }

  /**
   * Expired rows of a target that are still flagged active (the expiry job
   * runs every 5 minutes): deactivated before a new row of the same key is
   * written, since they hold the unique key of migration 032.
   */
  private async expireStale(t: Pick<ParsedCidr, 'address' | 'prefix'>): Promise<void> {
    const ids = await db('ip_bans')
      .where('is_active', true)
      .whereNotNull('expires_at')
      .where('expires_at', '<=', db.fn.now())
      .whereRaw('ip = ?::inet', [t.address])
      .whereRaw(`${prefixSql('ip_bans')} = ?`, [t.prefix])
      .pluck('id') as number[];
    if (ids.length > 0) await this.deactivateBans(ids, 'expiry');
  }

  /**
   * Withdraw the active external bans `sourceApp` pushed for `ip`
   * (DELETE /api/external-bans/:ip). Returns the number of rows lifted.
   */
  async withdrawExternal(ip: string, sourceApp: string): Promise<number> {
    const p = parseIpOrCidr(ip);
    if (!p || p.prefix !== fullPrefix(p)) throw new AppError(400, 'ip required (single IPv4/IPv6 address)');
    const ids = await db('ip_bans')
      .whereRaw('ip = ?::inet', [p.address])
      .where({ ban_type: 'external', origin_app: sourceApp, is_active: true })
      .pluck('id') as number[];
    return (await this.deactivateBans(ids, 'external_withdraw', { app: sourceApp })).length;
  }

  /**
   * Compute the ban list delta for an agent (or a MikroTik router): the
   * targets that should be enforced but are not in agentCurrentBans, and the
   * entries of agentCurrentBans that are no longer wanted.
   *
   * Applicable bans: active and unexpired; global (unless this tenant excluded
   * it), the device tenant's tenant-scoped bans, group bans of `groupIds` and
   * agent bans of the device — scoped rows only through their real scope.
   * A ban contained in an applicable whitelist entry (global, the tenant's,
   * its groups', the agent's) is not delivered: real CIDR containment in SQL.
   *
   * Targets are delivered as plain host (/32, /128) or 'network/prefix' when
   * the device reports the 'cidr' capability (`opts.cidr` overrides, e.g.
   * RouterOS), else as the network address (older agents). The comparison
   * with the device's current state is canonical (host bits, IPv6 form); a
   * remove echoes the device's own text.
   *
   * `_resolvedWhitelist` is ignored (kept for the existing call sites): the
   * whitelist is applied in SQL.
   */
  async computeBanDelta(
    deviceId: number,
    groupIds: number[],
    tenantId: number,
    agentCurrentBans: string[],
    _resolvedWhitelist: string[] = [],
    opts: { cidr?: boolean } = {},
  ): Promise<{ add: string[]; remove: string[] }> {
    let cidr = opts.cidr;
    if (cidr === undefined) {
      const dev = await db('agent_devices').where({ id: deviceId }).first('capabilities') as { capabilities?: unknown } | undefined;
      cidr = hasCapability(dev?.capabilities, AGENT_CAPABILITY_CIDR);
    }
    const wlContext: WhitelistMatchContext = { tenantId, groupIds, deviceId };

    const bans = await db('ip_bans as b')
      .where('b.is_active', true)
      .where((q) => q.whereNull('b.expires_at').orWhere('b.expires_at', '>', db.fn.now()))
      .where((q) => {
        q.where('b.scope', 'global')
          .orWhere((s) => s.where('b.scope', 'tenant').where('b.tenant_id', tenantId));
        if (groupIds.length > 0) q.orWhere((s) => s.where('b.scope', 'group').whereIn('b.scope_id', groupIds));
        q.orWhere((s) => s.where('b.scope', 'agent').where('b.scope_id', deviceId));
      })
      // The tenant opted out of this global ban.
      .whereNotExists(
        db('ip_ban_exclusions as ex').select(db.raw('1')).whereRaw('ex.ban_id = b.id').where('ex.tenant_id', tenantId),
      )
      // Covered by an applicable whitelist entry (w.ip contains the whole target).
      .whereNotExists(
        db('ip_whitelist as w').select(db.raw('1'))
          .whereRaw(`w.ip >>= ${networkSql('b')}`)
          .where((wb) => whereWhitelistApplies(wb, 'w', wlContext)),
      )
      .select('b.id', 'b.ip', 'b.cidr_prefix') as Array<Pick<BanRow, 'id' | 'ip' | 'cidr_prefix'>>;

    // Delivered texts, canonical (also the comparison key).
    const wanted = new Set<string>();
    for (const ban of bans) {
      // Unsafe legacy rows (reserved / too broad / protected, see banSafetyAudit)
      // are never delivered: the agent receives a 'remove' for them.
      if (isUnsafeBanId(ban.id)) continue;
      const p = rowTarget(ban);
      if (!p) continue;
      wanted.add(cidr ? targetText(p) : p.address);
    }

    const currentKeys = new Set<string>();
    const remove = new Set<string>();
    for (const raw of agentCurrentBans) {
      if (typeof raw !== 'string') continue;
      const p = parseIpOrCidr(raw);
      const key = p ? targetText(p) : raw;
      currentKeys.add(key);
      if (!wanted.has(key)) remove.add(raw);
    }
    const add = [...wanted].filter((text) => !currentKeys.has(text));

    return { add, remove: [...remove] };
  }

  /**
   * Create (or refresh) a ban received from another Obli suite app via `/api/external-bans`.
   *
   * The caller is authenticated via a delegation token whose `sub` starts with `app:` — this
   * function trusts the source app's identity to record `origin_app`, but is idempotent:
   *   - an active global EXTERNAL row of the address → kept, expires_at extended if the new
   *     window is longer (null = permanent absorbs any timestamp); audit trail (banned_at,
   *     original reason) preserved;
   *   - another active global row of the address (auto / manual) → left untouched, returned
   *     as not new: the address is already blocked everywhere, and the source app cannot
   *     withdraw a ban it did not create;
   *   - otherwise → INSERT a new row, ban_type='external', scope='global'.
   *
   * A lifted row, or a tenant/group/agent-scoped row, is NEVER reactivated: an operator's
   * Lift stays lifted until the source app pushes again (which creates a new row), and a
   * scoped ban never becomes global.
   */
  async createFromExternal(args: {
    ip: string;
    reason: string | null;
    sourceApp: string;                  // 'oblihub' etc.
    expiresAt: Date | null;             // null = permanent
    masterTenantId: number;             // the platform tenant that owns cross-suite bans
  }): Promise<{ ban: IpBan; isNew: boolean }> {
    // Same contract as every ban path: strict single address, public, not protected.
    await ensureInfraFresh();
    const chk = await checkBanTarget(args.ip, { allowCidr: false, includeInterfaces: true });
    if (!chk.ok) throw new AppError(400, chk.message);
    const ip = chk.target.address;
    if (await whitelistService.isWhitelisted(ip, {})) throw new AppError(409, 'This IP is whitelisted');
    await this.expireStale(chk.target);

    const activeGlobal = (k: Knex) => k('ip_bans')
      .where({ scope: 'global', is_active: true })
      .whereRaw('ip = ?::inet', [ip])
      .whereRaw(`${prefixSql('ip_bans')} = ?`, [fullPrefix(chk.target)]);

    const result = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`ip_bans:${ip}`]);
      const current = await activeGlobal(trx).orderByRaw("(ban_type = 'external') DESC").first() as BanRow | undefined;
      if (current && current.ban_type === 'external') {
        // Reconcile expires_at (null = permanent wins).
        let nextExpires: Date | null = current.expires_at ? new Date(current.expires_at as unknown as string) : null;
        if (args.expiresAt == null) nextExpires = null;
        else if (nextExpires != null && args.expiresAt > nextExpires) nextExpires = args.expiresAt;
        const [row] = await trx('ip_bans').where({ id: current.id }).update({
          expires_at: nextExpires,
          origin_app: current.origin_app ?? args.sourceApp,
        }).returning('*') as BanRow[];
        return { row, isNew: false, changed: true };
      }
      if (current) return { row: current, isNew: false, changed: false };

      const [row] = await trx('ip_bans').insert({
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
      return { row, isNew: true, changed: true };
    }).catch(async (err) => {
      // Unique key (032): a concurrent global ban of the address won the race.
      if (!isUniqueViolation(err)) throw err;
      const row = await activeGlobal(db).first() as BanRow | undefined;
      if (!row) throw err;
      return { row, isNew: false, changed: false };
    });

    if (result.isNew) {
      emitBanRow('ban:created', result.row);
      // Sync downstream (MikroTik + remote blocklists) — same fire-and-forget as manual bans.
      pushMikrotik(deliveredBanTarget(result.row), 'ban', mikrotikAudienceOf(result.row));
    } else if (result.changed) {
      emitBanRow('ban:updated', result.row);
    }

    return { ban: rowToBan(result.row), isNew: result.isNew };
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
      // Approved agents' and routers' public addresses are never auto-banned.
      await ensureInfraFresh();
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
   * Lift watermark: only failures NEWER than the address's latest global
   * deactivation (lifted_at: Lift, wipe, expiry, external withdraw) count, so
   * a Lift is not undone by the failures that caused the ban.
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
          .whereRaw(`ip_events.timestamp > COALESCE((
            SELECT max(lb.lifted_at) FROM ip_bans lb
             WHERE lb.ip = ip_events.ip AND lb.scope = 'global' AND lb.lifted_at IS NOT NULL
          ), '-infinity'::timestamptz)`)
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
    rawIp: string,
    originTenantId: number,
    service: string,
    failureCount: number,
  ): Promise<void> {
    // Never auto-ban a non-public, reserved or protected address (approved
    // agents and routers included). Logged here, throttled: the engine sees
    // the same address every cycle.
    const chk = await checkBanTarget(rawIp, { allowCidr: false, includeInterfaces: true, silent: true });
    if (!chk.ok) {
      const now = Date.now();
      const last = refusedAutoBanLog.get(rawIp);
      if (last == null || now - last > 60 * 60 * 1000) {
        if (refusedAutoBanLog.size > 1000) refusedAutoBanLog.clear();
        refusedAutoBanLog.set(rawIp, now);
        logger.warn({ ip: rawIp, reason: chk.code }, 'BanEngine: refusing to auto-ban a non-public, reserved or protected address (BanSafety)');
      }
      return;
    }
    const ip = chk.target.address;

    // Already blocked everywhere: an active global ban of the address, or of
    // a subnet containing it. An expired row still flagged active is
    // deactivated (it holds the unique key of migration 032).
    const covering = await db('ip_bans')
      .where('scope', 'global')
      .where('is_active', true)
      .whereRaw(`${networkSql('ip_bans')} >>= ?::inet`, [ip])
      .select('id', 'expires_at') as Array<{ id: number; expires_at: Date | null }>;
    const now = Date.now();
    if (covering.some((b) => b.expires_at == null || new Date(b.expires_at).getTime() > now)) return;
    if (covering.length > 0) await banService.deactivateBans(covering.map((b) => b.id), 'expiry');

    // Global whitelist only (real containment, single-address entries
    // included); tenant-local entries act at delivery time.
    if (await whitelistService.isWhitelisted(ip, {})) return;

    let inserted: { id: number } | undefined;
    try {
      [inserted] = await db('ip_bans').insert({
        ip,
        scope: 'global',
        ban_type: 'auto',
        origin_tenant_id: originTenantId,
        reason: `Auto-ban: ${failureCount} ${service} auth failures`,
        is_active: true,
      }).returning(['id']) as Array<{ id: number }>;
    } catch (err) {
      // Unique key (032): a concurrent global ban of the address won the race.
      if (isUniqueViolation(err)) return;
      throw err;
    }

    // Ensure the IP has a reputation row so it appears in the IP Reputation module
    // even if ip_events were processed before the reputation upsert fix.
    await ipReputationService.ensureExists(ip).catch(() => { /* non-fatal */ });

    logger.info({ ip, service, failureCount }, 'BanEngine: auto-banned IP');
    // Auto-bans are global: every tenant hears of the ban, only Default learns
    // which tenant's agents triggered it.
    const autoPayload = { id: inserted.id, ip, service, failureCount };
    emitGlobal(_io, 'ban:auto', { ...autoPayload, originTenantId: null },
      new Map([[MASTER_TENANT_ID, { ...autoPayload, originTenantId }]]));

    // Push auto-ban to MikroTik devices (fire-and-forget)
    pushMikrotik(ip, 'ban', undefined);

    // ── Mark origin agents as "under attack" ──────────────────────────────────
    // Find agent devices that had recent auth_failure events from this IP (last 10 min)
    try {
      const cutoff = new Date(Date.now() - 10 * 60 * 1000);
      const affectedDevices = await db('ip_events')
        .where({ event_type: 'auth_failure', tenant_id: originTenantId })
        .whereRaw('ip = ?::inet', [ip])
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
