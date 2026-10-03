import type { Request } from 'express';
import { db } from '../db';
import { clientIp } from '../utils/clientIp';
import { logger } from '../utils/logger';
import type { ReadTenants } from '../middleware/tenant';

/**
 * Audit log (W11-1), ported from Obliance services/audit.service.ts.
 *
 * "Who did what, when, from where, on which agent, and did it work": one
 * audit_logs row per sensitive action (logins, 2FA, users / teams / tenants /
 * permission sets, bans, whitelist, remote blocklists, instance keys, agents,
 * enrolment keys, firewall rules, policies, notification channels...).
 *
 * Rules:
 *   - log() never throws: auditing must never break the request it records.
 *     A failed insert is logged (warn) and swallowed;
 *   - secrets are never stored: every `details` key containing password,
 *     secret, token, key, credential, otp, cookie or authorization is
 *     replaced by '[redacted]' (recursively), whatever the caller passed.
 *     Callers record WHICH setting changed, never its value;
 *   - an action on an agent is filed in the agent's tenant (Obliance
 *     logReqAs): a Default-tenant admin acting on a customer's agent leaves
 *     a trace in that customer's own log;
 *   - tenant_id NULL = instance-level row (failed login of an unknown
 *     account, instance configuration): read only from the Default tenant's
 *     god view.
 *
 * Reads: Default sees every tenant (optionally narrowed by ?tenants= chips),
 * any other tenant only its own rows (ReadTenants, middleware/tenant).
 */

/** Keys whose VALUE is never written to the audit trail. */
const SECRET_KEY_RE = /password|passwd|secret|token|key|credential|otp|cookie|authorization/i;
export const REDACTED = '[redacted]';

const MAX_DEPTH = 6;
const MAX_ARRAY = 200;
const MAX_STRING = 2000;
const MAX_DETAILS_BYTES = 16 * 1024;
const MAX_USER_AGENT = 512;

/** Retention of audit rows (owner default: 365 days; env AUDIT_RETENTION_DAYS). */
export const AUDIT_RETENTION_DAYS = (() => {
  const n = Number(process.env.AUDIT_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 365;
})();

/** Copy of `value` with secret-named keys redacted and sizes bounded. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redactSecrets(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`… ${value.length - MAX_ARRAY} more`);
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === 'function') continue;
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function serializeDetails(details: Record<string, unknown> | null | undefined): string | null {
  if (!details || typeof details !== 'object') return null;
  const clean = redactSecrets(details) as Record<string, unknown>;
  if (Object.keys(clean).length === 0) return null;
  const json = JSON.stringify(clean);
  if (Buffer.byteLength(json) <= MAX_DETAILS_BYTES) return json;
  return JSON.stringify({ truncated: true, keys: Object.keys(clean).slice(0, 50) });
}

export interface AuditEntry {
  /** Owning tenant; null = instance-level row (Default god view only). */
  tenantId: number | null;
  userId?: number | null;
  /** Actor name snapshot (or the attempted name of a failed login). */
  username?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  deviceId?: number | null;
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  success?: boolean;
}

/** What a route handler passes to logReq (actor, tenant and origin come from the request). */
export interface AuditReqEntry {
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  deviceId?: number | null;
  /** Override the request's operating tenant (agent tenant, instance-level null). */
  tenantId?: number | null;
  details?: Record<string, unknown> | null;
  success?: boolean;
  /** Override the session actor (login: the account being signed in). */
  userId?: number | null;
  username?: string | null;
}

export interface AuditLogRow {
  id: number;
  tenantId: number | null;
  tenantName: string | null;
  userId: number | null;
  username: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  deviceId: number | null;
  deviceName: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  success: boolean;
  createdAt: string;
}

