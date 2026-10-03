import type { Server as SocketIOServer } from 'socket.io';
import type { Knex } from 'knex';
import { db } from '../db';
import { SOCKET_EVENTS, MASTER_TENANT_ID, isMasterTenant } from '@obliview/shared';

let _io: SocketIOServer | null = null;

export function setLiveAlertIO(io: SocketIOServer): void {
  _io = io;
}

export type LiveAlertSeverity = 'down' | 'up' | 'warning' | 'info';

export interface LiveAlertRow {
  id: number;
  tenantId: number;
  tenantName?: string;
  severity: LiveAlertSeverity;
  title: string;
  message: string;
  navigateTo: string | null;
  stableKey: string | null;
  read: boolean;
  /** ISO time the alert was marked read, or null. */
  readAt: string | null;
  createdAt: string; // ISO
  /** Incident fields (migration 034); null / 1 for a plain alert. */
  incidentKind: LiveAlertIncidentKind | null;
  deviceId: number | null;
  resolvedAt: string | null;
  /** How many times the open incident was raised (1 = once). */
  occurrences: number;
  /** ISO time of the last raise, or null. */
  updatedAt: string | null;
}

function iso(v: unknown): string | null {
  return v ? new Date(v as string | Date).toISOString() : null;
}

function rowToAlert(row: Record<string, unknown>): LiveAlertRow {
  return {
    id: row.id as number,
    tenantId: row.tenant_id as number,
    tenantName: row.tenant_name as string | undefined,
    severity: row.severity as LiveAlertRow['severity'],
    title: row.title as string,
    message: row.message as string,
    navigateTo: row.navigate_to as string | null,
    stableKey: row.stable_key as string | null,
    read: row.read_at != null,
    readAt: iso(row.read_at),
    createdAt: (row.created_at as Date).toISOString(),
    incidentKind: (row.incident_kind as LiveAlertIncidentKind | null | undefined) ?? null,
    deviceId: (row.device_id as number | null | undefined) ?? null,
    resolvedAt: iso(row.resolved_at),
    occurrences: Number(row.occurrences ?? 1),
    updatedAt: iso(row.updated_at),
  };
}

// ─── Incidents ───────────────────────────────────────────────────────────────
// Ported from Obliance (services/liveAlert.service.ts). An incident is one
// problem with a recovery counterpart, identified by a stable key inside a
// tenant (e.g. `agent_offline:device:42`). While it lasts, at most ONE row
// of it is active (`resolved_at IS NULL`):
//
//   - raiseIncident on an open key bumps that row (occurrences + 1,
//     updated_at, latest title/message) instead of adding a new one; a raise
//     with another severity resolves the open row and inserts a new one (an
//     escalation is notified again: higher id);
//   - the recovery resolves the row (NOTIFICATION_RESOLVED) instead of adding
//     a "back to normal" alert: that message only goes to the notification
//     channels.
//
// Resolved rows are hidden from the lists (the API returns them with
// ?includeResolved=1) and age out through cleanup(); the per-tenant trim
// keeps active rows first.
//
// Audience (owner decision): every member of the alert's tenant, plus the
// Default tenant (god view). Socket events go to the tenant's notification
// room and to the Default tenant's.

/** Incident kinds the producers raise (owner decision on live alerts). */
export const LIVE_ALERT_INCIDENT_KINDS = [
  'agent_offline',
  'ban_burst',
  'blocklist_sync_failed',
  'mikrotik_sync_failed',
  'agent_update_failed',
  'agent_pending',
] as const;
export type LiveAlertIncidentKind = typeof LIVE_ALERT_INCIDENT_KINDS[number];

/** Rows kept per tenant (active rows first). */
export const LIVE_ALERTS_PER_TENANT = 500;

/** Incidents per resolve transaction (advisory locks + bind parameters). */
const RESOLVE_CHUNK = 200;

/**
 * Conventional stable key of an incident: `<kind>:<subject>`, e.g.
 * incidentStableKey('agent_offline', `device:${id}`). Producers may use any
 * key; it only has to be stable for one problem of one tenant.
 */
