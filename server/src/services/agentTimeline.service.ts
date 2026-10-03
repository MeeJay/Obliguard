import type { Knex } from 'knex';
import { z } from 'zod';
import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';
import type { ReadTenants } from '../middleware/tenant';
import { logger } from '../utils/logger';

/**
 * Agent timeline — "what happened to this machine" (W13-2, DATA-REALTIME-20).
 *
 * Port of Obliance changeEvent.service.ts (read-through union, per-caller
 * kinds, window and limit caps, truncated flag): an incident on an agent can
 * be correlated with the bans, attacks, updates, outages and admin changes
 * that preceded it.
 *
 * ── Endpoint (routes/agent.routes.ts) ───────────────────────────────────────
 *
 *   GET /api/agent/devices/:id/timeline?from=<iso>&to=<iso>&kinds=<csv>&limit=<n>
 *     → { success, data: { formatVersion, deviceId, from, to, order, kinds,
 *                           limit, truncated, count, events: TimelineEvent[] } }
 *
 *   Guard: the agent read scope (agentScope.resolveRequestAgent 'read'): own
 *   tenant, the Default god view, the team grant; any other agent is a 404.
 *   `from` / `to` accept ISO-8601 or epoch-ms. Defaults: to = now,
 *   from = to - 7 days. The window is capped at 30 days (400 beyond) and the
 *   list at 500 rows; hitting the row cap sets `truncated: true` and drops the
 *   OLDEST events, never silently. Events are NEWEST FIRST.
 *
 * ── Read-through union, no new storage ──────────────────────────────────────
 *
 *   ban_applied / ban_lifted  ip_bans whose delivery reaches this agent
 *                             (computeBanDelta audience): agent-scoped, its
 *                             group chain, its tenant, and the global bans
 *                             its tenant did not exclude. A global ban is
 *                             delivered to the whole fleet, so only those
 *                             covering an address that attacked THIS agent
 *                             (ip_events) are listed: the rest is not news
 *                             about this machine and would bury it.
 *   attack_burst              ip_events auth failures of the agent, per 5 min
 *                             bucket, at or above ATTACK_BURST_MIN_FAILURES
 *   agent_update              agent_update_attempts (one row per target
 *                             version) + update request audit rows
 *   offline / online          live_alerts 'agent_offline' incidents (opened /
 *                             resolved), plus agent_devices.last_offline_at /
 *                             last_online_at when no incident covers them
 *   approval                  agent_devices.created_at (enrolled) and
 *                             approved_at, + approve / refuse / suspend /
 *                             reinstate audit rows
 *   firewall_change           audit_logs firewall.* rows of the agent
 *   config_change             every other audit_logs row of the agent
 *
 * ── Permissions ─────────────────────────────────────────────────────────────
 * The agent read scope is necessary but not sufficient: audit_logs is
 * audit.read only (routes/audit.routes.ts), so the audit-backed sources are
 * dropped for a caller without it (firewall_change and config_change are not
 * served at all; approval and agent_update keep their non-audit sources).
 * Global ban authors stay hidden outside the Default god view (rowToBan
 * rule). The kinds actually served are echoed in `kinds`.
 *
 * ── formatVersion ───────────────────────────────────────────────────────────
 * Currently 1. Bump it when a field is renamed, removed or restructured.
 * `title` / `detail` are English fallbacks: the client localises from
 * `kind` + `payload`, the stable machine-readable part.
 */

const FORMAT_VERSION = 1 as const;

export const AGENT_TIMELINE_KINDS = [
  'ban_applied',
  'ban_lifted',
  'attack_burst',
  'agent_update',
  'offline',
  'online',
  'approval',
  'firewall_change',
  'config_change',
] as const;

export type AgentTimelineKind = (typeof AGENT_TIMELINE_KINDS)[number];
export type TimelineSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface TimelineEvent {
  /** `<source table>:<row id>[:suffix]`: always traceable, unique in a response. */
  id: string;
  kind: AgentTimelineKind;
  at: string;
  title: string;
  detail: string | null;
  /** Who did it (username), null for the system / the agent itself. */
  actor: string | null;
  severity: TimelineSeverity;
  payload: Record<string, unknown>;
}

