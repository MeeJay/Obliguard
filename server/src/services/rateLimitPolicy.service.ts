import type { Knex } from 'knex';
import { db } from '../db';
import { isMasterTenant, MASTER_TENANT_ID } from '@obliview/shared';
import { codedError } from '../utils/errorCodes';
import { readTenantsFor, whereReadTenants } from '../middleware/tenant';
import { whitelistDeleteVerdict } from '../utils/tenantWriteRules';
import { assertScopeInTenant, orOwnedScopeRows, resolveScopeTenant } from './tenantScope.service';
import { appConfigService } from './appConfig.service';
import type {
  RateLimitPolicy,
  CreateRateLimitPolicyRequest,
  RateLimitScope,
  RateLimitType,
  RateLimitAction,
  RateLimitRule,
  UpdateRateLimitPolicyRequest,
} from '@obliview/shared';

export type { UpdateRateLimitPolicyRequest };

/** A listed policy with its owning tenant's name (W10-5; null tenant = global policy). */
export type RateLimitPolicyListItem = RateLimitPolicy & { tenantName: string | null };

/** Upper bound of a policy list response (DATA-REALTIME-13). */
const MAX_LIST = 1000;

/**
 * Value bounds. Every numeric field is an int4 column and an `int` on the Go
 * agent: a fraction or an out-of-range value would fail the insert, or make
 * the agent drop the whole config frame.
 */
const MAX_LIMIT_VALUE = 1_000_000;
const MIN_BAN_MULTIPLIER = 2;
const MAX_BAN_MULTIPLIER = 1000;
const MAX_BAN_TTL_SECONDS = 10 * 365 * 24 * 3600;
const MAX_INT4 = 2_147_483_647;

const TYPES: readonly RateLimitType[] = ['connection', 'rate', 'volume'];
const SCOPES: readonly RateLimitScope[] = ['global', 'tenant', 'group', 'agent'];

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
  /** Joined from tenants (list queries only). */
  tenant_name?: string | null;
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

/** List row: the model plus the owning tenant's name. */
function rowToListItem(row: RateLimitPolicyRow): RateLimitPolicyListItem {
  return { ...rowToPolicy(row), tenantName: row.tenant_name ?? null };
}

/** List query: every column plus the owning tenant's name. */
function listQuery(): Knex.QueryBuilder<RateLimitPolicyRow> {
  return db<RateLimitPolicyRow>('rate_limit_policies as p')
    .leftJoin('tenants as pt', 'pt.id', 'p.tenant_id')
    .select('p.*', 'pt.name as tenant_name');
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Fields of a policy, after merging a create or edit request. */
interface PolicyFields {
  type: RateLimitType;
  scope: RateLimitScope;
  scopeId: number | null;
  enabled: boolean;
  port: number | null;
  maxValue: number;
  banMultiplier: number | null;
  action: RateLimitAction;
  banTtlSeconds: number | null;
}

function isIntIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}

/** Throws 400 on the first invalid field (same rules for create and edit). */
function validatePolicyFields(p: PolicyFields): void {
  if (!SCOPES.includes(p.scope)) throw codedError(400, 'RATE_LIMIT_SCOPE_INVALID', `Unknown rate limit scope: ${String(p.scope)}`);
  if ((p.scope === 'group' || p.scope === 'agent') && p.scopeId == null) {
    throw codedError(400, 'SCOPE_ID_REQUIRED', 'scopeId is required for group/agent scope');
  }
  if (p.scopeId !== null && !isIntIn(p.scopeId, 1, MAX_INT4)) throw codedError(400, 'SCOPE_ID_INVALID', 'Invalid scopeId');
  if (!TYPES.includes(p.type)) throw codedError(400, 'RATE_LIMIT_TYPE_INVALID', `Invalid rate limit type: ${String(p.type)}`);
  if (!isIntIn(p.maxValue, 1, MAX_LIMIT_VALUE)) {
    throw codedError(400, 'RATE_LIMIT_MAX_VALUE_INVALID', `maxValue must be an integer between 1 and ${MAX_LIMIT_VALUE}`, { max: MAX_LIMIT_VALUE });
  }
  if (p.port !== null && !isIntIn(p.port, 1, 65535)) throw codedError(400, 'PORT_INVALID', 'port must be an integer between 1 and 65535');
  if (typeof p.enabled !== 'boolean') throw codedError(400, 'FIELD_BOOLEAN', 'enabled must be a boolean', { field: 'enabled' });
  // drop everywhere; reject (TCP RST) for connection/rate; shape for volume only.
  const actions: RateLimitAction[] = p.type === 'volume' ? ['drop', 'shape'] : ['drop', 'reject'];
  if (!actions.includes(p.action)) {
    throw codedError(400, 'RATE_LIMIT_ACTION_INVALID', `action must be one of ${actions.join(', ')} for a ${p.type} limit`);
  }
  if (p.banMultiplier !== null && !isIntIn(p.banMultiplier, MIN_BAN_MULTIPLIER, MAX_BAN_MULTIPLIER)) {
    throw codedError(400, 'RATE_LIMIT_BAN_MULTIPLIER_INVALID', `banMultiplier must be an integer between ${MIN_BAN_MULTIPLIER} and ${MAX_BAN_MULTIPLIER}`, { min: MIN_BAN_MULTIPLIER, max: MAX_BAN_MULTIPLIER });
  }
  if (p.banTtlSeconds !== null && !isIntIn(p.banTtlSeconds, 1, MAX_BAN_TTL_SECONDS)) {
    throw codedError(400, 'RATE_LIMIT_BAN_TTL_INVALID', `banTtlSeconds must be an integer between 1 and ${MAX_BAN_TTL_SECONDS}`, { max: MAX_BAN_TTL_SECONDS });
  }
}

