import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, Calendar, Cpu, Crosshair, FolderTree, Globe2, LayoutDashboard,
  Server, ShieldOff,
} from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '@/api/client';
import { bansApi } from '@/api/bans.api';
import { dashboardApi } from '@/api/dashboard.api';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import { useSocketRefresh } from '@/hooks/useSocketRefresh';
import { useIpDrawer } from '@/hooks/useIpDrawer';
import { useIpsPermissions } from '@/hooks/useIpsPermissions';
import { useCan } from '@/hooks/usePermission';
import { useTenantStore } from '@/store/tenantStore';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Tip } from '@/components/common/Tip';
import { HeroCard } from '@/components/dashboard/HeroCard';
import { ActivityChart, type ActivityPoint } from '@/components/dashboard/ActivityChart';
import { BreakdownCard } from '@/components/dashboard/BreakdownCard';
import { GroupTree } from '@/components/dashboard/GroupCard';
import { SOCKET_EVENTS } from '@obliview/shared';
import type {
  AgentVersionDistribution, ApiResponse, DashboardBreakdown, DashboardGroupStats, DashboardSummary,
  IpBan, IpsSeriesPoint,
} from '@obliview/shared';
import { anonHostname, anonIp } from '@/utils/anonymize';

/** Background refresh while the page is visible (sockets cover most changes). */
const SUMMARY_REFRESH_MS = 60_000;

/**
 * Socket events that change the dashboard figures.
 */
const REFRESH_EVENTS = [
  SOCKET_EVENTS.BAN_CREATED, SOCKET_EVENTS.BAN_AUTO, SOCKET_EVENTS.BAN_LIFTED, SOCKET_EVENTS.BAN_BULK_LIFTED,
  SOCKET_EVENTS.BAN_UPDATED, SOCKET_EVENTS.BAN_EXCLUDED, SOCKET_EVENTS.BAN_EXCLUSION_REMOVED,
  SOCKET_EVENTS.AGENT_STATUS_CHANGED,
] as const;

type ActivityRange = '24h' | '48h' | '7d' | '14d' | '30d';
const RANGES: ActivityRange[] = ['24h', '48h', '7d', '14d', '30d'];

/** Server error message of an axios failure, else the fallback. */
function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

