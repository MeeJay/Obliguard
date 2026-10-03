/**
 * Fleet list of the /agents page (W10-1, Obliance DeviceTable model):
 * server-side search, status chips with counts, group / tenant filters, sort
 * and paging over the agents a request may read.
 *
 * Several chips are runtime states, not columns: presence comes from the WS
 * hub (obliguardHub.isConnected), "updating" / "update failed" from the
 * latest update attempt and "outdated" from the version this server serves.
 * The candidate set (tenant + team scope + group) is therefore hydrated
 * through agentService.listDevices, exactly like the unpaged GET
 * /agent/devices, then searched, counted, filtered, sorted and sliced here;
 * the 24 h event / ban counters are aggregated in SQL (the page only, or the
 * whole candidate set when they are the sort key).
 *
 * Chip semantics: several chips are OR-ed (Obliance status filters). The
 * counts are computed on the set matched by every OTHER filter (search,
 * group, tenants, type), so a count tells how many rows a click would show.
 */
import type { Knex } from 'knex';
import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';
import type { AgentDevice, AgentUpdateAttemptInfo } from '@obliview/shared';
import { agentService } from './agent.service';
import { banAudience, eventScope } from './ipsSnapshot.service';
import { parseAgentSemver } from '../utils/agentUpdate';

export const AGENT_LIST_CHIPS = [
  'online', 'offline', 'pending', 'suspended', 'refused',
  'updating', 'update_failed', 'evaluate_only', 'outdated',
] as const;
export type AgentListChip = typeof AGENT_LIST_CHIPS[number];

export const AGENT_LIST_SORT_FIELDS = [
  'name', 'status', 'lastSeen', 'version', 'events24h', 'bans24h', 'group', 'tenant',
] as const;
export type AgentListSortField = typeof AGENT_LIST_SORT_FIELDS[number];

export const AGENT_LIST_DEVICE_TYPES = ['agent', 'mikrotik', 'm365'] as const;
export type AgentListDeviceType = typeof AGENT_LIST_DEVICE_TYPES[number];

export const AGENT_LIST_MAX_PAGE_SIZE = 200;
export const AGENT_LIST_DEFAULT_PAGE_SIZE = 50;
/** Longest search string accepted (longer input is cut). */
export const AGENT_LIST_MAX_SEARCH = 200;

