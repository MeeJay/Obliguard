import type { Request, Response, NextFunction } from 'express';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { liveAlertService } from '../services/liveAlert.service';
import { db } from '../db';

// Audience of the live alerts (owner decision): every member of the alert's
// tenant, plus the Default tenant (god view: its members and the platform
// admins see every tenant's alerts). Reading (and marking read) follows the
// audience; deleting stays with the tenant's own members and the platform
// admins (the god view covers reads, not another tenant's data).

/** ?includeResolved=1|true also returns the resolved incidents. */
function includeResolved(req: Request): boolean {
  const raw = req.query.includeResolved;
  return raw === '1' || raw === 'true';
}

function parseAlertId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function memberTenantIds(userId: number): Promise<number[]> {
  return await db('user_tenants').where('user_id', userId).pluck('tenant_id') as number[];
}

/** Tenants whose alerts the user may read: 'all' for platform admins and Default members. */
async function readableTenants(req: Request): Promise<number[] | 'all'> {
  if (req.session.role === 'admin') return 'all';
  const ids = await memberTenantIds(req.session.userId!);
  return ids.includes(MASTER_TENANT_ID) ? 'all' : ids;
}

/** Alert row by id when its tenant is in `scope`, else undefined. */
async function alertIn(id: number, scope: number[] | 'all'): Promise<{ id: number; tenant_id: number } | undefined> {
  const q = db('live_alerts').where({ id });
  if (scope !== 'all') q.whereIn('tenant_id', scope);
  return await q.first('id', 'tenant_id') as { id: number; tenant_id: number } | undefined;
}

/** GET /api/live-alerts — current tenant (Default: every tenant). ?includeResolved=1 */
export async function getAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const alerts = await liveAlertService.getForTenant(req.tenantId, 100, { includeResolved: includeResolved(req) });
    res.json(alerts);
  } catch (err) { next(err); }
}

/**
 * GET /api/live-alerts/all — all tenants whose alerts this user may read.
 * Returns { alerts, tenants } where alerts are enriched with tenantName.
 * ?includeResolved=1 also returns the resolved incidents.
 */
export async function getAllTenantAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const scope = await readableTenants(req);
    const tenantsQ = db('tenants').select('tenants.id', 'tenants.name').orderBy('tenants.id');
    if (scope !== 'all') tenantsQ.whereIn('tenants.id', scope);
    const tenants = await tenantsQ as { id: number; name: string }[];

    const alerts = await liveAlertService.getForTenants(scope, 200, { includeResolved: includeResolved(req) });
    res.json({ alerts, tenants });
  } catch (err) { next(err); }
}

/** PATCH /api/live-alerts/:id/read — mark one alert as read (cross-tenant, within the audience) */
export async function markRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseAlertId(req.params.id);
    const alert = id === null ? undefined : await alertIn(id, await readableTenants(req));
    if (!alert) { res.status(404).json({ error: 'Alert not found' }); return; }

    const readAt = await liveAlertService.markRead(alert.id, alert.tenant_id);
    if (readAt) liveAlertService.emitRead(req.session.userId!, alert.tenant_id, [alert.id], readAt);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** POST /api/live-alerts/read-all — mark all as read for current tenant */
export async function markAllRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ids, readAt } = await liveAlertService.markAllRead(req.tenantId);
    liveAlertService.emitRead(req.session.userId!, req.tenantId, ids, readAt);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** DELETE /api/live-alerts/:id — delete one alert (a tenant the user belongs to; platform admins: any) */
export async function deleteAlert(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseAlertId(req.params.id);
    const scope = req.session.role === 'admin' ? 'all' as const : await memberTenantIds(req.session.userId!);
    const alert = id === null ? undefined : await alertIn(id, scope);
    if (!alert) { res.status(404).json({ error: 'Alert not found' }); return; }

    await liveAlertService.deleteAlert(alert.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/** DELETE /api/live-alerts — clear all for current tenant */
export async function clearAll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await liveAlertService.clearAll(req.tenantId);
    res.json({ ok: true });
  } catch (err) { next(err); }
}
