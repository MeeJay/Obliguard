import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Activity, Download, Pause, Play, RefreshCw, ShieldCheck, ShieldOff, ArrowUp, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { IpEventsFrame, IpEventStreamRow } from '@obliview/shared';
import apiClient from '@/api/client';
import { bansApi } from '@/api/bans.api';
import { whitelistApi } from '@/api/whitelist.api';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { useAgentDevices, useAgentStore } from '@/store/agentStore';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import { useIpsPermissions } from '@/hooks/useIpsPermissions';
import { useIpDrawer, notifyIpChanged } from '@/hooks/useIpDrawer';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { PeriodSelector } from '@/components/common/PeriodSelector';
import { TableScroll } from '@/components/common/TableScroll';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EventTypeBadge } from '@/components/status/EventTypeBadge';
import { anonHostname, anonIp, anonLog, anonUsername } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { CSV_EXPORT_MAX, csvExportError, downloadCsvExport } from '@/utils/download';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A row of the list: GET /ip-events (snake_case) and ip:events rows normalised. */
interface EventRow {
  id: number;
  deviceId: number | null;
  hostname: string | null;
  tenantId: number | null;
  ip: string;
  username: string | null;
  service: string;
  eventType: string;
  timestamp: string;
  rawLog: string | null;
}

interface ApiEventRow {
  id: number | string;
  device_id: number | null;
  hostname?: string | null;
  tenant_id: number | null;
  ip: string;
  username: string | null;
  service: string;
  event_type: string;
  timestamp: string;
  raw_log: string | null;
}

interface KeysetResponse {
  data: ApiEventRow[];
  hasMore: boolean;
  nextBefore: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Rows per request (first page and each "Load older"). */
const PAGE_SIZE = 50;
/** Most rows kept while live rows are prepended (the oldest fall off). */
const LIVE_CAP = 500;
/** IP search → URL debounce. */
const SEARCH_DEBOUNCE_MS = 300;
/** How long a streamed row stays highlighted. */
const FRESH_MS = 2500;

const EVENT_TYPES = ['auth_failure', 'auth_success', 'port_scan'] as const;
const BUILTIN_SERVICES = ['ssh', 'rdp', 'nginx', 'apache', 'iis', 'ftp', 'mail', 'mysql'] as const;
const PERIOD_MS: Record<string, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '365d': 365 * 86_400_000,
};

/** URL parameters of the page (all filters live in the URL). */
const P = { search: 'q', service: 'service', type: 'type', agent: 'agent', period: 'period' } as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function hostPart(ip: string): string {
  return ip.split('/')[0];
}

function fromApi(r: ApiEventRow): EventRow {
  return {
    id: Number(r.id),
    deviceId: r.device_id == null ? null : Number(r.device_id),
    hostname: r.hostname ?? null,
    tenantId: r.tenant_id == null ? null : Number(r.tenant_id),
    ip: hostPart(r.ip),
    username: r.username,
    service: r.service,
    eventType: r.event_type,
    timestamp: r.timestamp,
    rawLog: r.raw_log,
  };
}

function fromStream(r: IpEventStreamRow, hostname: string | null): EventRow {
  return {
    id: r.id,
    deviceId: r.deviceId,
    hostname,
    tenantId: r.tenantId,
    ip: hostPart(r.ip),
    username: r.username,
    service: r.service,
    eventType: r.eventType,
    timestamp: r.timestamp,
    // Raw lines are not streamed (size); the drawer and a reload show them.
    rawLog: null,
  };
}

/** Newest first, one row per id, at most `cap`. */
function mergeRows(a: EventRow[], b: EventRow[], cap: number): EventRow[] {
  const byId = new Map<number, EventRow>();
  for (const r of a) byId.set(r.id, r);
  for (const r of b) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()].sort((x, y) => y.id - x.id).slice(0, cap);
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(ip: string): number | null {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * Client-side mirror of the server's ?ip= search (utils/pagination
 * parseIpSearch) for streamed rows: exact address, IPv4 CIDR, or a "contains"
 * text match. null = cannot tell here (IPv6 forms): the row is counted in the
 * "new events" pill instead of being shown.
 */
