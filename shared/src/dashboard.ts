/**
 * Dashboard read models (GET /api/dashboard/summary, GET /api/ip-events/stats).
 *
 * Every figure is tenant-scoped; the Default tenant sees the whole install.
 * A non-Default tenant also counts global bans, since they are enforced on
 * its agents (minus the ones it excluded). "Today" starts at midnight in the
 * database timezone; the *24h fields cover a rolling 24-hour window.
 */

export interface DashboardTopIp {
  ip: string;
  /** Failures seen by the caller's tenant (the global total for Default). */
  totalFailures: number;
  geoCountryCode: string | null;
  lastSeen: string | null;
}

export interface DashboardAgentStats {
  deviceId: number;
  /** Display name (name, else hostname). */
  name: string;
  events24h: number;
  failures24h: number;
  /** Bans created in the last 24 h that cover an IP seen by this agent in the same window. */
  bans24h: number;
}

export interface DashboardSummary {
  activeBans: number;
  /** Bans created today, by origin. Remote / external / MikroTik bans are not counted. */
  bansToday: { auto: number; manual: number };
  eventsToday: number;
  failuresToday: number;
  /** Distinct IPs with at least one auth failure today. */
  uniqueIpsToday: number;
  failures24h: number;
  uniqueIps24h: number;
  /** Approved agents (MikroTik devices excluded from the agent counters). */
  agentsTotal: number;
  /** Approved agents with a live WS channel (offline grace period included). */
  agentsConnected: number;
  /** Approved agents in evaluate-only mode (own flag or an evaluate-only ancestor group). */
  agentsEvaluateOnly: number;
  /** Approved agents running a version older than the one this server serves. */
  agentsOutdated: number;
  /** Top 5 IPs by failure count. */
  topIps: DashboardTopIp[];
  /** Per approved device (agents and MikroTik), busiest first. */
  perAgent: DashboardAgentStats[];
  /** Day-over-day comparisons of the hero KPIs. */
  deltas: DashboardDeltas;
}

export interface IpEventStats {
  today: number;
  last24h: number;
  /** Event count per device over the last 24 hours, busiest first. */
  byDevice: Array<{ deviceId: number; count: number }>;
}

/** Day-over-day comparisons of the hero KPIs (null = no reference point yet). */
export interface DashboardDeltas {
  /** Active bans now minus ~24 h ago (hourly snapshot, else yesterday's daily one). */
  activeBans: number | null;
  /** Failures of the last 24 h minus those of the 24 h before. */
  failures24h: number | null;
  /** Hostile unique IPs of the last 24 h minus those of the 24 h before. */
  uniqueIps24h: number | null;
  /** Connected agents now minus ~24 h ago (null for a team-restricted user). */
  agentsConnected: number | null;
}

/**
 * One bucket of the IPS activity series (GET /api/dashboard/timeseries: a day,
 * 'YYYY-MM-DD'; GET /api/dashboard/hourly: an hour, ISO timestamp). The last
 * point is the live current bucket. Flow figures count what happened in the
 * bucket; gauges (activeBans, agents*) are the state when it was snapshotted,
 * null when unknown (backfilled bucket, team-restricted caller).
 */
export interface IpsSeriesPoint {
  bucket: string;
  events: number;
  failures: number;
  /** Distinct IPs with at least one auth failure in the bucket. */
  uniqueIps: number;
  autoBans: number;
  manualBans: number;
  activeBans: number | null;
  agentsTotal: number | null;
  agentsConnected: number | null;
}

export interface DashboardBreakdownRow {
  /** Service name, ISO country code ('??' = unknown) or device id (as a string). */
  key: string;
  /** Display label (agent name for bansPerAgent). */
  label: string;
  /** Auth failures (services, countries) or bans (bansPerAgent). */
  count: number;
  /** Distinct attacking IPs. */
  uniqueIps: number;
}

/** GET /api/dashboard/breakdown?hours=24: top 8 of each dimension over the window. */
export interface DashboardBreakdown {
  hours: number;
  topServices: DashboardBreakdownRow[];
  topCountries: DashboardBreakdownRow[];
  /** Bans of the window covering an IP the agent saw in the window, busiest first. */
  bansPerAgent: Array<DashboardBreakdownRow & { deviceId: number }>;
}

/**
 * GET /api/dashboard/groups: one row per visible group (direct agents only,
 * the client nests the rows by parentId), plus a groupId=null row for the
 * agents of no group when there are any.
 */
export interface DashboardGroupStats {
  groupId: number | null;
  groupName: string | null;
  parentId: number | null;
  sortOrder: number;
  /** Owning tenant: set from the Default tenant only (god view bucketing). */
  tenantId: number | null;
  tenantName: string | null;
  /** The group itself or an ancestor is in evaluate-only mode. */
  evaluateOnly: boolean;
  agents: number;
  connected: number;
  events24h: number;
  failures24h: number;
  bans24h: number;
}