/** A Link when `enabled`, else a plain block (the target page is not allowed). */
function MaybeLink({ enabled, to, className, children }: { enabled: boolean; to: string; className?: string; children: React.ReactNode }) {
  return enabled
    ? <Link to={to} className={className}>{children}</Link>
    : <div className={className}>{children}</div>;
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className ?? ''}`} />;
}

function relativeTime(ts: string, t: TFunction): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (diff < 60) return t('dashboard.secondsAgo', { count: diff, defaultValue: '{{count}}s ago' });
  if (diff < 3600) return t('dashboard.minutesAgo', { count: Math.floor(diff / 60), defaultValue: '{{count}}m ago' });
  if (diff < 86400) return t('dashboard.hoursAgo', { count: Math.floor(diff / 3600), defaultValue: '{{count}}h ago' });
  return t('dashboard.daysAgo', { count: Math.floor(diff / 86400), defaultValue: '{{count}}d ago' });
}

/** 'YYYY-MM-DD' (server day bucket) as a local date. */
function dayDate(bucket: string): Date {
  const [y, m, d] = bucket.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Card shell shared by the panels (Obliance surface: no border, soft shadow). */
const PANEL = 'rounded-xl bg-bg-secondary shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)]';

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { t } = useTranslation();

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [daily, setDaily] = useState<IpsSeriesPoint[]>([]);
  const [hourly, setHourly] = useState<IpsSeriesPoint[]>([]);
  const [breakdown, setBreakdown] = useState<DashboardBreakdown | null>(null);
  const [groups, setGroups] = useState<DashboardGroupStats[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [activityRange, setActivityRange] = useState<ActivityRange>('7d');

  const [recentBans, setRecentBans] = useState<IpBan[]>([]);
  const [bansLoading, setBansLoading] = useState(true);
  const [liftingId, setLiftingId] = useState<number | null>(null);
  const confirm = useConfirm();
  // IP cells open the unified IP detail drawer (?ip=, mounted in AppLayout).
  const { open: openIp } = useIpDrawer();
  const { canLift, canLiftGlobally } = useIpsPermissions();
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  // The update chips open the Agent config hub (Update policy: Retry / Update now).
  const canOpenAgentAdmin = useCan(['agents.keys', 'agents.approve', 'agents.manage']);
  const canManageGroups = useCan('groups.manage');

  // Agent version distribution (C17-1): outdated / update-requested chip.
  const [versionDist, setVersionDist] = useState<AgentVersionDistribution | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await dashboardApi.summary());
    } catch {
      // Keep the previous numbers; the cards show '—' on first failure.
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const loadSeries = useCallback(async () => {
    const [d, h] = await Promise.all([
      dashboardApi.timeseries(30).catch(() => null),
      dashboardApi.hourly(48).catch(() => null),
    ]);
    if (d) setDaily(d);
    if (h) setHourly(h);
  }, []);

  const loadBreakdown = useCallback(async () => {
    try {
      setBreakdown(await dashboardApi.breakdown(24));
    } catch {
      // Previous breakdown kept.
    }
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await dashboardApi.groups());
    } catch {
      // Previous cards kept.
    } finally {
      setGroupsLoading(false);
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

  /** Everything that moves with a ban or an agent going up / down. */
  const refreshLive = useCallback(() => {
    void loadSummary();
    void loadBans();
    void loadGroups();
    void loadSeries();
  }, [loadSummary, loadBans, loadGroups, loadSeries]);

  const refreshAll = useCallback(() => {
    refreshLive();
    void loadBreakdown();
    loadVersions();
  }, [refreshLive, loadBreakdown, loadVersions]);

  // Tenant switch (and first mount): reload everything.
  useEffect(() => {
    refreshAll();
  }, [refreshAll, currentTenantId]);

  // Live: debounced refetch on ban / agent status events and after a socket
  // reconnect (events emitted while it was down are lost).
  useSocketRefresh(REFRESH_EVENTS, refreshLive, { debounceMs: 1500 });

  // Every minute while visible (events keep flowing without a socket event),
  // and on return to the tab.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      refreshAll();
    };
    const id = setInterval(refresh, SUMMARY_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(SOCKET_RESYNC_EVENT, loadVersions);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(SOCKET_RESYNC_EVENT, loadVersions);
    };
  }, [refreshAll, loadVersions]);

  /**
   * Lift is offered only where the server accepts it (ban.service lift): from
   * the master tenant any ban (global effect); elsewhere a global ban (local
   * exclusion) or a ban owned by the current tenant.
   */
  const canLiftBan = (ban: IpBan): boolean =>
    canLift && (canLiftGlobally || ban.scope === 'global' || ban.tenantId === currentTenantId);

  const handleLiftBan = async (ban: IpBan) => {
    const ip = anonIp(ban.ip);
    const message = canLiftGlobally
      ? (ban.scope === 'global'
        ? t('dashboard.liftConfirmGlobal', { ip, defaultValue: 'Lift the ban on {{ip}}? It is removed on every agent of every workspace.' })
        : t('dashboard.liftConfirm', { ip, defaultValue: 'Lift the ban on {{ip}}?' }))
      : (ban.scope === 'global'
        ? t('dashboard.liftConfirmLocal', { ip, defaultValue: 'Lift the ban on {{ip}} for this workspace? The global ban stays active for the other workspaces.' })
        : t('dashboard.liftConfirm', { ip, defaultValue: 'Lift the ban on {{ip}}?' }));
    const ok = await confirm({
      title: t('dashboard.liftTitle', { defaultValue: 'Lift ban' }),
      message,
      confirmLabel: t('dashboard.lift', { defaultValue: 'Lift' }),
      danger: true,
    });
    if (!ok) return;
    setLiftingId(ban.id);
    try {
      await bansApi.lift(ban.id);
      setRecentBans(prev => prev.filter(b => b.id !== ban.id));
      toast.success(t('dashboard.lifted', { ip, defaultValue: 'Ban on {{ip}} lifted' }));
      void loadSummary();
    } catch (err) {
      toast.error(apiError(err, t('dashboard.liftFailed', { defaultValue: 'Failed to lift the ban' })));
    } finally {
      setLiftingId(null);
    }
  };

  // ── Derived figures ──────────────────────────────────────────────────────

  const deltas = summary?.deltas;
  /** "12 vs yesterday" / "stable" / the fallback when there is no reference. */
  const deltaText = (d: number | null | undefined, fallback?: string): string | undefined => {
    if (d == null) return fallback;
    if (d === 0) return t('dashboard.stableVsYesterday', { defaultValue: 'stable vs yesterday' });
    return t('dashboard.vsYesterday', { count: Math.abs(d), defaultValue: '{{count}} vs yesterday' });
  };

  const last24h = useMemo(() => hourly.slice(-24), [hourly]);
  const bansSeries = useMemo(() => daily.slice(-14).map(p => p.autoBans + p.manualBans), [daily]);
  const failuresSeries = useMemo(() => last24h.map(p => p.failures), [last24h]);
  const ipsSeries = useMemo(() => last24h.map(p => p.uniqueIps), [last24h]);
  const connectedSeries = useMemo(
    () => hourly.filter(p => p.agentsConnected != null).slice(-24).map(p => p.agentsConnected as number),
    [hourly],
  );

  const activityData: ActivityPoint[] = useMemo(() => {
    if (activityRange === '24h' || activityRange === '48h') {
      return hourly.slice(activityRange === '24h' ? -24 : -48).map((p) => {
        const d = new Date(p.bucket);
        return {
          label: t('dashboard.hourTick', { hour: String(d.getHours()).padStart(2, '0'), defaultValue: '{{hour}}h' }),
          title: d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
          failures: p.failures, events: p.events, uniqueIps: p.uniqueIps, bans: p.autoBans + p.manualBans,
        };
      });
    }
    const n = activityRange === '7d' ? 7 : activityRange === '14d' ? 14 : 30;
    return daily.slice(-n).map((p) => ({
      label: p.bucket.slice(5),
      title: dayDate(p.bucket).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      failures: p.failures, events: p.events, uniqueIps: p.uniqueIps, bans: p.autoBans + p.manualBans,
    }));
  }, [activityRange, hourly, daily, t]);

  const rangeTotals = useMemo(() => activityData.reduce(
    (acc, p) => ({ failures: acc.failures + p.failures, bans: acc.bans + p.bans }),
    { failures: 0, bans: 0 },
  ), [activityData]);

  const agentsOffline = summary ? summary.agentsTotal - summary.agentsConnected : 0;

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        icon={<LayoutDashboard size={20} />}
        title={t('dashboard.title', { defaultValue: 'Dashboard' })}
        description={summary
          ? t('dashboard.agentsProtected', { count: summary.agentsTotal, defaultValue: '{{count}} agents protected' })
          : undefined}
        actions={(
          <Link
            to="/live-events"
            className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md bg-accent/10 px-3.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent/20"
          >
            {t('dashboard.openLiveEvents', { defaultValue: 'Live events' })}
            <ArrowRight size={14} />
          </Link>
        )}
      />

      {/* Hero KPIs: each card opens the filtered view behind its number. */}
      <div className="grid grid-cols-1 items-stretch gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <HeroCard
          label={t('dashboard.activeBans', { defaultValue: 'Active Bans' })}
          icon={<ShieldOff size={13} />}
          value={summary?.activeBans ?? null}
          valueClass="text-status-down"
          status="down"
          loading={summaryLoading}
          delta={deltas?.activeBans ?? null}
          upIsGood={false}
          deltaText={deltaText(deltas?.activeBans)}
          series={bansSeries}
          seriesColor="rgb(var(--c-status-down))"
          subStats={summary ? [
            { label: t('dashboard.autoToday', { defaultValue: 'auto today' }), value: `+${summary.bansToday.auto}` },
            { label: t('dashboard.manualToday', { defaultValue: 'manual today' }), value: `+${summary.bansToday.manual}` },
          ] : undefined}
          to="/ip-reputation?tab=bans"
        />
        <HeroCard
          label={t('dashboard.attacks24h', { defaultValue: 'Attacks (24h)' })}
          icon={<Activity size={13} />}
          value={summary?.failures24h ?? null}
          valueClass="text-orange-400"
          status="alert"
          loading={summaryLoading}
          delta={deltas?.failures24h ?? null}
          upIsGood={false}
          deltaText={deltaText(deltas?.failures24h)}
          series={failuresSeries}
          seriesColor="rgb(var(--c-status-down))"
          subStats={summary ? [
            { label: t('dashboard.failuresToday', { defaultValue: 'failures today' }), value: summary.failuresToday },
            { label: t('dashboard.eventsToday', { defaultValue: 'events today' }), value: summary.eventsToday },
          ] : undefined}
          to="/live-events?period=24h"
        />
        <HeroCard
          label={t('dashboard.agentsConnected', { defaultValue: 'Agents Connected' })}
          icon={<Cpu size={13} />}
          value={summary ? `${summary.agentsConnected}/${summary.agentsTotal}` : null}
          valueClass="text-status-up"
          status="up"
          loading={summaryLoading}
          delta={deltas?.agentsConnected ?? null}
          deltaText={deltaText(
            deltas?.agentsConnected,
            summary && summary.agentsTotal > 0
              ? t('dashboard.connectedPct', {
                pct: Math.round((summary.agentsConnected / summary.agentsTotal) * 100),
                defaultValue: '{{pct}}% connected',
              })
              : undefined,
          )}
          series={connectedSeries}
          seriesColor="rgb(var(--c-status-up))"
          subStats={summary ? [
            ...(agentsOffline > 0 ? [{ label: t('dashboard.offlineShort', { defaultValue: 'offline' }), value: agentsOffline, className: 'text-status-down' }] : []),
            // C20: evaluate-only agents observe without banning, always shown.
            {
              label: t('dashboard.evaluateOnlyShort', { defaultValue: 'evaluate-only' }),
              value: summary.agentsEvaluateOnly,
              className: summary.agentsEvaluateOnly > 0 ? 'text-amber-400' : undefined,
            },
            ...(summary.agentsOutdated > 0 ? [{ label: t('dashboard.outdatedShort', { defaultValue: 'outdated' }), value: summary.agentsOutdated, className: 'text-amber-400' }] : []),
          ] : undefined}
          // /agents is open to every member and reads ?status= as chips (W10-1).
          to={agentsOffline > 0 ? '/agents?status=offline' : '/agents'}
        />
        <HeroCard
          label={t('dashboard.hostileIps24h', { defaultValue: 'Hostile IPs (24h)' })}
          icon={<Crosshair size={13} />}
          value={summary?.uniqueIps24h ?? null}
          valueClass="text-purple-400"
          status="events"
          loading={summaryLoading}
          delta={deltas?.uniqueIps24h ?? null}
          upIsGood={false}
          deltaText={deltaText(deltas?.uniqueIps24h)}
          series={ipsSeries}
          seriesColor="rgb(168 85 247)"
          subStats={summary ? [
            { label: t('dashboard.today', { defaultValue: 'today' }), value: summary.uniqueIpsToday },
          ] : undefined}
          to="/ip-reputation?tab=activity&sortBy=failures"
        />
      </div>

      {/* Agent updates (C17-1): failed attempts, outdated agents, pending requests */}
      {versionDist && (versionDist.outdated > 0 || versionDist.updatePending > 0 || (versionDist.updateFailed ?? 0) > 0) && (
        <MaybeLink enabled={canOpenAgentAdmin} to="/manage/agents" className="flex w-fit flex-wrap items-center gap-2 text-xs">
          {(versionDist.updateFailed ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 font-medium text-red-400"
              data-testid="dashboard-updates-failed"
            >
              <AlertTriangle size={11} />
              {t('agents.update.failedCount', { defaultValue: '{{count}} update(s) failed', count: versionDist.updateFailed })}
            </span>
          )}
          {versionDist.outdated > 0 && (
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 font-medium text-amber-400">
              {t('agentUpdate.dashboardOutdated', {
                defaultValue: '{{count}} agent(s) behind v{{version}}',
                count: versionDist.outdated,
                version: versionDist.latestVersion ?? '?',
              })}
            </span>
          )}
          {versionDist.updatePending > 0 && (
            <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 font-medium text-blue-400">
              {t('agentUpdate.distribution.pending', { defaultValue: '{{count}} update(s) requested', count: versionDist.updatePending })}
            </span>
          )}
        </MaybeLink>
      )}

      {/* Activity chart (2/3) + attacked services (1/3) */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-3">
        <div className={`${PANEL} p-5 lg:col-span-2 max-sm:p-4`}>
          <div className="mb-3 flex items-center gap-3 max-sm:flex-wrap max-sm:gap-y-2">
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-text-primary">
                {t('dashboard.attackActivity', { defaultValue: 'Attack activity' })}
              </div>
              <div className="text-[11px] font-mono tracking-wider text-text-muted">
                {t('dashboard.rangeTotals', {
                  range: activityRange,
                  failures: rangeTotals.failures,
                  bans: rangeTotals.bans,
                  defaultValue: '{{range}} · {{failures}} failures · {{bans}} bans',
                })}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-1 rounded-md bg-bg-hover p-0.5" role="group" aria-label={t('dashboard.range', { defaultValue: 'Range' })}>
              {RANGES.map((r) => {
                const hourlyRange = r === '24h' || r === '48h';
                const have = hourlyRange ? hourly.length : daily.length;
                const enabled = have >= 2;
                const active = activityRange === r;
                const btn = (
                  <button
                    key={r}
                    type="button"
                    onClick={() => enabled && setActivityRange(r)}
                    disabled={!enabled}
                    aria-pressed={active}
                    className={`rounded px-2.5 py-1 text-[11px] font-mono transition-colors coarse:min-h-9 coarse:px-3 ${
                      active
                        ? 'bg-bg-active text-text-primary'
                        : enabled ? 'text-text-muted hover:text-text-primary' : 'cursor-not-allowed text-text-muted/40'
                    }`}
                  >
                    {r}
                  </button>
                );
                return enabled ? btn : (
                  <Tip key={r} content={t('dashboard.notEnoughHistory', { defaultValue: 'Not enough history yet' })}>{btn}</Tip>
                );
              })}
            </div>
          </div>
          <ActivityChart data={activityData} />
          <div className="mt-2 flex items-center gap-4 text-[11px] font-mono text-text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 bg-status-down" /> {t('dashboard.seriesFailures', { defaultValue: 'Failures' })}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 border-t border-dashed border-text-muted" /> {t('dashboard.seriesEvents', { defaultValue: 'Events' })}
            </span>
          </div>
        </div>

        <BreakdownCard
          title={t('dashboard.topServices', { defaultValue: 'Attacked services' })}
          subtitle={t('dashboard.failures24hSub', { defaultValue: 'auth failures · 24h' })}
          icon={<Server size={16} />}
          loading={!breakdown}
          emptyText={t('dashboard.noAttacks24h', { defaultValue: 'No attack in the last 24 hours' })}
          barColor="rgb(var(--c-status-down))"
          items={(breakdown?.topServices ?? []).map((r) => ({
            key: r.key,
            label: r.label,
            count: r.count,
            sub: t('dashboard.ipsCount', { count: r.uniqueIps, defaultValue: '{{count}} IPs' }),
            to: `/live-events?period=24h&service=${encodeURIComponent(r.key)}`,
          }))}
        />
      </div>

      {/* Breakdowns: countries, bans per agent */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <BreakdownCard
          title={t('dashboard.topCountries', { defaultValue: 'Attacking countries' })}
          subtitle={t('dashboard.failures24hSub', { defaultValue: 'auth failures · 24h' })}
          icon={<Globe2 size={16} />}
          loading={!breakdown}
          emptyText={t('dashboard.noAttacks24h', { defaultValue: 'No attack in the last 24 hours' })}
          items={(breakdown?.topCountries ?? []).map((r) => ({
            key: r.key,
            label: r.key === '??' ? t('dashboard.unknownCountry', { defaultValue: 'Unknown' }) : r.label,
            count: r.count,
            sub: t('dashboard.ipsCount', { count: r.uniqueIps, defaultValue: '{{count}} IPs' }),
          }))}
        />
        <BreakdownCard
          title={t('dashboard.bansPerAgent', { defaultValue: 'Bans per agent' })}
          subtitle={t('dashboard.bansPerAgentSub', { defaultValue: 'bans on IPs seen by the agent · 24h' })}
          icon={<ShieldOff size={16} />}
          loading={!breakdown}
          emptyText={t('dashboard.noBans24h', { defaultValue: 'No ban in the last 24 hours' })}
          items={(breakdown?.bansPerAgent ?? []).map((r) => ({
            key: r.key,
            label: anonHostname(r.label),
            count: r.count,
            sub: t('dashboard.ipsCount', { count: r.uniqueIps, defaultValue: '{{count}} IPs' }),
            to: `/agents/${r.deviceId}`,
          }))}
        />
      </div>

      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
        {/* Recent Bans */}
        <div className={PANEL}>
          <div className="flex items-center justify-between px-5 py-4">
            <div className="text-[15px] font-semibold text-text-primary">
              {t('dashboard.recentBans', { defaultValue: 'Recent Bans' })}
            </div>
            <Link to="/ip-reputation?tab=bans" className="text-[12px] font-mono text-accent transition-opacity hover:opacity-80">
              {t('dashboard.viewAll', { defaultValue: 'View all' })} →
            </Link>
          </div>
          <div className="overflow-x-auto">
            {bansLoading ? (
              <div className="space-y-2 px-5 pb-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : recentBans.length === 0 ? (
              <EmptyState compact title={t('dashboard.noBans', { defaultValue: 'No active bans' })} />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-border text-xs uppercase text-text-muted">
                    <th className="px-4 py-2 text-left font-medium">{t('dashboard.colIp', { defaultValue: 'IP' })}</th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('dashboard.colScope', { defaultValue: 'Scope' })}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('dashboard.colType', { defaultValue: 'Type' })}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('dashboard.colReason', { defaultValue: 'Reason' })}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('dashboard.colBannedAt', { defaultValue: 'Banned At' })}
                    </th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentBans.map(ban => (
                    <tr key={ban.id} className="transition-colors hover:bg-bg-hover">
                      <td className="px-4 py-2.5 font-mono text-xs text-text-primary">
                        <button type="button" onClick={() => openIp(ban.ip)} className="hover:underline">
                          {anonIp(ban.ip)}{ban.cidrPrefix != null ? `/${ban.cidrPrefix}` : ''}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-text-secondary">
                        {t(`status.scope.${ban.scope}`, { defaultValue: ban.scope })}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-text-secondary">
                        {t(`bans.type.${ban.banType}`, { defaultValue: ban.banType })}
                      </td>
                      <td className="max-w-[160px] truncate px-4 py-2.5 text-text-secondary" title={ban.reason ?? undefined}>
                        {ban.reason ?? <span className="text-text-muted">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-text-muted">
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
                        {canLiftBan(ban) && (
                          <button
                            onClick={() => { void handleLiftBan(ban); }}
                            disabled={liftingId === ban.id}
                            className="text-xs text-red-400 transition-colors hover:text-red-300 disabled:opacity-50"
                          >
                            {t('dashboard.lift', { defaultValue: 'Lift' })}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Top IPs by Failure Count */}
        <div className={PANEL}>
          <div className="flex items-center justify-between px-5 py-4">
            <div className="text-[15px] font-semibold text-text-primary">
              {t('dashboard.topIps', { defaultValue: 'Top IPs by Failure Count' })}
            </div>
            <Link to="/ip-reputation?tab=activity&sortBy=failures" className="text-[12px] font-mono text-accent transition-opacity hover:opacity-80">
              {t('dashboard.viewAll', { defaultValue: 'View all' })} →
            </Link>
          </div>
          <div className="overflow-x-auto">
            {summaryLoading ? (
              <div className="space-y-2 px-5 pb-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : !summary || summary.topIps.length === 0 ? (
              <EmptyState compact title={t('dashboard.noIpData', { defaultValue: 'No IP reputation data' })} />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-border text-xs uppercase text-text-muted">
                    <th className="px-4 py-2 text-left font-medium">{t('dashboard.colIp', { defaultValue: 'IP' })}</th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('dashboard.colCountry', { defaultValue: 'Country' })}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('dashboard.colFailures', { defaultValue: 'Failures' })}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('dashboard.colLastSeen', { defaultValue: 'Last Seen' })}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summary.topIps.map(rec => (
                    <tr key={rec.ip} className="transition-colors hover:bg-bg-hover">
                      <td className="px-4 py-2.5 font-mono text-xs text-text-primary">
                        <button type="button" onClick={() => openIp(rec.ip)} className="hover:underline">
                          {anonIp(rec.ip)}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary">
                        {rec.geoCountryCode ?? <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-semibold text-orange-400">{rec.totalFailures}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-text-muted">
                        {rec.lastSeen ? relativeTime(rec.lastSeen, t) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* By group: hierarchical, root → children indented by depth. */}
      <div className={`${PANEL} p-5 max-sm:p-4`}>
        <div className="mb-4 flex items-center gap-3 max-sm:flex-wrap max-sm:gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <FolderTree size={16} className="shrink-0 text-accent" aria-hidden="true" />
            <div>
              <div className="text-[15px] font-semibold text-text-primary">
                {t('dashboard.groupView', { defaultValue: 'By group' })}
              </div>
              <div className="text-[11px] font-mono tracking-wider text-text-muted">
                {t('dashboard.groupViewSub', { defaultValue: 'connected agents · attacks · bans (24h)' })}
              </div>
            </div>
          </div>
          {canManageGroups && (
            <Link to="/groups" className="ml-auto text-[12px] font-mono text-accent transition-opacity hover:opacity-80 coarse:py-2">
              {t('dashboard.manageGroups', { defaultValue: 'Manage groups' })} →
            </Link>
          )}
        </div>
        {groupsLoading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : groups.length === 0 ? (
          <EmptyState compact title={t('dashboard.noAgents', { defaultValue: 'No agents registered yet' })} />
        ) : (
          <GroupTree groups={groups} />
        )}
      </div>
    </PageContainer>
  );
}