function ipMatcher(raw: string): (ip: string) => boolean | null {
  const q = raw.trim().toLowerCase();
  if (!q) return () => true;
  if (q.includes('/')) {
    const [addr, bitsRaw] = q.split('/');
    const base = ipv4ToInt(addr);
    const bits = Number(bitsRaw);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return () => null;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ip) => {
      const n = ipv4ToInt(ip);
      return n === null ? false : ((n & mask) >>> 0) === ((base & mask) >>> 0);
    };
  }
  if (ipv4ToInt(q) !== null) return (ip) => ip.toLowerCase() === q;
  if (q.includes(':')) return (ip) => (ip.toLowerCase() === q ? true : null);
  return (ip) => ip.toLowerCase().includes(q);
}

function relativeTime(ts: string, now: number, t: TFunction): string {
  const diff = Math.max(0, Math.floor((now - new Date(ts).getTime()) / 1000));
  if (diff < 60) return t('liveEvents.secondsAgo', { count: diff, defaultValue: '{{count}}s ago' });
  if (diff < 3600) return t('liveEvents.minutesAgo', { count: Math.floor(diff / 60), defaultValue: '{{count}}m ago' });
  if (diff < 86400) return t('liveEvents.hoursAgo', { count: Math.floor(diff / 3600), defaultValue: '{{count}}h ago' });
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function absoluteTime(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Server error message of an axios failure, else the fallback. */
function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

const selectClass = 'rounded-md border border-border bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent';

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * Live Events: the newest agent events, streamed. The list is newest-first by
 * id (keyset: GET /ip-events?keyset=1, then ?before=<id> for "Load older").
 * While the head is shown and the stream is not paused, ip:events rows that
 * match the filters are prepended (merged by id, LIVE_CAP rows kept);
 * otherwise they are counted in a "N new events" pill that reloads the head.
 */
export function LiveEventsPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { open: openIp } = useIpDrawer();
  const perms = useIpsPermissions();
  const socketStatus = useSocketStore((s) => s.status);
  const generation = useSocketStore((s) => s.generation);

  // ── Filters (URL) ──────────────────────────────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get(P.search) ?? '';
  const service = searchParams.get(P.service) ?? '';
  const eventType = searchParams.get(P.type) ?? '';
  const agentRaw = searchParams.get(P.agent) ?? '';
  const agentId = /^[1-9]\d{0,9}$/.test(agentRaw) ? Number(agentRaw) : null;
  const periodRaw = searchParams.get(P.period) ?? '';
  const period = PERIOD_MS[periodRaw] ? periodRaw : '';
  const hasFilters = !!(search || service || eventType || agentId || period);

  const setParam = useCallback((key: string, value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const clearFilters = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const key of Object.values(P)) next.delete(key);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Debounced IP search: the input is local, the URL follows after a pause.
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => { setSearchDraft(search); }, [search]);
  useEffect(() => {
    if (searchDraft.trim() === search) return;
    const timer = setTimeout(() => setParam(P.search, searchDraft.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, search, setParam]);

  // ── Agents (filter + hostnames of streamed rows) ───────────────────────────
  const devices = useAgentDevices();
  useEffect(() => { void useAgentStore.getState().fetchDevices(); }, []);
  const hostnames = useMemo(() => {
    const m = new Map<number, string>();
    for (const d of devices) m.set(d.id, d.name || d.hostname);
    return m;
  }, [devices]);
  const hostnamesRef = useRef(hostnames);
  hostnamesRef.current = hostnames;

  // ── Rows ───────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  /** Older pages were loaded: live rows go to the pill (the user is reading back). */
  const [olderLoaded, setOlderLoaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(0);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());

  const filterParams = useCallback((): Record<string, string | number> => {
    const params: Record<string, string | number> = { limit: PAGE_SIZE };
    if (search) params.ip = search;
    if (service) params.service = service;
    if (eventType) params.eventType = eventType;
    if (agentId) params.deviceId = agentId;
    if (period) params.from = new Date(Date.now() - PERIOD_MS[period]).toISOString();
    return params;
  }, [search, service, eventType, agentId, period]);

  // ── CSV export (current filters, server-side, capped) ──
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      // The list filters without the page size (the export has its own cap).
      const params = filterParams();
      delete params.limit;
      const r = await downloadCsvExport('/ip-events/export', params, 'events.csv');
      if (!r.ok) toast.error(t('csvExport.failed', { defaultValue: 'Export failed' }));
      else if (r.truncated) {
        toast(t('csvExport.truncated', {
          max: CSV_EXPORT_MAX.toLocaleString(),
          defaultValue: 'Only the first {{max}} rows were exported: narrow the filters to get the rest',
        }));
      }
    } catch (err) {
      toast.error(await csvExportError(err, t('csvExport.failed', { defaultValue: 'Export failed' })));
    } finally {
      setExporting(false);
    }
  };

  // Only the latest head request may write the list (filters change fast).
  const requestSeq = useRef(0);
  /**
   * Rows streamed while a head request is in flight: the response may predate
   * them (its query ran before their insert), so they are merged into it
   * instead of being overwritten. null when no head request runs.
   */
  const inflightRows = useRef<EventRow[] | null>(null);
  /** The socket resynced while the stream was paused / browsing: Resume re-reads the head. */
  const staleRef = useRef(false);
  const rowsRef = useRef<EventRow[]>([]);
  rowsRef.current = rows;

  const loadHead = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    inflightRows.current = [];
    try {
      const res = await apiClient.get<KeysetResponse>('/ip-events', { params: { ...filterParams(), keyset: 1 } });
      if (seq !== requestSeq.current) return;
      const streamed = inflightRows.current ?? [];
      inflightRows.current = null;
      staleRef.current = false;
      setRows(mergeRows(streamed, (res.data.data ?? []).map(fromApi), LIVE_CAP));
      setHasMore(!!res.data.hasMore);
      setNextBefore(res.data.nextBefore ?? null);
      setOlderLoaded(false);
      setPending(0);
      setLoadError(false);
    } catch {
      if (seq === requestSeq.current) {
        inflightRows.current = null;
        setLoadError(true);
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [filterParams]);

  useEffect(() => { void loadHead(); }, [loadHead]);

  const loadOlder = useCallback(async () => {
    // Continue below the oldest row shown: live rows may have pushed older
    // ones off the list (LIVE_CAP), and those come back here.
    const tail = rowsRef.current[rowsRef.current.length - 1];
    const cursor = tail && tail.id > 0 ? String(tail.id) : nextBefore;
    if (!cursor || loadingOlder) return;
    const seq = requestSeq.current;
    setLoadingOlder(true);
    try {
      const res = await apiClient.get<KeysetResponse>('/ip-events', { params: { ...filterParams(), before: cursor } });
      if (seq !== requestSeq.current) return;
      const older = (res.data.data ?? []).map(fromApi);
      // No cap here: the user asked for these rows.
      setRows((prev) => mergeRows(prev, older, Number.MAX_SAFE_INTEGER));
      setHasMore(!!res.data.hasMore);
      setNextBefore(res.data.nextBefore ?? null);
      setOlderLoaded(true);
    } catch (err) {
      toast.error(apiError(err, t('liveEvents.loadFailed', { defaultValue: 'Failed to load events' })));
    } finally {
      setLoadingOlder(false);
    }
  }, [nextBefore, loadingOlder, filterParams, t]);

  // ── Live stream (ip:events) ────────────────────────────────────────────────
  const live = !paused && !olderLoaded;
  const liveRef = useRef(live);
  liveRef.current = live;
  const matchIp = useMemo(() => ipMatcher(search), [search]);
  const filterRef = useRef({ service, eventType, agentId, matchIp, period });
  filterRef.current = { service, eventType, agentId, matchIp, period };
  const loadHeadRef = useRef(loadHead);
  loadHeadRef.current = loadHead;

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    const onFrame = (frame: IpEventsFrame) => {
      if (!frame || !Array.isArray(frame.events)) return;
      const f = filterRef.current;
      const since = f.period ? Date.now() - PERIOD_MS[f.period] : null;
      const shown: EventRow[] = [];
      let unknown = 0;
      for (const ev of frame.events) {
        if (f.service && ev.service !== f.service) continue;
        if (f.eventType && ev.eventType !== f.eventType) continue;
        if (f.agentId && ev.deviceId !== f.agentId) continue;
        // A late flush may carry old events: keep the period filter.
        if (since !== null && new Date(ev.timestamp).getTime() < since) continue;
        const ipOk = f.matchIp(hostPart(ev.ip));
        if (ipOk === false) continue;
        if (ipOk === null) { unknown++; continue; }
        shown.push(fromStream(ev, hostnamesRef.current.get(ev.deviceId) ?? null));
      }
      const dropped = Math.max(0, Number(frame.dropped) || 0);
      if (!liveRef.current) {
        const n = shown.length + unknown + dropped;
        if (n > 0) setPending((p) => p + n);
        return;
      }
      if (shown.length > 0) {
        if (inflightRows.current) inflightRows.current.push(...shown);
        // Rows pushed off the end by LIVE_CAP stay reachable through "Load older".
        if (rowsRef.current.length + shown.length > LIVE_CAP) setHasMore(true);
        setRows((prev) => mergeRows(shown, prev, LIVE_CAP));
        const ids = shown.map((r) => r.id);
        setFresh((prev) => new Set([...prev, ...ids]));
        setTimeout(() => {
          setFresh((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.delete(id);
            return next;
          });
        }, FRESH_MS);
      }
      if (unknown > 0) setPending((p) => p + unknown);
      // Rows of the flush left out of the frame: re-read the head once the burst settles.
      if (dropped > 0) {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { void loadHeadRef.current(); }, 1000);
      }
    };
    // Reconnected (events emitted while down are lost): re-read the head.
    const onResync = () => {
      if (liveRef.current) void loadHeadRef.current();
      else staleRef.current = true;
    };

    socket.on(SOCKET_EVENTS.IP_EVENTS, onFrame);
    window.addEventListener(SOCKET_RESYNC_EVENT, onResync);
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      socket.off(SOCKET_EVENTS.IP_EVENTS, onFrame);
      window.removeEventListener(SOCKET_RESYNC_EVENT, onResync);
    };
  }, [generation]);

  const resume = useCallback(() => {
    setPaused(false);
    if (pending > 0 || olderLoaded || staleRef.current) void loadHead();
  }, [pending, olderLoaded, loadHead]);

  // Relative times stay current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────
  const [busyIps, setBusyIps] = useState<ReadonlySet<string>>(new Set());
  const withBusy = useCallback(async (ip: string, fn: () => Promise<void>) => {
    setBusyIps((prev) => new Set(prev).add(ip));
    try { await fn(); } finally {
      setBusyIps((prev) => { const next = new Set(prev); next.delete(ip); return next; });
    }
  }, []);

  const handleBan = useCallback(async (ip: string) => {
    const ok = await confirm({
      title: t('liveEvents.banTitle', { defaultValue: 'Ban this IP?' }),
      message: perms.isGodView
        ? t('bans.confirmBanGlobal', { ip, defaultValue: 'Ban IP {{ip}}?\n\nIt will be blocked on every agent of every tenant.' })
        : t('bans.confirmBanLocal', { ip, defaultValue: 'Ban IP {{ip}}?\n\nIt will be blocked on the agents of this tenant.' }),
      confirmLabel: t('liveEvents.ban', { defaultValue: 'Ban' }),
      danger: true,
    });
    if (!ok) return;
    await withBusy(ip, async () => {
      try {
        // No scope: the server derives it from the operating tenant.
        await bansApi.create({ ip, reason: t('liveEvents.banReason', { defaultValue: 'Manual ban from live events' }) });
        toast.success(perms.isGodView
          ? t('bans.bannedGlobal', { ip, defaultValue: '{{ip}} banned on every agent' })
          : t('bans.bannedLocal', { ip, defaultValue: '{{ip}} banned on this tenant' }));
        notifyIpChanged(ip);
      } catch (err) {
        toast.error(apiError(err, t('liveEvents.banFailed', { ip, defaultValue: 'Failed to ban {{ip}}' })));
      }
    });
  }, [confirm, perms.isGodView, t, withBusy]);

  const handleWhitelist = useCallback(async (ip: string) => {
    const ok = await confirm({
      title: t('liveEvents.whitelistTitle', { defaultValue: 'Whitelist this IP?' }),
      message: perms.canWhitelistGlobally
        ? t('liveEvents.whitelistConfirmGlobal', { ip, defaultValue: '{{ip}} will never be banned, on any tenant.' })
        : t('liveEvents.whitelistConfirmLocal', { ip, defaultValue: '{{ip}} will never be banned on this tenant.' }),
      confirmLabel: t('liveEvents.whitelist', { defaultValue: 'Whitelist' }),
    });
    if (!ok) return;
    await withBusy(ip, async () => {
      try {
        await whitelistApi.create({ ip });
        toast.success(t('liveEvents.whitelisted', { ip, defaultValue: '{{ip}} added to the whitelist' }));
        notifyIpChanged(ip);
      } catch (err) {
        toast.error(apiError(err, t('liveEvents.whitelistFailed', { ip, defaultValue: 'Failed to whitelist {{ip}}' })));
      }
    });
  }, [confirm, perms.canWhitelistGlobally, t, withBusy]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const serviceOptions = useMemo(() => {
    const set = new Set<string>(BUILTIN_SERVICES);
    for (const r of rows) set.add(r.service);
    if (service) set.add(service);
    return [...set].sort();
  }, [rows, service]);

  const agentOptions = useMemo(
    () => [...devices]
      .map((d) => ({ id: d.id, label: d.name || d.hostname }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [devices],
  );

  const showActions = perms.canBan || perms.canWhitelist;
  const colCount = 7 + (perms.isGodView ? 1 : 0) + (showActions ? 1 : 0);

  const statusBadge = (() => {
    if (socketStatus !== 'connected') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-text-muted" aria-hidden="true" />
          {t('liveEvents.offline', { defaultValue: 'Offline' })}
        </span>
      );
    }
    if (!live) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-[11px] font-medium text-yellow-400">
          <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" aria-hidden="true" />
          {paused
            ? t('liveEvents.paused', { defaultValue: 'Paused' })
            : t('liveEvents.browsing', { defaultValue: 'Browsing history' })}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-status-up/30 bg-status-up/10 px-2 py-0.5 text-[11px] font-medium text-status-up">
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-up opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-status-up" />
        </span>
        {t('liveEvents.live', { defaultValue: 'Live' })}
      </span>
    );
  })();

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <PageContainer className="space-y-4">
      <PageHeader
        icon={<Activity size={20} />}
        title={t('liveEvents.title', { defaultValue: 'Live events' })}
        description={t('liveEvents.description', { defaultValue: 'Authentication events reported by your agents, as they arrive.' })}
        badge={statusBadge}
        actions={(
          <>
            {paused ? (
              <Button variant="secondary" size="sm" onClick={resume}>
                <Play size={14} className="mr-1.5" />
                {t('liveEvents.resume', { defaultValue: 'Resume' })}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setPaused(true)}>
                <Pause size={14} className="mr-1.5" />
                {t('liveEvents.pause', { defaultValue: 'Pause' })}
              </Button>
            )}
            <IconButton
              label={t('common.refresh', { defaultValue: 'Refresh' })}
              icon={<RefreshCw size={15} className={cn(loading && 'animate-spin')} />}
              variant="solid"
              onClick={() => void loadHead()}
              disabled={loading}
            />
            <IconButton
              variant="solid"
              label={t('csvExport.button', { defaultValue: 'Export CSV' })}
              icon={<Download className={cn('h-4 w-4', exporting && 'animate-pulse')} />}
              onClick={() => void exportCsv()}
              disabled={exporting}
            />
          </>
        )}
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder={t('liveEvents.searchIp', { defaultValue: 'IP, CIDR or part of an IP…' })}
            aria-label={t('liveEvents.searchIp', { defaultValue: 'IP, CIDR or part of an IP…' })}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={cn(selectClass, 'w-56 font-mono')}
          />
        </div>
        <select
          value={service}
          onChange={(e) => setParam(P.service, e.target.value)}
          aria-label={t('liveEvents.service', { defaultValue: 'Service' })}
          className={selectClass}
        >
          <option value="">{t('liveEvents.allServices', { defaultValue: 'All services' })}</option>
          {serviceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={eventType}
          onChange={(e) => setParam(P.type, e.target.value)}
          aria-label={t('liveEvents.type', { defaultValue: 'Type' })}
          className={selectClass}
        >
          <option value="">{t('liveEvents.allTypes', { defaultValue: 'All types' })}</option>
          {EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`liveEvents.eventType.${type}`, { defaultValue: type === 'auth_failure' ? 'Auth failure' : type === 'auth_success' ? 'Auth success' : 'Port scan' })}
            </option>
          ))}
        </select>
        <select
          value={agentId ? String(agentId) : ''}
          onChange={(e) => setParam(P.agent, e.target.value)}
          aria-label={t('liveEvents.agent', { defaultValue: 'Agent' })}
          className={cn(selectClass, 'max-w-[14rem]')}
        >
          <option value="">{t('liveEvents.allAgents', { defaultValue: 'All agents' })}</option>
          {agentOptions.map((a) => <option key={a.id} value={a.id}>{anonHostname(a.label)}</option>)}
          {agentId && !agentOptions.some((a) => a.id === agentId) && (
            <option value={agentId}>{t('liveEvents.agentId', { id: agentId, defaultValue: 'Agent #{{id}}' })}</option>
          )}
        </select>
        <div className="flex items-center gap-1">
          <PeriodSelector value={period} onChange={(p) => setParam(P.period, p)} />
          <button
            type="button"
            onClick={() => setParam(P.period, '')}
            className={cn(
              'rounded-md border border-border px-3 py-1 text-xs font-medium transition-colors',
              period ? 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary' : 'bg-accent text-white',
            )}
            aria-pressed={!period}
          >
            {t('liveEvents.allTime', { defaultValue: 'All' })}
          </button>
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X size={14} className="mr-1" />
            {t('liveEvents.clearFilters', { defaultValue: 'Clear filters' })}
          </Button>
        )}
      </div>

      {/* New events pill */}
      {pending > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => { setPaused(false); void loadHead(); }}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-medium text-white shadow hover:bg-accent-hover transition-colors"
          >
            <ArrowUp size={12} />
            {t('liveEvents.newEvents', { count: pending, defaultValue: '{{count}} new events' })}
          </button>
        </div>
      )}

      <TableScroll className="border border-border bg-bg-secondary">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase text-text-muted">
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('liveEvents.colTime', { defaultValue: 'Time' })}</th>
              <th className="px-4 py-2 text-left font-medium">{t('liveEvents.colAgent', { defaultValue: 'Agent' })}</th>
              {perms.isGodView && <th className="px-4 py-2 text-left font-medium">{t('liveEvents.colTenant', { defaultValue: 'Tenant' })}</th>}
              <th className="px-4 py-2 text-left font-medium">{t('liveEvents.colIp', { defaultValue: 'IP' })}</th>
              <th className="px-4 py-2 text-left font-medium">{t('liveEvents.colService', { defaultValue: 'Service' })}</th>
              <th className="px-4 py-2 text-left font-medium">{t('liveEvents.colType', { defaultValue: 'Type' })}</th>
              <th className="px-4 py-2 text-left font-medium">{t('liveEvents.colUser', { defaultValue: 'User' })}</th>
              <th className="px-4 py-2 text-left font-medium">{t('liveEvents.colRawLog', { defaultValue: 'Raw log' })}</th>
              {showActions && <th className="w-16 px-2 py-2"><span className="sr-only">{t('common.actions', { defaultValue: 'Actions' })}</span></th>}
            </tr>
          </thead>
          <tbody className={cn('divide-y divide-border', loading && rows.length > 0 && 'opacity-60')}>
            {loading && rows.length === 0 ? (
              <TableSkeleton rows={10} cols={colCount} rowClassName="h-10" />
            ) : loadError && rows.length === 0 ? (
              <EmptyState
                colSpan={colCount}
                title={t('liveEvents.loadFailed', { defaultValue: 'Failed to load events' })}
                action={<Button variant="secondary" size="sm" onClick={() => void loadHead()}>{t('common.retry', { defaultValue: 'Retry' })}</Button>}
              />
            ) : rows.length === 0 ? (
              hasFilters
                ? <EmptyState variant="filtered" colSpan={colCount} onClearFilters={clearFilters} />
                : (
                  <EmptyState
                    colSpan={colCount}
                    title={t('liveEvents.empty', { defaultValue: 'No events yet' })}
                    description={t('liveEvents.emptyHint', { defaultValue: 'Events show up here as soon as an agent reports them.' })}
                  />
                )
            ) : rows.map((ev) => {
              const host = ev.hostname ?? (ev.deviceId != null ? hostnames.get(ev.deviceId) ?? null : null);
              return (
                <tr
                  key={ev.id}
                  className={cn(
                    'group transition-colors hover:bg-bg-hover',
                    fresh.has(ev.id) && 'bg-accent/10',
                  )}
                >
                  <td className="whitespace-nowrap px-4 py-2.5 text-text-muted" title={absoluteTime(ev.timestamp)}>
                    {relativeTime(ev.timestamp, now, t)}
                  </td>
                  <td className="max-w-[10rem] truncate px-4 py-2.5 text-text-secondary">
                    {host ? anonHostname(host) : <span className="text-text-muted">—</span>}
                  </td>
                  {perms.isGodView && (
                    <td className="px-4 py-2.5"><TenantBadge tenantId={ev.tenantId} /></td>
                  )}
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => openIp(ev.ip)}
                      className="font-mono text-accent hover:underline"
                    >
                      {anonIp(ev.ip)}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">{ev.service}</td>
                  <td className="px-4 py-2.5"><EventTypeBadge type={ev.eventType} short /></td>
                  <td className="px-4 py-2.5 font-mono text-text-secondary">
                    {ev.username ? anonUsername(ev.username) : <span className="text-text-muted">—</span>}
                  </td>
                  <td className="max-w-[16rem] px-4 py-2.5">
                    {ev.rawLog ? (
                      <span title={anonLog(ev.rawLog)} className="block cursor-help truncate text-text-muted">
                        {anonLog(ev.rawLog)}
                      </span>
                    ) : <span className="text-text-muted">—</span>}
                  </td>
                  {showActions && (
                    <td className="px-2 py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        {perms.canBan && (
                          <IconButton
                            label={t('liveEvents.quickBan', { defaultValue: 'Quick ban' })}
                            icon={<ShieldOff size={13} />}
                            variant="danger"
                            size="sm"
                            touchTarget="overlay"
                            disabled={busyIps.has(ev.ip)}
                            onClick={() => void handleBan(ev.ip)}
                          />
                        )}
                        {perms.canWhitelist && (
                          <IconButton
                            label={t('liveEvents.whitelist', { defaultValue: 'Whitelist' })}
                            icon={<ShieldCheck size={13} />}
                            variant="accent"
                            size="sm"
                            touchTarget="overlay"
                            disabled={busyIps.has(ev.ip)}
                            onClick={() => void handleWhitelist(ev.ip)}
                          />
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
          <span>{t('liveEvents.shown', { count: rows.length, defaultValue: '{{count}} events shown' })}</span>
          {hasMore ? (
            <Button variant="secondary" size="sm" onClick={() => void loadOlder()} loading={loadingOlder} disabled={loadingOlder}>
              {t('liveEvents.loadOlder', { defaultValue: 'Load older' })}
            </Button>
          ) : (
            <span>{t('liveEvents.end', { defaultValue: 'No older events' })}</span>
          )}
        </div>
      )}
    </PageContainer>
  );
}
