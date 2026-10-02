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
}

export interface IpEventStats {
  today: number;
  last24h: number;
  /** Event count per device over the last 24 hours, busiest first. */
  byDevice: Array<{ deviceId: number; count: number }>;
}
