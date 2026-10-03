import type { Knex } from 'knex';
import { isMasterTenant } from '@obliview/shared';
import { db } from '../db';
import { codedError } from '../utils/errorCodes';
import { deviceAccessVerdict, FOREIGN_DEVICE_READ_ONLY } from '../utils/tenantWriteRules';

/**
 * Ownership of group/agent scope ids (W1-2).
 *
 * Whitelist entries, rate-limit policies and local template assignments carry
 * a (scope, scope_id) pair. For 'group' and 'agent' the id points at a row of
 * another table (monitor_groups / agent_devices) that belongs to exactly one
 * tenant, and the operating tenant may only target its own rows.
 *
 * Same verdict as device access (tenantWriteRules.deviceAccessVerdict):
 *   - own tenant                  → ok;
 *   - Default tenant, read        → ok (god view of operational reads);
 *   - Default tenant, write       → 403 (only global Lift and the global
 *                                   whitelist are cross-tenant writes);
 *   - any other tenant            → 404 (existence never revealed).
 */

export type ScopeKind = 'global' | 'tenant' | 'group' | 'agent';

const FOREIGN_GROUP_READ_ONLY = 'This group belongs to another tenant: read-only from the Default tenant';

function parseScopeId(scopeId: unknown): number {
  const id = typeof scopeId === 'number' ? scopeId : Number(scopeId);
  if (!Number.isSafeInteger(id) || id <= 0) throw codedError(400, 'SCOPE_ID_INVALID', 'Invalid scopeId');
  return id;
}

/**
 * Tenant owning a scope target: the group's / agent's tenant, the tenant id
 * itself for scope 'tenant', null for 'global' or a missing target.
 */
export async function resolveScopeTenant(
  scope: ScopeKind | string,
  scopeId: number | null | undefined,
  conn: Knex = db,
): Promise<number | null> {
  if (scopeId == null) return null;
  if (scope === 'tenant') return Number(scopeId);
  if (scope === 'agent') {
    const r = await conn('agent_devices').where({ id: scopeId }).first('tenant_id') as { tenant_id: number } | undefined;
    return r ? Number(r.tenant_id) : null;
  }
  if (scope === 'group') {
    const r = await conn('monitor_groups').where({ id: scopeId }).first('tenant_id') as { tenant_id: number } | undefined;
    return r ? Number(r.tenant_id) : null;
  }
  return null;
}

/**
 * Throws unless the operating tenant may use (scope, scopeId).
 * 'global' never carries an id (who may write global rows is the caller's
 * rule); 'tenant' must name the operating tenant when an id is given;
 * 'group' / 'agent' require an existing target of the operating tenant.
 */
export async function assertScopeInTenant(
  scope: ScopeKind | string,
  scopeId: unknown,
  tenantId: number,
  mode: 'read' | 'write' = 'write',
): Promise<void> {
  if (scope === 'global') return;
  if (scope === 'tenant') {
    if (scopeId == null || scopeId === '') return;
    const id = parseScopeId(scopeId);
    if (id === Number(tenantId)) return;
    if (mode === 'read' && isMasterTenant(tenantId)) return;
    if (isMasterTenant(tenantId)) throw codedError(403, 'FOREIGN_TENANT_READ_ONLY', 'This scope belongs to another tenant: read-only from the Default tenant');
    throw codedError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
  }
  if (scope !== 'group' && scope !== 'agent') throw codedError(400, 'SCOPE_INVALID', `Unknown scope: ${String(scope)}`);

  const id = parseScopeId(scopeId);
  const what = scope === 'agent' ? 'Device' : 'Group';
  const notFoundCode = scope === 'agent' ? 'AGENT_NOT_FOUND' : 'GROUP_NOT_FOUND';
  const owner = await resolveScopeTenant(scope, id);
  if (owner == null) throw codedError(404, notFoundCode, `${what} not found`);
  switch (deviceAccessVerdict(owner, tenantId, mode)) {
    case 'ok':
      return;
    case 'forbidden':
      throw codedError(403, 'FOREIGN_TENANT_READ_ONLY', scope === 'agent' ? FOREIGN_DEVICE_READ_ONLY : FOREIGN_GROUP_READ_ONLY);
    default:
      throw codedError(404, notFoundCode, `${what} not found`);
  }
}

/**
 * Restricts a query on a (scope, scope_id) table to group/agent rows whose
 * target belongs to `tenantId`. Add it inside an OR group, e.g.
 *   q.where((b) => { b.where({ scope: 'global' }); orOwnedScopeRows(b, tenantId); })
 */
export function orOwnedScopeRows(b: Knex.QueryBuilder, tenantId: number, table?: string): Knex.QueryBuilder {
  const col = (c: string) => (table ? `${table}.${c}` : c);
  return b
    .orWhere((s) => s.where(col('scope'), 'agent')
      .whereIn(col('scope_id'), db('agent_devices').select('id').where('tenant_id', tenantId)))
    .orWhere((s) => s.where(col('scope'), 'group')
      .whereIn(col('scope_id'), db('monitor_groups').select('id').where('tenant_id', tenantId)));
}

/**
 * Keeps the group/agent items whose target belongs to `tenantId` (other
 * scopes pass through). The Default tenant keeps everything (god view).
 */
export async function filterOwnedScopeItems<T extends { scope: string; scopeId: number | null }>(
  items: T[],
  tenantId: number,
): Promise<T[]> {
  if (isMasterTenant(tenantId) || items.length === 0) return items;
  const ids = (scope: string) => items.filter((i) => i.scope === scope && i.scopeId != null).map((i) => i.scopeId as number);
  const agentIds = ids('agent');
  const groupIds = ids('group');
  const ownAgents = new Set(agentIds.length === 0 ? [] : (await db('agent_devices')
    .whereIn('id', agentIds).where('tenant_id', tenantId).pluck('id') as number[]).map(Number));
  const ownGroups = new Set(groupIds.length === 0 ? [] : (await db('monitor_groups')
    .whereIn('id', groupIds).where('tenant_id', tenantId).pluck('id') as number[]).map(Number));
  return items.filter((i) => {
    if (i.scope === 'agent') return i.scopeId != null && ownAgents.has(Number(i.scopeId));
    if (i.scope === 'group') return i.scopeId != null && ownGroups.has(Number(i.scopeId));
    return true;
  });
}
