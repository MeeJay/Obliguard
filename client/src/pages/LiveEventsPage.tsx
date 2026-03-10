import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  ShieldOff, ShieldCheck, ExternalLink, ChevronLeft, ChevronRight, X, Eye,
} from 'lucide-react';
import apiClient from '@/api/client';
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
  lastSeen: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
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

function LookupButtons({ ip }: { ip: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {LOOKUP_LINKS.map(({ label, url }) => (
        <a
          key={label}
          href={url(ip)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary hover:border-accent/40 transition-colors"
        >
          {label} <ExternalLink size={8} />
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
    auth_failure: 'FAIL', auth_success: 'OK', port_scan: 'SCAN',
  };
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold ${styles[type] ?? 'bg-bg-tertiary text-text-muted border-border'}`}>
      {labels[type] ?? type.toUpperCase()}
    </span>
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
  ip, onClose, onBan, onWhitelist,
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
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-bg-secondary border-l border-border flex flex-col overflow-hidden shadow-2xl">
        <div className="flex items-start justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="min-w-0">
            <h2 className="font-mono text-lg font-semibold text-text-primary">{ip}</h2>
            <p className="text-xs text-text-muted mt-0.5 space-x-2">
              <span>{events.length} events</span>
              <span>·</span>
              <span className="text-red-400">{failures} failures</span>
              <span>·</span>
              <span>{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
              {services.length > 0 && <><span>·</span><span>{services.join(', ')}</span></>}
            </p>
          </div>
          <button onClick={onClose} className="ml-4 rounded p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors flex-shrink-0">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-border flex-shrink-0 space-y-2">
          <LookupButtons ip={ip} />
          <div className="flex gap-2 pt-1">
            <button onClick={() => onBan(ip)} className="inline-flex items-center gap-1.5 rounded bg-red-500/10 border border-red-500/20 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/20 transition-colors">
              <ShieldOff size={13} /> Quick Ban
            </button>
            <button onClick={() => onWhitelist(ip)} className="inline-flex items-center gap-1.5 rounded bg-green-500/10 border border-green-500/20 px-3 py-1.5 text-sm text-green-400 hover:bg-green-500/20 transition-colors">
              <ShieldCheck size={13} /> Whitelist
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16"><Spinner /></div>
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
                    <td className="px-4 py-2 text-text-secondary">{ev.hostname ?? <span className="text-text-muted">—</span>}</td>
                    <td className="px-4 py-2 text-text-primary">{ev.service}</td>
                    <td className="px-4 py-2"><EventTypeBadge type={ev.event_type} /></td>
                    <td className="px-4 py-2 font-mono text-text-secondary">{ev.username ?? <span className="text-text-muted">—</span>}</td>
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

export function LiveEventsPage() {
  // Events (paginated)
  const [events, setEvents]         = useState<IpEventRow[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(false);

  // Filters
  const [serviceFilter, setServiceFilter]   = useState('');
  const [typeFilter, setTypeFilter]         = useState('');
  const [agentFilter, setAgentFilter]       = useState('');

  // Agents (for filter dropdown)
  const [agents, setAgents] = useState<Pick<AgentDevice, 'id' | 'hostname' | 'name'>[]>([]);

  // IP drawer
  const [selectedIp, setSelectedIp]         = useState<string | null>(null);
  const [banningIps, setBanningIps]         = useState(new Set<string>());
  const [whitelistingIps, setWhitelistingIps] = useState(new Set<string>());

  // ── Load agents for filter ─────────────────────────────────────────────────
  useEffect(() => {
    apiClient
      .get<ApiResponse<AgentDevice[]>>('/agent/devices')
      .then(res => setAgents(
        (res.data.data ?? []).map(d => ({ id: d.id, hostname: d.hostname, name: d.name })),
      ))
      .catch(() => {});
  }, []);

  // ── Load events ────────────────────────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { page, pageSize: PAGE_SIZE };
      if (serviceFilter) params.service    = serviceFilter;
      if (typeFilter)    params.eventType  = typeFilter;
      if (agentFilter)   params.deviceId   = agentFilter;
      const res = await apiClient.get('/ip-events', { params });
      setEvents((res.data.data ?? []) as IpEventRow[]);
      setTotal(res.data.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [page, serviceFilter, typeFilter, agentFilter]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);
  useEffect(() => { setPage(1); }, [serviceFilter, typeFilter, agentFilter]);

  // ── Per-IP summary (from current page) ────────────────────────────────────
  const ipSummary = useMemo<IpSummaryItem[]>(() => {
    const map = new Map<string, IpSummaryItem>();
    for (const ev of events) {
      const item = map.get(ev.ip);
      if (item) {
        item.totalEvents++;
        if (ev.event_type === 'auth_failure') item.failures++;
        if (!item.services.includes(ev.service)) item.services.push(ev.service);
        if (ev.timestamp > item.lastSeen) item.lastSeen = ev.timestamp;
      } else {
        map.set(ev.ip, {
          ip: ev.ip, totalEvents: 1,
          failures: ev.event_type === 'auth_failure' ? 1 : 0,
          services: [ev.service], lastSeen: ev.timestamp,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.failures - a.failures || b.totalEvents - a.totalEvents);
  }, [events]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleBan = useCallback(async (ip: string) => {
    if (!confirm(`Ban IP ${ip}?\n\nThis IP will be blocked across all agents.`)) return;
    setBanningIps(prev => new Set(prev).add(ip));
    try {
      await bansApi.create({ ip, reason: 'Manual ban from live events' });
    } catch { alert(`Failed to ban ${ip}`); }
    finally { setBanningIps(prev => { const s = new Set(prev); s.delete(ip); return s; }); }
  }, []);

  const handleWhitelist = useCallback(async (ip: string) => {
    if (!confirm(`Add ${ip} to the whitelist?`)) return;
    setWhitelistingIps(prev => new Set(prev).add(ip));
    try {
      await whitelistApi.create({ ip });
    } catch { alert(`Failed to whitelist ${ip}`); }
    finally { setWhitelistingIps(prev => { const s = new Set(prev); s.delete(ip); return s; }); }
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">Live Events</h1>
        <span className="text-sm text-text-muted">{total.toLocaleString()} total events</span>
      </div>

      {/* Main grid: table + IP summary */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

        {/* Events table */}
        <div className="xl:col-span-2 rounded-lg border border-border bg-bg-secondary flex flex-col">

          {/* Filters */}
          <div className="px-4 py-2.5 border-b border-border flex items-center gap-2 flex-wrap">
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
            <select
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
              className="rounded border border-border bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="">All agents</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.hostname}
                </option>
              ))}
            </select>
            <button
              onClick={() => void loadEvents()}
              className="ml-auto rounded border border-border bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              Refresh
            </button>
          </div>

          {/* Table */}
          <div className="overflow-x-auto flex-1 min-h-[300px]">
            {loading ? (
              <div className="flex items-center justify-center py-20"><Spinner /></div>
            ) : events.length === 0 ? (
              <div className="py-16 text-center text-sm text-text-muted">No events found</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase text-text-muted border-b border-border">
                    <th className="text-left px-4 py-2 font-medium whitespace-nowrap">Time</th>
                    <th className="text-left px-4 py-2 font-medium">Agent</th>
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
                      <td className="px-4 py-2.5 text-text-secondary text-xs truncate max-w-[90px]">
                        {ev.hostname ?? <span className="text-text-muted">—</span>}
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
                      <td className="px-4 py-2.5"><EventTypeBadge type={ev.event_type} /></td>
                      <td className="px-4 py-2.5 font-mono text-text-secondary">
                        {ev.username ?? <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5 max-w-[150px]">
                        {ev.raw_log ? (
                          <span title={ev.raw_log} className="truncate block text-text-muted cursor-help">
                            {ev.raw_log.length > 45 ? `${ev.raw_log.slice(0, 45)}…` : ev.raw_log}
                          </span>
                        ) : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-2 py-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => void handleBan(ev.ip)}
                          disabled={banningIps.has(ev.ip)}
                          title="Quick ban"
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

        {/* IP Summary (from current page) */}
        <div className="rounded-lg border border-border bg-bg-secondary flex flex-col">
          <div className="px-4 py-3 border-b border-border flex-shrink-0 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              IPs on this page
            </h2>
            <span className="text-xs text-text-muted">{ipSummary.length} unique</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {ipSummary.length === 0 ? (
              <div className="py-10 text-center text-sm text-text-muted">No data</div>
            ) : (
              <div className="divide-y divide-border">
                {ipSummary.map(item => (
                  <div key={item.ip} className="px-4 py-3 hover:bg-bg-hover transition-colors">
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
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                      <span>
                        <span className={item.failures > 0 ? 'text-red-400 font-semibold' : 'text-text-secondary'}>
                          {item.failures}
                        </span>
                        {' '}fail / {item.totalEvents} events
                      </span>
                      {item.services.length > 0 && (
                        <span className="truncate max-w-[110px]" title={item.services.join(', ')}>
                          {item.services.join(', ')}
                        </span>
                      )}
                      <span>{relativeTime(item.lastSeen)}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {LOOKUP_LINKS.slice(0, 3).map(({ label, url }) => (
                        <a
                          key={label}
                          href={url(item.ip)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-[9px] text-text-muted hover:text-accent border border-border/60 rounded px-1.5 py-0.5 hover:border-accent/40 transition-colors"
                        >
                          {label}
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* IP Detail Drawer */}
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