/**
 * Checks that the operating tenant may target (scope, scopeId): global only
 * from Default; group/agent targets must belong to the operating tenant (W1-2;
 * refused from Default on another tenant's target).
 */
async function assertTargetWritable(p: PolicyFields, tenantId: number): Promise<void> {
  if (p.scope === 'global' && !isMasterTenant(tenantId)) {
    throw codedError(403, 'RATE_LIMIT_GLOBAL_DEFAULT_TENANT_ONLY', 'Global rate limit policies can only be created from the Default tenant');
  }
  if (p.scope === 'group' || p.scope === 'agent') {
    await assertScopeInTenant(p.scope, p.scopeId, tenantId, 'write');
  }
}

/** Optional numeric request field: undefined / null / '' → null. */
function optInt(v: unknown): number | null {
  return v === undefined || v === null || v === '' ? null : (v as number);
}

/** scopeId of a request: a number or a decimal string (older clients); anything else fails validation. */
function optScopeId(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^d+$/.test(v)) return Number(v);
  return NaN;
}

/** True when the request carries the key (an explicit null counts: it clears the field). */
function sent<T extends object>(data: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined;
}

// ── Service ──────────────────────────────────────────────────────────────────

class RateLimitPolicyService {
  /**
   * List policies for a single scope (RBAC mirrors the whitelist rules).
   * Global policies apply to every tenant, so every tenant reads them (as in
   * listAll); the platform role grants nothing extra (W10-5). `tenantIds`
   * (tenant chips) narrows the Default view to the rows those tenants own.
   */
  async listByScope(
    scope: RateLimitScope,
    scopeId: number | null,
    tenantId: number,
    _isAdmin?: boolean,
    tenantIds?: number[],
  ): Promise<RateLimitPolicyListItem[]> {
    const query = listQuery();

    if (scope === 'global') {
      query.where('p.scope', 'global');
    } else if (scope === 'tenant') {
      query.where('p.scope', 'tenant');
      if (!isMasterTenant(tenantId)) query.where('p.tenant_id', tenantId);
    } else if (scope === 'group' || scope === 'agent') {
      query.where('p.scope', scope);
      if (scopeId !== null) {
        await assertScopeInTenant(scope, scopeId, tenantId, 'read');
        query.where('p.scope_id', scopeId);
      }
      // Group/agent rows of the operating tenant only (W1-2); Default sees all.
      if (!isMasterTenant(tenantId)) query.where((b) => { orOwnedScopeRows(b, tenantId, 'p'); });
    } else {
      throw codedError(400, 'RATE_LIMIT_SCOPE_INVALID', `Unknown rate limit scope: ${scope as string}`);
    }
    if (isMasterTenant(tenantId)) whereReadTenants(query, 'p.tenant_id', readTenantsFor(tenantId, tenantIds));

    const rows = await query.orderBy('p.created_at', 'asc').orderBy('p.id', 'asc').limit(MAX_LIST) as RateLimitPolicyRow[];
    return rows.map(rowToListItem);
  }

