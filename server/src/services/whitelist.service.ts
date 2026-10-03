import { isIP } from 'net';
import type { Knex } from 'knex';
import type { Server as SocketIOServer } from 'socket.io';
import { db } from '../db';
import type { IpWhitelist, CreateWhitelistRequest, WhitelistScope, WhitelistChangedEvent } from '@obliview/shared';
import { isMasterTenant, SOCKET_EVENTS } from '@obliview/shared';
import { emitGlobal, emitToTenantAudience } from '../utils/socketRooms';
import { codedError } from '../utils/errorCodes';
import { readTenantsFor, whereReadTenants } from '../middleware/tenant';
import { whitelistDeleteVerdict } from '../utils/tenantWriteRules';
import { likeContains } from '../utils/pagination';
import { assertScopeInTenant, orOwnedScopeRows, resolveScopeTenant } from './tenantScope.service';

// ── Row interface ────────────────────────────────────────────────────────────

interface IpWhitelistRow {
  id: number;
  ip: string;
  label: string | null;
  scope: string;
  scope_id: number | null;
  tenant_id: number | null;
  created_by: number | null;
  created_at: Date;
  /** Joined from users (list queries only). */
  created_by_username?: string | null;
  /** Joined names (list queries only). */
  scope_name?: string | null;
  tenant_name?: string | null;
}

/**
 * List entry: the shared model plus names instead of ids (BROKEN-21,
 * UI-PAGES-IPS-12): the creator's username, the scope target's name (group,
 * agent display name, tenant) and the owning tenant's name.
 */
export type IpWhitelistEntry = IpWhitelist & {
  createdByUsername?: string | null;
  scopeName?: string | null;
  tenantName?: string | null;
};

export type WhitelistListSort = 'createdAt' | 'ip' | 'scope';

