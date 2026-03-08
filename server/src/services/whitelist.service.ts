import { db } from '../db';
import type { IpWhitelist, CreateWhitelistRequest, WhitelistScope } from '@obliview/shared';

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
      if (!isAdmin) throw new Error('Only admins can view global whitelist entries');
      query.where({ scope: 'global' });
    } else if (scope === 'tenant') {
      if (!isAdmin) {
        // Tenant members may only see their own tenant entries
        query.where({ scope: 'tenant', tenant_id: tenantId });
      } else {
        query.where({ scope: 'tenant' });
      }
    } else if (scope === 'group') {
      if (scopeId === null) throw new Error('scopeId is required for group scope');
      query.where({ scope: 'group', scope_id: scopeId });
    } else if (scope === 'agent') {
      if (scopeId === null) throw new Error('scopeId is required for agent scope');
      query.where({ scope: 'agent', scope_id: scopeId });
    } else {
      throw new Error(`Unknown whitelist scope: ${scope as string}`);
    }

    const rows = await query.orderBy('created_at', 'asc');
    return rows.map(rowToWhitelist);
  }

  /**
   * Creates a new whitelist entry.
   */
  async create(
    data: CreateWhitelistRequest,
    userId: number,
    tenantId: number,
  ): Promise<IpWhitelist> {
    const scope: WhitelistScope = data.scope ?? 'tenant';

    if ((scope === 'group' || scope === 'agent') && data.scopeId == null) {
      throw new Error('scopeId is required for group/agent scope');
    }

    // Validate the IP/CIDR value via Postgres (will throw on invalid input)
    const [row] = await db<IpWhitelistRow>('ip_whitelist')
      .insert({
        ip: db.raw('?::cidr', [data.ip]),
        label: data.label ?? null,
        scope,
        scope_id: data.scopeId ?? null,
        tenant_id: scope === 'global' ? null : tenantId,
        created_by: userId,
        created_at: new Date(),
      } as unknown as IpWhitelistRow)
      .returning('*');

    if (!row) throw new Error('Failed to create whitelist entry');
    return rowToWhitelist(row);
  }

  /**
   * Deletes a whitelist entry by ID.
   * Tenants can only delete their own entries; admins can delete any.
   */
  async delete(id: number, tenantId: number, isAdmin: boolean): Promise<void> {
    const row = await db<IpWhitelistRow>('ip_whitelist').where({ id }).first();
    if (!row) throw new Error('Whitelist entry not found');

    if (!isAdmin) {
      // Non-admin: must belong to this tenant and be a non-global scope
      if (row.scope === 'global') {
        throw new Error('Only admins can delete global whitelist entries');
      }
      if (row.tenant_id !== tenantId) {
        throw new Error('Whitelist entry does not belong to your tenant');
      }
    }

    const deleted = await db('ip_whitelist').where({ id }).del();
    if (!deleted) throw new Error('Whitelist entry not found');
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
    for (const row of rows as Array<{ ip: string }>) {
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
