import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import apiClient from '@/api/client';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import { useIpDrawer } from '@/hooks/useIpDrawer';
import { useIpsPermissions } from '@/hooks/useIpsPermissions';
import { useIpActions } from '@/components/ip/IpDetailDrawer';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Pagination } from '@/components/common/Pagination';
import { TableScroll } from '@/components/common/TableScroll';
import { anonIp, anonUsername } from '@/utils/anonymize';
import {
  BUILTIN_SERVICES, EventTypeBadge, SectionTitle, formatTs, relativeTime, rowFromStream, useAgentIpEvents,
  useWindowEvent, type AgentTabProps, type IpEventRow,
} from './parts';

const PAGE_SIZE = 50;
const EVENT_TYPES = ['auth_failure', 'auth_success', 'port_scan'] as const;

/**
 * Connection events of the agent: server-side filters and pages, live rows
 * (ip:events, the page keeps an agent watch) prepended on the first page.
 * On another page the live rows are only counted, with a "show" shortcut.
 */
export function EventsTab({ device, refreshKey }: AgentTabProps) {
  const { t } = useTranslation();
  const { open: openIp } = useIpDrawer();
  const perms = useIpsPermissions();
  const ipActions = useIpActions();
  const devId = device.id;

  const [events,        setEvents]        = useState<IpEventRow[]>([]);
  const [total,         setTotal]         = useState(0);
  const [page,          setPage]          = useState(1);
  const [loading,       setLoading]       = useState(false);
  const [serviceFilter, setServiceFilter] = useState('');
  const [typeFilter,    setTypeFilter]    = useState('');
  const [missed,        setMissed]        = useState(0);
  const [busyIps,       setBusyIps]       = useState<ReadonlySet<string>>(new Set());

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { deviceId: devId, page, pageSize: PAGE_SIZE };
      if (serviceFilter) params.service = serviceFilter;
      if (typeFilter)    params.eventType = typeFilter;
      const res = await apiClient.get('/ip-events', { params });
      setEvents((res.data.data ?? []) as IpEventRow[]);
      setTotal(res.data.total ?? 0);
      setMissed(0);
    } catch {
      setEvents([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [devId, page, serviceFilter, typeFilter]);

  useEffect(() => { void loadEvents(); }, [loadEvents, refreshKey]);
  // A filter change goes back to page 1 in the same render (one fetch, not two).
  const changeService = (v: string) => { setServiceFilter(v); setPage(1); };
  const changeType    = (v: string) => { setTypeFilter(v); setPage(1); };
  useWindowEvent(SOCKET_RESYNC_EVENT, () => { void loadEvents(); });

  // ── Live rows ──────────────────────────────────────────────────────────────
  useAgentIpEvents(devId, (rows) => {
    const matching = rows.filter(r =>
      (!serviceFilter || r.service === serviceFilter) && (!typeFilter || r.eventType === typeFilter));
    if (matching.length === 0) return;
    if (page !== 1 || loading) { setMissed(n => n + matching.length); return; }
    const seen = new Set(events.map(e => e.id));
    const fresh = matching.filter(r => !seen.has(r.id)).map(rowFromStream);
    if (fresh.length === 0) return;
    const freshIds = new Set(fresh.map(e => e.id));
    setEvents(prev => [...fresh, ...prev.filter(e => !freshIds.has(e.id))].slice(0, PAGE_SIZE));
    setTotal(n => n + fresh.length);
  });

  const serviceOptions = useMemo(() => {
    const set = new Set<string>(BUILTIN_SERVICES);
    for (const ev of events) set.add(ev.service);
    if (serviceFilter) set.add(serviceFilter);
    return [...set].filter(Boolean).sort();
  }, [events, serviceFilter]);

  const typeLabel = (type: string) => ({
    auth_failure: t('agentDetail.eventType.authFailure', { defaultValue: 'Auth failure' }),
    auth_success: t('agentDetail.eventType.authSuccess', { defaultValue: 'Auth success' }),
    port_scan:    t('agentDetail.eventType.portScan', { defaultValue: 'Port scan' }),
  } as Record<string, string>)[type] ?? type;

  const quickBan = async (ip: string) => {
    setBusyIps(prev => new Set(prev).add(ip));
    try { await ipActions.ban({ ip }); } finally {
      setBusyIps(prev => { const next = new Set(prev); next.delete(ip); return next; });
    }
  };

  const filtered = !!serviceFilter || !!typeFilter;
  const selectCls = 'rounded border border-border bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent coarse:min-h-10';

  return (
    <div className="rounded-lg border border-border bg-bg-secondary flex flex-col">
      <SectionTitle
        extra={
          <>
            <span>{t('agentDetail.events.total', { defaultValue: '{{count}} total', count: total })}</span>
            <IconButton
              size="sm"
              label={t('common.refresh', { defaultValue: 'Refresh' })}
              icon={<RefreshCw size={12} className={loading ? 'animate-spin' : ''} />}
              onClick={() => void loadEvents()}
            />
          </>
        }
      >
        {t('agentDetail.events.title', { defaultValue: 'Connection events' })}
      </SectionTitle>

      <div className="px-4 py-2 border-b border-border flex items-center gap-2 flex-wrap">
        <select
          value={serviceFilter}
          onChange={e => changeService(e.target.value)}
          aria-label={t('agentDetail.events.serviceFilter', { defaultValue: 'Service' })}
          className={selectCls}
        >
          <option value="">{t('agentDetail.events.allServices', { defaultValue: 'All services' })}</option>
          {serviceOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={typeFilter}
          onChange={e => changeType(e.target.value)}
          aria-label={t('agentDetail.events.typeFilter', { defaultValue: 'Type' })}
          className={selectCls}
        >
          <option value="">{t('agentDetail.events.allTypes', { defaultValue: 'All types' })}</option>
          {EVENT_TYPES.map(type => <option key={type} value={type}>{typeLabel(type)}</option>)}
        </select>
        {missed > 0 && (
          <button
            type="button"
            onClick={() => { if (page === 1) void loadEvents(); else setPage(1); }}
            className="ml-auto rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/20 transition-colors coarse:min-h-8"
          >
            {t('agentDetail.events.newRows', { defaultValue: '{{count}} new events: show', count: missed })}
          </button>
        )}
      </div>

      <div className="flex-1 min-h-[200px]">
        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center py-16"><LoadingSpinner /></div>
        ) : events.length === 0 ? (
          <EmptyState
            variant={filtered ? 'filtered' : 'empty'}
            title={filtered ? undefined : t('agentDetail.events.empty', { defaultValue: 'No events found' })}
            onClearFilters={() => { setServiceFilter(''); setTypeFilter(''); setPage(1); }}
            compact
          />
        ) : (
          <TableScroll className="rounded-none">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase text-text-muted border-b border-border">
                  <th className="text-left px-4 py-2 font-medium whitespace-nowrap">{t('agentDetail.events.colTime', { defaultValue: 'Time' })}</th>
                  <th className="text-left px-4 py-2 font-medium">{t('agentDetail.events.colIp', { defaultValue: 'IP' })}</th>
                  <th className="text-left px-4 py-2 font-medium">{t('agentDetail.events.colService', { defaultValue: 'Service' })}</th>
                  <th className="text-left px-4 py-2 font-medium">{t('agentDetail.events.colType', { defaultValue: 'Type' })}</th>
                  <th className="text-left px-4 py-2 font-medium">{t('agentDetail.events.colUser', { defaultValue: 'User' })}</th>
                  <th className="text-left px-4 py-2 font-medium">{t('agentDetail.events.colRawLog', { defaultValue: 'Raw log' })}</th>
                  {perms.canBan && <th className="w-8 px-2 py-2"><span className="sr-only">{t('common.actions', { defaultValue: 'Actions' })}</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map(ev => (
                  <tr key={ev.id} className="hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-2.5 text-text-muted whitespace-nowrap" title={formatTs(ev.timestamp)}>{relativeTime(ev.timestamp, t)}</td>
                    <td className="px-4 py-2.5">
                      <button type="button" onClick={() => openIp(ev.ip)} className="font-mono text-accent hover:underline coarse:min-h-8">
                        {anonIp(ev.ip)}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary">{ev.service}</td>
                    <td className="px-4 py-2.5"><EventTypeBadge type={ev.event_type} /></td>
                    <td className="px-4 py-2.5 font-mono text-text-secondary">
                      {ev.username ? anonUsername(ev.username) : <span className="text-text-muted">—</span>}
                    </td>
                    <td className="px-4 py-2.5 max-w-[220px]">
                      {ev.raw_log ? (
                        <span title={ev.raw_log} className="truncate block text-text-muted">
                          {ev.raw_log.length > 64 ? `${ev.raw_log.slice(0, 64)}…` : ev.raw_log}
                        </span>
                      ) : <span className="text-text-muted">—</span>}
                    </td>
                    {perms.canBan && (
                      <td className="px-2 py-2.5">
                        <IconButton
                          size="sm"
                          variant="danger"
                          label={t('agentDetail.ip.quickBan', { defaultValue: 'Quick ban' })}
                          icon={<ShieldOff size={12} />}
                          disabled={busyIps.has(ev.ip)}
                          onClick={() => void quickBan(ev.ip)}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onChange={setPage}
        disabled={loading}
        className="px-4 py-2.5 border-t border-border"
      />
    </div>
  );
}
