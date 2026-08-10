import { db } from '../db';
import type { IpWhitelist, CreateWhitelistRequest, WhitelistScope } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';

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
}

// ── Row → Model ──────────────────────────────────────────────────────────────

function rowToWhitelist(row: IpWhitelistRow): IpWhitelist {
  return {
    id: row.id,
    ip: row.ip,
    label: row.label,
    scope: row.scope as WhitelistScope,
    scopeId: row.scope_id,
    tenantId: row.tenant_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

class WhitelistService {
  /**
   * Returns all whitelist entries visible to a given user/tenant.
   * Admins can see global + tenant entries; tenants see global + their own.
   */
  async listByScope(
    scope: WhitelistScope,
    scopeId: number | null,
    tenantId: number,
    isAdmin: boolean,
  ): Promise<IpWhitelist[]> {
    const query = db<IpWhitelistRow>('ip_whitelist');

    if (scope === 'global') {
      // Global entries apply to every tenant and are not locally overridable, so
      // any authenticated member may VIEW them (removal is still gated in delete()).
      query.where({ scope: 'global' });
    } else if (scope === 'tenant') {
      if (!isAdmin) {
        // Tenant members may only see their own tenant entries
        if (isMasterTenant(tenantId)) {
          query.where({ scope: 'tenant' });
        } else {
          query.where({ scope: 'tenant', tenant_id: tenantId });
        }
      } else {
        query.where({ scope: 'tenant' });
      }
    } else if (scope === 'group') {
      if (scopeId !== null) query.where({ scope: 'group', scope_id: scopeId });
      else query.where({ scope: 'group' });
    } else if (scope === 'agent') {
      if (scopeId !== null) query.where({ scope: 'agent', scope_id: scopeId });
      else query.where({ scope: 'agent' });
    } else {
      throw new Error(`Unknown whitelist scope: ${scope as string}`);
    }

    const rows = await query.orderBy('created_at', 'asc');
    return rows.map(rowToWhitelist);
  }

  /**
   * Returns all whitelist entries visible to a user across all scopes.
   * Admins see everything; others see global + their tenant + group/agent entries.
   */
  async listAll(tenantId: number, isAdmin: boolean): Promise<IpWhitelist[]> {
    const query = db<IpWhitelistRow>('ip_whitelist');
    if (!isAdmin && !isMasterTenant(tenantId)) {
      query.where((b) =>
        b.where({ scope: 'global' })
          .orWhere({ scope: 'tenant', tenant_id: tenantId })
          .orWhereIn('scope', ['group', 'agent']),
      );
    }
    const rows = await query.orderBy('scope').orderBy('created_at', 'asc');
    return rows.map(rowToWhitelist);
  }

  /**
   * Creates a new whitelist entry.
   *
   * The global-vs-local dimension is decided by the OPERATING TENANT, not by the
   * caller, mirroring the ban model:
   *   - Default/master tenant → a GLOBAL entry (applies to every tenant and is
   *     NOT locally overridable — no other tenant can remove it).
   *   - Any other tenant → a LOCAL (tenant-scoped) entry.
   * Explicit group/agent scopes are kept as-is (local sub-scopes owned by the
   * tenant); a non-Default tenant can therefore never mint a global entry.
   */
  async create(
    data: CreateWhitelistRequest,
    userId: number,
    tenantId: number,
  ): Promise<IpWhitelist> {
    const requested: WhitelistScope = data.scope ?? 'tenant';

    let scope: WhitelistScope;
    let scopeId: number | null = null;
    if (requested === 'group' || requested === 'agent') {
      if (data.scopeId == null) {
        throw new AppError(400, 'scopeId is required for group/agent scope');
      }
      scope = requested;
      scopeId = data.scopeId;
    } else {
      // Main whitelist dimension: authority derived from the operating tenant.
      scope = isMasterTenant(tenantId) ? 'global' : 'tenant';
    }

    // Validate the IP/CIDR value via Postgres (will throw on invalid input)
    const [row] = await db<IpWhitelistRow>('ip_whitelist')
      .insert({
        ip: db.raw('?::cidr', [data.ip]),
        label: data.label ?? null,
        scope,
        scope_id: scopeId,
        tenant_id: scope === 'global' ? null : tenantId,
        created_by: userId,
        created_at: new Date(),
      } as unknown as IpWhitelistRow)
      .returning('*');

    if (!row) throw new AppError(500, 'Failed to create whitelist entry');
    return rowToWhitelist(row);
  }

  /**
   * Deletes a whitelist entry by ID.
   *
   * A GLOBAL entry is authoritative and NOT locally overridable: only a platform
   * admin or the Default/master tenant may remove it. A non-Default tenant may
   * only remove its own local (tenant/group/agent) entries.
   */
  async delete(id: number, tenantId: number, isAdmin: boolean): Promise<void> {
    const row = await db<IpWhitelistRow>('ip_whitelist').where({ id }).first();
    if (!row) throw new AppError(404, 'Whitelist entry not found');

    if (!isAdmin && !isMasterTenant(tenantId)) {
      if (row.scope === 'global') {
        throw new AppError(403, 'A global whitelist entry can only be removed from the Default tenant');
      }
      if (row.tenant_id !== tenantId) {
        throw new AppError(403, 'Whitelist entry does not belong to your tenant');
      }
    }

    const deleted = await db('ip_whitelist').where({ id }).del();
    if (!deleted) throw new AppError(404, 'Whitelist entry not found');
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

    // 1. Agent-level entries
    const agentRows = await db<IpWhitelistRow>('ip_whitelist')
      .where({ scope: 'agent', scope_id: deviceId })
      .orderBy('created_at', 'asc');
    collect(agentRows);

    // 2. Group-level entries (closest ancestor first)
    if (groupIds.length > 0) {
      // groupIds is ordered closest → farthest; process in that order
      for (const groupId of groupIds) {
        const groupRows = await db<IpWhitelistRow>('ip_whitelist')
          .where({ scope: 'group', scope_id: groupId })
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
   * Checks whether a given IP address falls within any whitelist CIDR
   * applicable to the agent (uses PostgreSQL inet << cidr containment).
   */
  async isWhitelisted(
    ip: string,
    deviceId: number,
    groupIds: number[],
    tenantId: number,
  ): Promise<boolean> {
    // Build the set of applicable whitelist CIDRs first, then check containment
    // in a single query using the postgres << (inet contained by cidr) operator.

    // Collect all applicable scope conditions
    const conditions: Array<{ scope: string; scope_id?: number | null; tenant_id?: number | null }> = [
      { scope: 'agent', scope_id: deviceId },
      ...groupIds.map((gid) => ({ scope: 'group', scope_id: gid })),
      { scope: 'tenant', tenant_id: tenantId },
      { scope: 'global' },
    ];

    // Build a query that checks if the given IP is contained in any matching CIDR
    const query = db<IpWhitelistRow>('ip_whitelist').where((builder) => {
      for (const cond of conditions) {
        builder.orWhere((sub) => {
          sub.where('scope', cond.scope);
          if (cond.scope_id !== undefined) {
            sub.where('scope_id', cond.scope_id as number);
          }
          if (cond.tenant_id !== undefined) {
            sub.where('tenant_id', cond.tenant_id as number);
          }
        });
      }
    });

    const rows = await query.select(db.raw('ip::text as ip'));

    if (rows.length === 0) return false;

    // Use PostgreSQL to check CIDR containment for each applicable CIDR
    for (const row of rows as unknown as Array<{ ip: string }>) {
      const result = await db
        .raw<{ rows: Array<{ contained: boolean }> }>(
          'SELECT ?::inet << ?::cidr AS contained',
          [ip, row.ip],
        );
      if (result.rows[0]?.contained) return true;
    }

    return false;
  }
}

export const whitelistService = new WhitelistService();