export interface WhitelistListOptions {
  tenantId: number;
  /** Restrict to one scope; undefined / 'all' = every visible scope. */
  scope?: WhitelistScope | 'all';
  /** With scope group/agent: one target (must be readable by the tenant). */
  scopeId?: number | null;
  /** Only entries containing this address or range (ip >>= ?::inet). */
  ip?: string;
  /** Free text: an address / CIDR (entries containing it) or a label / address substring. */
  search?: string;
  /** God view (Default) only: entries owned by these tenants. */
  tenantIds?: number[];
  /** The caller's team agent scope (agentScope.scopeAgentIds); 'all' / undefined = no restriction. */
  visibleAgentIds?: number[] | 'all';
  /** Explicit sort; undefined keeps the historical order (scope, created_at, id). */
  sortBy?: WhitelistListSort;
  sortOrder?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** Result of a bulk delete: counts plus the first refusals. */
export interface WhitelistBulkDeleteResult {
  deleted: number;
  /** Global entries outside Default, foreign entries from Default. */
  forbidden: number;
  notFound: number;
  errors: Array<{ id: number; status: number; error: string }>;
}

/** Bulk delete: at most this many ids per request. */
export const WHITELIST_BULK_DELETE_MAX = 1000;
const BULK_DETAIL_MAX = 50;

/**
 * Team agent scope on a (scope, scope_id) table (RBAC-8): a user restricted
 * by team grants keeps every global / tenant row, the agent rows of the
 * agents granted to them and the group rows of the groups (or ancestors) of
 * those agents. Add it inside a where((b) => ...) group.
 */
export function whereTeamScopeAllows(b: Knex.QueryBuilder, alias: string, agentIds: number[]): Knex.QueryBuilder {
  return b
    .whereNotIn(`${alias}.scope`, ['group', 'agent'])
    .orWhere((s) => s.where(`${alias}.scope`, 'agent').whereIn(`${alias}.scope_id`, agentIds))
    .orWhere((s) => s.where(`${alias}.scope`, 'group').whereIn(`${alias}.scope_id`,
      db('group_closure as gc')
        .join('agent_devices as gd', 'gd.group_id', 'gc.descendant_id')
        .whereIn('gd.id', agentIds)
        .select('gc.ancestor_id')));
}

// ── Row → Model ──────────────────────────────────────────────────────────────

function rowToWhitelist(row: IpWhitelistRow): IpWhitelistEntry {
  const entry: IpWhitelistEntry = {
    id: row.id,
    ip: row.ip,
    label: row.label,
    scope: row.scope as WhitelistScope,
    scopeId: row.scope_id,
    tenantId: row.tenant_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
  if (row.created_by_username !== undefined) entry.createdByUsername = row.created_by_username;
  if (row.scope_name !== undefined) entry.scopeName = row.scope_name;
  if (row.tenant_name !== undefined) entry.tenantName = row.tenant_name;
  return entry;
}

const WHITELIST_SCOPES: readonly string[] = ['global', 'tenant', 'group', 'agent'];

/** True for a plain address or a CIDR range Postgres' inet accepts. */
export function isInetLiteral(v: string): boolean {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(v.trim());
  if (!m) return false;
  const family = isIP(m[1]);
  if (family === 0) return false;
  if (m[2] === undefined) return true;
  return Number(m[2]) <= (family === 4 ? 32 : 128);
}

// ── Realtime refresh hint ────────────────────────────────────────────────────

let _io: SocketIOServer | null = null;

export function setWhitelistIO(io: SocketIOServer): void {
  _io = io;
}

/**
 * WHITELIST_CHANGED refresh hint after a write (ids only, no addresses): a
 * global entry reaches every socket, a local one its tenant plus Default.
 */
export function notifyWhitelistChanged(
  action: WhitelistChangedEvent['action'],
  entries: ReadonlyArray<{ id?: number; scope: string; tenantId: number | null }>,
): void {
  if (!_io || entries.length === 0) return;
  const byAudience = new Map<number | null, number[]>();
  for (const e of entries) {
    const key = e.scope === 'global' ? null : e.tenantId;
    const ids = byAudience.get(key) ?? [];
    if (e.id != null) ids.push(Number(e.id));
    byAudience.set(key, ids);
  }
  for (const [tenantId, ids] of byAudience) {
    const payload: WhitelistChangedEvent = { action, ids, tenantId };
    if (tenantId === null) emitGlobal(_io, SOCKET_EVENTS.WHITELIST_CHANGED, payload);
    else emitToTenantAudience(_io, tenantId, SOCKET_EVENTS.WHITELIST_CHANGED, payload);
  }
}

// ── Service ──────────────────────────────────────────────────────────────────

class WhitelistService {
  /**
   * Entries visible to the operating tenant (W1-2, W10-5 readTenantsFor):
   *   - Default tenant: every entry (god view of operational reads), or the
   *     entries owned by the tenant chips (`tenantIds`);
   *   - other tenants: global entries, their own tenant-scope entries, and
   *     group/agent entries whose target group/agent belongs to them.
   * The platform role grants nothing extra. Paged; `total` is the full count.
   * Rows carry tenantId + tenantName (null = global entry).
   */
  async list(opts: WhitelistListOptions): Promise<{ data: IpWhitelistEntry[]; total: number }> {
    const { tenantId } = opts;
    const tenants = readTenantsFor(tenantId, opts.tenantIds);
    const query = db('ip_whitelist as w');

    if (!isMasterTenant(tenantId)) {
      query.where((b) => {
        b.where('w.scope', 'global')
          .orWhere((s) => s.where('w.scope', 'tenant').where('w.tenant_id', tenantId));
        orOwnedScopeRows(b, tenantId, 'w');
      });
    }

    const scope = opts.scope && opts.scope !== 'all' ? opts.scope : null;
    if (scope !== null) {
      if (!WHITELIST_SCOPES.includes(scope)) throw codedError(400, 'WHITELIST_SCOPE_INVALID', `Unknown whitelist scope: ${scope as string}`);
      query.where('w.scope', scope);
      if ((scope === 'group' || scope === 'agent') && opts.scopeId != null) {
        await assertScopeInTenant(scope, opts.scopeId, tenantId, 'read');
        query.where('w.scope_id', opts.scopeId);
      }
    }

    if (opts.ip !== undefined) {
      if (!isInetLiteral(opts.ip)) throw codedError(400, 'IP_FILTER_INVALID', 'Invalid ip filter');
      query.whereRaw('w.ip >>= ?::inet', [opts.ip.trim()]);
    }

    if (opts.search) {
      const s = opts.search.trim();
      if (isInetLiteral(s)) {
        // An address or a range: the entries covering it, and the ranges inside it.
        query.where((b) => {
          b.whereRaw('w.ip >>= ?::inet', [s]).orWhereRaw('w.ip <<= ?::inet', [s]);
        });
      } else {
        const pattern = likeContains(s);
        query.where((b) => {
          b.whereRaw('w.ip::text ILIKE ?', [pattern]).orWhereRaw('w.label ILIKE ?', [pattern]);
        });
      }
    }

    // Tenant chips (Default only): the entries those tenants own.
    if (isMasterTenant(tenantId)) whereReadTenants(query, 'w.tenant_id', tenants);

    if (opts.visibleAgentIds && opts.visibleAgentIds !== 'all') {
      const allowed = opts.visibleAgentIds;
      query.where((b) => whereTeamScopeAllows(b, 'w', allowed));
    }

    const [{ count }] = await query.clone().count<{ count: string }[]>({ count: 'w.id' });
    query
      .leftJoin('users as u', 'u.id', 'w.created_by')
      .leftJoin('tenants as wt', 'wt.id', 'w.tenant_id')
      .leftJoin('monitor_groups as sg', function () {
        this.on('sg.id', '=', 'w.scope_id').andOnVal('w.scope', '=', 'group');
      })
      .leftJoin('agent_devices as sd', function () {
        this.on('sd.id', '=', 'w.scope_id').andOnVal('w.scope', '=', 'agent');
      })
      .select(
        'w.*',
        'u.username as created_by_username',
        'wt.name as tenant_name',
        db.raw(`CASE w.scope
                  WHEN 'group' THEN sg.name
                  WHEN 'agent' THEN COALESCE(NULLIF(sd.name, ''), sd.hostname)
                  WHEN 'tenant' THEN wt.name
                END AS scope_name`),
      );

    const order = opts.sortOrder === 'desc' ? 'desc' : 'asc';
    switch (opts.sortBy) {
      case 'ip':
        query.orderBy('w.ip', order);
        break;
      case 'scope':
        query.orderBy('w.scope', order).orderBy('w.created_at', 'desc');
        break;
      case 'createdAt':
        query.orderBy('w.created_at', order);
        break;
      default:
        query.orderBy('w.scope').orderBy('w.created_at', 'asc');
    }
    const rows = await query
      .orderBy('w.id', opts.sortBy ? order : 'asc')
      .limit(opts.limit)
      .offset(opts.offset) as IpWhitelistRow[];

    return { data: rows.map(rowToWhitelist), total: Number(count) };
  }

  /**
   * Creates a new whitelist entry.
   *
   * The global-vs-local dimension is decided by the OPERATING TENANT, not by the
   * caller, mirroring the ban model:
   *   - Default/master tenant → a GLOBAL entry (applies to every tenant and is
   *     NOT locally overridable — no other tenant can remove it).
   *   - Any other tenant → a LOCAL (tenant-scoped) entry.
   * Explicit group/agent scopes are local sub-scopes: their target must belong
   * to the operating tenant (W1-2; refused from Default on a foreign target).
   * A non-Default tenant can therefore never mint a global entry.
   */
  async create(
    data: CreateWhitelistRequest,
    userId: number,
    tenantId: number,
  ): Promise<IpWhitelist> {
    const requested: WhitelistScope = data.scope ?? 'tenant';
    if (typeof data.ip !== 'string' || !isInetLiteral(data.ip)) {
      throw codedError(400, 'WHITELIST_IP_INVALID', 'ip must be an IP address or a CIDR range');
    }

    let scope: WhitelistScope;
    let scopeId: number | null = null;
    if (requested === 'group' || requested === 'agent') {
      if (data.scopeId == null) {
        throw codedError(400, 'SCOPE_ID_REQUIRED', 'scopeId is required for group/agent scope');
      }
      await assertScopeInTenant(requested, data.scopeId, tenantId, 'write');
      scope = requested;
      scopeId = Number(data.scopeId);
    } else {
      // Main whitelist dimension: authority derived from the operating tenant.
      scope = isMasterTenant(tenantId) ? 'global' : 'tenant';
    }

    // Uniqueness is (ip, scope, scope_id, tenant_id): two tenants may whitelist
    // the same address (migration 029).
    let row: IpWhitelistRow | undefined;
    try {
      [row] = await db<IpWhitelistRow>('ip_whitelist')
        .insert({
          ip: db.raw('?::cidr', [data.ip.trim()]),
          label: data.label ?? null,
          scope,
          scope_id: scopeId,
          tenant_id: scope === 'global' ? null : tenantId,
          created_by: userId || null,
          created_at: new Date(),
        } as unknown as IpWhitelistRow)
        .returning('*');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') throw codedError(409, 'WHITELIST_DUPLICATE', 'This address is already whitelisted in this scope');
      // 22P02: not a valid cidr (e.g. host bits set: 10.0.0.1/8)
      if (code === '22P02') throw codedError(400, 'WHITELIST_IP_INVALID', 'ip must be an IP address or a CIDR range');
      throw err;
    }

    if (!row) throw codedError(500, 'WHITELIST_CREATE_FAILED', 'Failed to create whitelist entry');
    const entry = rowToWhitelist(row);
    notifyWhitelistChanged('created', [entry]);
    return entry;
  }

  /**
   * Deletes a whitelist entry by ID, following the operating tenant
   * (whitelistDeleteVerdict). The platform role grants nothing extra.
   *
   * - A GLOBAL entry is authoritative: only the Default tenant may remove it.
   * - A local entry may be removed by its owner tenant, or by the tenant that
   *   owns the targeted agent/group (a victim removes an entry planted on its
   *   own agent or group; customers remove rows created from Default on them).
   * - Otherwise: 403 from Default (read-only god view), 404 elsewhere.
   */
  async delete(id: number, tenantId: number, opts: { visibleAgentIds?: number[] | 'all' } = {}): Promise<void> {
    const row = await db<IpWhitelistRow>('ip_whitelist').where({ id }).first();
    if (!row) throw codedError(404, 'WHITELIST_ENTRY_NOT_FOUND', 'Whitelist entry not found');
    // Team scope (RBAC-8): a group/agent entry outside the caller's writable agents does not exist for it.
    if (opts.visibleAgentIds && opts.visibleAgentIds !== 'all') {
      const allowed = opts.visibleAgentIds;
      const inScope = await db('ip_whitelist as w').where('w.id', id)
        .where((b) => whereTeamScopeAllows(b, 'w', allowed)).first('w.id');
      if (!inScope) throw codedError(404, 'WHITELIST_ENTRY_NOT_FOUND', 'Whitelist entry not found');
    }

    const target = row.scope === 'group' || row.scope === 'agent'
      ? await resolveScopeTenant(row.scope, row.scope_id)
      : null;
    switch (whitelistDeleteVerdict(row, target, tenantId)) {
      case 'forbidden-global':
        throw codedError(403, 'WHITELIST_GLOBAL_READ_ONLY', 'A global whitelist entry can only be removed from the Default tenant');
      case 'forbidden-foreign':
        throw codedError(403, 'FOREIGN_TENANT_READ_ONLY', 'This whitelist entry belongs to another tenant: read-only from the Default tenant');
      case 'not-found':
        throw codedError(404, 'WHITELIST_ENTRY_NOT_FOUND', 'Whitelist entry not found');
      default:
        break;
    }

    const deleted = await db('ip_whitelist').where({ id }).del();
    if (!deleted) throw codedError(404, 'WHITELIST_ENTRY_NOT_FOUND', 'Whitelist entry not found');
    notifyWhitelistChanged('deleted', [{ id, scope: row.scope, tenantId: row.tenant_id }]);
  }

  /** Sets `canDelete` on each entry for the operating tenant (same rule as delete). */
  async annotateDeletable<T extends IpWhitelist>(
    entries: T[],
    tenantId: number,
    opts: { visibleAgentIds?: number[] | 'all' } = {},
  ): Promise<T[]> {
    const targetTenant = await this.resolveTargetTenants(entries);
    // Team write scope (RBAC-8): group/agent entries outside it are read-only.
    let writable: Set<number> | null = null;
    if (opts.visibleAgentIds && opts.visibleAgentIds !== 'all' && entries.length > 0) {
      const allowed = opts.visibleAgentIds;
      const kept = await db('ip_whitelist as w').whereIn('w.id', entries.map((e) => e.id))
        .where((b) => whereTeamScopeAllows(b, 'w', allowed)).pluck('w.id') as number[];
      writable = new Set(kept.map(Number));
    }
    for (const entry of entries) {
      entry.canDelete = (writable === null || writable.has(Number(entry.id)))
        && whitelistDeleteVerdict({ scope: entry.scope, tenant_id: entry.tenantId }, targetTenant(entry), tenantId) === 'ok';
    }
    return entries;
  }

  /**
   * Delete several entries at once (Whitelist tab bulk action), each one
   * under the delete rule (whitelistDeleteVerdict): a global entry is
   * locked outside Default, a foreign entry is read-only from Default.
   * Entries outside the caller's team agent scope count as not found.
   * Refused entries never abort the batch.
   */
  async bulkDelete(
    ids: number[],
    tenantId: number,
    opts: { visibleAgentIds?: number[] | 'all' } = {},
  ): Promise<WhitelistBulkDeleteResult> {
    const unique = [...new Set(ids)];
    const result: WhitelistBulkDeleteResult = { deleted: 0, forbidden: 0, notFound: 0, errors: [] };
    const refuse = (id: number, status: 403 | 404, error: string) => {
      if (status === 403) result.forbidden++;
      else result.notFound++;
      if (result.errors.length < BULK_DETAIL_MAX) result.errors.push({ id, status, error });
    };

    const q = db('ip_whitelist as w').whereIn('w.id', unique);
    if (opts.visibleAgentIds && opts.visibleAgentIds !== 'all') {
      const allowed = opts.visibleAgentIds;
      q.where((b) => whereTeamScopeAllows(b, 'w', allowed));
    }
    const rows = (await q.select('w.*') as IpWhitelistRow[]).map(rowToWhitelist);
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const targetTenant = await this.resolveTargetTenants(rows);

    const allowed: number[] = [];
    for (const id of unique) {
      const entry = byId.get(id);
      if (!entry) { refuse(id, 404, 'Whitelist entry not found'); continue; }
      switch (whitelistDeleteVerdict({ scope: entry.scope, tenant_id: entry.tenantId }, targetTenant(entry), tenantId)) {
        case 'forbidden-global':
          refuse(id, 403, 'A global whitelist entry can only be removed from the Default tenant');
          break;
        case 'forbidden-foreign':
          refuse(id, 403, 'This whitelist entry belongs to another tenant: read-only from the Default tenant');
          break;
        case 'not-found':
          refuse(id, 404, 'Whitelist entry not found');
          break;
        default:
          allowed.push(id);
      }
    }
    if (allowed.length > 0) {
      result.deleted = await db('ip_whitelist').whereIn('id', allowed).del();
      notifyWhitelistChanged('deleted', allowed.map((id) => byId.get(id)!));
    }
    return result;
  }

  /** Owner tenant of each group/agent entry's target (one query per kind). */
  private async resolveTargetTenants(entries: IpWhitelist[]): Promise<(entry: IpWhitelist) => number | null> {
    const agentIds = [...new Set(entries.filter((e) => e.scope === 'agent' && e.scopeId != null).map((e) => e.scopeId as number))];
    const groupIds = [...new Set(entries.filter((e) => e.scope === 'group' && e.scopeId != null).map((e) => e.scopeId as number))];
    const agentTenant = new Map<number, number>();
    const groupTenant = new Map<number, number>();
    if (agentIds.length > 0) {
      const rows = await db('agent_devices').whereIn('id', agentIds).select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
      for (const r of rows) agentTenant.set(Number(r.id), Number(r.tenant_id));
    }
    if (groupIds.length > 0) {
      const rows = await db('monitor_groups').whereIn('id', groupIds).select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
      for (const r of rows) groupTenant.set(Number(r.id), Number(r.tenant_id));
    }
    return (entry) => {
      if (entry.scopeId == null) return null;
      if (entry.scope === 'agent') return agentTenant.get(Number(entry.scopeId)) ?? null;
      if (entry.scope === 'group') return groupTenant.get(Number(entry.scopeId)) ?? null;
      return null;
    };
  }

  /**
   * Resolves all whitelist CIDRs applicable to a given agent, in priority order:
   *   agent → group (closest → farthest) → tenant → global
   * Returns a deduplicated array of CIDR strings.
   */
  async resolveWhitelistForAgent(
    deviceId: number,
    groupIds: number[],
    tenantId: number,
  ): Promise<string[]> {
    const cidrs: string[] = [];
    const seen = new Set<string>();

    const collect = (rows: IpWhitelistRow[]) => {
      for (const row of rows) {
        if (!seen.has(row.ip)) {
          seen.add(row.ip);
          cidrs.push(row.ip);
        }
      }
    };

    // 1. Agent-level entries. Group/agent rows only count when they belong to
    //    the agent's own tenant: a row planted by another tenant on this
    //    agent/group is never delivered (W1-2).
    const agentRows = await db<IpWhitelistRow>('ip_whitelist')
      .where({ scope: 'agent', scope_id: deviceId, tenant_id: tenantId })
      .orderBy('created_at', 'asc');
    collect(agentRows);

    // 2. Group-level entries (closest ancestor first)
    if (groupIds.length > 0) {
      // groupIds is ordered closest → farthest; process in that order
      for (const groupId of groupIds) {
        const groupRows = await db<IpWhitelistRow>('ip_whitelist')
          .where({ scope: 'group', scope_id: groupId, tenant_id: tenantId })
          .orderBy('created_at', 'asc');
        collect(groupRows);
      }
    }

    // 3. Tenant-level entries
    const tenantRows = await db<IpWhitelistRow>('ip_whitelist')
      .where({ scope: 'tenant', tenant_id: tenantId })
      .orderBy('created_at', 'asc');
    collect(tenantRows);

    // 4. Global entries
    const globalRows = await db<IpWhitelistRow>('ip_whitelist')
      .where({ scope: 'global' })
      .orderBy('created_at', 'asc');
    collect(globalRows);

    return cidrs;
  }

  /**
   * True when an applicable whitelist entry covers `target` (an address or a
   * CIDR range). Containment is real CIDR containment in SQL (`w.ip >>= x`):
   * 10.0.0.0/8 covers 10.1.2.3, 1.2.3.4/32 covers 1.2.3.4 but not 1.2.3.40.
   * `mode: 'overlaps'` also matches an entry that only intersects the target
   * (manual ban creation refuses a range that would block a whitelisted
   * address). See whereWhitelistApplies for the scopes considered.
   */
  async isWhitelisted(
    target: string,
    ctx: WhitelistMatchContext = {},
    opts: { mode?: 'contains' | 'overlaps'; trx?: Knex } = {},
  ): Promise<boolean> {
    const k = opts.trx ?? db;
    const op = opts.mode === 'overlaps' ? '&&' : '>>=';
    const row = await k('ip_whitelist as w')
      .whereRaw(`w.ip ${op} ?::inet`, [target])
      .where((b) => whereWhitelistApplies(b, 'w', ctx))
      .first('w.id');
    return !!row;
  }
}

/**
 * Where a whitelist entry may apply. Global entries always do; with a
 * `tenantId`, so do the tenant's own entries, its group entries for
 * `groupIds` and its agent entry for `deviceId`. Group/agent rows count only
 * when they belong to the tenant (a row planted on a foreign target never
 * applies, W1-2).
 */
export interface WhitelistMatchContext {
  tenantId?: number | null;
  groupIds?: number[];
  deviceId?: number | null;
}

/** OR-clause of the whitelist rows (alias `w`) applying to `ctx`. */
export function whereWhitelistApplies(b: Knex.QueryBuilder, w: string, ctx: WhitelistMatchContext): void {
  b.where(`${w}.scope`, 'global');
  if (ctx.tenantId == null) return;
  const tenantId = ctx.tenantId;
  b.orWhere((s) => s.where(`${w}.scope`, 'tenant').where(`${w}.tenant_id`, tenantId));
  const groupIds = ctx.groupIds ?? [];
  if (groupIds.length > 0) {
    b.orWhere((s) => s.where(`${w}.scope`, 'group').whereIn(`${w}.scope_id`, groupIds).where(`${w}.tenant_id`, tenantId));
  }
  if (ctx.deviceId != null) {
    const deviceId = ctx.deviceId;
    b.orWhere((s) => s.where(`${w}.scope`, 'agent').where(`${w}.scope_id`, deviceId).where(`${w}.tenant_id`, tenantId));
  }
}

export const whitelistService = new WhitelistService();
