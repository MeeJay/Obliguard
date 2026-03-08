import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldOff, Cpu, Activity, Calendar } from 'lucide-react';
import apiClient from '@/api/client';
import type { ApiResponse } from '@obliview/shared';

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
}: {
  label: string;
  value: number | null;
  icon: React.ReactNode;
  loading: boolean;
  colorClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4">
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

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { t } = useTranslation();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [recentBans, setRecentBans] = useState<BanRecord[]>([]);
  const [bansLoading, setBansLoading] = useState(true);

  const [topIps, setTopIps] = useState<IpReputationRecord[]>([]);
  const [ipsLoading, setIpsLoading] = useState(true);

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

  const handleLiftBan = async (banId: number) => {
    try {
      await apiClient.delete(`/bans/${banId}`);
      setRecentBans(prev => prev.filter(b => b.id !== banId));
      setStats(prev => prev ? { ...prev, activeBans: Math.max(0, prev.activeBans - 1) } : prev);
    } catch {
      // silently ignore — page will show stale data
    }
  };

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
        />
        <StatCard
          label={t('dashboard.blockedToday', { defaultValue: 'IPs Blocked Today' })}
          value={stats?.blockedToday ?? null}
          icon={<ShieldOff size={16} />}
          loading={statsLoading}
          colorClass="text-orange-400"
        />
        <StatCard
          label={t('dashboard.agentsOnline', { defaultValue: 'Agents Online' })}
          value={stats?.agentsOnline ?? null}
          icon={<Cpu size={16} />}
          loading={statsLoading}
          colorClass="text-status-up"
        />
        <StatCard
          label={t('dashboard.eventsToday', { defaultValue: 'Events Today' })}
          value={stats?.eventsToday ?? null}
          icon={<Activity size={16} />}
          loading={statsLoading}
          colorClass="text-accent"
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
    </div>
  );
}
