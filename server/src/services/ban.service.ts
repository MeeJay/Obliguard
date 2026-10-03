import type { Server as SocketIOServer } from 'socket.io';
import type { Knex } from 'knex';
import { db } from '../db';
import type { IpBan, CreateBanRequest, BanScope, ResolvedServiceConfig } from '@obliview/shared';
import { isMasterTenant, MASTER_TENANT_ID, SOCKET_EVENTS } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { codedError, type ErrorCode } from '../utils/errorCodes';
import { logger } from '../utils/logger';
import { serviceTemplateService } from './serviceTemplate.service';
import { ipReputationService } from './ipReputation.service';
import { canUseTenant } from '../middleware/tenant';
import { parseBanTarget, parseIpOrCidr, banTargetRawFromRow, banPrefixFloor, RESERVED_OR_PROTECTED_MESSAGE } from '../utils/ipValidation';
import type { BanTarget, BanTargetErrorCode, ParsedCidr } from '../utils/ipValidation';
import { checkBanTarget, ensureInfraFresh, findBanSafetyConflict } from '../utils/protectedIps';
import { parseIpSearch, ipSearchSql } from '../utils/pagination';
import { applyBanVisibility, canSeeBan, canSeeBanAuthor, seesAllBans } from './banVisibility';
import { isUnsafeBanId, startBanSafetyAudit, stopBanSafetyAudit } from './banSafetyAudit';
import { emitGlobal, emitToTenantAudience } from '../utils/socketRooms';
import { whitelistService, whereWhitelistApplies, whereTeamScopeAllows } from './whitelist.service';
import { liveAlertService, incidentStableKey } from './liveAlert.service';
import { banPolicyService } from './banPolicy.service';
import { agentConfigService } from './agentConfig.service';
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
export type BanLiftReason = 'lift' | 'wipe' | 'expiry' | 'external_withdraw' | 'remote_sync';

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
/** Targets per INSERT ... SELECT of createRemoteBans. */
const REMOTE_INSERT_CHUNK = 1000;
/** Rows per multi-row INSERT of the ban engine cycle (auto-bans, reputation rows). */
const AUTO_INSERT_CHUNK = 1000;

/** SQL: the effective prefix of ban row `a`. */
const prefixSql = (a: string) => `COALESCE(${a}.cidr_prefix, masklen(${a}.ip))`;
/** SQL: ban row `a` as a network (containment checks). */
const networkSql = (a: string) => `set_masklen(${a}.ip, ${prefixSql(a)})`;

/**
 * Restrict `q` to the rows (alias `a`) of exactly target `t`, whatever their
 * storage form: network address + cidr_prefix, or a legacy masked inet
 * (MikroTik import). Index-friendly (plain equality on ip).
 */
function whereSameTarget(q: Knex.QueryBuilder, a: string, t: Pick<ParsedCidr, 'address' | 'prefix'>): Knex.QueryBuilder {
  return q
    .whereRaw(`(${a}.ip = ?::inet OR ${a}.ip = ?::inet)`, [t.address, `${t.address}/${t.prefix}`])
    .whereRaw(`${prefixSql(a)} = ?`, [t.prefix]);
}

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

/** 'blocklist:<id>' → id (null for any other origin_ref). */
export function blocklistIdOfOriginRef(ref: string | null | undefined): number | null {
  const m = /^blocklist:([1-9][0-9]{0,9})$/.exec(ref ?? '');
  return m ? Number(m[1]) : null;
}

/** Disable the remote blocklist entries behind lifted 'remote' rows. Never throws. */
async function disableLiftedBlocklistEntries(rows: Array<Pick<BanRow, 'ban_type' | 'origin_ref' | 'ip' | 'cidr_prefix'>>): Promise<void> {
  for (const row of rows) {
    const listId = row.ban_type === 'remote' ? blocklistIdOfOriginRef(row.origin_ref) : null;
    if (listId == null) continue;
    await db('remote_blocked_ips')
      .where({ blocklist_id: listId, enabled: true })
      .whereRaw('ip = set_masklen(?::inet, COALESCE(?::int, masklen(?::inet)))', [String(row.ip), row.cidr_prefix, String(row.ip)])
      .update({ enabled: false })
      .catch((err) => logger.warn({ err, listId }, 'Remote blocklist entry disable after Lift failed'));
  }
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
  /** Source of a 'remote' ban: 'blocklist:<id>' or 'mikrotik:<deviceId>' (migration 037). */
  origin_ref?: string | null;
  banned_by_user_id: number | null;
  banned_at: Date;
  expires_at: Date | null;
  is_active: boolean;
  /** When the row was deactivated (migration 032). */
  lifted_at?: Date | null;
  /** Why the row was deactivated (BanLiftReason, migration 037). */
  lift_reason?: string | null;
}

/**
 * The origin_ref a caller may read: everything for the god view; a MikroTik
 * import names its router only to the router's tenant (the origin tenant).
 */
function visibleOriginRef(row: Pick<BanRow, 'origin_ref' | 'origin_tenant_id'>, godView: boolean, callerTenantId?: number): string | null {
  const ref = row.origin_ref ?? null;
  if (ref == null || godView || !ref.startsWith('mikrotik:')) return ref;
  return callerTenantId != null && row.origin_tenant_id === callerTenantId ? ref : 'mikrotik';
}

