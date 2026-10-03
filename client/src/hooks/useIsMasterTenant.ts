import { useTenantStore } from '@/store/tenantStore';
import { MASTER_TENANT_ID, isMasterTenant } from '@obliview/shared';

/** True when the active tenant is the master/Default tenant — the
 *  god view that aggregates every child tenant's data. UI code uses
 *  this to switch between strict tenant scoping and the cross-tenant
 *  view (tenant badges on lists, the tenant filter chips, the global
 *  ban Lift instead of the per-tenant Exclude, etc).
 *
 *  Re-exports the constant so call sites that need both the boolean
 *  and the literal id (e.g. for query-param building) only import this. */
export function useIsMasterTenant(): boolean {
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  return isMasterTenant(currentTenantId);
}

export { MASTER_TENANT_ID };