export function incidentStableKey(kind: LiveAlertIncidentKind, subject: string | number): string {
  return `${kind}:${subject}`;
}

export interface RaiseIncidentInput {
  tenantId: number;
  kind: LiveAlertIncidentKind;
  stableKey: string;
  deviceId?: number | null;
  title: string;
  message: string;
  severity: LiveAlertSeverity;
  /** In-app route opened from the bell (navigate_to). */
  link?: string | null;
}

export interface RaiseIncidentResult {
  alert: LiveAlertRow;
  /** true: a new row (NOTIFICATION_NEW emitted); false: the open row was bumped. */
  created: boolean;
}

/** Resolve selector: a stable key, or a device (optionally one kind of it). */
export interface ResolveIncidentsInput {
  /** Restrict to one tenant; omitted = every tenant (a device moved between tenants). */
  tenantId?: number;
  stableKey?: string;
  deviceId?: number;
  kind?: LiveAlertIncidentKind;
}

type TenantRow = { id: number; tenant_id: number };

/** Notification rooms of a tenant's alert audience: the tenant and Default. */
function audienceRooms(tenantId: number): string[] {
  const rooms = [`tenant:${tenantId}:notifications`];
  if (!isMasterTenant(tenantId)) rooms.push(`tenant:${MASTER_TENANT_ID}:notifications`);
  return rooms;
}

function groupByTenant(rows: TenantRow[]): Map<number, number[]> {
  const byTenant = new Map<number, number[]>();
  for (const r of rows) {
    const list = byTenant.get(r.tenant_id) ?? [];
    list.push(r.id);
    byTenant.set(r.tenant_id, list);
  }
  return byTenant;
}

/**
 * Tell the open clients that these rows left the lists:
 * NOTIFICATION_RESOLVED `{ tenantId, ids }`, same audience as NOTIFICATION_NEW.
 */
function emitResolved(rows: TenantRow[]): void {
  if (!_io || rows.length === 0) return;
  for (const [tenantId, ids] of groupByTenant(rows)) {
    _io.to(audienceRooms(tenantId)).emit(SOCKET_EVENTS.NOTIFICATION_RESOLVED, { tenantId, ids });
  }
}

function incidentLockKey(tenantId: number, stableKey: string): string {
  return `live_alert_incident:${tenantId}:${stableKey}`;
}

/**
 * Take the advisory locks of several incidents in the current transaction,
 * sorted by lock id so two multi-incident transactions never deadlock.
 */
async function lockIncidents(trx: Knex.Transaction, lockKeys: string[]): Promise<void> {
  if (lockKeys.length === 0) return;
  await trx.raw(
    `SELECT count(pg_advisory_xact_lock(h)) FROM unnest(
       (SELECT array_agg(DISTINCT hashtext(k) ORDER BY hashtext(k)) FROM unnest(?::text[]) AS k)
     ) AS h`,
    [lockKeys],
  );
}

/**
 * Keep only the newest LIVE_ALERTS_PER_TENANT rows of a tenant. Active rows
 * are kept first, so the resolved history of a flapping agent never pushes
 * a still-open alert out. Dropped active rows leave the open clients.
 */
async function trimTenant(tenantId: number): Promise<void> {
  const res = await db.raw(
    `DELETE FROM live_alerts WHERE tenant_id = ? AND id NOT IN (
       SELECT id FROM live_alerts WHERE tenant_id = ?
        ORDER BY (resolved_at IS NULL) DESC, id DESC
        LIMIT ?
     ) RETURNING id, tenant_id, resolved_at`,
    [tenantId, tenantId, LIVE_ALERTS_PER_TENANT],
  ) as { rows?: Array<{ id: number; tenant_id: number; resolved_at: Date | null }> };
  const droppedActive = (res.rows ?? []).filter((r) => r.resolved_at == null);
  emitResolved(droppedActive.map((r) => ({ id: r.id, tenant_id: r.tenant_id })));
}

