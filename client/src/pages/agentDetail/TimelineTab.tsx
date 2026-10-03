import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  BadgeCheck, BrickWall, ChevronDown, ChevronRight, Download, RefreshCw, Settings2, ShieldBan, ShieldCheck,
  Swords, Wifi, WifiOff, type LucideIcon,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { ApiResponse } from '@obliview/shared';
import apiClient from '@/api/client';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import { useIpDrawer } from '@/hooks/useIpDrawer';
import { useCan } from '@/hooks/usePermission';
import { AuditActionPill } from '@/pages/AuditLogPage';
import { anonIp, anonUsername } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { SectionTitle, useWindowEvent, type AgentTabProps } from './parts';

/** Tab id of the Timeline tab (registered by AgentDetailPage; it absorbed the W11-1 Activity tab). */
export const TIMELINE_TAB_ID = 'timeline';

// ── API (server/src/services/agentTimeline.service.ts) ───────────────────────

export type TimelineKind =
  | 'ban_applied' | 'ban_lifted' | 'attack_burst' | 'agent_update'
  | 'offline' | 'online' | 'approval' | 'firewall_change' | 'config_change';

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  at: string;
  /** English fallback; the tab renders from kind + payload. */
  title: string;
  detail: string | null;
  actor: string | null;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  payload: Record<string, any>;
}

export interface AgentTimeline {
  formatVersion: number;
  deviceId: number;
  from: string;
  to: string;
  kinds: TimelineKind[];
  limit: number;
  truncated: boolean;
  count: number;
  events: TimelineEvent[];
}

async function fetchTimeline(deviceId: number, params: { from: string; to: string; kinds?: string; limit: number }): Promise<AgentTimeline> {
  const res = await apiClient.get<ApiResponse<AgentTimeline>>(`/agent/devices/${deviceId}/timeline`, { params });
  return res.data.data!;
}

// ── Filters ──────────────────────────────────────────────────────────────────

/** Rows asked per load (server cap: 500). */
const LIMIT = 300;

type Period = '24h' | '7d' | '30d';
const PERIOD_MS: Record<Period, number> = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };

type Category = 'bans' | 'attacks' | 'updates' | 'presence' | 'approval' | 'firewall' | 'config';

const CATEGORY_KINDS: Record<Category, TimelineKind[]> = {
  bans: ['ban_applied', 'ban_lifted'],
  attacks: ['attack_burst'],
  updates: ['agent_update'],
  presence: ['offline', 'online'],
  approval: ['approval'],
  firewall: ['firewall_change'],
  config: ['config_change'],
};

/** Categories backed by the audit log only (audit.read). */
const AUDIT_ONLY: ReadonlySet<Category> = new Set<Category>(['firewall', 'config']);

function categoryLabel(c: Category, t: TFunction): string {
  switch (c) {
    case 'bans': return t('agentDetail.timeline.filter.bans', { defaultValue: 'Bans' });
    case 'attacks': return t('agentDetail.timeline.filter.attacks', { defaultValue: 'Attacks' });
    case 'updates': return t('agentDetail.timeline.filter.updates', { defaultValue: 'Updates' });
    case 'presence': return t('agentDetail.timeline.filter.presence', { defaultValue: 'Connectivity' });
    case 'approval': return t('agentDetail.timeline.filter.approval', { defaultValue: 'Approval' });
    case 'firewall': return t('agentDetail.timeline.filter.firewall', { defaultValue: 'Firewall' });
    case 'config': return t('agentDetail.timeline.filter.config', { defaultValue: 'Configuration' });
  }
}

// ── Rendering helpers ────────────────────────────────────────────────────────

const KIND_ICONS: Record<TimelineKind, LucideIcon> = {
  ban_applied: ShieldBan,
  ban_lifted: ShieldCheck,
  attack_burst: Swords,
  agent_update: Download,
  offline: WifiOff,
  online: Wifi,
  approval: BadgeCheck,
  firewall_change: BrickWall,
  config_change: Settings2,
};

const SEVERITY_STYLES: Record<TimelineEvent['severity'], string> = {
  info: 'bg-bg-tertiary text-text-secondary border-border',
  low: 'bg-accent/10 text-accent border-accent/30',
  medium: 'bg-orange-400/10 text-orange-400 border-orange-400/30',
  high: 'bg-status-down/10 text-status-down border-status-down/40',
  critical: 'bg-status-down/20 text-status-down border-status-down/60',
};