  /**
   * List every policy visible to the caller across all scopes: everything
   * from Default (narrowed to the rows owned by `tenantIds` when given),
   * else the global policies plus the operating tenant's own.
   */
  async listAll(tenantId: number, tenantIds?: number[]): Promise<RateLimitPolicyListItem[]> {
    const query = listQuery();
    if (!isMasterTenant(tenantId)) {
      query.where((b) => {
        b.where('p.scope', 'global')
          .orWhere((t) => t.where('p.scope', 'tenant').where('p.tenant_id', tenantId));
        orOwnedScopeRows(b, tenantId, 'p');
      });
    } else {
      whereReadTenants(query, 'p.tenant_id', readTenantsFor(tenantId, tenantIds));
    }
    const rows = await query.orderBy('p.scope').orderBy('p.created_at', 'asc').orderBy('p.id', 'asc').limit(MAX_LIST) as RateLimitPolicyRow[];
    return rows.map(rowToListItem);
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
    const fields: PolicyFields = {
      type: data.type,
      scope,
      scopeId: scope === 'group' || scope === 'agent' ? optScopeId(data.scopeId) : null,
      enabled: data.enabled ?? true,
      port: optInt(data.port),
      maxValue: data.maxValue,
      banMultiplier: optInt(data.banMultiplier),
      action: data.action ?? 'drop',
      banTtlSeconds: optInt(data.banTtlSeconds),
    };
    validatePolicyFields(fields);
    await assertTargetWritable(fields, tenantId);

    const [row] = await db<RateLimitPolicyRow>('rate_limit_policies')
      .insert({
        type: fields.type,
        scope,
        scope_id: fields.scopeId,
        tenant_id: scope === 'global' ? null : tenantId,
        enabled: fields.enabled,
        port: fields.port,
        max_value: fields.maxValue,
        ban_multiplier: fields.banMultiplier,
        action: fields.action,
        ban_ttl_seconds: fields.banTtlSeconds,
        created_by: userId || null,
      } as unknown as RateLimitPolicyRow)
      .returning('*');

    if (!row) throw codedError(500, 'RATE_LIMIT_POLICY_CREATE_FAILED', 'Failed to create rate limit policy');
    return rowToPolicy(row);
  }

  /**
   * Edits a policy (any field, incl. enabled and the target); the create rules
   * apply to the merged result. Only the owner may edit: a global policy from
   * Default, a local one from its owner tenant (a tenant whose agent/group
   * carries another tenant's row may delete it, not edit it); otherwise 403
   * from Default (read-only god view), 404 elsewhere.
   */
  async update(id: number, data: UpdateRateLimitPolicyRequest, tenantId: number): Promise<RateLimitPolicy> {
    const row = await db<RateLimitPolicyRow>('rate_limit_policies').where({ id }).first();
    if (!row) throw codedError(404, 'RATE_LIMIT_POLICY_NOT_FOUND', 'Rate limit policy not found');

    if (row.scope === 'global') {
      if (!isMasterTenant(tenantId)) {
        throw codedError(403, 'RATE_LIMIT_GLOBAL_DEFAULT_TENANT_ONLY', 'A global rate limit policy can only be edited from the Default tenant');
      }
    } else if (Number(row.tenant_id ?? MASTER_TENANT_ID) !== Number(tenantId)) {
      if (isMasterTenant(tenantId)) {
        throw codedError(403, 'FOREIGN_TENANT_READ_ONLY', 'This rate limit policy belongs to another tenant: read-only from the Default tenant');
      }
      throw codedError(404, 'RATE_LIMIT_POLICY_NOT_FOUND', 'Rate limit policy not found');
    }

    const cur = rowToPolicy(row);
    const scope = sent(data, 'scope') ? (data.scope as RateLimitScope) : cur.scope;
    const targeted = scope === 'group' || scope === 'agent';
    const fields: PolicyFields = {
      type: sent(data, 'type') ? (data.type as RateLimitType) : cur.type,
      scope,
      scopeId: !targeted ? null
        : sent(data, 'scopeId') ? optScopeId(data.scopeId)
        : scope === cur.scope ? cur.scopeId : null,
      enabled: sent(data, 'enabled') ? (data.enabled as boolean) : cur.enabled,
      port: sent(data, 'port') ? optInt(data.port) : cur.port,
      maxValue: sent(data, 'maxValue') ? (data.maxValue as number) : cur.maxValue,
      banMultiplier: sent(data, 'banMultiplier') ? optInt(data.banMultiplier) : cur.banMultiplier,
      action: sent(data, 'action') ? (data.action as RateLimitAction) : cur.action,
      banTtlSeconds: sent(data, 'banTtlSeconds') ? optInt(data.banTtlSeconds) : cur.banTtlSeconds,
    };
    // Disabling alone is always allowed: a row stored before these rules (e.g.
    // an action that does not suit its type, a limit beyond the bounds) can
    // still be switched off. Any other edit validates the merged result.
    const disableOnly = fields.enabled === false
      && (Object.keys(data) as Array<keyof UpdateRateLimitPolicyRequest>).every((k) => k === 'enabled' || data[k] === undefined);
    if (disableOnly) {
      const [updated] = await db<RateLimitPolicyRow>('rate_limit_policies')
        .where({ id })
        .update({ enabled: false, updated_at: new Date() } as unknown as RateLimitPolicyRow)
        .returning('*');
      if (!updated) throw codedError(404, 'RATE_LIMIT_POLICY_NOT_FOUND', 'Rate limit policy not found');
      return rowToPolicy(updated);
    }
    validatePolicyFields(fields);
    await assertTargetWritable(fields, tenantId);

    const [updated] = await db<RateLimitPolicyRow>('rate_limit_policies')
      .where({ id })
      .update({
        type: fields.type,
        scope: fields.scope,
        scope_id: fields.scopeId,
        tenant_id: fields.scope === 'global' ? null : tenantId,
        enabled: fields.enabled,
        port: fields.port,
        max_value: fields.maxValue,
        ban_multiplier: fields.banMultiplier,
        action: fields.action,
        ban_ttl_seconds: fields.banTtlSeconds,
        updated_at: new Date(),
      } as unknown as RateLimitPolicyRow)
      .returning('*');

    if (!updated) throw codedError(404, 'RATE_LIMIT_POLICY_NOT_FOUND', 'Rate limit policy not found');
    return rowToPolicy(updated);
  }

