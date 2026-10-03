/**
 * Ban visibility predicates, shared by the ban list, GET /bans/:id, the ban
 * stats and IP reputation. No service import (no cycle).
 *
 * Only the Default tenant (god view) sees every ban (decision 5, W10-5): the
 * platform role grants nothing extra, so a platform admin standing on a
 * customer tenant sees what that tenant sees. Any other tenant sees global
 * bans plus its own tenant/group/agent bans.
 *
 * `isAdmin` is still accepted (callers pass it for their display fields) but
 * no longer widens visibility.
 */
import type { Knex } from 'knex';
import { isMasterTenant } from '@obliview/shared';
import type { ReadTenants } from '../middleware/tenant';

export function seesAllBans(tenantId: number | null | undefined, _isAdmin?: boolean): boolean {
  return isMasterTenant(tenantId);
}

export function applyBanVisibility<Q extends Knex.QueryBuilder>(
  q: Q,
  tenantId: number | null | undefined,
  isAdmin: boolean,
  alias = 'ip_bans',
): Q {
  if (seesAllBans(tenantId, isAdmin)) return q;
  return applyBanReadTenants(q, tenantId == null ? [] : [tenantId], alias);
}

/**
 * Bans the given read tenants are subject to (resolveReadTenants): every ban
 * for 'all', else the global bans plus the bans owned by those tenants.
 */
export function applyBanReadTenants<Q extends Knex.QueryBuilder>(q: Q, tenants: ReadTenants, alias = 'ip_bans'): Q {
  if (tenants === 'all') return q;
  if (tenants.length === 0) return q.where(`${alias}.scope`, 'global') as Q;
  return q.where((b) => {
    b.where(`${alias}.scope`, 'global').orWhereIn(`${alias}.tenant_id`, tenants);
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

/** The ban author (banned_by_user_id) is shown to the owning/origin tenant and Default only. */
export function canSeeBanAuthor(
  row: { tenant_id: number | null; origin_tenant_id: number | null },
  tenantId: number | null | undefined,
  isAdmin: boolean,
): boolean {
  return seesAllBans(tenantId, isAdmin)
    || (row.tenant_id != null && row.tenant_id === tenantId)
    || (row.origin_tenant_id != null && row.origin_tenant_id === tenantId);
}
