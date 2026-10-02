import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { ShieldOff, Cpu, Activity, Calendar, Server, Wifi, ChevronRight, Crosshair, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '@/api/client';
import { bansApi } from '@/api/bans.api';
import { dashboardApi } from '@/api/dashboard.api';
import { useAgentDevices, useAgentDevicesLoaded } from '@/store/agentStore';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import type {
  AgentDevice, AgentVersionDistribution, ApiResponse, DashboardSummary, IpBan,
} from '@obliview/shared';
import { anonHostname, anonIp } from '@/utils/anonymize';

/** Background refresh of the summary while the page is visible. */
const SUMMARY_REFRESH_MS = 60_000;

/** Server error message of an axios failure, else the fallback. */
function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
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
  sub,
  icon,
  loading,
  colorClass = 'text-text-primary',
  status,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
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
        <>
          <div className={`text-2xl font-bold ${colorClass}`}>
            {value ?? '—'}
          </div>
          {sub && <div className="mt-1 text-xs text-text-muted">{sub}</div>}
        </>
      )}
    </div>
  );
}

// ── Agent Card ────────────────────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function AgentCard({
  device,
  events24h,
  bans24h,
  onClick,
}: {
  device: AgentDevice;
  events24h: number;
  bans24h: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const displayName = anonHostname(device.name ?? device.hostname);
  const isOnline = device.wsConnected;
  // Presence (heartbeats / events only): admin edits move updatedAt, not this.
  const lastSeen = device.lastSeenAt ?? null;

  const osLabel = device.osInfo
    ? [device.osInfo.distro ?? device.osInfo.platform, device.osInfo.release]
        .filter(Boolean)
        .join(' ')
    : null;

  return (
    <button
      onClick={onClick}
      data-status={isOnline ? 'up' : 'down'}
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
            <span className="truncate">{anonHostname(device.hostname)}</span>
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
            <span className="font-mono">{anonIp(device.ip)}</span>
          </div>
        )}
      </div>

      {/* Stats (last 24 h) */}
      <div className="mt-3 pt-3 border-t border-border grid grid-cols-3 text-center">
        <div>
          <div className="text-base font-bold text-accent">{events24h}</div>
          <div className="text-[10px] text-text-muted leading-tight">
            {t('dashboard.events24h', { defaultValue: 'events 24h' })}
          </div>
        </div>
        <div>
          <div className={`text-base font-bold ${bans24h > 0 ? 'text-status-down' : 'text-text-muted'}`}>
            {bans24h}
          </div>
          <div className="text-[10px] text-text-muted leading-tight">
            {t('dashboard.bans24h', { defaultValue: 'bans 24h' })}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-text-muted">
            {lastSeen ? relativeTime(lastSeen) : '—'}
          </div>
          <div className="text-[10px] text-text-muted leading-tight">
            {t('dashboard.lastSeen', { defaultValue: 'last seen' })}
          </div>
        </div>
      </div>
    </button>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [recentBans, setRecentBans] = useState<IpBan[]>([]);
  const [bansLoading, setBansLoading] = useState(true);
  const [liftingId, setLiftingId] = useState<number | null>(null);

  // Agent version distribution (C17-1): outdated / update-requested chip.
  const [versionDist, setVersionDist] = useState<AgentVersionDistribution | null>(null);

  // Agents come from the shared store (polled by AppLayout, live via sockets).
  const allDevices = useAgentDevices();
  const agentsLoaded = useAgentDevicesLoaded();
  const agentDevices = allDevices.filter(d => d.status === 'approved' || d.status === 'pending');

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await dashboardApi.summary());
    } catch {
      // Keep the previous numbers; the cards show '—' on first failure.
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const loadBans = useCallback(async () => {
    try {
      const res = await bansApi.list({ active: true, pageSize: 10 });
      setRecentBans(res.data ?? []);
    } catch {
      setRecentBans([]);
    } finally {
      setBansLoading(false);
    }
  }, []);

  const loadVersions = useCallback(() => {
    apiClient
      .get<ApiResponse<AgentVersionDistribution>>('/agent/devices/versions')
      .then(res => setVersionDist(res.data.data ?? null))
      .catch(() => setVersionDist(null));
  }, []);

  useEffect(() => {
    void loadSummary();
    void loadBans();
    loadVersions();
  }, [loadSummary, loadBans, loadVersions]);

  // Refresh: every minute while visible, on return to the tab, and after a
  // socket reconnect (events emitted while it was down are lost).
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      void loadSummary();
      void loadBans();
      loadVersions();
    };
    const id = setInterval(refresh, SUMMARY_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(SOCKET_RESYNC_EVENT, refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(SOCKET_RESYNC_EVENT, refresh);
    };
  }, [loadSummary, loadBans, loadVersions]);

  const handleLiftBan = async (ban: IpBan) => {
    if (!window.confirm(t('dashboard.liftConfirm', { ip: ban.ip, defaultValue: 'Lift the ban on {{ip}}?' }))) return;
    setLiftingId(ban.id);
    try {
      await bansApi.lift(ban.id);
      setRecentBans(prev => prev.filter(b => b.id !== ban.id));
      toast.success(t('dashboard.lifted', { ip: ban.ip, defaultValue: 'Ban on {{ip}} lifted' }));
      void loadSummary();
    } catch (err) {
      toast.error(apiError(err, t('dashboard.liftFailed', { defaultValue: 'Failed to lift the ban' })));
    } finally {
      setLiftingId(null);
    }
  };

  const perAgent = new Map((summary?.perAgent ?? []).map(a => [a.deviceId, a]));

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
          value={summary?.activeBans ?? null}
          sub={summary && t('dashboard.bansTodaySplit', {
            defaultValue: '+{{auto}} auto · +{{manual}} manual today',
            auto: summary.bansToday.auto,
            manual: summary.bansToday.manual,
          })}
          icon={<ShieldOff size={16} />}
          loading={summaryLoading}
          colorClass="text-status-down"
          status="down"
        />
        <StatCard
          label={t('dashboard.attacks24h', { defaultValue: 'Attacks (24h)' })}
          value={summary?.failures24h ?? null}
          sub={summary && t('dashboard.failuresTodaySub', {
            defaultValue: '{{failures}} failures / {{events}} events today',
            failures: summary.failuresToday,
            events: summary.eventsToday,
          })}
          icon={<Activity size={16} />}
          loading={summaryLoading}
          colorClass="text-orange-400"
          status="alert"
        />
        <StatCard
          label={t('dashboard.agentsConnected', { defaultValue: 'Agents Connected' })}
          value={summary ? `${summary.agentsConnected}/${summary.agentsTotal}` : null}
          sub={summary && (summary.agentsEvaluateOnly > 0 || summary.agentsOutdated > 0)
            ? [
                summary.agentsEvaluateOnly > 0
                  ? t('dashboard.agentsEvaluateOnly', { defaultValue: '{{count}} evaluate-only', count: summary.agentsEvaluateOnly })
                  : null,
                summary.agentsOutdated > 0
                  ? t('dashboard.agentsOutdated', { defaultValue: '{{count}} outdated', count: summary.agentsOutdated })
                  : null,
              ].filter(Boolean).join(' · ')
            : undefined}
          icon={<Cpu size={16} />}
          loading={summaryLoading}
          colorClass="text-status-up"
          status="up"
        />
        <StatCard
          label={t('dashboard.hostileIps24h', { defaultValue: 'Hostile IPs (24h)' })}
          value={summary?.uniqueIps24h ?? null}
          sub={summary && t('dashboard.hostileIpsTodaySub', {
            defaultValue: '{{count}} today',
            count: summary.uniqueIpsToday,
          })}
          icon={<Crosshair size={16} />}
          loading={summaryLoading}
          colorClass="text-purple-400"
          status="events"
        />
      </div>

      {/* Agent updates (C17-1): failed attempts, outdated agents, pending requests */}
      {versionDist && (versionDist.outdated > 0 || versionDist.updatePending > 0 || (versionDist.updateFailed ?? 0) > 0) && (
        <Link to="/manage/agents" className="mb-6 flex flex-wrap items-center gap-2 text-xs w-fit">
          {(versionDist.updateFailed ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium bg-red-500/10 text-red-400 border border-red-500/20"
              data-testid="dashboard-updates-failed"
            >
              <AlertTriangle size={11} />
              {t('agents.update.failedCount', { defaultValue: '{{count}} update(s) failed', count: versionDist.updateFailed })}
            </span>
          )}
          {versionDist.outdated > 0 && (
            <span className="rounded-full px-2.5 py-1 font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
              {t('agentUpdate.dashboardOutdated', {
                defaultValue: '{{count}} agent(s) behind v{{version}}',
                count: versionDist.outdated,
                version: versionDist.latestVersion ?? '?',
              })}
            </span>
          )}
          {versionDist.updatePending > 0 && (
            <span className="rounded-full px-2.5 py-1 font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
              {t('agentUpdate.distribution.pending', { defaultValue: '{{count}} update(s) requested', count: versionDist.updatePending })}
            </span>
          )}
        </Link>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Recent Bans */}
        <div className="rounded-lg border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('dashboard.recentBans', { defaultValue: 'Recent Bans' })}
            </h2>
            <Link to="/ip-reputation?status=banned" className="text-xs text-accent hover:underline">
              {t('dashboard.viewAll', { defaultValue: 'View all' })}
            </Link>
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
                      {t('dashboard.colScope', { defaultValue: 'Scope' })}
                    </th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colType', { defaultValue: 'Type' })}
                    </th>
                    <th className="text-left px-4 py-2 font-medium">
                      {t('dashboard.colReason', { defaultValue: 'Reason' })}
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
                      <td className="px-4 py-2.5 font-mono text-xs text-text-primary">
                        <Link to={`/ip-reputation?search=${encodeURIComponent(ban.ip)}`} className="hover:underline">
                          {anonIp(ban.ip)}{ban.cidrPrefix != null ? `/${ban.cidrPrefix}` : ''}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary text-xs whitespace-nowrap">
                        {ban.scope}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary text-xs whitespace-nowrap">
                        {ban.banType}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary truncate max-w-[160px]" title={ban.reason ?? undefined}>
                        {ban.reason ?? <span className="text-text-muted">—</span>}
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
                          onClick={() => { void handleLiftBan(ban); }}
                          disabled={liftingId === ban.id}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
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
            {summaryLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : !summary || summary.topIps.length === 0 ? (
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
                      {t('dashboard.colLastSeen', { defaultValue: 'Last Seen' })}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summary.topIps.map(rec => (
                    <tr key={rec.ip} className="hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2.5 font-mono text-xs text-text-primary">
                        <Link to={`/ip-reputation?search=${encodeURIComponent(rec.ip)}`} className="hover:underline">
                          {anonIp(rec.ip)}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary">
                        {rec.geoCountryCode ?? <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-semibold text-orange-400">{rec.totalFailures}</span>
                      </td>
                      <td className="px-4 py-2.5 text-text-muted text-xs whitespace-nowrap">
                        {rec.lastSeen ? relativeTime(rec.lastSeen) : '—'}
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
          {agentDevices.length > 0 && (
            <span className="text-xs text-text-muted">
              {t('dashboard.agentsOnlineCount', {
                defaultValue: '{{online}}/{{total}} online',
                online: agentDevices.filter(d => d.wsConnected).length,
                total: agentDevices.length,
              })}
            </span>
          )}
        </div>

        {!agentsLoaded ? (
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
              const counts = perAgent.get(device.id);
              return (
                <AgentCard
                  key={device.id}
                  device={device}
                  events24h={counts?.events24h ?? 0}
                  bans24h={counts?.bans24h ?? 0}
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
