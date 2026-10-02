import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { whitelistDeleteVerdict } from '../utils/tenantWriteRules';
import { assertScopeInTenant, orOwnedScopeRows, resolveScopeTenant } from './tenantScope.service';
import type {
  RateLimitPolicy,
  CreateRateLimitPolicyRequest,
  RateLimitScope,
  RateLimitType,
  RateLimitAction,
  RateLimitRule,
} from '@obliview/shared';

/** Upper bound of a policy list response (DATA-REALTIME-13). */
const MAX_LIST = 1000;

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
      if (!isAdmin) throw new AppError(403, 'Only admins can view global rate limit policies');
      query.where({ scope: 'global' });
    } else if (scope === 'tenant') {
      if (!isMasterTenant(tenantId)) query.where({ scope: 'tenant', tenant_id: tenantId });
      else query.where({ scope: 'tenant' });
    } else if (scope === 'group' || scope === 'agent') {
      query.where({ scope });
      if (scopeId !== null) {
        await assertScopeInTenant(scope, scopeId, tenantId, 'read');
        query.where({ scope_id: scopeId });
      }
      // Group/agent rows of the operating tenant only (W1-2); Default sees all.
      if (!isMasterTenant(tenantId)) query.where((b) => { orOwnedScopeRows(b, tenantId); });
    } else {
      throw new AppError(400, `Unknown rate limit scope: ${scope as string}`);
    }

    const rows = await query.orderBy('created_at', 'asc').limit(MAX_LIST);
    return rows.map(rowToPolicy);
  }

  /** List every policy visible to the caller across all scopes. */
  async listAll(tenantId: number): Promise<RateLimitPolicy[]> {
    const query = db<RateLimitPolicyRow>('rate_limit_policies');
    if (!isMasterTenant(tenantId)) {
      query.where((b) => {
        b.where({ scope: 'global' })
          .orWhere({ scope: 'tenant', tenant_id: tenantId });
        orOwnedScopeRows(b, tenantId);
      });
    }
    const rows = await query.orderBy('scope').orderBy('created_at', 'asc').limit(MAX_LIST);
    return rows.map(rowToPolicy);
  }

  /**
   * Creates a policy. Global policies apply to every tenant: only the Default
   * tenant may create them. Group/agent targets must belong to the operating
   * tenant (W1-2; refused from Default on another tenant's target).
   */
  async create(
    data: CreateRateLimitPolicyRequest,
    userId: number,
    tenantId: number,
  ): Promise<RateLimitPolicy> {
    const scope: RateLimitScope = data.scope ?? 'global';

    if (scope !== 'global' && scope !== 'tenant' && scope !== 'group' && scope !== 'agent') {
      throw new AppError(400, `Unknown rate limit scope: ${scope as string}`);
    }
    if ((scope === 'group' || scope === 'agent') && data.scopeId == null) {
      throw new AppError(400, 'scopeId is required for group/agent scope');
    }
    if (data.type !== 'connection' && data.type !== 'rate' && data.type !== 'volume') {
      throw new AppError(400, `Invalid rate limit type: ${data.type as string}`);
    }
    if (!Number.isSafeInteger(data.maxValue) || data.maxValue < 1) {
      throw new AppError(400, 'maxValue must be a positive integer');
    }
    if (scope === 'global' && !isMasterTenant(tenantId)) {
      throw new AppError(403, 'Global rate limit policies can only be created from the Default tenant');
    }
    if (scope === 'group' || scope === 'agent') {
      await assertScopeInTenant(scope, data.scopeId, tenantId, 'write');
    }

    const [row] = await db<RateLimitPolicyRow>('rate_limit_policies')
      .insert({
        type: data.type,
        scope,
        scope_id: scope === 'group' || scope === 'agent' ? Number(data.scopeId) : null,
        tenant_id: scope === 'global' ? null : tenantId,
        enabled: data.enabled ?? true,
        port: data.port ?? null,
        max_value: data.maxValue,
        ban_multiplier: data.banMultiplier ?? null,
        action: data.action ?? 'drop',
        ban_ttl_seconds: data.banTtlSeconds ?? null,
        created_by: userId || null,
      } as unknown as RateLimitPolicyRow)
      .returning('*');

    if (!row) throw new AppError(500, 'Failed to create rate limit policy');
    return rowToPolicy(row);
  }

  /**
   * Deletes a policy, following the operating tenant (same rule as the
   * whitelist): a global policy only from Default; a local one by its owner
   * tenant or by the tenant owning the targeted group/agent; otherwise 403
   * from Default (read-only god view), 404 elsewhere.
   */
  async delete(id: number, tenantId: number): Promise<void> {
    const row = await db<RateLimitPolicyRow>('rate_limit_policies').where({ id }).first();
    if (!row) throw new AppError(404, 'Rate limit policy not found');

    const target = row.scope === 'group' || row.scope === 'agent'
      ? await resolveScopeTenant(row.scope, row.scope_id)
      : null;
    switch (whitelistDeleteVerdict(row, target, tenantId)) {
      case 'forbidden-global':
        throw new AppError(403, 'A global rate limit policy can only be removed from the Default tenant');
      case 'forbidden-foreign':
        throw new AppError(403, 'This rate limit policy belongs to another tenant: read-only from the Default tenant');
      case 'not-found':
        throw new AppError(404, 'Rate limit policy not found');
      default:
        break;
    }

    const deleted = await db('rate_limit_policies').where({ id }).del();
    if (!deleted) throw new AppError(404, 'Rate limit policy not found');
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
    //    Group/agent rows only count when they belong to the agent's own
    //    tenant: a row planted by another tenant is never delivered (W1-2).
    collect(await db<RateLimitPolicyRow>('rate_limit_policies')
      .where({ scope: 'agent', scope_id: deviceId, tenant_id: tenantId })
      .orderBy('created_at', 'asc'));

    // 2. Group-level (closest ancestor first)
    for (const groupId of groupIds) {
      collect(await db<RateLimitPolicyRow>('rate_limit_policies')
        .where({ scope: 'group', scope_id: groupId, tenant_id: tenantId })
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
