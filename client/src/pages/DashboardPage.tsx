import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ShieldOff, Cpu, Activity, Calendar, Server, Wifi, ChevronRight } from 'lucide-react';
import apiClient from '@/api/client';
import type { AgentDevice, ApiResponse } from '@obliview/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

interface BanRecord {
  id: number;
  ip: string;
  service?: string | null;
  reason?: string | null;
  agentName?: string | null;
  bannedAt: string;
}

interface IpReputationRecord {
  ip: string;
  country?: string | null;
  failureCount: number;
  services?: string[];
  status?: string | null;
}

interface DashboardStats {
  activeBans: number;
  blockedToday: number;
  agentsOnline: number;
  eventsToday: number;
}

interface AgentEventCount {
  count: number;
  failures: number;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded bg-bg-tertiary ${className ?? ''}`} />
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  loading,
  colorClass = 'text-text-primary',
  status,
}: {
  label: string;
  value: number | null;
  icon: React.ReactNode;
  loading: boolean;
  colorClass?: string;
  status?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4" data-status={status}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-text-muted">{icon}</span>
        <span className="text-sm text-text-secondary">{label}</span>
      </div>
      {loading ? (
        <Skeleton className="h-8 w-20 mt-1" />
      ) : (
        <div className={`text-2xl font-bold ${colorClass}`}>
          {value ?? '—'}
        </div>
      )}
    </div>
  );
}

// ── Agent Card ────────────────────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function AgentCard({
  device,
  eventCount,
  failureCount,
  onClick,
}: {
  device: AgentDevice;
  eventCount: number;
  failureCount: number;
  onClick: () => void;
}) {
  const displayName = device.name ?? device.hostname;
  const intervalSecs = device.resolvedSettings?.checkIntervalSeconds ?? 60;
  const isOnline = Date.now() - new Date(device.updatedAt).getTime() < intervalSecs * 3 * 1000;

  const osLabel = device.osInfo
    ? [device.osInfo.distro ?? device.osInfo.platform, device.osInfo.release]
        .filter(Boolean)
        .join(' ')
    : null;

  return (
    <button
      onClick={onClick}
      className="rounded-lg border border-border bg-bg-secondary p-4 text-left hover:bg-bg-hover hover:border-accent/30 transition-colors w-full"
    >
      {/* Header row */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              isOnline ? 'bg-status-up' : 'bg-status-down'
            }`}
          />
          <span className="font-medium text-text-primary text-sm truncate">{displayName}</span>
        </div>
        <ChevronRight size={14} className="text-text-muted flex-shrink-0 mt-0.5 ml-1" />
      </div>

      {/* Meta */}
      <div className="space-y-1 text-xs text-text-secondary">
        {device.hostname !== displayName && (
          <div className="flex items-center gap-1">
            <Server size={10} className="text-text-muted flex-shrink-0" />
            <span className="truncate">{device.hostname}</span>
          </div>
        )}
        {osLabel && (
          <div className="flex items-center gap-1">
            <Cpu size={10} className="text-text-muted flex-shrink-0" />
            <span className="truncate">{osLabel}</span>
          </div>
        )}
        {device.ip && (
          <div className="flex items-center gap-1">
            <Wifi size={10} className="text-text-muted flex-shrink-0" />
            <span className="font-mono">{device.ip}</span>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="mt-3 pt-3 border-t border-border grid grid-cols-3 text-center">
        <div>
          <div className="text-base font-bold text-accent">{eventCount}</div>
          <div className="text-[10px] text-text-muted leading-tight">events</div>
        </div>
        <div>
          <div
            className={`text-base font-bold ${
              failureCount > 0 ? 'text-status-down' : 'text-text-muted'
            }`}
          >
            {failureCount}
          </div>
          <div className="text-[10px] text-text-muted leading-tight">failures</div>
        </div>
        <div>
          <div className="text-xs font-medium text-text-muted">
            {relativeTime(device.updatedAt)}
          </div>
          <div className="text-[10px] text-text-muted leading-tight">last seen</div>
        </div>
      </div>
    </button>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [recentBans, setRecentBans] = useState<BanRecord[]>([]);
  const [bansLoading, setBansLoading] = useState(true);

  const [topIps, setTopIps] = useState<IpReputationRecord[]>([]);
  const [ipsLoading, setIpsLoading] = useState(true);

  const [agentDevices, setAgentDevices] = useState<AgentDevice[]>([]);
  const [agentEventCounts, setAgentEventCounts] = useState<Map<number, AgentEventCount>>(new Map());
  const [agentsLoading, setAgentsLoading] = useState(true);

  // Fetch stats
  useEffect(() => {
    async function fetchStats() {
      try {
        const [bansRes, agentsRes, eventsRes] = await Promise.allSettled([
          apiClient.get<ApiResponse<{ active: number; today: number }>>('/bans/stats'),
          apiClient.get<ApiResponse<{ online: number }>>('/agent/devices/stats'),
          apiClient.get<ApiResponse<{ today: number }>>('/ip-events/stats'),
        ]);

        const activeBans =
          bansRes.status === 'fulfilled' ? (bansRes.value.data.data?.active ?? 0) : 0;
        const blockedToday =
          bansRes.status === 'fulfilled' ? (bansRes.value.data.data?.today ?? 0) : 0;
        const agentsOnline =
          agentsRes.status === 'fulfilled' ? (agentsRes.value.data.data?.online ?? 0) : 0;
        const eventsToday =
          eventsRes.status === 'fulfilled' ? (eventsRes.value.data.data?.today ?? 0) : 0;

        setStats({ activeBans, blockedToday, agentsOnline, eventsToday });
      } catch {
        setStats({ activeBans: 0, blockedToday: 0, agentsOnline: 0, eventsToday: 0 });
      } finally {
        setStatsLoading(false);
      }
    }
    fetchStats();
  }, []);

  // Fetch recent bans
  useEffect(() => {
    apiClient
      .get<ApiResponse<BanRecord[]>>('/bans', { params: { active: 'true', pageSize: 10 } })
      .then(res => setRecentBans(res.data.data ?? []))
      .catch(() => setRecentBans([]))
      .finally(() => setBansLoading(false));
  }, []);

  // Fetch top IPs by failure count
  useEffect(() => {
    apiClient
      .get<ApiResponse<IpReputationRecord[]>>('/ip-reputation', { params: { limit: 5 } })
      .then(res => setTopIps(res.data.data ?? []))
      .catch(() => setTopIps([]))
      .finally(() => setIpsLoading(false));
  }, []);

  // Fetch agents + today's event counts
  useEffect(() => {
    async function fetchAgents() {
      try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const [devicesRes, eventsRes] = await Promise.allSettled([
          apiClient.get<ApiResponse<AgentDevice[]>>('/agent/devices'),
          apiClient.get('/ip-events', {
            params: { from: todayStart.toISOString(), pageSize: 1000 },
          }),
        ]);

        const devices =
          devicesRes.status === 'fulfilled' ? (devicesRes.value.data.data ?? []) : [];
        setAgentDevices(devices.filter(d => d.status === 'approved' || d.status === 'pending'));

        const countsMap = new Map<number, AgentEventCount>();
        if (eventsRes.status === 'fulfilled') {
          for (const ev of (eventsRes.value.data.data ?? [])) {
            const did = ev.device_id ?? ev.deviceId;
            if (!did) continue;
            const cur = countsMap.get(did);
            if (cur) {
              cur.count++;
              if (ev.event_type === 'auth_failure' || ev.eventType === 'auth_failure') {
                cur.failures++;
              }
            } else {
              countsMap.set(did, {
                count: 1,
                failures:
                  ev.event_type === 'auth_failure' || ev.eventType === 'auth_failure' ? 1 : 0,
              });
            }
          }
        }
        setAgentEventCounts(countsMap);
      } finally {
        setAgentsLoading(false);
      }
    }
    fetchAgents();
  }, []);

  const handleLiftBan = async (banId: number) => {
    try {
      await apiClient.delete(`/bans/${banId}`);
      setRecentBans(prev => prev.filter(b => b.id !== banId));
      setStats(prev => prev ? { ...prev, activeBans: Math.max(0, prev.activeBans - 1) } : prev);
    } catch {
      // silently ignore — page will show stale data
    }
  };

  // Count how many agents are online
  const onlineCount = useMemo(() => {
    return agentDevices.filter(d => {
      const interval = d.resolvedSettings?.checkIntervalSeconds ?? 60;
      return Date.now() - new Date(d.updatedAt).getTime() < interval * 3 * 1000;
    }).length;
  }, [agentDevices]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">
          {t('dashboard.title', { defaultValue: 'Dashboard' })}
        </h1>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label={t('dashboard.activeBans', { defaultValue: 'Active Bans' })}
          value={stats?.activeBans ?? null}
          icon={<ShieldOff size={16} />}
          loading={statsLoading}
          colorClass="text-status-down"
          status="down"
        />
        <StatCard
          label={t('dashboard.blockedToday', { defaultValue: 'IPs Blocked Today' })}
          value={stats?.blockedToday ?? null}
          icon={<ShieldOff size={16} />}
          loading={statsLoading}
          colorClass="text-orange-400"
          status="alert"
        />
        <StatCard
          label={t('dashboard.agentsOnline', { defaultValue: 'Agents Online' })}
          value={stats?.agentsOnline ?? null}
          icon={<Cpu size={16} />}
          loading={statsLoading}
          colorClass="text-status-up"
          status="up"
        />
        <StatCard
          label={t('dashboard.eventsToday', { defaultValue: 'Events Today' })}
          value={stats?.eventsToday ?? null}
          icon={<Activity size={16} />}
          loading={statsLoading}
          colorClass="text-accent"
          status="pending"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Recent Bans */}
        <div className="rounded-lg border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('dashboard.recentBans', { defaultValue: 'Recent Bans' })}
            </h2>
          </div>
          <div className="overflow-x-auto">
            {bansLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : recentBans.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-text-muted">
                {t('dashboard.noBans', { defaultValue: 'No active bans' })}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase text-text-muted border-b border-border">
                    <th className="text-left px-4 py-2 font-medium">IP</th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colService', { defaultValue: 'Service' })}
                    </th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colReason', { defaultValue: 'Reason' })}
                    </th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colAgent', { defaultValue: 'Agent' })}
                    </th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colBannedAt', { defaultValue: 'Banned At' })}
                    </th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentBans.map(ban => (
                    <tr key={ban.id} className="hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2.5 font-mono text-xs text-text-primary">{ban.ip}</td>
                      <td className="px-4 py-2.5 text-text-secondary truncate max-w-[100px]">
                        {ban.service ?? <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary truncate max-w-[120px]">
                        {ban.reason ?? <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary truncate max-w-[100px]">
                        {ban.agentName ?? <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-text-muted text-xs whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <Calendar size={11} />
                          {new Date(ban.bannedAt).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={() => handleLiftBan(ban.id)}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors"
                        >
                          {t('dashboard.lift', { defaultValue: 'Lift' })}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Top IPs by Failure Count */}
        <div className="rounded-lg border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('dashboard.topIps', { defaultValue: 'Top IPs by Failure Count' })}
            </h2>
          </div>
          <div className="overflow-x-auto">
            {ipsLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : topIps.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-text-muted">
                {t('dashboard.noIpData', { defaultValue: 'No IP reputation data' })}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase text-text-muted border-b border-border">
                    <th className="text-left px-4 py-2 font-medium">IP</th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colCountry', { defaultValue: 'Country' })}
                    </th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colFailures', { defaultValue: 'Failures' })}
                    </th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colServices', { defaultValue: 'Services' })}
                    </th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colStatus', { defaultValue: 'Status' })}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {topIps.map((rec, i) => (
                    <tr key={i} className="hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2.5 font-mono text-xs text-text-primary">{rec.ip}</td>
                      <td className="px-4 py-2.5 text-text-secondary">
                        {rec.country ?? <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-semibold text-orange-400">{rec.failureCount}</span>
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary truncate max-w-[120px]">
                        {rec.services && rec.services.length > 0
                          ? rec.services.join(', ')
                          : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {rec.status ? (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            rec.status === 'banned'
                              ? 'bg-red-500/10 text-red-400'
                              : rec.status === 'whitelisted'
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-bg-tertiary text-text-muted'
                          }`}>
                            {rec.status.toUpperCase()}
                          </span>
                        ) : (
                          <span className="text-text-muted text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* ── Agent Cards ──────────────────────────────────────────────────────── */}
      <div className="mt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            {t('dashboard.agents', { defaultValue: 'Agents' })}
          </h2>
          {!agentsLoading && agentDevices.length > 0 && (
            <span className="text-xs text-text-muted">
              {onlineCount}/{agentDevices.length} online
            </span>
          )}
        </div>

        {agentsLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-36 w-full" />
            ))}
          </div>
        ) : agentDevices.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-secondary px-4 py-8 text-center text-sm text-text-muted">
            {t('dashboard.noAgents', { defaultValue: 'No agents registered yet' })}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {agentDevices.map(device => {
              const counts = agentEventCounts.get(device.id) ?? { count: 0, failures: 0 };
              return (
                <AgentCard
                  key={device.id}
                  device={device}
                  eventCount={counts.count}
                  failureCount={counts.failures}
                  onClick={() => navigate(`/agents/${device.id}`)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
