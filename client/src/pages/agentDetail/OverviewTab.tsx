import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, Network, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import apiClient from '@/api/client';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import { useIpDrawer } from '@/hooks/useIpDrawer';
import { useIpsPermissions } from '@/hooks/useIpsPermissions';
import { useIpActions } from '@/components/ip/IpDetailDrawer';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { anonHostname, anonIp } from '@/utils/anonymize';
import { AgentMiniMap } from './AgentMiniMap';
import {
  LookupButtons, MiniStat, SectionTitle, relativeTime, rowFromStream, useAgentIpEvents, useWindowEvent,
  type AgentTabProps, type IpEventRow,
} from './parts';

interface IpSummaryItem {
  ip: string;
  totalEvents: number;
  failures: number;
  services: string[];
  firstSeen: string;
  lastSeen: string;
}

/** Rows of the 7-day window kept in memory (initial load + live rows). */
const SUMMARY_CAP = 500;
const SUMMARY_DAYS = 7;

/**
 * Overview: today's figures, the star map of the agent's IPs and the most
 * active IPs of the last 7 days. Live rows (ip:events) are folded in, so the
 * figures move while the page is open.
 */
export function OverviewTab({ device, refreshKey }: AgentTabProps) {
  const { t } = useTranslation();
  const { open: openIp } = useIpDrawer();
  const perms = useIpsPermissions();
  const ipActions = useIpActions();
  const devId = device.id;
  const displayName = device.name ?? device.hostname;

  const [summaryEvents,  setSummaryEvents]  = useState<IpEventRow[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [busyIps,        setBusyIps]        = useState<ReadonlySet<string>>(new Set());

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const from = new Date();
      from.setDate(from.getDate() - SUMMARY_DAYS);
      const res = await apiClient.get('/ip-events', {
        params: { deviceId: devId, from: from.toISOString(), pageSize: SUMMARY_CAP },
      });
      setSummaryEvents((res.data.data ?? []) as IpEventRow[]);
    } catch {
      setSummaryEvents([]);
    } finally {
      setSummaryLoading(false);
    }
  }, [devId]);

  useEffect(() => { void loadSummary(); }, [loadSummary, refreshKey]);
  // After a socket reconnect, rows may have been missed.
  useWindowEvent(SOCKET_RESYNC_EVENT, () => { void loadSummary(); });

  // Live rows on top (newest first), without duplicates, capped.
  useAgentIpEvents(devId, (rows) => {
    setSummaryEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      const fresh = rows.filter((r) => !seen.has(r.id)).map(rowFromStream);
      if (fresh.length === 0) return prev;
      return [...fresh, ...prev].slice(0, SUMMARY_CAP);
    });
  });

  // ── Derived figures ──────────────────────────────────────────────────────
  const ipSummary = useMemo<IpSummaryItem[]>(() => {
    const map = new Map<string, IpSummaryItem>();
    for (const ev of summaryEvents) {
      const item = map.get(ev.ip);
      if (item) {
        item.totalEvents++;
        if (ev.event_type === 'auth_failure') item.failures++;
        if (!item.services.includes(ev.service)) item.services.push(ev.service);
        if (ev.timestamp > item.lastSeen)  item.lastSeen  = ev.timestamp;
        if (ev.timestamp < item.firstSeen) item.firstSeen = ev.timestamp;
      } else {
        map.set(ev.ip, {
          ip: ev.ip, totalEvents: 1,
          failures:  ev.event_type === 'auth_failure' ? 1 : 0,
          services:  [ev.service],
          firstSeen: ev.timestamp, lastSeen: ev.timestamp,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.totalEvents - a.totalEvents);
  }, [summaryEvents]);

  const todayStart = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  }, []);
  const todayEvents   = useMemo(() => summaryEvents.filter(e => new Date(e.timestamp).getTime() >= todayStart), [summaryEvents, todayStart]);
  const todayFailures = useMemo(() => todayEvents.filter(e => e.event_type === 'auth_failure').length, [todayEvents]);
  const uniqueIpCount = ipSummary.length;
  const topService    = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of summaryEvents) counts.set(ev.service, (counts.get(ev.service) ?? 0) + 1);
    let top = '—'; let max = 0;
    for (const [svc, cnt] of counts) { if (cnt > max) { max = cnt; top = svc; } }
    return top;
  }, [summaryEvents]);

  // ── Quick IP actions (confirmation, toast and refresh live in useIpActions) ──
  const withBusy = useCallback(async (ip: string, fn: () => Promise<unknown>) => {
    setBusyIps((prev) => new Set(prev).add(ip));
    try { await fn(); } finally {
      setBusyIps((prev) => { const next = new Set(prev); next.delete(ip); return next; });
    }
  }, []);

  const loadingValue = '…';

  return (
    <div className="space-y-6">
      {/* ── Stats strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniStat
          label={t('agentDetail.stats.eventsToday', { defaultValue: 'Events today' })}
          value={summaryLoading ? loadingValue : todayEvents.length}
          colorClass="text-accent"
        />
        <MiniStat
          label={t('agentDetail.stats.failuresToday', { defaultValue: 'Failures today' })}
          value={summaryLoading ? loadingValue : todayFailures}
          colorClass={todayFailures > 0 ? 'text-status-down' : 'text-status-up'}
        />
        <MiniStat
          label={t('agentDetail.stats.uniqueIps', { defaultValue: 'Unique IPs (7d)' })}
          value={summaryLoading ? loadingValue : uniqueIpCount}
          colorClass="text-orange-400"
        />
        <MiniStat
          label={t('agentDetail.stats.topService', { defaultValue: 'Top service' })}
          value={summaryLoading ? loadingValue : topService}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* ── Star map (2 cols) ──────────────────────────────────────────── */}
        <div className="xl:col-span-2 rounded-lg border border-border bg-bg-secondary overflow-hidden flex flex-col">
          <SectionTitle
            extra={summaryLoading ? loadingValue : t('agentDetail.starMap.ipCount', { defaultValue: '{{count}} IPs (7d)', count: uniqueIpCount })}
          >
            <span className="inline-flex items-center gap-2">
              <Network size={14} className="text-accent" />
              {t('agentDetail.starMap.title', { defaultValue: 'Star map — {{name}}', name: anonHostname(displayName) })}
            </span>
          </SectionTitle>
          <div className="h-[360px] sm:h-[460px]">
            <AgentMiniMap deviceId={devId} summaryEvents={summaryEvents} onSelectIp={openIp} />
          </div>
        </div>

        {/* ── Top IPs (1 col) ────────────────────────────────────────────── */}
        <div className="rounded-lg border border-border bg-bg-secondary flex flex-col min-h-0 xl:max-h-[513px]">
          <SectionTitle
            extra={!summaryLoading && t('agentDetail.topIps.unique', { defaultValue: '{{count}} unique', count: ipSummary.length })}
          >
            {t('agentDetail.topIps.title', { defaultValue: 'Top IPs (7 days)' })}
          </SectionTitle>
          <div className="flex-1 overflow-y-auto">
            {summaryLoading ? (
              <div className="flex items-center justify-center py-12"><LoadingSpinner size="sm" /></div>
            ) : ipSummary.length === 0 ? (
              <div className="py-10 text-center text-sm text-text-muted">
                {t('agentDetail.topIps.empty', { defaultValue: 'No activity in the last 7 days' })}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {ipSummary.slice(0, 25).map(item => (
                  <div key={item.ip} className="px-4 py-3 hover:bg-bg-hover transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => openIp(item.ip)}
                        className="font-mono text-sm text-accent hover:underline text-left min-w-0 truncate coarse:min-h-8"
                      >
                        {anonIp(item.ip)}
                      </button>
                      <div className="flex gap-0.5 flex-shrink-0">
                        {perms.canBan && (
                          <IconButton
                            size="sm"
                            label={t('agentDetail.ip.quickBan', { defaultValue: 'Quick ban' })}
                            icon={<ShieldOff size={12} />}
                            disabled={busyIps.has(item.ip)}
                            onClick={() => void withBusy(item.ip, () => ipActions.ban({ ip: item.ip }))}
                            variant="danger"
                          />
                        )}
                        {perms.canWhitelist && (
                          <IconButton
                            size="sm"
                            label={t('agentDetail.ip.whitelist', { defaultValue: 'Whitelist' })}
                            icon={<ShieldCheck size={12} />}
                            disabled={busyIps.has(item.ip)}
                            onClick={() => void withBusy(item.ip, () => ipActions.whitelist({ ip: item.ip }))}
                            className="hover:text-green-400 hover:bg-green-500/10"
                          />
                        )}
                        <IconButton
                          size="sm"
                          label={t('agentDetail.ip.viewDetails', { defaultValue: 'View IP details' })}
                          icon={<Eye size={12} />}
                          onClick={() => openIp(item.ip)}
                          variant="accent"
                        />
                      </div>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                      <span>
                        <span className={item.failures > 0 ? 'text-red-400 font-semibold' : 'text-text-secondary'}>
                          {item.failures}
                        </span>
                        {' '}{t('agentDetail.topIps.failOf', { defaultValue: 'fail / {{count}} events', count: item.totalEvents })}
                      </span>
                      {item.services.length > 0 && (
                        <span className="truncate max-w-[100px]">{item.services.join(', ')}</span>
                      )}
                      <span>{relativeTime(item.lastSeen, t)}</span>
                    </div>
                    <div className="mt-1.5">
                      <LookupButtons ip={item.ip} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