export interface AuditListParams {
  tenants: ReadTenants;
  /** Actor: user id, or a username substring. */
  userId?: number;
  actor?: string;
  /** Exact action, or a prefix when it ends with '.' ("bans." = every ban action). */
  action?: string;
  targetType?: string;
  targetId?: string;
  deviceId?: number;
  success?: boolean;
  from?: Date;
  to?: Date;
  /** Free text over username, target id, IP and details. */
  search?: string;
  page?: number;
  pageSize?: number;
}

export const AUDIT_MAX_PAGE_SIZE = 500;

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

function rowToAudit(r: Record<string, any>): AuditLogRow {
  let details = r.details ?? null;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { details = null; }
  }
  return {
    id: Number(r.id),
    tenantId: r.tenant_id ?? null,
    tenantName: r.tenant_name ?? null,
    userId: r.user_id ?? null,
    username: r.username ?? r.user_username ?? null,
    action: r.action,
    targetType: r.target_type ?? null,
    targetId: r.target_id ?? null,
    deviceId: r.device_id ?? null,
    deviceName: r.device_name ?? null,
    details,
    ipAddress: r.ip_address ?? null,
    userAgent: r.user_agent ?? null,
    success: r.success !== false,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** Restricts a query on `al` to the read tenants (instance rows only for the full god view). */
function scopeTenants(q: any, tenants: ReadTenants, column = 'al.tenant_id'): void {
  if (tenants === 'all') return;
  if (tenants.length === 0) { q.whereRaw('false'); return; }
  q.whereIn(column, tenants);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function baseQuery() {
  return db('audit_logs as al')
    .leftJoin('users as u', 'u.id', 'al.user_id')
    .leftJoin('agent_devices as d', 'd.id', 'al.device_id')
    .leftJoin('tenants as ten', 'ten.id', 'al.tenant_id');
}

const SELECT_COLUMNS = [
  'al.*',
  'u.username as user_username',
  db.raw('COALESCE(d.name, d.hostname) as device_name'),
  'ten.name as tenant_name',
];

/** Actor id + name of a request (session user). */
function sessionActor(req: Request): { userId: number | null; username: string | null } {
  const id = positiveInt(req.session?.userId);
  const name = typeof req.session?.username === 'string' ? req.session.username : null;
  return { userId: id, username: name };
}

/** Operating tenant of a request (validated req.tenantId, else the session's). */
function requestTenant(req: Request): number | null {
  return positiveInt(req.tenantId) ?? positiveInt(req.session?.currentTenantId);
}

/**
 * Owning tenant of each agent id (rows linked to an agent and given no
 * explicit tenant are filed in the agent's tenant, Obliance logReqAs). A
 * lookup failure or a deleted agent leaves the id out (operating tenant).
 */
async function deviceTenants(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  try {
    const rows = await db('agent_devices').whereIn('id', [...new Set(ids)]).select('id', 'tenant_id') as
      Array<{ id: number; tenant_id: number | null }>;
    for (const r of rows) {
      const t = positiveInt(r.tenant_id);
      if (t !== null) out.set(Number(r.id), t);
    }
  } catch (err) {
    logger.warn({ err }, 'Audit: agent tenant lookup failed');
  }
  return out;
}

/** Tenant of a request entry: explicit override, else the linked agent's, else the operating tenant. */
function entryTenant(entry: AuditReqEntry, operating: number | null, agents: Map<number, number>): number | null {
  if (entry.tenantId !== undefined) return entry.tenantId;
  const dev = positiveInt(entry.deviceId);
  return (dev !== null ? agents.get(dev) : undefined) ?? operating;
}

export const auditService = {
  /** Writes one row. Never throws. */
  async log(entry: AuditEntry): Promise<void> {
    try {
      const ua = typeof entry.userAgent === 'string' && entry.userAgent.trim() !== ''
        ? entry.userAgent.slice(0, MAX_USER_AGENT)
        : null;
      await db('audit_logs').insert({
        tenant_id: positiveInt(entry.tenantId),
        user_id: positiveInt(entry.userId),
        username: typeof entry.username === 'string' && entry.username !== '' ? entry.username.slice(0, 255) : null,
        action: String(entry.action).slice(0, 100),
        target_type: entry.targetType ? String(entry.targetType).slice(0, 50) : null,
        target_id: entry.targetId === null || entry.targetId === undefined || entry.targetId === ''
          ? null
          : String(entry.targetId).slice(0, 1000),
        device_id: positiveInt(entry.deviceId),
        details: serializeDetails(entry.details),
        ip_address: entry.ipAddress ? String(entry.ipAddress).slice(0, 45) : null,
        user_agent: ua,
        success: entry.success !== false,
      });
    } catch (err) {
      logger.warn({ err, action: entry.action }, 'Audit: failed to write an audit row');
    }
  },

  /**
   * Writes one row for a request: actor from the session (overridable), tenant
   * from the operating tenant (overridable, null = instance-level), client IP
   * through utils/clientIp (trusted proxies only) and the User-Agent.
   */
  async logReq(req: Request, entry: AuditReqEntry): Promise<void> {
    const actor = sessionActor(req);
    let ip: string | null = null;
    try { ip = clientIp(req) || null; } catch { ip = null; }
    const uaHeader = req.headers?.['user-agent'];
    const dev = entry.tenantId === undefined ? positiveInt(entry.deviceId) : null;
    const agents = dev !== null ? await deviceTenants([dev]) : new Map<number, number>();
    await auditService.log({
      tenantId: entryTenant(entry, requestTenant(req), agents),
      userId: entry.userId !== undefined ? entry.userId : actor.userId,
      username: entry.username !== undefined ? entry.username : actor.username,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      deviceId: entry.deviceId,
      details: entry.details,
      success: entry.success,
      ipAddress: ip,
      userAgent: typeof uaHeader === 'string' ? uaHeader : null,
    });
  },

  /**
   * logReq for several rows of one request (bulk actions: one row per agent,
   * so each agent's Activity tab shows it). One INSERT per 500 rows; never throws.
   */
  async logReqMany(req: Request, entries: AuditReqEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const actor = sessionActor(req);
    let ip: string | null = null;
    try { ip = clientIp(req) || null; } catch { ip = null; }
    const uaHeader = req.headers?.['user-agent'];
    const ua = typeof uaHeader === 'string' && uaHeader.trim() !== '' ? uaHeader.slice(0, MAX_USER_AGENT) : null;
    const operating = requestTenant(req);
    const agents = await deviceTenants(entries
      .filter((e) => e.tenantId === undefined)
      .map((e) => positiveInt(e.deviceId))
      .filter((id): id is number => id !== null));
    const rows = entries.map((e) => ({
      tenant_id: positiveInt(entryTenant(e, operating, agents)),
      user_id: positiveInt(e.userId !== undefined ? e.userId : actor.userId),
      username: (e.username !== undefined ? e.username : actor.username)?.slice(0, 255) || null,
      action: String(e.action).slice(0, 100),
      target_type: e.targetType ? String(e.targetType).slice(0, 50) : null,
      target_id: e.targetId === null || e.targetId === undefined || e.targetId === '' ? null : String(e.targetId).slice(0, 1000),
      device_id: positiveInt(e.deviceId),
      details: serializeDetails(e.details),
      ip_address: ip ? ip.slice(0, 45) : null,
      user_agent: ua,
      success: e.success !== false,
    }));
    try {
      for (let i = 0; i < rows.length; i += 500) {
        await db('audit_logs').insert(rows.slice(i, i + 500));
      }
    } catch (err) {
      logger.warn({ err, action: entries[0].action, count: entries.length }, 'Audit: failed to write audit rows');
    }
  },

  /** Filtered, paginated list (newest first). */
  async list(params: AuditListParams): Promise<{ items: AuditLogRow[]; total: number; page: number; pageSize: number }> {
    const pageSize = Math.min(AUDIT_MAX_PAGE_SIZE, Math.max(1, Math.floor(params.pageSize ?? 50)));
    const page = Math.max(1, Math.floor(params.page ?? 1));

    const q = baseQuery();
    scopeTenants(q, params.tenants);
    if (params.userId) q.where('al.user_id', params.userId);
    if (params.actor) {
      q.whereRaw("COALESCE(al.username, u.username, '') ILIKE ? ESCAPE '\\'", [`%${escapeLike(params.actor)}%`]);
    }
    if (params.action) {
      if (params.action.endsWith('.')) q.whereRaw("al.action LIKE ? ESCAPE '\\'", [`${escapeLike(params.action)}%`]);
      else q.where('al.action', params.action);
    }
    if (params.targetType) q.where('al.target_type', params.targetType);
    if (params.targetId) q.where('al.target_id', params.targetId);
    if (params.deviceId) q.where('al.device_id', params.deviceId);
    if (typeof params.success === 'boolean') q.where('al.success', params.success);
    if (params.from) q.where('al.created_at', '>=', params.from);
    if (params.to) q.where('al.created_at', '<=', params.to);
    if (params.search) {
      const like = `%${escapeLike(params.search)}%`;
      q.where((b: any) => {
        b.whereRaw("COALESCE(al.username, u.username, '') ILIKE ? ESCAPE '\\'", [like])
          .orWhereRaw("COALESCE(al.target_id, '') ILIKE ? ESCAPE '\\'", [like])
          .orWhereRaw("COALESCE(al.ip_address, '') ILIKE ? ESCAPE '\\'", [like])
          .orWhereRaw("COALESCE(al.details::text, '') ILIKE ? ESCAPE '\\'", [like]);
      });
    }

    const countRow = await q.clone().clearSelect().count<{ c: string }[]>({ c: 'al.id' }).first();
    const total = Number((countRow as any)?.c ?? 0);
    const rows = await q
      .select(SELECT_COLUMNS)
      .orderBy('al.created_at', 'desc')
      .orderBy('al.id', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items: rows.map(rowToAudit), total, page, pageSize };
  },

  /** Actions present in the readable rows (filter dropdown). */
  async distinctActions(tenants: ReadTenants): Promise<string[]> {
    const q = db('audit_logs as al').distinct('al.action').orderBy('al.action', 'asc');
    scopeTenants(q, tenants);
    const rows = await q;
    return rows.map((r: { action: string }) => r.action);
  },

  /** Latest rows of one agent (agent detail Activity tab). */
  async getByDevice(deviceId: number, tenants: ReadTenants, limit = 100): Promise<AuditLogRow[]> {
    const q = baseQuery().where('al.device_id', deviceId);
    scopeTenants(q, tenants);
    const rows = await q
      .select(SELECT_COLUMNS)
      .orderBy('al.created_at', 'desc')
      .orderBy('al.id', 'desc')
      .limit(Math.min(AUDIT_MAX_PAGE_SIZE, Math.max(1, Math.floor(limit))));
    return rows.map(rowToAudit);
  },

  /**
   * Deletes rows older than `olderThanDays` days (0 = every row) of the given
   * tenants ('all' includes instance-level rows). Returns the count.
   */
  async purge(tenants: ReadTenants, olderThanDays: number): Promise<number> {
    const q = db('audit_logs');
    scopeTenants(q, tenants, 'tenant_id');
    if (olderThanDays > 0) {
      q.whereRaw('created_at < NOW() - make_interval(days => ?::int)', [Math.floor(olderThanDays)]);
    }
    return q.del();
  },

  /** Retention job: deletes rows past AUDIT_RETENTION_DAYS (or `days`). */
  async purgeExpired(days: number = AUDIT_RETENTION_DAYS): Promise<number> {
    return auditService.purge('all', Math.max(1, Math.floor(days)));
  },
};
