/**
 * Ban visibility predicates, shared by the ban list, GET /bans/:id, the ban
 * stats and IP reputation. No service import (no cycle).
 *
 * The Default tenant (god view) and platform admins see every ban (the
 * isAdmin clause keeps the historical list() behaviour until C8-3); any other
 * tenant sees global bans plus its own tenant/group/agent bans.
 */
import type { Knex } from 'knex';
import { isMasterTenant } from '@obliview/shared';

export function seesAllBans(tenantId: number | null | undefined, isAdmin: boolean): boolean {
  return isAdmin || isMasterTenant(tenantId);
}

export function applyBanVisibility<Q extends Knex.QueryBuilder>(
  q: Q,
  tenantId: number | null | undefined,
  isAdmin: boolean,
  alias = 'ip_bans',
): Q {
  if (seesAllBans(tenantId, isAdmin)) return q;
  if (tenantId == null) return q.where(`${alias}.scope`, 'global') as Q;
  return q.where((b) => {
    b.where(`${alias}.scope`, 'global').orWhere(`${alias}.tenant_id`, tenantId);
  }) as Q;
}

export function canSeeBan(
  row: { scope: string; tenant_id: number | null },
  tenantId: number | null | undefined,
  isAdmin: boolean,
): boolean {
  return seesAllBans(tenantId, isAdmin)
    || row.scope === 'global'
    || (row.tenant_id != null && row.tenant_id === tenantId);
}

/** The ban author (banned_by_user_id) is shown to the owning/origin tenant, Default and platform admins only. */
export function canSeeBanAuthor(
  row: { tenant_id: number | null; origin_tenant_id: number | null },
  tenantId: number | null | undefined,
  isAdmin: boolean,
): boolean {
  return seesAllBans(tenantId, isAdmin)
    || (row.tenant_id != null && row.tenant_id === tenantId)
    || (row.origin_tenant_id != null && row.origin_tenant_id === tenantId);
}