export interface AgentListQuery {
  /** Operating tenant (Default: every tenant, read god view). */
  tenantId: number;
  /** Team scope of the caller (agentScope.scopeAgentIds): 'all' = no restriction. */
  visibleIds: number[] | 'all';
  /** Case-insensitive substring of the hostname, the display name or the IP. */
  search?: string;
  /** Status chips, OR-ed. Empty = every status. */
  chips?: AgentListChip[];
  /** A group (recursive: with its whole sub-tree), null = ungrouped agents, undefined = all. */
  groupId?: number | null;
  recursive?: boolean;
  /** God view only: narrow to these tenants (ignored outside the Default tenant). */
  tenantIds?: number[];
  deviceType?: AgentListDeviceType;
  sortBy?: AgentListSortField;
  sortOrder?: 'asc' | 'desc';
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export type AgentListRow = AgentDevice & {
  groupName: string | null;
  tenantName: string | null;
  /** ip_events of the agent over the last 24 h. */
  events24h: number;
  /** Bans of the last 24 h covering an IP the agent saw in the same window (dashboard rule). */
  bans24h: number;
};

export type AgentListCounts = Record<AgentListChip | 'all', number>;

export interface AgentListResult {
  rows: AgentListRow[];
  /** Rows matching every filter (chips included). */
  total: number;
  page: number;
  pageSize: number;
  /** Per chip, on the set matched by the other filters; 'all' = that set's size. */
  counts: AgentListCounts;
}

type DeviceWithGroup = AgentDevice & { groupName?: string | null };

const AGENT_SIDE_PHASES: ReadonlySet<string> = new Set(['offered', 'downloading', 'verifying', 'installing', 'restarting']);

function semverCompare(a: string, b: string): number {
  const pa = parseAgentSemver(a);
  const pb = parseAgentSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The attempt worth showing (client utils/agentUpdate visibleUpdateAttempt):
 * settled attempts and attempts whose target the agent already runs are hidden.
 */
function visibleAttempt(d: AgentDevice): AgentUpdateAttemptInfo | null {
  const u = d.update;
  if (!u || u.phase === 'succeeded' || u.phase === 'cancelled') return null;
  if (d.agentVersion && u.targetVersion && semverCompare(d.agentVersion, u.targetVersion) >= 0) return null;
  return u;
}

/** The chips a device belongs to (several at once: e.g. offline + outdated). */
export function agentChips(d: AgentDevice): Set<AgentListChip> {
  const out = new Set<AgentListChip>();
  if (d.status !== 'approved') {
    out.add(d.status as AgentListChip);
    return out;
  }
  out.add(d.wsConnected ? 'online' : 'offline');
  const attempt = visibleAttempt(d);
  if ((attempt && AGENT_SIDE_PHASES.has(attempt.phase)) || !!d.updatingSince) out.add('updating');
  if (attempt?.phase === 'failed') out.add('update_failed');
  if (d.evaluateOnly) out.add('evaluate_only');
  if (d.updateAvailable) out.add('outdated');
  return out;
}

/** Sort rank of the approval / presence state (problem agents first, as the sidebar). */
function statusRank(d: AgentDevice): number {
  if (d.status === 'refused') return 0;
  if (d.status === 'pending') return 2;
  if (d.status === 'suspended') return 4;
  return d.wsConnected ? 3 : 1;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function displayName(d: AgentDevice): string {
  return d.name || d.hostname || '';
}

/** Nulls (no value) always sort last, whatever the direction. */
function compareNullable<T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number, dir: number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b) * dir;
}

function matchesSearch(d: AgentDevice, needle: string): boolean {
  if (!needle) return true;
  return (d.hostname ?? '').toLowerCase().includes(needle)
    || (d.name ?? '').toLowerCase().includes(needle)
    || (d.ip ?? '').toLowerCase().includes(needle);
}

interface Stats24h { events: Map<number, number>; bans: Map<number, number> }

/**
 * 24 h counters per device. `ids` = only those devices (a page); null = every
 * device of the scope (the counters are the sort key).
 */
async function load24hStats(tenantId: number, visibleIds: number[] | 'all', ids: number[] | null): Promise<Stats24h> {
  const events = new Map<number, number>();
  const bans = new Map<number, number>();
  if (ids !== null && ids.length === 0) return { events, bans };
  const narrow = (q: Knex.QueryBuilder): Knex.QueryBuilder => (ids !== null ? q.whereIn('e.device_id', ids) : q);

  const eventsQ = narrow(eventScope(db('ip_events as e'), tenantId, visibleIds))
    .whereRaw("e.timestamp >= NOW() - INTERVAL '24 hours'")
    .whereNotNull('e.device_id')
    .groupBy('e.device_id')
    .select('e.device_id', db.raw('count(*) AS n'));
  const bansQ = banAudience(
    narrow(eventScope(
      db('ip_events as e')
        .joinRaw('JOIN ip_bans AS b ON e.ip <<= set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip)))')
        .whereRaw("e.timestamp >= NOW() - INTERVAL '24 hours'")
        .whereRaw("b.banned_at >= NOW() - INTERVAL '24 hours'")
        .whereNotNull('e.device_id'),
      tenantId,
      visibleIds,
    )),
    tenantId,
  ).groupBy('e.device_id').select('e.device_id', db.raw('count(DISTINCT b.id) AS n'));

  const [evRows, banRows] = await Promise.all([
    eventsQ as unknown as Promise<Array<{ device_id: number; n: string }>>,
    bansQ as unknown as Promise<Array<{ device_id: number; n: string }>>,
  ]);
  for (const r of evRows) events.set(Number(r.device_id), Number(r.n));
  for (const r of banRows) bans.set(Number(r.device_id), Number(r.n));
  return { events, bans };
}

async function tenantNames(): Promise<Map<number, string>> {
  const rows = await db('tenants').select('id', 'name') as Array<{ id: number; name: string }>;
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

export function emptyAgentListCounts(): AgentListCounts {
  const counts = { all: 0 } as AgentListCounts;
  for (const c of AGENT_LIST_CHIPS) counts[c] = 0;
  return counts;
}

export const agentListService = {
  async listAgentsPaged(q: AgentListQuery): Promise<AgentListResult> {
    const pageSize = Math.min(AGENT_LIST_MAX_PAGE_SIZE, Math.max(1, Math.floor(q.pageSize ?? AGENT_LIST_DEFAULT_PAGE_SIZE)));
    const page = Math.max(1, Math.floor(q.page ?? 1));
    const sortBy: AgentListSortField = q.sortBy ?? 'name';
    const dir = q.sortOrder === 'desc' ? -1 : 1;
    const master = isMasterTenant(q.tenantId);
    const needle = (q.search ?? '').trim().slice(0, AGENT_LIST_MAX_SEARCH).toLowerCase();
    const tenantFilter = master && q.tenantIds && q.tenantIds.length > 0 ? new Set(q.tenantIds) : null;

    // Tenant + team scope + group (SQL), then the in-memory filters.
    const all = await agentService.listDevices(q.tenantId, undefined, {
      groupId: q.groupId,
      recursive: q.recursive,
      visibleIds: q.visibleIds,
    }) as DeviceWithGroup[];
    const base = all.filter((d) => (!tenantFilter || tenantFilter.has(d.tenantId))
      && (!q.deviceType || (d.deviceType ?? 'agent') === q.deviceType)
      && matchesSearch(d, needle));

    // Counts on the base set, then the chip filter (OR).
    const counts = emptyAgentListCounts();
    counts.all = base.length;
    const chipsOf = new Map<number, Set<AgentListChip>>();
    for (const d of base) {
      const chips = agentChips(d);
      chipsOf.set(d.id, chips);
      for (const c of chips) counts[c]++;
    }
    const wanted = new Set(q.chips ?? []);
    const matched = wanted.size === 0
      ? base
      : base.filter((d) => [...chipsOf.get(d.id)!].some((c) => wanted.has(c)));

    // The 24 h counters of every candidate only when they are the sort key.
    const byStats = sortBy === 'events24h' || sortBy === 'bans24h';
    const [names, wholeStats] = await Promise.all([
      tenantNames(),
      byStats ? load24hStats(q.tenantId, q.visibleIds, null) : Promise.resolve(null),
    ]);

    const tenantName = (d: AgentDevice) => names.get(d.tenantId) ?? null;
    const primary = (a: DeviceWithGroup, b: DeviceWithGroup): number => {
      switch (sortBy) {
        case 'status': return (statusRank(a) - statusRank(b)) * dir;
        case 'lastSeen': return compareNullable(a.lastSeenAt ?? null, b.lastSeenAt ?? null, (x, y) => Date.parse(x) - Date.parse(y), dir);
        case 'version': return compareNullable(a.agentVersion || null, b.agentVersion || null, semverCompare, dir);
        case 'group': return compareNullable(a.groupName ?? null, b.groupName ?? null, collator.compare, dir);
        case 'tenant': return compareNullable(tenantName(a), tenantName(b), collator.compare, dir);
        case 'events24h': return ((wholeStats!.events.get(a.id) ?? 0) - (wholeStats!.events.get(b.id) ?? 0)) * dir;
        case 'bans24h': return ((wholeStats!.bans.get(a.id) ?? 0) - (wholeStats!.bans.get(b.id) ?? 0)) * dir;
        case 'name':
        default: return collator.compare(displayName(a), displayName(b)) * dir;
      }
    };
    const sorted = [...matched].sort((a, b) => primary(a, b)
      || collator.compare(displayName(a), displayName(b))
      || a.id - b.id);

    const slice = sorted.slice((page - 1) * pageSize, page * pageSize);
    const stats = wholeStats ?? await load24hStats(q.tenantId, q.visibleIds, slice.map((d) => d.id));

    const rows: AgentListRow[] = slice.map((d) => Object.assign(d, {
      groupName: d.groupName ?? null,
      tenantName: tenantName(d),
      events24h: stats.events.get(d.id) ?? 0,
      bans24h: stats.bans.get(d.id) ?? 0,
    }));

    return { rows, total: matched.length, page, pageSize, counts };
  },
};