/** Enrich with the tenant name and broadcast NOTIFICATION_NEW. */
async function announce(row: Record<string, unknown>, tenantId: number): Promise<LiveAlertRow> {
  const alert = rowToAlert(row);
  const tenantRow = await db('tenants').where({ id: tenantId }).select('name').first() as { name: string } | undefined;
  const enriched: LiveAlertRow = { ...alert, tenantName: tenantRow?.name ?? '' };
  if (_io) {
    _io.to(audienceRooms(tenantId)).emit(SOCKET_EVENTS.NOTIFICATION_NEW, enriched);
  }
  return enriched;
}

function assertIncidentInput(input: RaiseIncidentInput): void {
  if (!Number.isInteger(input.tenantId) || input.tenantId <= 0) throw new Error('raiseIncident: invalid tenantId');
  if (!(LIVE_ALERT_INCIDENT_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`raiseIncident: unknown incident kind "${input.kind}"`);
  }
  if (typeof input.stableKey !== 'string' || input.stableKey.length === 0 || input.stableKey.length > 255) {
    throw new Error('raiseIncident: stableKey must be 1-255 characters');
  }
}

/** Options of the list queries. */
export interface ListAlertsOptions {
  /** Also return resolved incidents (hidden by default). */
  includeResolved?: boolean;
}