  /**
   * Deletes a policy, following the operating tenant (same rule as the
   * whitelist): a global policy only from Default; a local one by its owner
   * tenant or by the tenant owning the targeted group/agent; otherwise 403
   * from Default (read-only god view), 404 elsewhere.
   */
  async delete(id: number, tenantId: number): Promise<void> {
    const row = await db<RateLimitPolicyRow>('rate_limit_policies').where({ id }).first();
    if (!row) throw codedError(404, 'RATE_LIMIT_POLICY_NOT_FOUND', 'Rate limit policy not found');

    const target = row.scope === 'group' || row.scope === 'agent'
      ? await resolveScopeTenant(row.scope, row.scope_id)
      : null;
    switch (whitelistDeleteVerdict(row, target, tenantId)) {
      case 'forbidden-global':
        throw codedError(403, 'RATE_LIMIT_GLOBAL_DEFAULT_TENANT_ONLY', 'A global rate limit policy can only be removed from the Default tenant');
      case 'forbidden-foreign':
        throw codedError(403, 'FOREIGN_TENANT_READ_ONLY', 'This rate limit policy belongs to another tenant: read-only from the Default tenant');
      case 'not-found':
        throw codedError(404, 'RATE_LIMIT_POLICY_NOT_FOUND', 'Rate limit policy not found');
      default:
        break;
    }

    const deleted = await db('rate_limit_policies').where({ id }).del();
    if (!deleted) throw codedError(404, 'RATE_LIMIT_POLICY_NOT_FOUND', 'Rate limit policy not found');
  }

  /**
   * Resolves the rate limit rules delivered to a given agent, in priority
   * order: agent → group (closest → farthest) → tenant → global.
   *
   * Resolution is keyed by (type, port): the most specific scope wins, so an
   * agent-level rule overrides a group/tenant/global rule for the same
   * type+port combination. Only enabled policies are read. While the global
   * switch app_config 'rateLimitEnforcement' is off (the default) nothing is
   * delivered: [] (the agent clears its limits). `ignoreEnforcement` resolves
   * regardless of the switch (previews).
   */
  async resolveForAgent(
    deviceId: number,
    groupIds: number[],
    tenantId: number,
    opts: { ignoreEnforcement?: boolean } = {},
  ): Promise<RateLimitRule[]> {
    if (!opts.ignoreEnforcement && (await appConfigService.getRateLimitEnforcement()) !== 'on') return [];

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
      .where({ scope: 'agent', scope_id: deviceId, tenant_id: tenantId, enabled: true })
      .orderBy('created_at', 'asc'));

    // 2. Group-level (closest ancestor first)
    for (const groupId of groupIds) {
      collect(await db<RateLimitPolicyRow>('rate_limit_policies')
        .where({ scope: 'group', scope_id: groupId, tenant_id: tenantId, enabled: true })
        .orderBy('created_at', 'asc'));
    }

    // 3. Tenant-level
    collect(await db<RateLimitPolicyRow>('rate_limit_policies')
      .where({ scope: 'tenant', tenant_id: tenantId, enabled: true })
      .orderBy('created_at', 'asc'));

    // 4. Global
    collect(await db<RateLimitPolicyRow>('rate_limit_policies')
      .where({ scope: 'global', enabled: true })
      .orderBy('created_at', 'asc'));

    return [...resolved.values()];
  }
}

export const rateLimitPolicyService = new RateLimitPolicyService();
