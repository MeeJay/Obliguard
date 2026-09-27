/**
 * Operating-tenant write rules (A5). Pure: no db import.
 *
 * Owner model: reads may cross tenants from the Default tenant (god view),
 * WRITES follow the operating tenant. The platform role grants nothing extra:
 * an admin switches tenant to change another tenant's data.
 */
import { MASTER_TENANT_ID, isMasterTenant } from '@obliview/shared';

export const FOREIGN_DEVICE_READ_ONLY = 'This agent belongs to another tenant: read-only from the Default tenant';

export type AccessVerdict = 'ok' | 'forbidden' | 'not-found';

/**
 * - same tenant                 → ok (read and write);
 * - Default tenant, read        → ok (god view);
 * - Default tenant, write       → forbidden (403, read-only god view);
 * - any other tenant            → not-found (404, existence never revealed).
 */
export function deviceAccessVerdict(deviceTenantId: number, tenantId: number, mode: 'read' | 'write'): AccessVerdict {
  if (Number(deviceTenantId) === Number(tenantId)) return 'ok';
  if (mode === 'read' && isMasterTenant(tenantId)) return 'ok';
  if (isMasterTenant(tenantId)) return 'forbidden';
  return 'not-found';
}

/**
 * Who may delete a whitelist entry. The platform role grants nothing extra.
 * - global entry: only from the Default tenant;
 * - local entry: its owner tenant (legacy NULL owner = Default), or the tenant
 *   that owns the targeted agent/group (a victim may remove an entry planted on
 *   its own agent or group);
 * - otherwise 403 from Default (read-only god view), 404 elsewhere.
 */
export function whitelistDeleteVerdict(
  row: { scope: string; tenant_id: number | null },
  targetTenantId: number | null,
  tenantId: number,
): 'ok' | 'forbidden-global' | 'forbidden-foreign' | 'not-found' {
  if (row.scope === 'global') return isMasterTenant(tenantId) ? 'ok' : 'forbidden-global';
  const owner = row.tenant_id ?? MASTER_TENANT_ID;
  if (tenantId === owner || (targetTenantId != null && tenantId === targetTenantId)) return 'ok';
  return isMasterTenant(tenantId) ? 'forbidden-foreign' : 'not-found';
}