export const liveAlertService = {
  /**
   * Add a plain (non-incident) live alert. If stableKey is provided, the
   * insert is skipped when an unread, unresolved alert with the same
   * (tenant_id, stable_key) already exists. Returns the inserted row, or null
   * if dedup skipped it. Emits NOTIFICATION_NEW. Problems that recover use
   * raiseIncident / resolveIncidents instead.
   */
  async add(
    tenantId: number,
    opts: {
      severity: LiveAlertSeverity;
      title: string;
      message: string;
      navigateTo?: string | null;
      stableKey?: string | null;
    },
  ): Promise<LiveAlertRow | null> {
    if (opts.stableKey) {
      const existing = await db('live_alerts')
        .where({ tenant_id: tenantId, stable_key: opts.stableKey })
        .whereNull('read_at')
        .whereNull('resolved_at')
        .first();
      if (existing) return null;
    }

    const [row] = await db('live_alerts')
      .insert({
        tenant_id: tenantId,
        severity: opts.severity,
        title: opts.title,
        message: opts.message,
        navigate_to: opts.navigateTo ?? null,
        stable_key: opts.stableKey ?? null,
      })
      .returning('*');

    await trimTenant(tenantId);
    return announce(row as Record<string, unknown>, tenantId);
  },

  /**
   * Raise (or re-raise) an incident of a tenant. Serialised per (tenant,
   * stable key) with an advisory lock, so two producers raising the same
   * problem at once leave a single active row.
   *
   *   - an active row with the same key and severity: bumped (occurrences
   *     + 1, updated_at, latest title / message / link); nothing is emitted;
   *   - otherwise every active row of the key is resolved
   *     (NOTIFICATION_RESOLVED) and a new row is inserted (NOTIFICATION_NEW).
   */
  async raiseIncident(input: RaiseIncidentInput): Promise<RaiseIncidentResult> {
    assertIncidentInput(input);
    const now = new Date();
    const { row, created, resolved } = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [incidentLockKey(input.tenantId, input.stableKey)]);
      const active = await trx('live_alerts')
        .where({ tenant_id: input.tenantId, stable_key: input.stableKey })
        .whereNull('resolved_at')
        .orderBy('id', 'desc')
        .select('id', 'tenant_id', 'severity') as Array<TenantRow & { severity: string }>;
      const keep = active.find((r) => r.severity === input.severity);
      const stale = active.filter((r) => r !== keep).map((r) => r.id);
      let resolvedRows: TenantRow[] = [];
      if (stale.length > 0) {
        resolvedRows = await trx('live_alerts')
          .whereIn('id', stale)
          .whereNull('resolved_at')
          .update({ resolved_at: now })
          .returning(['id', 'tenant_id']) as TenantRow[];
      }
      if (keep) {
        // whereNull: a resolve whose locks did not cover this key (a large
        // device-wide resolve runs in chunks) may have closed the row since
        // it was read; the raise then opens a fresh incident below.
        const [bumped] = await trx('live_alerts')
          .where({ id: keep.id })
          .whereNull('resolved_at')
          .update({
            occurrences: trx.raw('occurrences + 1'),
            updated_at: now,
            title: input.title,
            message: input.message,
            navigate_to: input.link ?? null,
            incident_kind: input.kind,
            device_id: input.deviceId ?? null,
          })
          .returning('*');
        if (bumped) return { row: bumped as Record<string, unknown>, created: false, resolved: resolvedRows };
      }
      const [inserted] = await trx('live_alerts')
        .insert({
          tenant_id: input.tenantId,
          severity: input.severity,
          title: input.title,
          message: input.message,
          navigate_to: input.link ?? null,
          stable_key: input.stableKey,
          incident_kind: input.kind,
          device_id: input.deviceId ?? null,
          occurrences: 1,
          updated_at: now,
        })
        .returning('*');
      return { row: inserted as Record<string, unknown>, created: true, resolved: resolvedRows };
    });

    // Resolved first, then the new row: clients drop the previous alert of
    // the incident before they show its replacement.
    emitResolved(resolved);
    if (!created) return { alert: rowToAlert(row), created: false };
    await trimTenant(input.tenantId);
    return { alert: await announce(row, input.tenantId), created: true };
  },

  /**
   * Recovery: resolve every active row matching the selector (a stable key,
   * or a device with an optional kind), in one tenant or, without tenantId,
   * in every tenant. Nothing is inserted. Emits NOTIFICATION_RESOLVED per
   * tenant and returns the resolved ids. Internal callers only (never with
   * a selector taken from a request).
   */
  async resolveIncidents(sel: ResolveIncidentsInput): Promise<number[]> {
    if (!sel.stableKey && sel.deviceId === undefined) {
      throw new Error('resolveIncidents: stableKey or deviceId is required');
    }
    const match = (qb: Knex.QueryBuilder): Knex.QueryBuilder => {
      qb.whereNull('resolved_at');
      if (sel.tenantId !== undefined) qb.where('tenant_id', sel.tenantId);
      if (sel.stableKey) qb.where('stable_key', sel.stableKey);
      if (sel.deviceId !== undefined) qb.where('device_id', sel.deviceId);
      if (sel.kind) qb.where('incident_kind', sel.kind);
      return qb;
    };
    const candidates = await match(db('live_alerts').select('tenant_id', 'stable_key')) as Array<{ tenant_id: number; stable_key: string | null }>;
    const lockKeys = [...new Set(candidates
      .filter((c) => c.stable_key)
      .map((c) => incidentLockKey(c.tenant_id, c.stable_key as string)))];
    if (sel.tenantId !== undefined && sel.stableKey) lockKeys.push(incidentLockKey(sel.tenantId, sel.stableKey));
    if (candidates.length === 0 && lockKeys.length === 0) return [];

    const ids: number[] = [];
    const keys = [...new Set(lockKeys)];
    // One transaction per chunk of locks; the UPDATE re-applies the selector
    // under the locks, so a raise that committed in between is resolved too.
    for (let i = 0; i < Math.max(keys.length, 1); i += RESOLVE_CHUNK) {
      const chunk = keys.slice(i, i + RESOLVE_CHUNK);
      const rows = await db.transaction(async (trx) => {
        await lockIncidents(trx, chunk);
        return await match(trx('live_alerts'))
          .update({ resolved_at: new Date() })
          .returning(['id', 'tenant_id']) as TenantRow[];
      });
      emitResolved(rows);
      ids.push(...rows.map((r) => r.id));
    }
    return ids;
  },

  /**
   * Fetch the alerts of a single tenant (newest id first). The Default
   * tenant gets every tenant's alerts (god view). Resolved incidents are
   * left out unless opts.includeResolved.
   */
  async getForTenant(tenantId: number, limit = 100, opts: ListAlertsOptions = {}): Promise<LiveAlertRow[]> {
    const q = db('live_alerts')
      .leftJoin('tenants', 'live_alerts.tenant_id', 'tenants.id')
      .select('live_alerts.*', 'tenants.name as tenant_name');
    if (!isMasterTenant(tenantId)) q.where('live_alerts.tenant_id', tenantId);
    if (!opts.includeResolved) q.whereNull('live_alerts.resolved_at');
    const rows = await q.orderBy('live_alerts.id', 'desc').limit(limit);
    return rows.map(rowToAlert);
  },

  /**
   * Fetch the alerts of the given tenants ('all': every tenant), enriched
   * with the tenant name (newest id first). Used for the multi-tenant
   * notification panel.
   */
  async getForTenants(tenantIds: number[] | 'all', limit = 200, opts: ListAlertsOptions = {}): Promise<LiveAlertRow[]> {
    if (tenantIds !== 'all' && tenantIds.length === 0) return [];
    const q = db('live_alerts')
      .join('tenants', 'live_alerts.tenant_id', 'tenants.id')
      .select('live_alerts.*', 'tenants.name as tenant_name');
    if (tenantIds !== 'all') q.whereIn('live_alerts.tenant_id', tenantIds);
    if (!opts.includeResolved) q.whereNull('live_alerts.resolved_at');
    const rows = await q.orderBy('live_alerts.id', 'desc').limit(limit);
    return rows.map(rowToAlert);
  },

  /** Mark one alert read. Returns the read time, or null when no row matched. */
  async markRead(id: number, tenantId: number): Promise<Date | null> {
    const readAt = new Date();
    const rows = await db('live_alerts')
      .where({ id, tenant_id: tenantId })
      .update({ read_at: readAt })
      .returning(['id']) as Array<{ id: number }>;
    return rows.length > 0 ? readAt : null;
  },

  /** Mark every unread, active alert of a tenant read. Returns the ids and the read time. */
  async markAllRead(tenantId: number): Promise<{ ids: number[]; readAt: Date }> {
    const readAt = new Date();
    const rows = await db('live_alerts')
      .where({ tenant_id: tenantId })
      .whereNull('read_at')
      .whereNull('resolved_at')
      .update({ read_at: readAt })
      .returning(['id']) as Array<{ id: number }>;
    return { ids: rows.map((r) => r.id), readAt };
  },

  /**
   * NOTIFICATION_READ `{ tenantId, ids, readAt }`: to the reader's own room
   * (their other tabs and devices) and to the tenant's alert audience (read
   * state is per tenant, so every open bell drops the unread mark).
   */
  emitRead(userId: number, tenantId: number, ids: number[], readAt: Date): void {
    if (!_io || ids.length === 0) return;
    _io.to([`user:${userId}`, ...audienceRooms(tenantId)])
      .emit(SOCKET_EVENTS.NOTIFICATION_READ, { tenantId, ids, readAt: readAt.toISOString() });
  },

  async deleteAlert(id: number): Promise<void> {
    await db('live_alerts').where({ id }).delete();
  },

  async clearAll(tenantId: number): Promise<void> {
    await db('live_alerts').where({ tenant_id: tenantId }).delete();
  },

  /** Per-tenant trim (exposed for the retention job and tests). */
  async trimTenant(tenantId: number): Promise<void> {
    await trimTenant(tenantId);
  },

  /**
   * Retention: delete plain alerts created, and incidents resolved, more than
   * `retentionDays` ago. Open incidents are kept whatever their age (the
   * problem is still there); those of a deleted agent are resolved first.
   * Returns the number of deleted rows.
   */
  async cleanup(retentionDays = 30): Promise<number> {
    const orphaned = await db.raw(
      `UPDATE live_alerts SET resolved_at = now()
        WHERE resolved_at IS NULL AND device_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM agent_devices d WHERE d.id = live_alerts.device_id)
        RETURNING id, tenant_id`,
    ) as { rows?: TenantRow[] };
    emitResolved(orphaned.rows ?? []);

    const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000);
    return db('live_alerts')
      .where(function () {
        this.where(function () {
          this.whereNotNull('resolved_at').where('resolved_at', '<', cutoff);
        }).orWhere(function () {
          this.whereNull('resolved_at').whereNull('incident_kind').where('created_at', '<', cutoff);
        });
      })
      .delete();
  },
};