export const AGENT_TIMELINE_MAX_WINDOW_DAYS = 30;
const MAX_WINDOW_MS = AGENT_TIMELINE_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const AGENT_TIMELINE_DEFAULT_LIMIT = 200;
export const AGENT_TIMELINE_MAX_LIMIT = 500;

/** Attack bursts: auth failures of the agent per bucket, and the bucket width. */
export const ATTACK_BURST_MIN_FAILURES = 10;
const BURST_BUCKET_SECONDS = 300;

/** A presence column within this distance of an incident edge is the same fact. */
const PRESENCE_DEDUP_MS = 5 * 60 * 1000;
/** approved_at within this distance of an 'agent.approved' audit row is the same fact. */
const APPROVAL_DEDUP_MS = 2 * 60 * 1000;

const APPROVAL_ACTIONS = ['agent.approved', 'agent.refused', 'agent.suspended', 'agent.reinstated', 'agent.reset_pending'];
const UPDATE_ACTIONS = [
  'agent.update_requested', 'agent.update_retried', 'agent.update_cancelled',
  'agent.bulk_update_requested', 'agent.update_all_requested', 'agent.update_all_cancelled',
];
/** Audit rows another kind already sources from its own table (bans.*: ip_bans). */
const AUDIT_PREFIX_OWNED_ELSEWHERE = 'bans.';

/** SQL: ban row `b` as a network (same expression as ban.service networkSql). */
const BAN_NETWORK_SQL = 'set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip)))';
/** SQL: host prefix length of ban row `b`'s family. */
const BAN_HOST_LEN_SQL = 'CASE WHEN family(b.ip) = 4 THEN 32 ELSE 128 END';
/**
 * SQL: event `e` (a host address) lies in ban `b`'s network. The `<<=` alone
 * is not indexable against a correlated row, so the first and last host of
 * the network bound `e.ip` too: a btree range on idx_ip_events_ip per ban,
 * instead of a scan of the agent's whole event history per global ban (a
 * remote blocklist sync inserts thousands of them).
 */
