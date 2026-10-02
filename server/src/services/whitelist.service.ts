import { isIP } from 'net';
import type { Knex } from 'knex';
import { db } from '../db';
import type { IpWhitelist, CreateWhitelistRequest, WhitelistScope } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { whitelistDeleteVerdict } from '../utils/tenantWriteRules';
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
}

/** List entry: the shared model plus the creator's username (BROKEN-21). */
export type IpWhitelistEntry = IpWhitelist & { createdByUsername?: string | null };

export interface WhitelistListOptions {
  tenantId: number;
  /** Restrict to one scope; undefined / 'all' = every visible scope. */
  scope?: WhitelistScope | 'all';
  /** With scope group/agent: one target (must be readable by the tenant). */
  scopeId?: number | null;
  /** Only entries containing this address or range (ip >>= ?::inet). */
  ip?: string;
  limit: number;
  offset: number;
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

// ── Service ──────────────────────────────────────────────────────────────────

class WhitelistService {
  /**
   * Entries visible to the operating tenant (W1-2):
   *   - Default tenant: every entry (god view of operational reads);
   *   - other tenants: global entries, their own tenant-scope entries, and
   *     group/agent entries whose target group/agent belongs to them.
   * The platform role grants nothing extra. Paged; `total` is the full count.
   */
  async list(opts: WhitelistListOptions): Promise<{ data: IpWhitelistEntry[]; total: number }> {
    const { tenantId } = opts;
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
      if (!WHITELIST_SCOPES.includes(scope)) throw new AppError(400, `Unknown whitelist scope: ${scope as string}`);
      query.where('w.scope', scope);
      if ((scope === 'group' || scope === 'agent') && opts.scopeId != null) {
        await assertScopeInTenant(scope, opts.scopeId, tenantId, 'read');
        query.where('w.scope_id', opts.scopeId);
      }
    }

    if (opts.ip !== undefined) {
      if (!isInetLiteral(opts.ip)) throw new AppError(400, 'Invalid ip filter');
      query.whereRaw('w.ip >>= ?::inet', [opts.ip.trim()]);
    }

    const [{ count }] = await query.clone().count<{ count: string }[]>({ count: 'w.id' });
    const rows = await query
      .leftJoin('users as u', 'u.id', 'w.created_by')
      .select('w.*', 'u.username as created_by_username')
      .orderBy('w.scope')
      .orderBy('w.created_at', 'asc')
      .orderBy('w.id', 'asc')
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
      throw new AppError(400, 'ip must be an IP address or a CIDR range');
    }

    let scope: WhitelistScope;
    let scopeId: number | null = null;
    if (requested === 'group' || requested === 'agent') {
      if (data.scopeId == null) {
        throw new AppError(400, 'scopeId is required for group/agent scope');
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
      if (code === '23505') throw new AppError(409, 'This address is already whitelisted in this scope');
      // 22P02: not a valid cidr (e.g. host bits set: 10.0.0.1/8)
      if (code === '22P02') throw new AppError(400, 'ip must be an IP address or a CIDR range');
      throw err;
    }

    if (!row) throw new AppError(500, 'Failed to create whitelist entry');
    return rowToWhitelist(row);
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
  async delete(id: number, tenantId: number): Promise<void> {
    const row = await db<IpWhitelistRow>('ip_whitelist').where({ id }).first();
    if (!row) throw new AppError(404, 'Whitelist entry not found');

    const target = row.scope === 'group' || row.scope === 'agent'
      ? await resolveScopeTenant(row.scope, row.scope_id)
      : null;
    switch (whitelistDeleteVerdict(row, target, tenantId)) {
      case 'forbidden-global':
        throw new AppError(403, 'A global whitelist entry can only be removed from the Default tenant');
      case 'forbidden-foreign':
        throw new AppError(403, 'This whitelist entry belongs to another tenant: read-only from the Default tenant');
      case 'not-found':
        throw new AppError(404, 'Whitelist entry not found');
      default:
        break;
    }

    const deleted = await db('ip_whitelist').where({ id }).del();
    if (!deleted) throw new AppError(404, 'Whitelist entry not found');
  }

  /** Sets `canDelete` on each entry for the operating tenant (same rule as delete). */
  async annotateDeletable(entries: IpWhitelist[], tenantId: number): Promise<IpWhitelist[]> {
    const agentIds = [...new Set(entries.filter((e) => e.scope === 'agent' && e.scopeId != null).map((e) => e.scopeId as number))];
    const groupIds = [...new Set(entries.filter((e) => e.scope === 'group' && e.scopeId != null).map((e) => e.scopeId as number))];
    const agentTenant = new Map<number, number>();
    const groupTenant = new Map<number, number>();
    if (agentIds.length > 0) {
      const rows = await db('agent_devices').whereIn('id', agentIds).select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
      for (const r of rows) agentTenant.set(r.id, r.tenant_id);
    }
    if (groupIds.length > 0) {
      const rows = await db('monitor_groups').whereIn('id', groupIds).select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
      for (const r of rows) groupTenant.set(r.id, r.tenant_id);
    }
    for (const entry of entries) {
      let target: number | null = null;
      if (entry.scopeId != null) {
        if (entry.scope === 'agent') target = agentTenant.get(entry.scopeId) ?? null;
        else if (entry.scope === 'group') target = groupTenant.get(entry.scopeId) ?? null;
      }
      entry.canDelete = whitelistDeleteVerdict({ scope: entry.scope, tenant_id: entry.tenantId }, target, tenantId) === 'ok';
    }
    return entries;
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
