import { db } from '../db';
import type {
  RateLimitPolicy,
  CreateRateLimitPolicyRequest,
  RateLimitScope,
  RateLimitType,
  RateLimitAction,
  RateLimitRule,
} from '@obliview/shared';

// ── Row interface ────────────────────────────────────────────────────────────

interface RateLimitPolicyRow {
  id: number;
  type: string;
  scope: string;
  scope_id: number | null;
  tenant_id: number | null;
  enabled: boolean;
  port: number | null;
  max_value: number;
  ban_multiplier: number | null;
  action: string;
  ban_ttl_seconds: number | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

// ── Row → Model ──────────────────────────────────────────────────────────────

function rowToPolicy(row: RateLimitPolicyRow): RateLimitPolicy {
  return {
    id: row.id,
    type: row.type as RateLimitType,
    scope: row.scope as RateLimitScope,
    scopeId: row.scope_id,
    tenantId: row.tenant_id,
    enabled: row.enabled,
    port: row.port,
    maxValue: Number(row.max_value),
    banMultiplier: row.ban_multiplier != null ? Number(row.ban_multiplier) : null,
    action: row.action as RateLimitAction,
    banTtlSeconds: row.ban_ttl_seconds != null ? Number(row.ban_ttl_seconds) : null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

class RateLimitPolicyService {
  /** List policies for a single scope (RBAC mirrors the whitelist rules). */
  async listByScope(
    scope: RateLimitScope,
    scopeId: number | null,
    tenantId: number,
    isAdmin: boolean,
  ): Promise<RateLimitPolicy[]> {
    const query = db<RateLimitPolicyRow>('rate_limit_policies');

    if (scope === 'global') {
      if (!isAdmin) throw new Error('Only admins can view global rate limit policies');
      query.where({ scope: 'global' });
    } else if (scope === 'tenant') {
      if (!isAdmin) query.where({ scope: 'tenant', tenant_id: tenantId });
      else query.where({ scope: 'tenant' });
    } else if (scope === 'group') {
      if (scopeId !== null) query.where({ scope: 'group', scope_id: scopeId });
      else query.where({ scope: 'group' });
    } else if (scope === 'agent') {
      if (scopeId !== null) query.where({ scope: 'agent', scope_id: scopeId });
      else query.where({ scope: 'agent' });
    } else {
      throw new Error(`Unknown rate limit scope: ${scope as string}`);
    }

    const rows = await query.orderBy('created_at', 'asc');
    return rows.map(rowToPolicy);
  }

  /** List every policy visible to the caller across all scopes. */
  async listAll(tenantId: number, isAdmin: boolean): Promise<RateLimitPolicy[]> {
    const query = db<RateLimitPolicyRow>('rate_limit_policies');
    if (!isAdmin) {
      query.where((b) =>
        b.where({ scope: 'global' })
          .orWhere({ scope: 'tenant', tenant_id: tenantId })
          .orWhereIn('scope', ['group', 'agent']),
      );
    }
    const rows = await query.orderBy('scope').orderBy('created_at', 'asc');
    return rows.map(rowToPolicy);
  }

  async create(
    data: CreateRateLimitPolicyRequest,
    userId: number,
    tenantId: number,
  ): Promise<RateLimitPolicy> {
    const scope: RateLimitScope = data.scope ?? 'global';

    if ((scope === 'group' || scope === 'agent') && data.scopeId == null) {
      throw new Error('scopeId is required for group/agent scope');
    }
    if (data.type !== 'connection' && data.type !== 'rate') {
      throw new Error(`Invalid rate limit type: ${data.type as string}`);
    }
    if (!Number.isFinite(data.maxValue) || data.maxValue < 1) {
      throw new Error('maxValue must be a positive integer');
    }

    const [row] = await db<RateLimitPolicyRow>('rate_limit_policies')
      .insert({
        type: data.type,
        scope,
        scope_id: data.scopeId ?? null,
        tenant_id: scope === 'global' ? null : tenantId,
        enabled: data.enabled ?? true,
        port: data.port ?? null,
        max_value: data.maxValue,
        ban_multiplier: data.banMultiplier ?? null,
        action: data.action ?? 'drop',
        ban_ttl_seconds: data.banTtlSeconds ?? null,
        created_by: userId,
      } as unknown as RateLimitPolicyRow)
      .returning('*');

    if (!row) throw new Error('Failed to create rate limit policy');
    return rowToPolicy(row);
  }

  async delete(id: number, tenantId: number, isAdmin: boolean): Promise<void> {
    const row = await db<RateLimitPolicyRow>('rate_limit_policies').where({ id }).first();
    if (!row) throw new Error('Rate limit policy not found');

    if (!isAdmin) {
      if (row.scope === 'global') throw new Error('Only admins can delete global rate limit policies');
      if (row.tenant_id !== tenantId) throw new Error('Rate limit policy does not belong to your tenant');
    }

    const deleted = await db('rate_limit_policies').where({ id }).del();
    if (!deleted) throw new Error('Rate limit policy not found');
  }

  /**
   * Resolves the effective rate limit rules for a given agent, in priority
   * order: agent → group (closest → farthest) → tenant → global.
   *
   * Resolution is keyed by (type, port): the most specific scope wins, so an
   * agent-level rule overrides a group/tenant/global rule for the same
   * type+port combination. Disabled policies are skipped.
   */
  async resolveForAgent(
    deviceId: number,
    groupIds: number[],
    tenantId: number,
  ): Promise<RateLimitRule[]> {
    const resolved = new Map<string, RateLimitRule>();

    const collect = (rows: RateLimitPolicyRow[]) => {
      for (const row of rows) {
        if (!row.enabled) continue;
        const key = `${row.type}:${row.port ?? 'all'}`;
        // First writer wins — we process most-specific scopes first.
        if (resolved.has(key)) continue;
        const p = rowToPolicy(row);
        resolved.set(key, {
          type: p.type,
          port: p.port,
          maxValue: p.maxValue,
          banMultiplier: p.banMultiplier,
          action: p.action,
          banTtlSeconds: p.banTtlSeconds,
        });
      }
    };

    // 1. Agent-level
    collect(await db<RateLimitPolicyRow>('rate_limit_policies')
      .where({ scope: 'agent', scope_id: deviceId })
      .orderBy('created_at', 'asc'));

    // 2. Group-level (closest ancestor first)
    for (const groupId of groupIds) {
      collect(await db<RateLimitPolicyRow>('rate_limit_policies')
        .where({ scope: 'group', scope_id: groupId })
        .orderBy('created_at', 'asc'));
    }

    // 3. Tenant-level
    collect(await db<RateLimitPolicyRow>('rate_limit_policies')
      .where({ scope: 'tenant', tenant_id: tenantId })
      .orderBy('created_at', 'asc'));

    // 4. Global
    collect(await db<RateLimitPolicyRow>('rate_limit_policies')
      .where({ scope: 'global' })
      .orderBy('created_at', 'asc'));

    return [...resolved.values()];
  }
}

export const rateLimitPolicyService = new RateLimitPolicyService();