const EVENT_IN_BAN_SQL =
  `e.ip >= set_masklen(network(${BAN_NETWORK_SQL}), ${BAN_HOST_LEN_SQL})::inet`
  + ` AND e.ip <= set_masklen(broadcast(${BAN_NETWORK_SQL}), ${BAN_HOST_LEN_SQL})::inet`
  + ` AND e.ip <<= ${BAN_NETWORK_SQL}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toIso(v: unknown): string {
  return new Date(v as string | number | Date).toISOString();
}

function toObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch { return {}; }
  }
  return {};
}

/** Truncate free text so one long reason or error cannot bloat the timeline. */
function short(v: unknown, max = 300): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function banTarget(row: { ip: string; cidr_prefix: number | null }): string {
  const ip = String(row.ip).split('/')[0];
  const full = ip.includes(':') ? 128 : 32;
  const prefix = row.cidr_prefix ?? (String(row.ip).includes('/') ? Number(String(row.ip).split('/')[1]) : full);
  return prefix >= full ? ip : `${ip}/${prefix}`;
}

function auditSeverity(action: string, success: boolean): TimelineSeverity {
  if (!success) return 'medium';
  if (/(deleted|refused|suspended|uninstall)/.test(action)) return 'high';
  if (action.startsWith('firewall.')) return 'medium';
  return 'low';
}

function updateSeverity(phase: string): TimelineSeverity {
  if (phase === 'failed') return 'high';
  if (phase === 'cancelled') return 'low';
  return 'info';
}

// ── Sources ──────────────────────────────────────────────────────────────────

interface TimelineDevice {
  id: number;
  tenant_id: number;
  group_id: number | null;
  created_at: Date | null;
  approved_at: Date | null;
  approved_by_username: string | null;
  last_online_at: Date | null;
  last_offline_at: Date | null;
}

interface SourceContext {
  device: TimelineDevice;
  /** Group chain of the agent (its group and every ancestor). */
  groupIds: number[];
  from: Date;
  to: Date;
  /** Rows fetched per source (limit + 1: tells "exactly full" from "truncated"). */
  take: number;
  /** Tenants whose audit rows the caller reads; null = no audit.read. */
  auditTenants: ReadTenants | null;
  /** The caller sees every tenant (Default): global ban authors are shown. */
  godView: boolean;
}

type Source = (ctx: SourceContext) => Promise<TimelineEvent[]>;

/** Bans delivered to the agent (computeBanDelta audience), on alias `b`. */
function banAudience(q: Knex.QueryBuilder, ctx: SourceContext): Knex.QueryBuilder {
  const { device, groupIds } = ctx;
  return q.where((w) => {
    w.where((s) => s.where('b.scope', 'agent').where('b.scope_id', device.id).where('b.tenant_id', device.tenant_id))
      .orWhere((s) => s.where('b.scope', 'tenant').where('b.tenant_id', device.tenant_id));
    if (groupIds.length > 0) {
      w.orWhere((s) => s.where('b.scope', 'group').whereIn('b.scope_id', groupIds).where('b.tenant_id', device.tenant_id));
    }
    w.orWhere((s) => s.where('b.scope', 'global')
      .whereNotExists(
        db('ip_ban_exclusions as ex').select(db.raw('1')).whereRaw('ex.ban_id = b.id').where('ex.tenant_id', device.tenant_id),
      )
      .whereExists(
        db('ip_events as e').select(db.raw('1')).where('e.device_id', device.id).whereRaw(EVENT_IN_BAN_SQL),
      ));
  });
}

interface BanTimelineRow {
  id: number;
  ip: string;
  cidr_prefix: number | null;
  reason: string | null;
  ban_type: string;
  scope: string;
  scope_id: number | null;
  banned_at: Date;
  expires_at: Date | null;
  lifted_at: Date | null;
  lift_reason: string | null;
  author: string | null;
}

function banPayload(r: BanTimelineRow): Record<string, unknown> {
  return {
    banId: r.id,
    target: banTarget(r),
    banType: r.ban_type,
    scope: r.scope,
    scopeId: r.scope_id,
    reason: short(r.reason),
    expiresAt: r.expires_at ? toIso(r.expires_at) : null,
  };
}

function banAuthor(r: BanTimelineRow, ctx: SourceContext): string | null {
  return r.scope !== 'global' || ctx.godView ? r.author ?? null : null;
}

const banApplied: Source = async (ctx) => {
  const rows = await banAudience(db('ip_bans as b').leftJoin('users as u', 'u.id', 'b.banned_by_user_id'), ctx)
    .where('b.banned_at', '>=', ctx.from).where('b.banned_at', '<=', ctx.to)
    .select('b.id', 'b.ip', 'b.cidr_prefix', 'b.reason', 'b.ban_type', 'b.scope', 'b.scope_id',
      'b.banned_at', 'b.expires_at', 'b.lifted_at', 'b.lift_reason', 'u.username as author')
    .orderBy('b.banned_at', 'desc').orderBy('b.id', 'desc')
    .limit(ctx.take) as BanTimelineRow[];
  return rows.map((r) => ({
    id: `ip_bans:${r.id}:applied`,
    kind: 'ban_applied',
    at: toIso(r.banned_at),
    title: `Ban applied: ${banTarget(r)}`,
    detail: short(r.reason),
    actor: banAuthor(r, ctx),
    severity: r.scope === 'global' ? 'medium' : 'low',
    payload: banPayload(r),
  }));
};

const banLifted: Source = async (ctx) => {
  const rows = await banAudience(db('ip_bans as b').leftJoin('users as u', 'u.id', 'b.banned_by_user_id'), ctx)
    .where('b.is_active', false)
    .whereNotNull('b.lifted_at')
    .where('b.lifted_at', '>=', ctx.from).where('b.lifted_at', '<=', ctx.to)
    .select('b.id', 'b.ip', 'b.cidr_prefix', 'b.reason', 'b.ban_type', 'b.scope', 'b.scope_id',
      'b.banned_at', 'b.expires_at', 'b.lifted_at', 'b.lift_reason', 'u.username as author')
    .orderBy('b.lifted_at', 'desc').orderBy('b.id', 'desc')
    .limit(ctx.take) as BanTimelineRow[];
  return rows.map((r) => ({
    id: `ip_bans:${r.id}:lifted`,
    kind: 'ban_lifted',
    at: toIso(r.lifted_at),
    title: `Ban lifted: ${banTarget(r)}`,
    detail: r.lift_reason ?? null,
    actor: null,
    severity: 'info',
    payload: { ...banPayload(r), liftReason: r.lift_reason ?? null, bannedAt: toIso(r.banned_at) },
  }));
};

const attackBursts: Source = async (ctx) => {
  const bucket = `to_timestamp(floor(extract(epoch from e.timestamp) / ${BURST_BUCKET_SECONDS}) * ${BURST_BUCKET_SECONDS})`;
  const rows = await db('ip_events as e')
    .where('e.device_id', ctx.device.id)
    .where('e.event_type', 'auth_failure')
    .where('e.timestamp', '>=', ctx.from).where('e.timestamp', '<=', ctx.to)
    .groupByRaw(bucket)
    .havingRaw('count(*) >= ?', [ATTACK_BURST_MIN_FAILURES])
    .select(
      db.raw(`${bucket} as bucket`),
      db.raw('min(e.timestamp) as first_at'),
      db.raw('max(e.timestamp) as last_at'),
      db.raw('count(*)::int as failures'),
      db.raw('count(DISTINCT e.ip)::int as ips'),
      db.raw('mode() WITHIN GROUP (ORDER BY host(e.ip)) as top_ip'),
      db.raw('array_agg(DISTINCT e.service) as services'),
    )
    .orderByRaw(`${bucket} DESC`)
    .limit(ctx.take) as Array<{
      bucket: Date; first_at: Date; last_at: Date; failures: number; ips: number; top_ip: string | null; services: string[] | null;
    }>;
  return rows.map((r) => {
    const services = Array.isArray(r.services) ? r.services.filter(Boolean).sort() : [];
    return {
      id: `ip_events:${new Date(r.bucket).getTime()}:burst`,
      kind: 'attack_burst',
      at: toIso(r.first_at),
      title: `Attack burst: ${r.failures} failures from ${r.ips} address(es)`,
      detail: services.length > 0 ? services.join(', ') : null,
      actor: null,
      severity: r.failures >= ATTACK_BURST_MIN_FAILURES * 10 ? 'high' : 'medium',
      payload: {
        bucketStart: toIso(r.bucket),
        bucketSeconds: BURST_BUCKET_SECONDS,
        firstAt: toIso(r.first_at),
        lastAt: toIso(r.last_at),
        failures: r.failures,
        uniqueIps: r.ips,
        topIp: r.top_ip,
        services,
      },
    };
  });
};

const updateAttempts: Source = async (ctx) => {
  const AT = 'COALESCE(a.finished_at, a.updated_at)';
  const rows = await db('agent_update_attempts as a')
    .where('a.device_id', ctx.device.id)
    .whereRaw(`${AT} >= ? AND ${AT} <= ?`, [ctx.from, ctx.to])
    .select('a.id', 'a.target_version', 'a.phase', 'a.offered_count', 'a.last_error', 'a.created_at', 'a.finished_at', db.raw(`${AT} as at`))
    .orderByRaw(`${AT} DESC`).orderBy('a.id', 'desc')
    .limit(ctx.take) as Array<{
      id: number; target_version: string; phase: string; offered_count: number; last_error: string | null;
      created_at: Date; finished_at: Date | null; at: Date;
    }>;
  return rows.map((r) => ({
    id: `agent_update_attempts:${r.id}`,
    kind: 'agent_update',
    at: toIso(r.at),
    title: `Update to ${r.target_version}: ${r.phase}`,
    detail: short(r.last_error),
    actor: null,
    severity: updateSeverity(r.phase),
    payload: {
      attemptId: r.id,
      targetVersion: r.target_version,
      phase: r.phase,
      offeredCount: r.offered_count,
      lastError: short(r.last_error),
      startedAt: toIso(r.created_at),
      finishedAt: r.finished_at ? toIso(r.finished_at) : null,
    },
  }));
};

interface IncidentRow { id: number; created_at: Date; resolved_at: Date | null; occurrences: number | null }

/** Offline incidents of the agent touching the window (opened or resolved in it). */
async function offlineIncidents(ctx: SourceContext, edge: 'created_at' | 'resolved_at'): Promise<IncidentRow[]> {
  return db('live_alerts as la')
    .where('la.device_id', ctx.device.id)
    .where('la.tenant_id', ctx.device.tenant_id)
    .where('la.incident_kind', 'agent_offline')
    .whereNotNull(`la.${edge}`)
    .where(`la.${edge}`, '>=', ctx.from).where(`la.${edge}`, '<=', ctx.to)
    .select('la.id', 'la.created_at', 'la.resolved_at', 'la.occurrences')
    .orderBy(`la.${edge}`, 'desc').orderBy('la.id', 'desc')
    .limit(ctx.take) as Promise<IncidentRow[]>;
}

/** The presence column as an event when no incident edge already stands for it. */
function presenceFallback(ctx: SourceContext, value: Date | null, edges: Date[], kind: 'offline' | 'online'): TimelineEvent | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (t < ctx.from.getTime() || t > ctx.to.getTime()) return null;
  if (edges.some((e) => Math.abs(new Date(e).getTime() - t) <= PRESENCE_DEDUP_MS)) return null;
  return {
    id: `agent_devices:${ctx.device.id}:last_${kind}`,
    kind,
    at: toIso(value),
    title: kind === 'offline' ? 'Agent went offline' : 'Agent connected',
    detail: null,
    actor: null,
    severity: kind === 'offline' ? 'low' : 'info',
    payload: { source: 'presence', incidentId: null },
  };
}

const offline: Source = async (ctx) => {
  const rows = await offlineIncidents(ctx, 'created_at');
  const events: TimelineEvent[] = rows.map((r) => ({
    id: `live_alerts:${r.id}:offline`,
    kind: 'offline',
    at: toIso(r.created_at),
    title: 'Agent declared offline',
    detail: null,
    actor: null,
    severity: 'high',
    payload: { source: 'incident', incidentId: r.id, resolvedAt: r.resolved_at ? toIso(r.resolved_at) : null },
  }));
  const extra = presenceFallback(ctx, ctx.device.last_offline_at, rows.map((r) => r.created_at), 'offline');
  return extra ? [...events, extra] : events;
};

const online: Source = async (ctx) => {
  const rows = await offlineIncidents(ctx, 'resolved_at');
  const events: TimelineEvent[] = rows.map((r) => {
    const downMs = new Date(r.resolved_at!).getTime() - new Date(r.created_at).getTime();
    return {
      id: `live_alerts:${r.id}:online`,
      kind: 'online',
      at: toIso(r.resolved_at),
      title: 'Agent back online',
      detail: null,
      actor: null,
      severity: 'info',
      payload: { source: 'incident', incidentId: r.id, offlineSince: toIso(r.created_at), downSeconds: Math.max(0, Math.round(downMs / 1000)) },
    };
  });
  const extra = presenceFallback(ctx, ctx.device.last_online_at, rows.map((r) => r.resolved_at!), 'online');
  return extra ? [...events, extra] : events;
};

interface AuditTimelineRow {
  id: number | string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: unknown;
  ip_address: string | null;
  user_agent: string | null;
  username: string | null;
  user_username: string | null;
  success: boolean;
  created_at: Date;
}

/** audit_logs rows of the agent readable by the caller, narrowed by `filter`. */
async function auditRows(ctx: SourceContext, filter: (q: Knex.QueryBuilder) => void): Promise<AuditTimelineRow[]> {
  const tenants = ctx.auditTenants;
  if (tenants === null || (Array.isArray(tenants) && tenants.length === 0)) return [];
  const q = db('audit_logs as al')
    .leftJoin('users as u', 'u.id', 'al.user_id')
    .where('al.device_id', ctx.device.id)
    .where('al.created_at', '>=', ctx.from).where('al.created_at', '<=', ctx.to);
  if (tenants !== 'all') q.whereIn('al.tenant_id', tenants);
  filter(q);
  return q
    .select('al.id', 'al.action', 'al.target_type', 'al.target_id', 'al.details', 'al.ip_address', 'al.user_agent', 'al.username', 'u.username as user_username', 'al.success', 'al.created_at')
    .orderBy('al.created_at', 'desc').orderBy('al.id', 'desc')
    .limit(ctx.take) as Promise<AuditTimelineRow[]>;
}

function auditEvent(kind: AgentTimelineKind, r: AuditTimelineRow): TimelineEvent {
  const success = r.success !== false;
  return {
    id: `audit_logs:${r.id}`,
    kind,
    at: toIso(r.created_at),
    title: success ? r.action : `${r.action} (failed)`,
    detail: null,
    actor: r.username ?? r.user_username ?? null,
    severity: auditSeverity(r.action, success),
    payload: {
      auditId: Number(r.id),
      action: r.action,
      success,
      targetType: r.target_type,
      targetId: r.target_id,
      details: toObj(r.details),
      // Request origin (the former Activity tab's IP column and details).
      ipAddress: r.ip_address ?? null,
      userAgent: short(r.user_agent),
    },
  };
}

const auditApprovals: Source = async (ctx) =>
  (await auditRows(ctx, (q) => { q.whereIn('al.action', APPROVAL_ACTIONS); })).map((r) => auditEvent('approval', r));

const auditUpdates: Source = async (ctx) =>
  (await auditRows(ctx, (q) => { q.whereIn('al.action', UPDATE_ACTIONS); })).map((r) => auditEvent('agent_update', r));

const firewallChanges: Source = async (ctx) =>
  (await auditRows(ctx, (q) => { q.whereRaw("al.action LIKE 'firewall.%'"); })).map((r) => auditEvent('firewall_change', r));

const configChanges: Source = async (ctx) =>
  (await auditRows(ctx, (q) => {
    q.whereNotIn('al.action', [...APPROVAL_ACTIONS, ...UPDATE_ACTIONS])
      .whereRaw("al.action NOT LIKE 'firewall.%'")
      .whereRaw('al.action NOT LIKE ?', [`${AUDIT_PREFIX_OWNED_ELSEWHERE}%`]);
  })).map((r) => auditEvent('config_change', r));

/** Enrolment and approval instants of the agent row (readable by every viewer). */
const lifecycle: Source = async (ctx) => {
  const { device } = ctx;
  const inWindow = (d: Date | null): d is Date => {
    if (!d) return false;
    const t = new Date(d).getTime();
    return t >= ctx.from.getTime() && t <= ctx.to.getTime();
  };
  const out: TimelineEvent[] = [];
  if (inWindow(device.created_at)) {
    out.push({
      id: `agent_devices:${device.id}:enrolled`,
      kind: 'approval',
      at: toIso(device.created_at),
      title: 'Agent enrolled',
      detail: null,
      actor: null,
      severity: 'info',
      payload: { step: 'enrolled' },
    });
  }
  if (inWindow(device.approved_at)) {
    // An 'agent.approved' audit row (shown to audit.read holders) is the same fact.
    const approvedMs = new Date(device.approved_at).getTime();
    const audited = ctx.auditTenants !== null && (await auditRows(
      { ...ctx, from: new Date(approvedMs - APPROVAL_DEDUP_MS), to: new Date(approvedMs + APPROVAL_DEDUP_MS), take: 1 },
      (q) => { q.where('al.action', 'agent.approved'); },
    )).length > 0;
    if (!audited) {
      out.push({
        id: `agent_devices:${device.id}:approved`,
        kind: 'approval',
        at: toIso(device.approved_at),
        title: 'Agent approved',
        detail: null,
        actor: device.approved_by_username ?? null,
        severity: 'info',
        payload: { step: 'approved' },
      });
    }
  }
  return out;
};

/** Sources of each kind for this caller (no entry = kind not served). */
function buildSources(canReadAudit: boolean): Partial<Record<AgentTimelineKind, Source[]>> {
  return {
    ban_applied: [banApplied],
    ban_lifted: [banLifted],
    attack_burst: [attackBursts],
    agent_update: canReadAudit ? [updateAttempts, auditUpdates] : [updateAttempts],
    offline: [offline],
    online: [online],
    approval: canReadAudit ? [lifecycle, auditApprovals] : [lifecycle],
    ...(canReadAudit ? { firewall_change: [firewallChanges], config_change: [configChanges] } : {}),
  };
}

/** Requested kinds ∩ kinds the caller may read, in canonical order (a forbidden kind is dropped, not 403'd). */
function resolveKinds(sources: Partial<Record<AgentTimelineKind, Source[]>>, requested?: AgentTimelineKind[]): AgentTimelineKind[] {
  const wanted = requested ? new Set(requested) : null;
  return AGENT_TIMELINE_KINDS.filter((k) => sources[k] && (!wanted || wanted.has(k)));
}

// ── Validation ───────────────────────────────────────────────────────────────

/** ISO-8601 or epoch-ms. */
const tsParam = z.preprocess(
  (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v),
  z.coerce.date(),
);

const kindsParam = z
  .string()
  .max(500)
  .transform((s) => s.split(',').map((k) => k.trim()).filter(Boolean))
  .pipe(z.array(z.enum(AGENT_TIMELINE_KINDS)).min(1));

export const agentTimelineQuerySchema = z
  .object({
    from: tsParam.optional(),
    to: tsParam.optional(),
    kinds: kindsParam.optional(),
    limit: z.coerce.number().int().min(1).max(AGENT_TIMELINE_MAX_LIMIT).optional(),
  })
  .transform((q) => {
    const to = q.to ?? new Date();
    return {
      to,
      from: q.from ?? new Date(to.getTime() - DEFAULT_WINDOW_MS),
      kinds: q.kinds,
      limit: q.limit ?? AGENT_TIMELINE_DEFAULT_LIMIT,
    };
  })
  .superRefine((w, ctx) => {
    if (w.from.getTime() >= w.to.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`from` must be strictly before `to`' });
    } else if (w.to.getTime() - w.from.getTime() > MAX_WINDOW_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Window too large: max ${AGENT_TIMELINE_MAX_WINDOW_DAYS} days` });
    }
  });