/** `godView`: the caller sees every tenant (seesAllBans), never the bare platform role. */
function rowToBan(row: BanRow, godView = false, callerTenantId?: number): IpBan {
  return {
    id: row.id,
    ip: row.ip,
    cidrPrefix: row.cidr_prefix,
    reason: row.reason,
    banType: row.ban_type as IpBan['banType'],
    scope: row.scope as BanScope,
    scopeId: row.scope_id,
    tenantId: row.tenant_id,
    // Only expose WHICH tenant the ban came from to the god view (Default; callers pass seesAllBans).
    originTenantId: godView ? row.origin_tenant_id : null,
    originTenantName: godView ? row.origin_tenant_name : undefined,
    // Safe for every tenant: "this ban is mine" without naming any other tenant.
    // Drives whether the UI offers Lift (global) or Exclude (local override).
    isOriginTenant:
      callerTenantId != null &&
      row.origin_tenant_id != null &&
      row.origin_tenant_id === callerTenantId,
    // The author is only shown to the owning/origin tenant, Default and platform admins.
    bannedByUserId: canSeeBanAuthor(row, callerTenantId, godView) ? row.banned_by_user_id : null,
    bannedAt: row.banned_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    isActive: row.is_active,
    originApp: row.origin_app ?? null,
    originRef: visibleOriginRef(row, godView, callerTenantId),
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

// ── Ban list (Bans tab) ──────────────────────────────────────────────────────

/** Lifecycle state of a ban row as the Bans tab shows it. */
export type BanListState = 'active' | 'expired' | 'lifted';

/**
 * SQL predicates (alias ip_bans) partitioning every row:
 *   - active:  enforced (is_active, not past its expiry);
 *   - expired: reached its expiry, whether the expiry job already
 *              deactivated it (lifted_at >= expires_at) or not yet;
 *   - lifted:  deactivated before its expiry (Lift, wipe, withdraw), or a
 *              legacy inactive row without lifted_at that has not expired.
 */
const BAN_EXPIRED_SQL = `(ip_bans.expires_at IS NOT NULL AND ip_bans.expires_at <= now()
  AND (ip_bans.is_active OR ip_bans.lifted_at IS NULL OR ip_bans.lifted_at >= ip_bans.expires_at))`;
export const BAN_STATE_SQL: Record<BanListState, string> = {
  active: '(ip_bans.is_active AND (ip_bans.expires_at IS NULL OR ip_bans.expires_at > now()))',
  expired: BAN_EXPIRED_SQL,
  lifted: `(NOT ip_bans.is_active AND NOT ${BAN_EXPIRED_SQL})`,
};

export type BanListSort = 'createdAt' | 'expiresAt' | 'ip';

export interface BanListOptions {
  tenantId: number;
  isAdmin: boolean;
  /** Default 'active'; 'all' = every state. */
  state?: BanListState | 'all';
  scope?: BanScope;
  /** ban_type: auto | manual | external | remote. */
  banType?: string;
  /** An address (exact), a CIDR (containment) or text (address or reason). */
  search?: string;
  /** God view only: rows owned by, or originating from, these tenants. */
  tenantIds?: number[];
  /** The caller's team agent scope (agentScope.scopeAgentIds); 'all' / undefined = no restriction. */
  visibleAgentIds?: number[] | 'all';
  /** The caller's team WRITE agent scope: group/agent rows outside it get liftAction null. */
  writableAgentIds?: number[] | 'all';
  sortBy?: BanListSort;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/** What a Lift from the caller tenant does to a row (see planLift). */
export type BanLiftAction = 'deactivate' | 'exclude';

/** A row of the Bans tab: the ban plus names instead of ids. */
export type IpBanListItem = IpBan & {
  isExcludedByTenant: boolean;
  state: BanListState;
  liftedAt: string | null;
  /** Author's username (only where the author is visible, see canSeeBanAuthor). */
  createdByUsername: string | null;
  /** Group name / agent display name / tenant name of a scoped ban. */
  scopeName: string | null;
  /** Name of the owning tenant (scoped bans; null for global bans). */
  tenantName: string | null;
  /** The Lift the caller tenant would perform; null when it cannot lift this row. */
  liftAction: BanLiftAction | null;
};

type BanListRow = BanRow & {
  is_excluded_by_tenant: boolean;
  state: BanListState;
  owner_tenant_name: string | null;
  author_username: string | null;
  scope_name: string | null;
};

type LiftPlan =
  | { kind: 'deactivate' | 'exclude'; action: BanLiftAction }
  | { kind: 'refuse'; status: 403 | 404 | 409; code: ErrorCode; message: string };

/**
 * The single Lift rule (one button in the UI), shared by Lift and bulk Lift:
 *   - Default tenant: authoritative deactivation, whatever the scope;
 *   - other tenant: a global ban becomes a per-tenant exclusion; its own
 *     tenant/group/agent ban is deactivated; another tenant's ban is refused
 *     (404 when not even visible).
 */
function planLift(ban: Pick<BanRow, 'scope' | 'tenant_id' | 'is_active'>, tenantId: number, isAdmin: boolean): LiftPlan {
  const inactive: LiftPlan = { kind: 'refuse', status: 409, code: 'BAN_INACTIVE', message: 'Ban is no longer active' };
  if (isMasterTenant(tenantId)) return ban.is_active ? { kind: 'deactivate', action: 'deactivate' } : inactive;
  if (!canSeeBan(ban, tenantId, isAdmin)) return { kind: 'refuse', status: 404, code: 'BAN_NOT_FOUND', message: 'Ban not found' };
  if (ban.scope === 'global') return ban.is_active ? { kind: 'exclude', action: 'exclude' } : inactive;
  if (ban.tenant_id !== tenantId) return { kind: 'refuse', status: 403, code: 'BAN_FOREIGN_TENANT', message: 'This ban belongs to another tenant' };
  return ban.is_active ? { kind: 'deactivate', action: 'deactivate' } : inactive;
}

/** Result of a bulk Lift: counts plus the first refusals. */
export interface BulkLiftResult {
  /** Rows deactivated. */
  lifted: number;
  /** Global bans lifted on the caller tenant only (new exclusions). */
  excluded: number;
  /** Already lifted / excluded / inactive rows (nothing to do). */
  skipped: number;
  /** Unknown, invisible or foreign rows. */
  refused: number;
  /** First refusals; `code` is the error catalogue code (utils/errorCodes.ts). */
  errors: Array<{ id: number; status: number; error: string; code: ErrorCode }>;
}

/**
 * Coded 400 for a refused ban target (parseBanTarget / checkBanTarget). The
 * widest bannable prefix and the family fill the "too broad" translation.
 */
function banTargetError(r: { code: BanTargetErrorCode; message: string }, raw: string, prefix = ''): AppError {
  const message = prefix + r.message;
  switch (r.code) {
    case 'too_broad': {
      const family = parseIpOrCidr(raw)?.family;
      if (family !== 4 && family !== 6) return codedError(400, 'BAN_TARGET_TOO_WIDE', message);
      const floors = banPrefixFloor();
      return codedError(400, 'BAN_TARGET_TOO_WIDE', message, { prefix: family === 4 ? floors.v4 : floors.v6, family });
    }
    case 'cidr_not_allowed':
      return codedError(400, 'BAN_TARGET_CIDR_NOT_ALLOWED', message);
    case 'reserved':
    case 'protected':
      return codedError(400, 'BAN_TARGET_RESERVED', message);
    default:
      return codedError(400, 'BAN_TARGET_INVALID', message);
  }
}

/** Bulk Lift: at most this many ids per request. */
export const BULK_LIFT_MAX = 1000;
const BULK_LIFT_DETAIL_MAX = 50;

/**
 * The ids (among `ids`) the caller's team agent scope lets it act on:
 * every global / tenant row, the group / agent rows of its granted agents
 * (whereTeamScopeAllows). 'all' / undefined = no team restriction.
 */
async function teamWritableBanIds(ids: number[], allowed: number[] | 'all' | undefined): Promise<Set<number>> {
  if (!allowed || allowed === 'all' || ids.length === 0) return new Set(ids);
  const kept = await db('ip_bans')
    .whereIn('ip_bans.id', ids)
    .where((b) => whereTeamScopeAllows(b, 'ip_bans', allowed))
    .pluck('ip_bans.id') as number[];
  return new Set(kept.map(Number));
}

// ── BanService ───────────────────────────────────────────────────────────────

class BanService {

  /**
   * Ban rows visible to the caller (the Bans tab), driven by ip_bans:
   *   - state: active | expired | lifted (a partition of every row, see
   *     BAN_STATE_SQL) or all;
   *   - visibility: the Default tenant sees every ban (W10-5: the platform
   *     role no longer widens it), other tenants global bans plus their own; a user restricted by team grants only
   *     sees the group/agent rows of the agents granted to them (RBAC-8);
   *   - god view (Default): `tenantIds` narrows to the rows owned by, or
   *     originating from, those tenants.
   * Rows carry names instead of ids (author, scope target, tenant), the
   * caller tenant's exclusion flag and the Lift the caller would perform.
   */
  async list(opts: BanListOptions): Promise<{ data: IpBanListItem[]; total: number }> {
    const { tenantId, isAdmin, state = 'active', search, limit = 50, offset = 0 } = opts;
    const godView = seesAllBans(tenantId, isAdmin);

    let base = applyBanVisibility(db('ip_bans'), tenantId, isAdmin, 'ip_bans');
    if (state !== 'all') base = base.whereRaw(BAN_STATE_SQL[state]);
    if (opts.scope) base = base.where('ip_bans.scope', opts.scope);
    if (opts.banType) base = base.where('ip_bans.ban_type', opts.banType);
    if (search) {
      const s = parseIpSearch(search);
      const ipSql = ipSearchSql('ip_bans.ip', s);
      if (s.kind === 'text') {
        base = base.where((b) => {
          b.whereRaw(ipSql.sql, ipSql.bindings).orWhereRaw('ip_bans.reason ILIKE ?', [s.pattern]);
        });
      } else {
        base = base.whereRaw(ipSql.sql, ipSql.bindings);
      }
    }
    if (godView && opts.tenantIds && opts.tenantIds.length > 0) {
      const ids = opts.tenantIds;
      base = base.where((b) => {
        b.whereIn('ip_bans.tenant_id', ids)
          .orWhere((g) => g.whereNull('ip_bans.tenant_id').whereIn('ip_bans.origin_tenant_id', ids));
      });
    }
    if (opts.visibleAgentIds && opts.visibleAgentIds !== 'all') {
      const allowed = opts.visibleAgentIds;
      base = base.where((b) => whereTeamScopeAllows(b, 'ip_bans', allowed));
    }

    const [{ count }] = await base.clone().count<Array<{ count: string }>>({ count: 'ip_bans.id' });

    const order = opts.sortOrder === 'asc' ? 'asc' : 'desc';
    const q = base
      .leftJoin('tenants as origin_tenant', 'ip_bans.origin_tenant_id', 'origin_tenant.id')
      .leftJoin('tenants as owner_tenant', 'ip_bans.tenant_id', 'owner_tenant.id')
      .leftJoin('users as author', 'ip_bans.banned_by_user_id', 'author.id')
      .leftJoin('monitor_groups as sg', function () {
        this.on('sg.id', '=', 'ip_bans.scope_id').andOnVal('ip_bans.scope', '=', 'group');
      })
      .leftJoin('agent_devices as sd', function () {
        this.on('sd.id', '=', 'ip_bans.scope_id').andOnVal('ip_bans.scope', '=', 'agent');
      })
      .leftJoin('ip_ban_exclusions as ex', function () {
        this.on('ex.ban_id', '=', 'ip_bans.id').andOnVal('ex.tenant_id', '=', tenantId);
      })
      .select(
        'ip_bans.*',
        'origin_tenant.name as origin_tenant_name',
        'owner_tenant.name as owner_tenant_name',
        'author.username as author_username',
        db.raw(`CASE ip_bans.scope
                  WHEN 'group' THEN sg.name
                  WHEN 'agent' THEN COALESCE(NULLIF(sd.name, ''), sd.hostname)
                  WHEN 'tenant' THEN owner_tenant.name
                END AS scope_name`),
        db.raw('ex.id IS NOT NULL AS is_excluded_by_tenant'),
        db.raw(`CASE WHEN ${BAN_STATE_SQL.active} THEN 'active'
                     WHEN ${BAN_STATE_SQL.expired} THEN 'expired'
                     ELSE 'lifted' END AS state`),
      );
    switch (opts.sortBy) {
      case 'ip':
        q.orderBy('ip_bans.ip', order);
        break;
      case 'expiresAt':
        // Permanent bans last whatever the direction.
        q.orderByRaw(`ip_bans.expires_at ${order} NULLS LAST`);
        break;
      default:
        q.orderBy('ip_bans.banned_at', order);
    }
    const rows = await q.orderBy('ip_bans.id', order).limit(limit).offset(offset) as BanListRow[];
    const writable = await teamWritableBanIds(rows.map((r) => Number(r.id)), opts.writableAgentIds);

    return {
      data: rows.map((r) => {
        const showAuthor = canSeeBanAuthor(r, tenantId, isAdmin);
        const plan = writable.has(Number(r.id))
          ? planLift(r, tenantId, isAdmin)
          : { kind: 'refuse' as const };
        return {
          // God view (Default or platform admin) sees the origin tenant.
          ...rowToBan(r, godView, tenantId),
          isExcludedByTenant: r.is_excluded_by_tenant ?? false,
          state: r.state,
          liftedAt: r.lifted_at ? new Date(r.lifted_at).toISOString() : null,
          createdByUsername: showAuthor ? r.author_username ?? null : null,
          scopeName: r.scope_name ?? null,
          tenantName: r.owner_tenant_name ?? null,
          // Only an enforced ban can be lifted (expired rows wait for the expiry job).
          liftAction: r.state === 'active' && plan.kind !== 'refuse' ? plan.action : null,
        };
      }),
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
      throw codedError(403, 'TENANT_MEMBERSHIP_REQUIRED', 'You are not a member of this tenant');
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
    if (typeof rawIp !== 'string') throw codedError(400, 'BAN_IP_REQUIRED', 'ip is required');
    const rawPrefix: unknown = (data as { cidrPrefix?: unknown }).cidrPrefix;
    let raw: string = rawIp;
    if (rawPrefix != null && rawPrefix !== '') {
      const n = Number(rawPrefix);
      if (!Number.isInteger(n)) throw codedError(400, 'BAN_CIDR_PREFIX_INVALID', 'Invalid CIDR prefix');
      if (rawIp.includes('/')) throw codedError(400, 'BAN_CIDR_PREFIX_TWICE', 'Give the prefix either in ip or in cidrPrefix, not both');
      raw = `${rawIp.trim()}/${n}`;
    }
    const r = parseBanTarget(raw, { allowCidr: true });
    if (!r.ok) throw banTargetError(r, raw);
    const t: BanTarget = r.target;

    // 2) Scope
    const requested = (data as { scope?: unknown }).scope ?? null;
    if (requested !== null && !(BAN_SCOPES as readonly unknown[]).includes(requested)) {
      throw codedError(400, 'BAN_SCOPE_INVALID', 'Invalid scope');
    }
    const derived: BanScope = isMasterTenant(tenantId) ? 'global' : 'tenant';
    let scope: BanScope;
    let scopeId: number | null = null;
    let rowTenantId: number | null;
    if (requested === 'group' || requested === 'agent') {
      const sid = Number((data as { scopeId?: unknown }).scopeId);
      if (!Number.isInteger(sid) || sid <= 0) throw codedError(400, 'SCOPE_ID_REQUIRED', 'scopeId is required for group/agent scope');
      const owner = await (requested === 'agent' ? db('agent_devices') : db('monitor_groups'))
        .where({ id: sid }).first('tenant_id') as { tenant_id: number | null } | undefined;
      // No admin / Default bypass: the god view is read-only for writes.
      if (!owner || Number(owner.tenant_id) !== tenantId) {
        throw requested === 'agent'
          ? codedError(404, 'AGENT_NOT_FOUND', 'Agent not found')
          : codedError(404, 'GROUP_NOT_FOUND', 'Group not found');
      }
      scope = requested;
      scopeId = sid;
      rowTenantId = tenantId;
    } else if (requested === 'global' && derived === 'tenant') {
      throw codedError(403, 'BAN_GLOBAL_DEFAULT_TENANT_ONLY', 'Global bans can only be created from the Default tenant');
    } else if (requested === 'tenant' && derived === 'global') {
      throw codedError(400, 'BAN_DEFAULT_TENANT_SCOPE', 'Bans created from the Default tenant are global: omit the scope, or use a group or agent scope');
    } else {
      scope = derived;
      rowTenantId = derived === 'global' ? null : tenantId;
    }

    // 3) Non-public ranges, interfaces and every tenant's infra addresses for
    //    a global ban; a scoped ban checks its own tenant's agents and routers
    await ensureInfraFresh();
    if (await findBanSafetyConflict(t, { global: scope === 'global', tenantId: rowTenantId })) {
      throw codedError(400, 'BAN_TARGET_RESERVED', RESERVED_OR_PROTECTED_MESSAGE);
    }

    // 4) Expiry and reason
    let expiresAt: Date | null = null;
    const rawExpires: unknown = (data as { expiresAt?: unknown }).expiresAt;
    if (rawExpires != null && rawExpires !== '') {
      const d = new Date(String(rawExpires));
      if (isNaN(d.getTime())) throw codedError(400, 'BAN_EXPIRES_AT_INVALID', 'Invalid expiresAt');
      if (d.getTime() <= Date.now()) throw codedError(400, 'BAN_EXPIRES_AT_PAST', 'expiresAt must be in the future');
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
        throw codedError(409, 'IP_WHITELISTED', 'This IP is whitelisted');
      }

      // Duplicate: only active global rows and the caller's own scope (no
      // oracle on other tenants' local bans).
      const dup = await whereSameTarget(trx('ip_bans'), 'ip_bans', t)
        .where('is_active', true)
        .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', trx.fn.now()))
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
          if (excluded) throw codedError(409, 'BAN_LIFTED_FOR_TENANT', 'This IP is banned globally but lifted on your tenant: use Re-enable instead');
          throw codedError(409, 'IP_ALREADY_BANNED_GLOBALLY', 'This IP is already banned globally');
        }
        throw codedError(409, 'IP_ALREADY_BANNED', 'This IP is already banned');
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
        if (isUniqueViolation(err)) throw codedError(409, 'IP_ALREADY_BANNED', 'This IP is already banned');
        throw err;
      }
    });

    emitBanRow(SOCKET_EVENTS.BAN_CREATED, row);

    // Push ban to MikroTik devices (fire-and-forget): only the tenant's routers
    // for a tenant/group/agent ban.
    if (!opts.deferMikrotik) pushMikrotik(deliveredBanTarget(row), 'ban', mikrotikAudienceOf(row));

    // Origin attribution follows the god view (Default only, W10-5), not the platform role.
    return rowToBan(row, seesAllBans(tenantId), tenantId);
  }

  /**
   * Promote a tenant/group/agent ban to global. The authority action of the
   * Default tenant (like the global Lift): Default only, for any Default
   * member holding 'bans' — platform admins included, never from elsewhere.
   * The address is rewritten in canonical form; the reason is kept (it becomes
   * visible to every tenant).
   */
  async promoteToGlobal(banId: number, tenantId: number, userId: number, isAdmin: boolean): Promise<IpBan> {
    if (!isMasterTenant(tenantId)) throw codedError(403, 'BAN_PROMOTE_DEFAULT_TENANT_ONLY', 'Promote to global is only available from the Default tenant');
    await this.assertOperatingMembership(userId, tenantId, isAdmin);

    const ban = await db('ip_bans').where('id', banId).first() as BanRow | undefined;
    if (!ban) throw codedError(404, 'BAN_NOT_FOUND', 'Ban not found');
    if (!ban.is_active || (ban.expires_at && new Date(ban.expires_at).getTime() <= Date.now())) {
      throw codedError(409, 'BAN_INACTIVE', 'Ban is no longer active');
    }
    if (ban.scope === 'global') throw codedError(409, 'BAN_ALREADY_GLOBAL', 'Ban is already global');

    const r = parseBanTarget(banTargetRawFromRow(String(ban.ip), ban.cidr_prefix), { allowCidr: true });
    if (!r.ok) throw banTargetError(r, banTargetRawFromRow(String(ban.ip), ban.cidr_prefix), 'Cannot promote this ban: ');
    const t = r.target;
    await ensureInfraFresh();
    if (await findBanSafetyConflict(t, { global: true })) {
      throw codedError(400, 'BAN_TARGET_RESERVED', RESERVED_OR_PROTECTED_MESSAGE);
    }
    await this.expireStale(t);

    const row = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`ip_bans:${t.cidr}`]);
      if (await whitelistService.isWhitelisted(t.cidr, {}, { mode: 'overlaps', trx })) {
        throw codedError(409, 'IP_WHITELISTED', 'This IP is whitelisted');
      }
      const dup = await whereSameTarget(trx('ip_bans'), 'ip_bans', t)
        .where('is_active', true)
        .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', trx.fn.now()))
        .where('scope', 'global')
        .first('id');
      if (dup) throw codedError(409, 'IP_ALREADY_BANNED_GLOBALLY', 'This IP is already banned globally');
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
        if (isUniqueViolation(err)) throw codedError(409, 'IP_ALREADY_BANNED_GLOBALLY', 'This IP is already banned globally');
        throw err;
      }
      if (!updated) throw codedError(409, 'BAN_INACTIVE', 'Ban is no longer active');
      return updated;
    });

    emitBanRow(SOCKET_EVENTS.BAN_UPDATED, row);

    // A global ban reaches every router not excluded from it (fire-and-forget).
    pushMikrotik(deliveredBanTarget(row), 'ban', mikrotikAudienceOf(row));

    // Origin attribution follows the god view (Default only, W10-5), not the platform role.
    return rowToBan(row, seesAllBans(tenantId), tenantId);
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
  async lift(
    banId: number,
    tenantId: number,
    userId: number,
    isAdmin = false,
    opts: { writableAgentIds?: number[] | 'all' } = {},
  ): Promise<void> {
    await this.assertOperatingMembership(userId, tenantId, isAdmin);
    const ban = await db('ip_bans').where('id', banId).first() as BanRow | undefined;
    if (!ban) throw codedError(404, 'BAN_NOT_FOUND', 'Ban not found');
    // Team scope (RBAC-8): a group/agent ban outside the caller's writable agents does not exist for it.
    if (!(await teamWritableBanIds([Number(ban.id)], opts.writableAgentIds)).has(Number(ban.id))) {
      throw codedError(404, 'BAN_NOT_FOUND', 'Ban not found');
    }

    // planLift: Default = authoritative deactivation; elsewhere a global ban
    // becomes a local exclusion, the tenant's own scoped ban is deactivated
    // (it was only ever enforced there) and another tenant's ban is refused.
    const plan = planLift(ban, tenantId, isAdmin);
    if (plan.kind === 'refuse') throw codedError(plan.status, plan.code, plan.message);

    if (plan.kind === 'exclude') {
      // Neutralise locally via a per-tenant exclusion; other tenants keep it.
      await db('ip_ban_exclusions')
        .insert({ ban_id: banId, tenant_id: tenantId, created_by: userId })
        .onConflict(['ban_id', 'tenant_id'])
        .ignore();
      emitToTenantAudience(_io, tenantId, SOCKET_EVENTS.BAN_EXCLUDED, { banId, tenantId });
      // Only the excluding tenant's routers drop it.
      pushMikrotik(deliveredBanTarget(ban), 'unban', { tenantId });
      return;
    }

    // Deactivation stamps lifted_at: the BanEngine ignores the failures that
    // led to this ban, so the Lift is not undone by the next cycle.
    const lifted = await this.deactivateBans([banId], 'lift', { userId, tenantId });
    if (lifted.length === 0) throw codedError(409, 'BAN_INACTIVE', 'Ban is no longer active');
  }

  /**
   * Lift several bans at once (Bans tab bulk action), row by row with the
   * same rule as lift() (planLift): from Default every active row is
   * deactivated; from another tenant global bans get a per-tenant exclusion
   * and the tenant's own scoped bans are deactivated. Deactivations go
   * through one deactivateBans call (one ban:bulkLifted / one MikroTik
   * reconciliation for mass lifts). Refused rows never abort the batch.
   */
  async bulkLift(
    ids: number[],
    tenantId: number,
    userId: number,
    isAdmin = false,
    opts: { writableAgentIds?: number[] | 'all' } = {},
  ): Promise<BulkLiftResult> {
    await this.assertOperatingMembership(userId, tenantId, isAdmin);
    const unique = [...new Set(ids)];
    const result: BulkLiftResult = { lifted: 0, excluded: 0, skipped: 0, refused: 0, errors: [] };
    const refuse = (id: number, status: number, error: string, code: ErrorCode) => {
      if (status === 409) result.skipped++;
      else result.refused++;
      if (result.errors.length < BULK_LIFT_DETAIL_MAX) result.errors.push({ id, status, error, code });
    };

    const rows = await db('ip_bans').whereIn('id', unique) as BanRow[];
    // Team scope (RBAC-8): rows outside the caller's writable agents count as not found.
    const writable = await teamWritableBanIds(rows.map((r) => Number(r.id)), opts.writableAgentIds);
    const byId = new Map(rows.filter((r) => writable.has(Number(r.id))).map((r) => [Number(r.id), r]));
    const toDeactivate: number[] = [];
    const toExclude: BanRow[] = [];
    for (const id of unique) {
      const ban = byId.get(id);
      if (!ban) { refuse(id, 404, 'Ban not found', 'BAN_NOT_FOUND'); continue; }
      const plan = planLift(ban, tenantId, isAdmin);
      if (plan.kind === 'refuse') refuse(id, plan.status, plan.message, plan.code);
      else if (plan.kind === 'exclude') toExclude.push(ban);
      else toDeactivate.push(id);
    }

    if (toExclude.length > 0) {
      const inserted = await db('ip_ban_exclusions')
        .insert(toExclude.map((b) => ({ ban_id: b.id, tenant_id: tenantId, created_by: userId > 0 ? userId : null })))
        .onConflict(['ban_id', 'tenant_id'])
        .ignore()
        .returning('ban_id') as Array<{ ban_id: number }>;
      const fresh = new Set(inserted.map((r) => Number(r.ban_id)));
      const excluded = toExclude.filter((b) => fresh.has(Number(b.id)));
      for (const b of toExclude) {
        if (!fresh.has(Number(b.id))) refuse(b.id, 409, 'Already lifted on this tenant', 'BAN_ALREADY_LIFTED_FOR_TENANT');
      }
      result.excluded = excluded.length;
      for (const b of excluded) emitToTenantAudience(_io, tenantId, SOCKET_EVENTS.BAN_EXCLUDED, { banId: b.id, tenantId });
      // Only the excluding tenant's routers drop them.
      if (excluded.length <= LIFT_MIKROTIK_MAX_ROWS) {
        for (const b of excluded) pushMikrotik(deliveredBanTarget(b), 'unban', { tenantId });
      } else if (excluded.length > 0) {
        reconcileMikrotik();
      }
    }

    if (toDeactivate.length > 0) {
      const done = await this.deactivateBans(toDeactivate, 'lift', { userId, tenantId });
      result.lifted = done.length;
      // Deactivated concurrently (another Lift, the expiry job).
      const doneIds = new Set(done.map((r) => Number(r.id)));
      for (const id of toDeactivate) {
        if (!doneIds.has(id)) refuse(id, 409, 'Ban is no longer active', 'BAN_INACTIVE');
      }
    }
    return result;
  }

  /**
   * Create a per-tenant exclusion for a global ban.
   * The ban stays active globally; agents of this tenant will not enforce it.
   */
  async excludeForTenant(banId: number, tenantId: number, userId: number, isAdmin = false): Promise<void> {
    await this.assertOperatingMembership(userId, tenantId, isAdmin);
    const ban = await db('ip_bans').where('id', banId).first() as BanRow | undefined;
    if (!ban || !canSeeBan(ban, tenantId, isAdmin)) throw codedError(404, 'BAN_NOT_FOUND', 'Ban not found');
    if (ban.scope !== 'global') throw codedError(400, 'BAN_EXCLUDE_GLOBAL_ONLY', 'Only global bans can be excluded per-tenant');
    if (!ban.is_active) throw codedError(409, 'BAN_INACTIVE', 'Ban is no longer active');

    // Insert — ignore duplicate (already excluded)
    await db('ip_ban_exclusions')
      .insert({ ban_id: banId, tenant_id: tenantId, created_by: userId })
      .onConflict(['ban_id', 'tenant_id'])
      .ignore();

    emitToTenantAudience(_io, tenantId, SOCKET_EVENTS.BAN_EXCLUDED, { banId, tenantId });
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
    if (!deleted) throw codedError(404, 'BAN_EXCLUSION_NOT_FOUND', 'No exclusion found for this ban and tenant');
    emitToTenantAudience(_io, tenantId, SOCKET_EVENTS.BAN_EXCLUSION_REMOVED, { banId, tenantId });
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
        .update({ is_active: false, lifted_at: db.fn.now(), lift_reason: reason })
        .returning('*') as BanRow[];
      rows.push(...done);
    }
    if (rows.length === 0) return rows;

    // An operator Lift of a ban imported from a remote blocklist disables the
    // list entry, so the next sync does not bring the ban back.
    if (reason === 'lift') await disableLiftedBlocklistEntries(rows);

    logger.info(
      { reason, actor, count: rows.length, ids: rows.slice(0, 20).map((r) => r.id) },
      'Bans deactivated',
    );

    if (rows.length <= LIFT_EVENT_MAX_ROWS) {
      for (const row of rows) emitBanEvent(SOCKET_EVENTS.BAN_LIFTED, row, { id: row.id, reason });
    } else {
      // Counts only: no row detail reaches a tenant that could not see it.
      emitGlobal(_io, SOCKET_EVENTS.BAN_BULK_LIFTED, { count: rows.length, reason });
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
    const ids = await whereSameTarget(db('ip_bans'), 'ip_bans', t)
      .where('is_active', true)
      .whereNotNull('expires_at')
      .where('expires_at', '<=', db.fn.now())
      .pluck('id') as number[];
    if (ids.length > 0) await this.deactivateBans(ids, 'expiry');
  }

  /**
   * Withdraw the active external bans `sourceApp` pushed for `ip`
   * (DELETE /api/external-bans/:ip). Returns the number of rows lifted.
   */
  async withdrawExternal(ip: string, sourceApp: string): Promise<number> {
    const p = parseIpOrCidr(ip);
    if (!p || p.prefix !== fullPrefix(p)) throw codedError(400, 'BAN_SINGLE_IP_REQUIRED', 'ip required (single IPv4/IPv6 address)');
    const ids = await db('ip_bans')
      .whereRaw('ip = ?::inet', [p.address])
      .where({ ban_type: 'external', origin_app: sourceApp, is_active: true })
      .pluck('id') as number[];
    return (await this.deactivateBans(ids, 'external_withdraw', { app: sourceApp })).length;
  }

  /**
   * Create the global 'remote' bans of imported targets (remote blocklist
   * sync, MikroTik address-list import) with one INSERT ... SELECT per chunk.
   * A target is skipped when:
   *   - an active global ban already covers it (same target or a containing
   *     subnet, whatever its type);
   *   - a whitelist entry applying to `whitelist` contains it (>>=; global
   *     entries always apply);
   *   - `respectLifts`: an operator lifted a ban of the same source and
   *     target (the source would otherwise bring it back on every import).
   * Targets must already have passed checkBanTarget. A concurrent insert of
   * the same key is absorbed by the unique index of migration 032 (ON
   * CONFLICT DO NOTHING). Created rows are announced like any ban (ban:created
   * up to LIFT_EVENT_MAX_ROWS rows; MikroTik push up to LIFT_MIKROTIK_MAX_ROWS
   * rows, else one reconciliation).
   * Returns the number of rows created.
   */
  async createRemoteBans(
    targets: ReadonlyArray<Pick<BanTarget, 'address' | 'prefix' | 'isNetwork'> & { reason?: string }>,
    o: {
      originRef: string;
      originTenantId: number | null;
      /** Reason of the targets without their own. */
      reason: string;
      whitelist?: WhitelistMatchContext;
      respectLifts?: boolean;
    },
  ): Promise<number> {
    if (targets.length === 0) return 0;
    const reason = o.reason.slice(0, 500);
    const created: BanRow[] = [];
    for (let i = 0; i < targets.length; i += REMOTE_INSERT_CHUNK) {
      const chunk = targets.slice(i, i + REMOTE_INSERT_CHUNK);
      const target = 'set_masklen(t.addr::inet, t.plen)';
      const sel = db
        .select(
          db.raw('t.addr::inet'),
          db.raw('t.cidr'),
          db.raw("'global'"),
          db.raw("'remote'"),
          db.raw('?::varchar', [o.originRef]),
          db.raw('?::int', [o.originTenantId]),
          db.raw('COALESCE(t.reason, ?::text)', [reason]),
          db.raw('true'),
        )
        .from(db.raw('unnest(?::text[], ?::int[], ?::int[], ?::text[]) AS t(addr, plen, cidr, reason)', [
          chunk.map((t) => t.address),
          chunk.map((t) => t.prefix),
          chunk.map((t) => (t.isNetwork ? t.prefix : null)),
          chunk.map((t) => (t.reason ? t.reason.slice(0, 500) : null)),
        // Array bindings (unnest): typed as RawBinding so knex > 3.1.0 still compiles.
        ] as unknown as Knex.RawBinding[]))
        .whereNotExists(
          db('ip_bans as b').select(db.raw('1'))
            .where('b.is_active', true)
            .where('b.scope', 'global')
            .whereRaw(`${networkSql('b')} >>= ${target}`),
        )
        .whereNotExists(
          db('ip_whitelist as w').select(db.raw('1'))
            .whereRaw(`w.ip >>= ${target}`)
            .where((wb) => whereWhitelistApplies(wb, 'w', o.whitelist ?? {})),
        );
      if (o.respectLifts) {
        sel.whereNotExists(
          db('ip_bans as l').select(db.raw('1'))
            .where('l.origin_ref', o.originRef)
            .where('l.is_active', false)
            .where('l.lift_reason', 'lift')
            .whereRaw(`${networkSql('l')} = ${target}`),
        );
      }
      const { sql, bindings } = sel.toSQL();
      const res = await db.raw(
        `INSERT INTO ip_bans (ip, cidr_prefix, scope, ban_type, origin_ref, origin_tenant_id, reason, is_active)
         ${sql}
         ON CONFLICT DO NOTHING
         RETURNING *`,
        bindings as Knex.RawBinding[],
      ) as { rows: BanRow[] };
      created.push(...res.rows);
    }
    if (created.length === 0) return 0;

    logger.info({ originRef: o.originRef, count: created.length }, 'Remote bans created');
    // A mass import (first sync of a big list) is not announced row by row:
    // the lists pick it up on their next refresh.
    if (created.length <= LIFT_EVENT_MAX_ROWS) {
      for (const row of created) emitBanRow(SOCKET_EVENTS.BAN_CREATED, row);
    }
    if (created.length <= LIFT_MIKROTIK_MAX_ROWS) {
      for (const row of created) pushMikrotik(deliveredBanTarget(row), 'ban', undefined);
    } else {
      reconcileMikrotik();
    }
    return created.length;
  }

  /**
   * Deactivate every active 'remote' ban of a source (`originRef`) as
   * 'remote_sync' (no lift watermark): the list stopped enforcing or was
   * deleted. Returns the number of rows deactivated.
   */
  async deactivateRemoteBans(originRef: string): Promise<number> {
    const ids = await db('ip_bans')
      .where({ origin_ref: originRef, ban_type: 'remote', is_active: true })
      .pluck('id') as number[];
    return (await this.deactivateBans(ids, 'remote_sync')).length;
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
        // Group/agent rows also carry the owning tenant: a row whose tenant
        // does not match the device's never applies (defence in depth).
        if (groupIds.length > 0) {
          q.orWhere((s) => s.where('b.scope', 'group').whereIn('b.scope_id', groupIds).where('b.tenant_id', tenantId));
        }
        q.orWhere((s) => s.where('b.scope', 'agent').where('b.scope_id', deviceId).where('b.tenant_id', tenantId));
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
    if (!chk.ok) throw banTargetError(chk, args.ip);
    const ip = chk.target.address;
    if (await whitelistService.isWhitelisted(ip, {})) throw codedError(409, 'IP_WHITELISTED', 'This IP is whitelisted');
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
      emitBanRow(SOCKET_EVENTS.BAN_CREATED, result.row);
      // Sync downstream (MikroTik + remote blocklists) — same fire-and-forget as manual bans.
      pushMikrotik(deliveredBanTarget(result.row), 'ban', mikrotikAudienceOf(result.row));
    } else if (result.changed) {
      emitBanRow(SOCKET_EVENTS.BAN_UPDATED, result.row);
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

/** Auto-bans of one tenant in one cycle that raise a 'ban_burst' live alert (owner decision). */
export const AUTO_BAN_BURST_THRESHOLD = 10;

/** A burst incident with no new burst for this long is resolved (it never "recovers" by itself). */
const BAN_BURST_QUIET_MS = 24 * 60 * 60 * 1000;

/** Interval between two passes that resolve quiet burst incidents. */
const BAN_BURST_SWEEP_MS = 10 * 60 * 1000;

/** Stable key of a tenant's burst incident for the UTC hour of `at` (one alert per tenant per hour). */
export function banBurstKey(tenantId: number, at = new Date()): string {
  return incidentStableKey('ban_burst', `tenant:${tenantId}:${at.toISOString().slice(0, 13)}`);
}

/** One threshold hit of a cycle: an address over a template's threshold on one agent. */
interface AutoBanCandidate {
  ip: string;
  /** Tenant of the events (the ban's origin tenant). */
  tenantId: number;
  service: string;
  failureCount: number;
}

/** A global auto-ban inserted by the cycle. */
interface CreatedAutoBan extends AutoBanCandidate {
  id: number;
  /** Duration from the ban policy (null = permanent). */
  ttlSeconds: number | null;
}

class BanEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastBurstSweepAt = 0;

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
    // the cycle's queries slow), skip this tick instead of stacking overlapping runs
    // that pile onto the connection pool and spiral into a hang.
    if (this.running) {
      logger.warn('BanEngine: previous cycle still running — skipping this tick');
      return;
    }
    this.running = true;
    try {
      // Approved agents' and routers' public addresses are never auto-banned.
      await ensureInfraFresh();
      const created = await this.evaluateThresholds();
      await this.reportBursts(created);
    } catch (err) {
      logger.error(err, 'BanEngine run failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * Live alert of the cycle (owner decision): a tenant whose agents caused at
   * least AUTO_BAN_BURST_THRESHOLD auto-bans raises a 'ban_burst' incident,
   * one per tenant per UTC hour (a later burst in the same hour bumps it).
   * Bursts quiet for 24 h are resolved. Never throws.
   */
  async reportBursts(created: Map<number, number>, now = new Date()): Promise<void> {
    for (const [tenantId, count] of created) {
      if (count < AUTO_BAN_BURST_THRESHOLD) continue;
      try {
        await liveAlertService.raiseIncident({
          tenantId,
          kind: 'ban_burst',
          stableKey: banBurstKey(tenantId, now),
          severity: 'warning',
          title: `Attack wave: ${count} addresses auto-banned`,
          message: `${count} addresses attacking this tenant's agents were banned in one evaluation cycle.`,
          link: '/ip-reputation?status=banned',
        });
        logger.warn({ tenantId, count }, 'BanEngine: auto-ban burst');
      } catch (err) {
        logger.warn({ err, tenantId }, 'BanEngine: burst alert failed');
      }
    }

    if (now.getTime() - this.lastBurstSweepAt < BAN_BURST_SWEEP_MS) return;
    this.lastBurstSweepAt = now.getTime();
    try {
      const quiet = await db('live_alerts')
        .where('incident_kind', 'ban_burst')
        .whereNull('resolved_at')
        .where('updated_at', '<', new Date(now.getTime() - BAN_BURST_QUIET_MS))
        .select('tenant_id', 'stable_key') as Array<{ tenant_id: number; stable_key: string }>;
      for (const q of quiet) {
        await liveAlertService.resolveIncidents({ tenantId: q.tenant_id, stableKey: q.stable_key });
      }
    } catch (err) {
      logger.warn({ err }, 'BanEngine: resolving quiet burst alerts failed');
    }
  }

  /**
   * For each approved agent, resolve its active service templates (opt-in model),
   * then count auth_failure events in each configured window.
   * If count >= threshold AND ip is not whitelisted, create a global ban.
   *
   * Lift watermark: only failures NEWER than the address's latest global
   * deactivation (lifted_at: Lift, wipe, expiry, external withdraw) count, so
   * a Lift is not undone by the failures that caused the ban. A remote ban
   * dropped by its source ('remote_sync') is not an operator decision and
   * sets no watermark: the local failures still count.
   *
   * Templates are opt-in: they must be explicitly enabled at group or agent level
   * (enabled_override = true) to count toward auto-bans.
   *
   * Cost (W11-3): a constant number of queries per cycle — devices,
   * evaluate-only groups, one ancestry query, the batched template resolver,
   * then one grouped aggregate per distinct (service, window, threshold) —
   * whatever the number of agents. Thresholds still count per agent.
   *
   * Returns the number of auto-bans created per origin tenant.
   */
  private async evaluateThresholds(): Promise<Map<number, number>> {
    // Fetch all approved agents
    const devices = await db('agent_devices')
      .where({ status: 'approved' })
      .select('id', 'group_id', 'tenant_id', 'evaluate_only') as Array<{ id: number; group_id: number | null; tenant_id: number; evaluate_only: boolean }>;

    if (devices.length === 0) return new Map();

    // Groups flagged evaluate-only (dry-run). A device inherits the flag if any
    // of its ancestor groups is in this set — such devices never auto-ban.
    const evalOnlyGroups = new Set(
      await db('monitor_groups').where('evaluate_only', true).pluck('id') as number[],
    );

    // Group ancestries of every device group in one query (closest first)
    const ancestryOf = new Map<number, number[]>();
    const directGroupIds = [...new Set(devices.map((d) => d.group_id).filter((g): g is number => g != null))];
    if (directGroupIds.length > 0) {
      const rows = await db('group_closure')
        .whereRaw('descendant_id = ANY(?::int[])', [directGroupIds])
        .select('descendant_id', 'ancestor_id')
        .orderBy([{ column: 'descendant_id' }, { column: 'depth', order: 'asc' }]) as Array<{ descendant_id: number; ancestor_id: number }>;
      for (const r of rows) {
        const list = ancestryOf.get(r.descendant_id);
        if (list) list.push(r.ancestor_id); else ancestryOf.set(r.descendant_id, [r.ancestor_id]);
      }
    }

    // Evaluate-only (dry-run): observe events but never create auto-bans for
    // a device (own flag or inherited from an ancestor group).
    const observed = devices
      .map((dev) => ({ dev, groupIds: dev.group_id ? ancestryOf.get(dev.group_id) ?? [] : [] }))
      .filter(({ dev, groupIds }) => !dev.evaluate_only && !groupIds.some((g) => evalOnlyGroups.has(g)));
    if (observed.length === 0) return new Map();

    // autoBanEnabled (settings cascade, W13): a device whose resolved value is
    // off keeps reporting and counting events but never triggers an auto-ban.
    // A resolver failure keeps the engine running (fail-open, as before W13).
    let autoBanOff = new Set<number>();
    try {
      autoBanOff = await agentConfigService.autoBanDisabledIds(observed.map(({ dev }) => ({
        id: dev.id, tenantId: dev.tenant_id, groupId: dev.group_id, evaluateOnly: dev.evaluate_only,
      })));
    } catch (err) {
      logger.warn({ err }, 'BanEngine: failed to resolve autoBanEnabled');
    }
    const evaluated = observed.filter(({ dev }) => !autoBanOff.has(dev.id));
    if (evaluated.length === 0) return new Map();

    let resolvedByDevice: Map<number, ResolvedServiceConfig[]>;
    try {
      resolvedByDevice = await serviceTemplateService.resolveForAgents(
        evaluated.map(({ dev, groupIds }) => ({ deviceId: dev.id, groupIds })),
      );
    } catch (err) {
      logger.warn({ err }, 'BanEngine: failed to resolve templates');
      return new Map();
    }

    // Only enabled ban-mode templates count. Devices sharing a (service,
    // window, threshold) triple share one aggregate query.
    const windowKey = (cfg: Pick<ResolvedServiceConfig, 'serviceType' | 'windowSeconds' | 'threshold'>) =>
      `${cfg.serviceType}\u0000${cfg.windowSeconds}\u0000${cfg.threshold}`;
    const plan = evaluated.map(({ dev }) => ({
      dev,
      templates: (resolvedByDevice.get(dev.id) ?? []).filter((cfg) => cfg.enabled && cfg.mode === 'ban'),
    }));
    const windows = new Map<string, { serviceType: string; windowSeconds: number; threshold: number; deviceIds: Set<number> }>();
    for (const { dev, templates } of plan) {
      for (const cfg of templates) {
        const key = windowKey(cfg);
        let w = windows.get(key);
        if (!w) {
          w = { serviceType: cfg.serviceType, windowSeconds: cfg.windowSeconds, threshold: cfg.threshold, deviceIds: new Set() };
          windows.set(key, w);
        }
        w.deviceIds.add(dev.id);
      }
    }

    // One grouped aggregate per template window: addresses over the
    // threshold, per agent (key|deviceId → rows).
    const now = Date.now();
    const hits = new Map<string, Array<{ ip: string; tenant_id: number; failure_count: string }>>();
    for (const [key, w] of windows) {
      const rows = await db('ip_events')
        .select('device_id', 'ip', 'tenant_id')
        .count('id as failure_count')
        .whereRaw('device_id = ANY(?::int[])', [[...w.deviceIds]])
        .where('service', w.serviceType)
        .where('event_type', 'auth_failure')
        .where('track_only', false)
        .where('timestamp', '>=', new Date(now - w.windowSeconds * 1000))
        .whereRaw(`ip_events.timestamp > COALESCE((
          SELECT max(lb.lifted_at) FROM ip_bans lb
           WHERE lb.ip = ip_events.ip AND lb.scope = 'global' AND lb.lifted_at IS NOT NULL
             AND lb.lift_reason IS DISTINCT FROM 'remote_sync'
        ), '-infinity'::timestamptz)`)
        .groupBy('device_id', 'ip', 'tenant_id')
        .havingRaw('count(id) >= ?', [w.threshold])
        .orderBy(['device_id', 'ip']) as Array<{
          device_id: number;
          ip: string;
          tenant_id: number;
          failure_count: string;
        }>;
      for (const r of rows) {
        const k = `${key}|${r.device_id}`;
        const list = hits.get(k);
        if (list) list.push(r); else hits.set(k, [r]);
      }
    }

    // Candidates in evaluation order (device, then template): the first hit
    // of an address decides its ban's origin tenant and reason.
    const candidates: AutoBanCandidate[] = [];
    for (const { dev, templates } of plan) {
      for (const cfg of templates) {
        for (const r of hits.get(`${windowKey(cfg)}|${dev.id}`) ?? []) {
          candidates.push({ ip: r.ip, tenantId: r.tenant_id, service: cfg.serviceType, failureCount: Number(r.failure_count) });
        }
      }
    }
    return this.createAutoBans(candidates);
  }

  /**
   * Global auto-bans of the cycle's candidates, in batch: BanSafety (in
   * memory), one covering-ban lookup, one global whitelist lookup, one
   * insert, then one pass over the agents under attack. An address already
   * covered by an active global ban (or by a ban of an earlier candidate)
   * is skipped. Returns the bans created per origin tenant.
   */
  private async createAutoBans(candidates: AutoBanCandidate[]): Promise<Map<number, number>> {
    const created = new Map<number, number>();
    if (candidates.length === 0) return created;

    // Never auto-ban a non-public, reserved or protected address (approved
    // agents and routers included). Logged here, throttled: the engine sees
    // the same address every cycle.
    const byAddress = new Map<string, AutoBanCandidate>();
    const checked = new Set<string>();
    for (const c of candidates) {
      if (checked.has(c.ip)) continue;
      checked.add(c.ip);
      const chk = await checkBanTarget(c.ip, { allowCidr: false, includeInterfaces: true, silent: true });
      if (!chk.ok) {
        const now = Date.now();
        const last = refusedAutoBanLog.get(c.ip);
        if (last == null || now - last > 60 * 60 * 1000) {
          if (refusedAutoBanLog.size > 1000) refusedAutoBanLog.clear();
          refusedAutoBanLog.set(c.ip, now);
          logger.warn({ ip: c.ip, reason: chk.code }, 'BanEngine: refusing to auto-ban a non-public, reserved or protected address (BanSafety)');
        }
        continue;
      }
      const ip = chk.target.address;
      if (!byAddress.has(ip)) byAddress.set(ip, { ...c, ip });
    }
    if (byAddress.size === 0) return created;

    // Already blocked everywhere: an active global ban of the address, or of
    // a subnet containing it. An expired row still flagged active is
    // deactivated (it holds the unique key of migration 032).
    const addrs = [...byAddress.keys()];
    const covering = await db.raw(
      `SELECT c.n::int AS n, b.id, b.expires_at
         FROM unnest(?::text[]) WITH ORDINALITY AS c(addr, n)
         JOIN ip_bans b ON b.scope = 'global' AND b.is_active = true
                       AND ${networkSql('b')} >>= c.addr::inet`,
      [addrs],
    ) as { rows: Array<{ n: number; id: number; expires_at: Date | null }> };
    const now = Date.now();
    const coveredBy = new Map<string, Array<{ id: number; expires_at: Date | null }>>();
    for (const r of covering.rows) {
      const ip = addrs[r.n - 1];
      const list = coveredBy.get(ip);
      if (list) list.push(r); else coveredBy.set(ip, [r]);
    }
    const expiredIds = new Set<number>();
    const uncovered: string[] = [];
    for (const ip of addrs) {
      const bans = coveredBy.get(ip) ?? [];
      if (bans.some((b) => b.expires_at == null || new Date(b.expires_at).getTime() > now)) continue;
      for (const b of bans) expiredIds.add(b.id);
      uncovered.push(ip);
    }
    if (expiredIds.size > 0) await banService.deactivateBans([...expiredIds], 'expiry');
    if (uncovered.length === 0) return created;

    // Global whitelist only (real containment, single-address entries
    // included); tenant-local entries act at delivery time.
    const whitelistedRows = await db
      .select(db.raw('c.n::int AS n'))
      .from(db.raw('unnest(?::text[]) WITH ORDINALITY AS c(addr, n)', [uncovered]))
      .whereExists(
        db('ip_whitelist as w').select(db.raw('1'))
          .whereRaw('w.ip >>= c.addr::inet')
          .where((wb) => whereWhitelistApplies(wb, 'w', {})),
      ) as unknown as Array<{ n: number }>;
    const whitelisted = new Set(whitelistedRows.map((r) => uncovered[r.n - 1]));
    const toBan = uncovered.filter((ip) => !whitelisted.has(ip)).map((ip) => byAddress.get(ip)!);
    if (toBan.length === 0) return created;

    // Duration from the platform ban policy (W12-3): auto-bans are global,
    // so the platform policy applies whatever the origin tenant. With a
    // repeat-offender ladder, one query counts the earlier single-address
    // bans of each address (any scope, type or state).
    const { policy } = await banPolicyService.getEffective();
    const priorBans = new Map<string, number>();
    if (banPolicyService.needsPriorCounts(policy)) {
      const { rows } = await db.raw(
        `SELECT host(ip) AS addr, count(*)::int AS n
           FROM ip_bans
          WHERE ip = ANY(?::inet[]) AND ${prefixSql('ip_bans')} = masklen(ip_bans.ip)
          GROUP BY ip`,
        [toBan.map((c) => c.ip)],
      ) as { rows: Array<{ addr: string; n: number }> };
      for (const r of rows) {
        const parsed = parseIpOrCidr(r.addr);
        if (parsed) priorBans.set(parsed.address, r.n);
      }
    }
    const createdAt = Date.now();
    const ttlOf = new Map<string, number | null>();
    for (const c of toBan) ttlOf.set(c.ip, banPolicyService.ttlFor(policy, priorBans.get(c.ip) ?? 0).ttlSeconds);
    const expiresOf = (ip: string): Date | null => {
      const ttl = ttlOf.get(ip) ?? null;
      return ttl === null ? null : new Date(createdAt + ttl * 1000);
    };

    // Unique key (032): an address a concurrent global ban won is skipped.
    // Chunked (bind parameter limit): one INSERT per 1000 bans.
    const insertedRows: Array<{ id: number; ip: string }> = [];
    for (let i = 0; i < toBan.length; i += AUTO_INSERT_CHUNK) {
      insertedRows.push(...await db('ip_bans')
        .insert(toBan.slice(i, i + AUTO_INSERT_CHUNK).map((c) => ({
          ip: c.ip,
          scope: 'global',
          ban_type: 'auto',
          origin_tenant_id: c.tenantId,
          reason: `Auto-ban: ${c.failureCount} ${c.service} auth failures`,
          is_active: true,
          expires_at: expiresOf(c.ip),
        })))
        .onConflict()
        .ignore()
        .returning(['id', 'ip']) as Array<{ id: number; ip: string }>);
    }
    const idOf = new Map<string, number>();
    for (const r of insertedRows) {
      const parsed = parseIpOrCidr(r.ip);
      if (parsed) idOf.set(parsed.address, r.id);
    }
    const bans: CreatedAutoBan[] = toBan
      .filter((c) => idOf.has(c.ip))
      .map((c) => ({ ...c, id: idOf.get(c.ip)!, ttlSeconds: ttlOf.get(c.ip) ?? null }));
    if (bans.length === 0) return created;

    // Ensure the IPs have a reputation row so they appear in the IP Reputation
    // module even if ip_events were processed before the reputation upsert fix
    // (ipReputationService.ensureExists, batched).
    try {
      const at = new Date();
      for (let i = 0; i < bans.length; i += AUTO_INSERT_CHUNK) {
        await db('ip_reputation')
          .insert(bans.slice(i, i + AUTO_INSERT_CHUNK).map((b) => ({
            ip: b.ip,
            total_failures: 0,
            total_successes: 0,
            affected_agents_count: 0,
            affected_services: [],
            attempted_usernames: [],
            first_seen: null,
            last_seen: null,
            last_event_device_id: null,
            geo_country_code: null,
            geo_city: null,
            asn: null,
            updated_at: at,
          })))
          .onConflict('ip')
          .ignore();
      }
      ipReputationService.enqueueGeo(bans.map((b) => b.ip));
    } catch { /* non-fatal */ }

    for (const b of bans) {
      created.set(b.tenantId, (created.get(b.tenantId) ?? 0) + 1);
      logger.info({
        ip: b.ip, service: b.service, failureCount: b.failureCount, ttlSeconds: b.ttlSeconds,
        ...(banPolicyService.needsPriorCounts(policy) ? { priorBans: priorBans.get(b.ip) ?? 0 } : {}),
      }, 'BanEngine: auto-banned IP');
      // Auto-bans are global: every tenant hears of the ban, only Default
      // learns which tenant's agents triggered it.
      const autoPayload = { id: b.id, ip: b.ip, service: b.service, failureCount: b.failureCount };
      emitGlobal(_io, SOCKET_EVENTS.BAN_AUTO, { ...autoPayload, originTenantId: null },
        new Map([[MASTER_TENANT_ID, { ...autoPayload, originTenantId: b.tenantId }]]));
      // Push auto-ban to MikroTik devices (fire-and-forget)
      pushMikrotik(b.ip, 'ban', undefined);
    }

    await this.markAgentsUnderAttack(bans);
    return created;
  }

  /**
   * Agents of the origin tenant with auth failures from a new ban's address
   * in the last 10 min are "under attack": last_attack_at is set and an
   * 'attack' notification fires per agent and ban. Three queries for the
   * whole cycle. Never throws.
   */
  private async markAgentsUnderAttack(bans: CreatedAutoBan[]): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 10 * 60 * 1000);
      const rows = await db('ip_events as e')
        .joinRaw(
          'JOIN unnest(?::text[], ?::int[]) WITH ORDINALITY AS c(addr, tid, n) ON e.ip = c.addr::inet AND e.tenant_id = c.tid',
          [bans.map((b) => b.ip), bans.map((b) => b.tenantId)],
        )
        .where('e.event_type', 'auth_failure')
        .where('e.timestamp', '>=', cutoff)
        .whereNotNull('e.device_id')
        .distinct(db.raw('c.n::int AS n'), 'e.device_id')
        .orderBy(['n', 'e.device_id']) as Array<{ n: number; device_id: number }>;
      if (rows.length === 0) return;

      const deviceIds = [...new Set(rows.map((r) => r.device_id))];
      await db('agent_devices')
        .whereRaw('id = ANY(?::int[])', [deviceIds])
        .update({ last_attack_at: new Date() });
      const names = await db('agent_devices')
        .whereRaw('id = ANY(?::int[])', [deviceIds])
        .select('id', 'name', 'hostname') as Array<{ id: number; name: string | null; hostname: string }>;
      const labelOf = new Map(names.map((d) => [d.id, d.name ?? d.hostname]));

      // Fire "attack" notifications for each affected device
      const { notificationService } = await import('./notification.service');
      for (const { n, device_id: devId } of rows) {
        const { ip, service, failureCount } = bans[n - 1];
        const label = labelOf.get(devId) ?? String(devId);
        notificationService.sendForAgent(devId, label, 'attack', 'ok', [`${ip} banned (${failureCount} ${service} failures)`], 'attack', { ip, service, failureCount }).catch(
          (err) => logger.warn({ err, devId, ip }, 'Failed to send attack notification'),
        );
      }
    } catch (err) {
      logger.warn({ err, ips: bans.map((b) => b.ip) }, 'BanEngine: failed to update last_attack_at for affected devices');
    }
  }
}

export const banEngine = new BanEngine();
