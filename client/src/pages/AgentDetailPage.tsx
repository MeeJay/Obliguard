import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, ShieldOff, ShieldCheck, ExternalLink,
  ChevronLeft, ChevronRight, Wifi, Cpu, Server, X, Eye,
} from 'lucide-react';
import apiClient from '@/api/client';
import { agentApi } from '@/api/agent.api';
import { bansApi } from '@/api/bans.api';
import { whitelistApi } from '@/api/whitelist.api';
import type { AgentDevice, ApiResponse } from '@obliview/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

interface IpEventRow {
  id: number;
  device_id: number | null;
  ip: string;
  username: string | null;
  service: string;
  event_type: string;
  timestamp: string;
  raw_log: string | null;
  hostname?: string;
}

interface IpSummaryItem {
  ip: string;
  totalEvents: number;
  failures: number;
  services: string[];
  firstSeen: string;
  lastSeen: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ── Lookup links ──────────────────────────────────────────────────────────────

const LOOKUP_LINKS = [
  { label: 'AbuseIPDB',  url: (ip: string) => `https://www.abuseipdb.com/check/${ip}` },
  { label: 'Shodan',     url: (ip: string) => `https://www.shodan.io/host/${ip}` },
  { label: 'VirusTotal', url: (ip: string) => `https://www.virustotal.com/gui/ip-address/${ip}` },
  { label: 'WHOIS',      url: (ip: string) => `https://who.is/whois-ip/ip-address/${ip}` },
  { label: 'MXToolbox',  url: (ip: string) => `https://mxtoolbox.com/SuperTool.aspx?action=ptr:${ip}` },
];

function LookupButtons({ ip, compact }: { ip: string; compact?: boolean }) {
  const links = compact ? LOOKUP_LINKS.slice(0, 3) : LOOKUP_LINKS;
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map(({ label, url }) => (
        <a
          key={label}
          href={url(ip)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary hover:border-accent/40 transition-colors"
        >
          {label}
          <ExternalLink size={8} />
        </a>
      ))}
    </div>
  );
}

// ── EventTypeBadge ────────────────────────────────────────────────────────────

function EventTypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    auth_failure: 'bg-red-500/10 text-red-400 border-red-500/20',
    auth_success: 'bg-green-500/10 text-green-400 border-green-500/20',
    port_scan:    'bg-orange-500/10 text-orange-400 border-orange-500/20',
  };
  const labels: Record<string, string> = {
    auth_failure: 'FAIL',
    auth_success: 'OK',
    port_scan:    'SCAN',
  };
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold ${
        styles[type] ?? 'bg-bg-tertiary text-text-muted border-border'
      }`}
    >
      {labels[type] ?? type.toUpperCase()}
    </span>
  );
}

// ── MiniStat ──────────────────────────────────────────────────────────────────

function MiniStat({
  label,
  value,
  colorClass,
}: {
  label: string;
  value: string | number;
  colorClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary px-4 py-3">
      <div className="text-[10px] uppercase text-text-muted tracking-wide mb-1">{label}</div>
      <div className={`text-xl font-bold ${colorClass ?? 'text-text-primary'}`}>{value}</div>
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner({ size = 24 }: { size?: number }) {
  return (
    <div
      style={{ width: size, height: size }}
      className="rounded-full border-2 border-accent border-t-transparent animate-spin flex-shrink-0"
    />
  );
}

// ── IP Detail Drawer ──────────────────────────────────────────────────────────

function IpDrawer({
  ip,
  onClose,
  onBan,
  onWhitelist,
}: {
  ip: string;
  onClose: () => void;
  onBan: (ip: string) => void;
  onWhitelist: (ip: string) => void;
}) {
  const [events, setEvents] = useState<IpEventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiClient
      .get<ApiResponse<IpEventRow[]>>(`/ip-events/${encodeURIComponent(ip)}`)
      .then(res => setEvents((res.data.data as IpEventRow[]) ?? []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [ip]);

  const failures = events.filter(e => e.event_type === 'auth_failure').length;
  const agents = [...new Set(events.map(e => e.hostname).filter(Boolean))];
  const services = [...new Set(events.map(e => e.service))];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-2xl bg-bg-secondary border-l border-border flex flex-col overflow-hidden shadow-2xl">

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="min-w-0">
            <h2 className="font-mono text-lg font-semibold text-text-primary">{ip}</h2>
            <p className="text-xs text-text-muted mt-0.5 space-x-2">
              <span>{events.length} events</span>
              <span>·</span>
              <span className="text-red-400">{failures} failures</span>
              <span>·</span>
              <span>{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
              {services.length > 0 && (
                <>
                  <span>·</span>
                  <span>{services.join(', ')}</span>
                </>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-4 rounded p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors flex-shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Actions */}
        <div className="px-5 py-3 border-b border-border flex-shrink-0 space-y-2">
          <LookupButtons ip={ip} />
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => onBan(ip)}
              className="inline-flex items-center gap-1.5 rounded bg-red-500/10 border border-red-500/20 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <ShieldOff size={13} />
              Quick Ban
            </button>
            <button
              onClick={() => onWhitelist(ip)}
              className="inline-flex items-center gap-1.5 rounded bg-green-500/10 border border-green-500/20 px-3 py-1.5 text-sm text-green-400 hover:bg-green-500/20 transition-colors"
            >
              <ShieldCheck size={13} />
              Whitelist
            </button>
          </div>
        </div>

        {/* Events list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner />
            </div>
          ) : events.length === 0 ? (
            <p className="text-center text-sm text-text-muted py-16">No events found for this IP</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-bg-secondary z-10">
                <tr className="text-[10px] uppercase text-text-muted border-b border-border">
                  <th className="text-left px-4 py-2 font-medium">Time</th>
                  <th className="text-left px-4 py-2 font-medium">Agent</th>
                  <th className="text-left px-4 py-2 font-medium">Service</th>
                  <th className="text-left px-4 py-2 font-medium">Type</th>
                  <th className="text-left px-4 py-2 font-medium">User</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map(ev => (
                  <tr key={ev.id} className="hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-2 text-text-muted whitespace-nowrap">{formatTs(ev.timestamp)}</td>
                    <td className="px-4 py-2 text-text-secondary">
                      {ev.hostname ?? <span className="text-text-muted">—</span>}
                    </td>
                    <td className="px-4 py-2 text-text-primary">{ev.service}</td>
                    <td className="px-4 py-2"><EventTypeBadge type={ev.event_type} /></td>
                    <td className="px-4 py-2 font-mono text-text-secondary">
                      {ev.username ?? <span className="text-text-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export function AgentDetailPage() {
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const devId = deviceId ? parseInt(deviceId, 10) : null;

  // Device info
  const [device, setDevice] = useState<AgentDevice | null>(null);
  const [deviceLoading, setDeviceLoading] = useState(true);

  // Paginated events (for the table)
  const [events, setEvents] = useState<IpEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Filters
  const [serviceFilter, setServiceFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  // Summary events (7-day window, for IP summary panel + stats)
  const [summaryEvents, setSummaryEvents] = useState<IpEventRow[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(true);

  // IP drawer
  const [selectedIp, setSelectedIp] = useState<string | null>(null);

  // In-flight ban / whitelist
  const [banningIps, setBanningIps] = useState(new Set<string>());
  const [whitelistingIps, setWhitelistingIps] = useState(new Set<string>());

  // ── Load device ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!devId) return;
    agentApi
      .getDeviceById(devId)
      .then(d => setDevice(d))
      .finally(() => setDeviceLoading(false));
  }, [devId]);

  // ── Load paginated events ───────────────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    if (!devId) return;
    setEventsLoading(true);
    try {
      const params: Record<string, unknown> = { deviceId: devId, page, pageSize: PAGE_SIZE };
      if (serviceFilter) params.service = serviceFilter;
      if (typeFilter) params.eventType = typeFilter;
      const res = await apiClient.get('/ip-events', { params });
      setEvents((res.data.data ?? []) as IpEventRow[]);
      setTotal(res.data.total ?? 0);
    } finally {
      setEventsLoading(false);
    }
  }, [devId, page, serviceFilter, typeFilter]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [serviceFilter, typeFilter]);

  // ── Load summary events (7-day, up to 500) ─────────────────────────────────
  const loadSummary = useCallback(async () => {
    if (!devId) return;
    setSummaryLoading(true);
    try {
      const from = new Date();
      from.setDate(from.getDate() - 7);
      const res = await apiClient.get('/ip-events', {
        params: { deviceId: devId, from: from.toISOString(), pageSize: 500 },
      });
      setSummaryEvents((res.data.data ?? []) as IpEventRow[]);
    } finally {
      setSummaryLoading(false);
    }
  }, [devId]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  // ── Compute IP summary ──────────────────────────────────────────────────────
  const ipSummary = useMemo<IpSummaryItem[]>(() => {
    const map = new Map<string, IpSummaryItem>();
    for (const ev of summaryEvents) {
      const item = map.get(ev.ip);
      if (item) {
        item.totalEvents++;
        if (ev.event_type === 'auth_failure') item.failures++;
        if (!item.services.includes(ev.service)) item.services.push(ev.service);
        if (ev.timestamp > item.lastSeen) item.lastSeen = ev.timestamp;
        if (ev.timestamp < item.firstSeen) item.firstSeen = ev.timestamp;
      } else {
        map.set(ev.ip, {
          ip: ev.ip,
          totalEvents: 1,
          failures: ev.event_type === 'auth_failure' ? 1 : 0,
          services: [ev.service],
          firstSeen: ev.timestamp,
          lastSeen: ev.timestamp,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.totalEvents - a.totalEvents);
  }, [summaryEvents]);

  // ── Today's stats (derived from summary events) ─────────────────────────────
  const todayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);

  const todayEvents = useMemo(
    () => summaryEvents.filter(e => e.timestamp >= todayStart),
    [summaryEvents, todayStart],
  );
  const todayFailures = useMemo(
    () => todayEvents.filter(e => e.event_type === 'auth_failure').length,
    [todayEvents],
  );
  const uniqueIpCount = useMemo(
    () => new Set(summaryEvents.map(e => e.ip)).size,
    [summaryEvents],
  );
  const topService = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of summaryEvents) {
      counts.set(ev.service, (counts.get(ev.service) ?? 0) + 1);
    }
    let top = '—';
    let max = 0;
    for (const [svc, cnt] of counts) {
      if (cnt > max) { max = cnt; top = svc; }
    }
    return top;
  }, [summaryEvents]);

  // ── Online detection ────────────────────────────────────────────────────────
  const isOnline = device
    ? Date.now() - new Date(device.updatedAt).getTime() <
      (device.resolvedSettings?.checkIntervalSeconds ?? 60) * 3 * 1000
    : false;

  // ── Quick ban ───────────────────────────────────────────────────────────────
  const handleBan = useCallback(async (ip: string) => {
    if (!confirm(`Ban IP ${ip}?\n\nThis IP will be blocked across all agents.`)) return;
    setBanningIps(prev => new Set(prev).add(ip));
    try {
      await bansApi.create({ ip, reason: 'Manual ban from agent detail' });
    } catch {
      alert(`Failed to ban ${ip}`);
    } finally {
      setBanningIps(prev => { const s = new Set(prev); s.delete(ip); return s; });
    }
  }, []);

  // ── Quick whitelist ─────────────────────────────────────────────────────────
  const handleWhitelist = useCallback(async (ip: string) => {
    if (!confirm(`Add ${ip} to the whitelist?`)) return;
    setWhitelistingIps(prev => new Set(prev).add(ip));
    try {
      await whitelistApi.create({ ip });
    } catch {
      alert(`Failed to whitelist ${ip}`);
    } finally {
      setWhitelistingIps(prev => { const s = new Set(prev); s.delete(ip); return s; });
    }
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Loading / not found ─────────────────────────────────────────────────────
  if (deviceLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size={32} />
      </div>
    );
  }

  if (!device) {
    return (
      <div className="p-6 text-center text-text-muted">
        <p>Agent not found.</p>
        <button onClick={() => navigate(-1)} className="mt-3 text-accent hover:underline text-sm">
          Go back
        </button>
      </div>
    );
  }

  const displayName = device.name ?? device.hostname;
  const osLabel = device.osInfo
    ? [device.osInfo.distro ?? device.osInfo.platform, device.osInfo.release]
        .filter(Boolean)
        .join(' ')
    : null;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <button
          onClick={() => navigate(-1)}
          className="mt-0.5 rounded p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors flex-shrink-0"
        >
          <ArrowLeft size={18} />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <div
              className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                isOnline ? 'bg-status-up' : 'bg-status-down'
              }`}
            />
            <h1 className="text-xl font-semibold text-text-primary">{displayName}</h1>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                isOnline
                  ? 'bg-green-500/10 text-green-400'
                  : 'bg-red-500/10 text-red-400'
              }`}
            >
              {isOnline ? 'ONLINE' : 'OFFLINE'}
            </span>
            {device.agentVersion && (
              <span className="text-xs text-text-muted font-mono">v{device.agentVersion}</span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
            {device.hostname !== displayName && (
              <span className="flex items-center gap-1">
                <Server size={11} className="text-text-muted" />
                {device.hostname}
              </span>
            )}
            {osLabel && (
              <span className="flex items-center gap-1">
                <Cpu size={11} className="text-text-muted" />
                {osLabel}{device.osInfo?.arch ? ` (${device.osInfo.arch})` : ''}
              </span>
            )}
            {device.ip && (
              <span className="flex items-center gap-1 font-mono">
                <Wifi size={11} className="text-text-muted" />
                {device.ip}
              </span>
            )}
            <span className="text-text-muted">
              Last seen: {new Date(device.updatedAt).toLocaleString()}
            </span>
          </div>
        </div>

        <button
          onClick={() => { void loadEvents(); void loadSummary(); }}
          className="flex-shrink-0 rounded p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Refresh"
        >
          <RefreshCw
            size={16}
            className={eventsLoading || summaryLoading ? 'animate-spin' : ''}
          />
        </button>
      </div>

      {/* ── Stats strip ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniStat
          label="Events Today"
          value={summaryLoading ? '…' : todayEvents.length}
          colorClass="text-accent"
        />
        <MiniStat
          label="Failures Today"
          value={summaryLoading ? '…' : todayFailures}
          colorClass={todayFailures > 0 ? 'text-status-down' : 'text-status-up'}
        />
        <MiniStat
          label="Unique IPs (7d)"
          value={summaryLoading ? '…' : uniqueIpCount}
          colorClass="text-orange-400"
        />
        <MiniStat
          label="Top Service"
          value={summaryLoading ? '…' : topService}
          colorClass="text-text-primary"
        />
      </div>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

        {/* ── Events table (2 cols) ──────────────────────────────────────── */}
        <div className="xl:col-span-2 rounded-lg border border-border bg-bg-secondary flex flex-col">

          {/* Table toolbar */}
          <div className="px-4 py-3 border-b border-border flex items-center gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide flex-shrink-0">
              Connection Events
            </h2>
            <span className="text-xs text-text-muted ml-auto">
              {total.toLocaleString()} total
            </span>
          </div>
          <div className="px-4 py-2 border-b border-border flex items-center gap-2 flex-wrap">
            <input
              type="text"
              placeholder="Filter by service…"
              value={serviceFilter}
              onChange={e => setServiceFilter(e.target.value)}
              className="rounded border border-border bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent w-40"
            />
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="rounded border border-border bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="">All types</option>
              <option value="auth_failure">Auth Failure</option>
              <option value="auth_success">Auth Success</option>
              <option value="port_scan">Port Scan</option>
            </select>
          </div>

          {/* Table body */}
          <div className="overflow-x-auto flex-1 min-h-[200px]">
            {eventsLoading ? (
              <div className="flex items-center justify-center py-16">
                <Spinner />
              </div>
            ) : events.length === 0 ? (
              <div className="py-12 text-center text-sm text-text-muted">
                No events found
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase text-text-muted border-b border-border">
                    <th className="text-left px-4 py-2 font-medium whitespace-nowrap">Time</th>
                    <th className="text-left px-4 py-2 font-medium">IP</th>
                    <th className="text-left px-4 py-2 font-medium">Service</th>
                    <th className="text-left px-4 py-2 font-medium">Type</th>
                    <th className="text-left px-4 py-2 font-medium">User</th>
                    <th className="text-left px-4 py-2 font-medium">Raw Log</th>
                    <th className="w-8 px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {events.map(ev => (
                    <tr key={ev.id} className="hover:bg-bg-hover transition-colors group">
                      <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">
                        {relativeTime(ev.timestamp)}
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => setSelectedIp(ev.ip)}
                          className="font-mono text-accent hover:underline"
                        >
                          {ev.ip}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary">{ev.service}</td>
                      <td className="px-4 py-2.5">
                        <EventTypeBadge type={ev.event_type} />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-text-secondary">
                        {ev.username ?? <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5 max-w-[160px]">
                        {ev.raw_log ? (
                          <span
                            title={ev.raw_log}
                            className="truncate block text-text-muted cursor-help"
                          >
                            {ev.raw_log.length > 48
                              ? `${ev.raw_log.slice(0, 48)}…`
                              : ev.raw_log}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => void handleBan(ev.ip)}
                          disabled={banningIps.has(ev.ip)}
                          title="Quick ban this IP"
                          className="rounded p-1 text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                        >
                          <ShieldOff size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-2.5 border-t border-border flex items-center justify-between text-xs text-text-muted">
              <span>Page {page} of {totalPages} ({total.toLocaleString()} events)</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="rounded p-1.5 hover:bg-bg-hover disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="rounded p-1.5 hover:bg-bg-hover disabled:opacity-30 transition-colors"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── IP Summary panel (1 col) ───────────────────────────────────── */}
        <div className="rounded-lg border border-border bg-bg-secondary flex flex-col">
          <div className="px-4 py-3 border-b border-border flex-shrink-0 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              Top IPs (7 days)
            </h2>
            {!summaryLoading && (
              <span className="text-xs text-text-muted">{ipSummary.length} unique</span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {summaryLoading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner size={20} />
              </div>
            ) : ipSummary.length === 0 ? (
              <div className="py-10 text-center text-sm text-text-muted">
                No activity in the last 7 days
              </div>
            ) : (
              <div className="divide-y divide-border">
                {ipSummary.slice(0, 25).map(item => (
                  <div key={item.ip} className="px-4 py-3 hover:bg-bg-hover transition-colors">
                    {/* IP row */}
                    <div className="flex items-start justify-between gap-2">
                      <button
                        onClick={() => setSelectedIp(item.ip)}
                        className="font-mono text-sm text-accent hover:underline text-left min-w-0 truncate"
                      >
                        {item.ip}
                      </button>
                      <div className="flex gap-0.5 flex-shrink-0">
                        <button
                          onClick={() => void handleBan(item.ip)}
                          disabled={banningIps.has(item.ip)}
                          title="Quick ban"
                          className="rounded p-1 text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                        >
                          <ShieldOff size={12} />
                        </button>
                        <button
                          onClick={() => void handleWhitelist(item.ip)}
                          disabled={whitelistingIps.has(item.ip)}
                          title="Whitelist"
                          className="rounded p-1 text-text-muted hover:text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-40"
                        >
                          <ShieldCheck size={12} />
                        </button>
                        <button
                          onClick={() => setSelectedIp(item.ip)}
                          title="View all events for this IP"
                          className="rounded p-1 text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                        >
                          <Eye size={12} />
                        </button>
                      </div>
                    </div>

                    {/* Stats row */}
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                      <span>
                        <span
                          className={item.failures > 0 ? 'text-red-400 font-semibold' : 'text-text-secondary'}
                        >
                          {item.failures}
                        </span>
                        {' '}fail / {item.totalEvents} events
                      </span>
                      {item.services.length > 0 && (
                        <span className="truncate max-w-[100px]" title={item.services.join(', ')}>
                          {item.services.join(', ')}
                        </span>
                      )}
                      <span title={`First: ${item.firstSeen}`}>
                        {relativeTime(item.lastSeen)}
                      </span>
                    </div>

                    {/* Compact lookup links */}
                    <div className="mt-1.5">
                      <LookupButtons ip={item.ip} compact />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── IP Detail Drawer ──────────────────────────────────────────────── */}
      {selectedIp && (
        <IpDrawer
          ip={selectedIp}
          onClose={() => setSelectedIp(null)}
          onBan={handleBan}
          onWhitelist={handleWhitelist}
        />
      )}
    </div>
  );
}