export type AgentTimelineQuery = z.output<typeof agentTimelineQuerySchema>;

export interface AgentTimelineOptions extends AgentTimelineQuery {
  /** Tenants whose audit rows the caller reads; null = the caller lacks audit.read. */
  auditTenants: ReadTenants | null;
  /** Operating tenant of the caller (Default = god view). */
  callerTenantId: number;
}

export interface AgentTimeline {
  formatVersion: typeof FORMAT_VERSION;
  deviceId: number;
  from: string;
  to: string;
  order: 'desc';
  kinds: AgentTimelineKind[];
  limit: number;
  truncated: boolean;
  count: number;
  events: TimelineEvent[];
}

// ── Service ──────────────────────────────────────────────────────────────────

export const agentTimelineService = {
  /**
   * One timeline (NEWEST FIRST) unioning every kind the caller may read for an
   * agent the route already resolved through the read scope. Each source
   * fetches `limit + 1` rows, newest first: a row a per-source cap drops is
   * older than `limit + 1` rows already merged, so it could never survive the
   * final slice, and `truncated` is exact. Null when the agent is gone.
   */
  async getTimeline(deviceId: number, opts: AgentTimelineOptions): Promise<AgentTimeline | null> {
    const device = await db('agent_devices as d')
      .leftJoin('users as u', 'u.id', 'd.approved_by')
      .where('d.id', deviceId)
      .first('d.id', 'd.tenant_id', 'd.group_id', 'd.created_at', 'd.approved_at', 'u.username as approved_by_username',
        'd.last_online_at', 'd.last_offline_at') as TimelineDevice | undefined;
    if (!device) return null;

    const groupIds = device.group_id == null ? [] : (await db('group_closure')
      .where('descendant_id', device.group_id)
      .pluck('ancestor_id') as number[]);

    const limit = Math.min(AGENT_TIMELINE_MAX_LIMIT, Math.max(1, Math.floor(opts.limit)));
    const ctx: SourceContext = {
      device,
      groupIds,
      from: opts.from,
      to: opts.to,
      take: limit + 1,
      auditTenants: opts.auditTenants,
      godView: isMasterTenant(opts.callerTenantId),
    };
    const sources = buildSources(opts.auditTenants !== null);
    const kinds = resolveKinds(sources, opts.kinds);

    const batches = await Promise.all(kinds.flatMap((kind) => (sources[kind] ?? []).map((src) => src(ctx))));
    const merged = batches.flat().sort((a, b) => {
      const d = Date.parse(b.at) - Date.parse(a.at);
      return d !== 0 ? d : a.id.localeCompare(b.id); // stable across identical instants
    });

    const truncated = merged.length > limit;
    if (truncated) {
      logger.debug({ deviceId, limit, found: merged.length }, 'agent timeline truncated');
    }
    return {
      formatVersion: FORMAT_VERSION,
      deviceId,
      from: opts.from.toISOString(),
      to: opts.to.toISOString(),
      order: 'desc',
      kinds,
      limit,
      truncated,
      count: Math.min(merged.length, limit),
      events: truncated ? merged.slice(0, limit) : merged,
    };
  },
};