function isAuditEvent(ev: TimelineEvent): boolean {
  return ev.id.startsWith('audit_logs:');
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function updatePhaseLabel(phase: string, t: TFunction): string {
  switch (phase) {
    case 'offered': return t('agentDetail.timeline.phase.offered', { defaultValue: 'offered' });
    case 'downloading': return t('agentDetail.timeline.phase.downloading', { defaultValue: 'downloading' });
    case 'verifying': return t('agentDetail.timeline.phase.verifying', { defaultValue: 'verifying' });
    case 'installing': return t('agentDetail.timeline.phase.installing', { defaultValue: 'installing' });
    case 'restarting': return t('agentDetail.timeline.phase.restarting', { defaultValue: 'restarting' });
    case 'succeeded': return t('agentDetail.timeline.phase.succeeded', { defaultValue: 'succeeded' });
    case 'failed': return t('agentDetail.timeline.phase.failed', { defaultValue: 'failed' });
    case 'cancelled': return t('agentDetail.timeline.phase.cancelled', { defaultValue: 'cancelled' });
    default: return phase;
  }
}

function liftReasonLabel(reason: string | null | undefined, t: TFunction): string | null {
  switch (reason) {
    case 'lift': return t('agentDetail.timeline.liftReason.lift', { defaultValue: 'lifted by an operator' });
    case 'expiry': return t('agentDetail.timeline.liftReason.expiry', { defaultValue: 'expired' });
    case 'wipe': return t('agentDetail.timeline.liftReason.wipe', { defaultValue: 'all bans wiped' });
    case 'external_withdraw': return t('agentDetail.timeline.liftReason.externalWithdraw', { defaultValue: 'withdrawn by the source app' });
    case 'remote_sync': return t('agentDetail.timeline.liftReason.remoteSync', { defaultValue: 'removed from its blocklist' });
    default: return reason ?? null;
  }
}

/** Main line of an event, localised from kind + payload (the server title is the fallback). */
function eventTitle(ev: TimelineEvent, t: TFunction, ipLink: (ip: string) => ReactNode): ReactNode {
  const p = ev.payload ?? {};
  if (isAuditEvent(ev)) return <AuditActionPill action={String(p.action ?? ev.title)} success={p.success !== false} />;
  switch (ev.kind) {
    case 'ban_applied':
      return <>{t('agentDetail.timeline.event.banApplied', { defaultValue: 'Ban applied' })} {ipLink(String(p.target ?? ''))}</>;
    case 'ban_lifted':
      return <>{t('agentDetail.timeline.event.banLifted', { defaultValue: 'Ban lifted' })} {ipLink(String(p.target ?? ''))}</>;
    case 'attack_burst':
      return t('agentDetail.timeline.event.attackBurst', {
        defaultValue: '{{failures}} failed logins from {{ips}} address(es) in 5 min',
        failures: p.failures ?? 0, ips: p.uniqueIps ?? 0,
      });
    case 'agent_update':
      return t('agentDetail.timeline.event.update', {
        defaultValue: 'Update to {{version}}: {{phase}}',
        version: p.targetVersion ?? '?', phase: updatePhaseLabel(String(p.phase ?? ''), t),
      });
    case 'offline':
      return p.source === 'incident'
        ? t('agentDetail.timeline.event.offlineIncident', { defaultValue: 'Agent declared offline' })
        : t('agentDetail.timeline.event.offline', { defaultValue: 'Agent went offline' });
    case 'online':
      return p.source === 'incident'
        ? t('agentDetail.timeline.event.onlineIncident', {
          defaultValue: 'Agent back online after {{duration}}', duration: formatDuration(Number(p.downSeconds ?? 0)),
        })
        : t('agentDetail.timeline.event.online', { defaultValue: 'Agent connected' });
    case 'approval':
      return p.step === 'enrolled'
        ? t('agentDetail.timeline.event.enrolled', { defaultValue: 'Agent enrolled' })
        : t('agentDetail.timeline.event.approved', { defaultValue: 'Agent approved' });
    default:
      return ev.title;
  }
}

/** Secondary line: reason, services, error, scope. */
function eventDetail(ev: TimelineEvent, t: TFunction, ipLink: (ip: string) => ReactNode): ReactNode {
  const p = ev.payload ?? {};
  if (isAuditEvent(ev)) return p.targetType ? `${p.targetType}${p.targetId ? ` #${p.targetId}` : ''}` : null;
  switch (ev.kind) {
    case 'ban_applied': {
      const scope = t('agentDetail.timeline.banScope', { defaultValue: '{{scope}} ban ({{type}})', scope: p.scope, type: p.banType });
      return p.reason ? `${scope} · ${p.reason}` : scope;
    }
    case 'ban_lifted':
      return liftReasonLabel(p.liftReason, t);
    case 'attack_burst': {
      const services = Array.isArray(p.services) ? p.services.join(', ') : '';
      return (
        <>
          {p.topIp && <>{t('agentDetail.timeline.topIp', { defaultValue: 'Top address:' })} {ipLink(String(p.topIp))}</>}
          {services && <span className="ml-2">{services}</span>}
        </>
      );
    }
    case 'agent_update':
      return p.lastError ? String(p.lastError) : null;
    default:
      return ev.detail;
  }
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Tab ──────────────────────────────────────────────────────────────────────

/**
 * Timeline of one agent (W13-2, DATA-REALTIME-20): "what happened to this
 * machine". Bans that reach it, attack bursts, update attempts, outages,
 * enrolment / approval and, for audit.read holders, its audit rows (firewall
 * rule writes, configuration changes; the former Activity tab). Grouped by
 * day, newest first, filtered by category and period server-side.
 */
export function TimelineTab({ device, refreshKey }: AgentTabProps) {
  const { t } = useTranslation();
  const devId = device.id;
  const canReadAudit = useCan('audit.read');
  const { open: openIp } = useIpDrawer();

  const [period, setPeriod] = useState<Period>('7d');
  const [selected, setSelected] = useState<ReadonlySet<Category>>(new Set());
  const [data, setData] = useState<AgentTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const categories = useMemo(
    () => (Object.keys(CATEGORY_KINDS) as Category[]).filter((c) => canReadAudit || !AUDIT_ONLY.has(c)),
    [canReadAudit],
  );
  const kindsParam = useMemo(
    () => (selected.size === 0 ? undefined : [...selected].flatMap((c) => CATEGORY_KINDS[c]).join(',')),
    [selected],
  );

  // Only the latest request lands: a slow answer for a previous period or
  // filter must not overwrite the current one.
  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const to = new Date();
    const from = new Date(to.getTime() - PERIOD_MS[period]);
    try {
      const next = await fetchTimeline(devId, { from: from.toISOString(), to: to.toISOString(), kinds: kindsParam, limit: LIMIT });
      if (seq !== requestSeq.current) return;
      setData(next);
      setFailed(false);
    } catch {
      if (seq !== requestSeq.current) return;
      setData(null);
      setFailed(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [devId, period, kindsParam]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useWindowEvent(SOCKET_RESYNC_EVENT, () => { void load(); });

  const toggleCategory = (c: Category) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    return next;
  });
  const toggleRow = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const ipLink = useCallback((ip: string): ReactNode => (ip
    ? (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); openIp(ip); }}
        className="font-mono text-accent hover:underline coarse:min-h-8"
      >
        {anonIp(ip)}
      </button>
    )
    : null), [openIp]);

  // Day groups (events arrive newest first).
  const days = useMemo(() => {
    const out: Array<{ key: string; label: string; events: TimelineEvent[] }> = [];
    for (const ev of data?.events ?? []) {
      const key = dayKey(ev.at);
      const last = out[out.length - 1];
      if (last && last.key === key) last.events.push(ev);
      else out.push({ key, label: dayLabel(ev.at), events: [ev] });
    }
    return out;
  }, [data]);

  const events = data?.events ?? [];

  return (
    <div className="rounded-lg border border-border bg-bg-secondary flex flex-col">
      <SectionTitle
        extra={(
          <>
            {canReadAudit && (
              <Link to={`/audit-log?device=${devId}`} className="text-accent hover:underline">
                {t('agentDetail.timeline.fullLog', { defaultValue: 'Full audit log' })}
              </Link>
            )}
            <IconButton
              size="sm"
              label={t('common.refresh', { defaultValue: 'Refresh' })}
              icon={<RefreshCw size={12} className={loading ? 'animate-spin' : ''} />}
              onClick={() => void load()}
            />
          </>
        )}
      >
        {t('agentDetail.timeline.title', { defaultValue: 'Timeline' })}
      </SectionTitle>

      {/* ── Filters: period + categories ─────────────────────────────────── */}
      <div className="px-4 py-2.5 border-b border-border flex flex-wrap items-center gap-2">
        <SegmentedTabs<Period>
          tabs={[
            { id: '24h', label: t('agentDetail.timeline.period.day', { defaultValue: '24 h' }) },
            { id: '7d', label: t('agentDetail.timeline.period.week', { defaultValue: '7 days' }) },
            { id: '30d', label: t('agentDetail.timeline.period.month', { defaultValue: '30 days' }) },
          ]}
          value={period}
          onChange={setPeriod}
          fill={false}
          size="sm"
          ariaLabel={t('agentDetail.timeline.period.label', { defaultValue: 'Period' })}
        />
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('agentDetail.timeline.filter.label', { defaultValue: 'Event types' })}>
          {categories.map((c) => {
            const on = selected.has(c);
            const Icon = KIND_ICONS[CATEGORY_KINDS[c][0]];
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => toggleCategory(c)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors coarse:min-h-8',
                  on
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-border bg-bg-tertiary text-text-secondary hover:text-text-primary hover:border-accent/40',
                )}
              >
                <Icon size={12} />
                {categoryLabel(c, t)}
              </button>
            );
          })}
          {selected.size > 0 && (
            <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-text-muted hover:text-text-primary hover:underline px-1">
              {t('agentDetail.timeline.filter.clear', { defaultValue: 'All types' })}
            </button>
          )}
        </div>
      </div>

      {data?.truncated && (
        <div className="px-4 py-2 border-b border-border text-xs text-text-muted bg-bg-primary/40">
          {t('agentDetail.timeline.truncated', {
            defaultValue: 'Showing the {{count}} most recent events. Narrow the period or the event types to see older ones.',
            count: data.count,
          })}
        </div>
      )}

      {/* ── Day-grouped events ───────────────────────────────────────────── */}
      <div className={cn('flex-1 min-h-[200px] transition-opacity', loading && events.length > 0 && 'opacity-60')}>
        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center py-16"><LoadingSpinner /></div>
        ) : events.length === 0 ? (
          <EmptyState
            title={failed
              ? t('agentDetail.timeline.loadFailed', { defaultValue: 'Failed to load the timeline' })
              : t('agentDetail.timeline.empty', { defaultValue: 'Nothing happened to this agent in this period' })}
            compact
          />
        ) : (
          <div className="divide-y divide-border">
            {days.map((day) => (
              <section key={day.key} aria-label={day.label}>
                <h3 className="sticky top-0 z-[1] bg-bg-secondary/95 backdrop-blur px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted border-b border-border">
                  {day.label}
                </h3>
                <ol className="relative px-4 py-2">
                  {day.events.map((ev) => {
                    const Icon = KIND_ICONS[ev.kind] ?? Settings2;
                    const audit = isAuditEvent(ev);
                    const details = audit ? ev.payload?.details : null;
                    const hasDetails = !!details && typeof details === 'object' && Object.keys(details).length > 0;
                    const ipAddress = audit && typeof ev.payload?.ipAddress === 'string' ? ev.payload.ipAddress : null;
                    const userAgent = audit && typeof ev.payload?.userAgent === 'string' ? ev.payload.userAgent : null;
                    const expandable = hasDetails || !!ipAddress || !!userAgent;
                    const open = expanded.has(ev.id);
                    const detail = eventDetail(ev, t, ipLink);
                    return (
                      <li key={ev.id} className="relative flex gap-3 py-2">
                        <span className={cn('mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border', SEVERITY_STYLES[ev.severity] ?? SEVERITY_STYLES.info)}>
                          <Icon size={14} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-primary">
                            <span className="font-mono text-xs text-text-muted whitespace-nowrap" title={ev.at}>{timeLabel(ev.at)}</span>
                            <span className="min-w-0 break-words">{eventTitle(ev, t, ipLink)}</span>
                            {ev.actor && (
                              <span className="text-xs text-text-muted">
                                {t('agentDetail.timeline.by', { defaultValue: 'by {{actor}}', actor: anonUsername(ev.actor) })}
                              </span>
                            )}
                            {expandable && (
                              <button
                                type="button"
                                onClick={() => toggleRow(ev.id)}
                                aria-expanded={open}
                                className="inline-flex items-center gap-0.5 text-xs text-text-muted hover:text-text-primary coarse:min-h-8"
                              >
                                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                {t('agentDetail.timeline.details', { defaultValue: 'Details' })}
                              </button>
                            )}
                          </div>
                          {detail && <div className="mt-0.5 text-xs text-text-secondary break-words">{detail}</div>}
                          {open && expandable && (
                            <div className="mt-1.5 space-y-1.5 rounded border border-border bg-bg-primary/40 p-2">
                              {hasDetails && (
                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-text-secondary">
                                  {JSON.stringify(details, null, 2)}
                                </pre>
                              )}
                              {ipAddress && (
                                <div className="text-[11px] text-text-muted">
                                  {t('audit.colIp', { defaultValue: 'IP' })}: <span className="font-mono">{anonIp(ipAddress)}</span>
                                </div>
                              )}
                              {userAgent && (
                                <div className="text-[11px] text-text-muted break-all">
                                  {t('audit.userAgent', { defaultValue: 'User agent' })}: <span className="font-mono">{userAgent}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
