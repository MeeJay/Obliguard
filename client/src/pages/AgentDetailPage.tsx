import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, ShieldOff, ShieldCheck, ExternalLink,
  ChevronLeft, ChevronRight, Wifi, Cpu, Server, X, Eye,
  Trash2, AlertTriangle,
  ChevronDown, ChevronUp, LayoutGrid, Network, Pencil, ArrowLeftRight,
} from 'lucide-react';
import apiClient from '@/api/client';
import { agentApi } from '@/api/agent.api';
import { appConfigApi } from '@/api/appConfig.api';
import { bansApi } from '@/api/bans.api';
import { whitelistApi } from '@/api/whitelist.api';
import { serviceTemplatesApi } from '@/api/serviceTemplates.api';
import { getSocket } from '@/socket/socketClient';
import type {
  AgentDevice,
  ServiceTemplate,
  CreateServiceTemplateRequest, NotificationTypeConfig, ServiceType,
} from '@obliview/shared';
import { NotificationTypesPanel } from '@/components/agent/NotificationTypesPanel';
import { ServiceTemplatesPanel } from '@/components/agent/ServiceTemplatesPanel';

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

interface MiniIpNode {
  ip: string;
  x: number; y: number;
  failures: number;
  totalEvents: number;
}

interface MiniParticle {
  sx: number; sy: number;
  tx: number; ty: number;
  t: number;
  color: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MINI_EVENT_COLORS: Record<string, string> = {
  auth_success: '#22d3ee',
  auth_failure: '#f97316',
  ban:          '#ef4444',
};

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
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold ${
      styles[type] ?? 'bg-bg-tertiary text-text-muted border-border'
    }`}>
      {labels[type] ?? type.toUpperCase()}
    </span>
  );
}

// ── MiniStat ──────────────────────────────────────────────────────────────────

function MiniStat({
  label, value, colorClass,
}: { label: string; value: string | number; colorClass?: string }) {
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

// ── AgentMiniMap ──────────────────────────────────────────────────────────────

interface AgentMiniMapProps {
  deviceId: number;
  summaryEvents: IpEventRow[];
  onSelectIp: (ip: string) => void;
}

function AgentMiniMap({ deviceId, summaryEvents, onSelectIp }: AgentMiniMapProps) {
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const animRef        = useRef<number>(0);
  const particlesRef   = useRef<MiniParticle[]>([]);
  const layoutRef      = useRef<MiniIpNode[]>([]);
  const sizeRef        = useRef({ cx: 200, cy: 200 });
  const summaryRef     = useRef(summaryEvents);
  const [tooltip, setTooltip] = useState<{ ip: string; x: number; y: number } | null>(null);

  // Always keep summaryRef current so ResizeObserver can use it
  summaryRef.current = summaryEvents;

  // ── Build layout (pure fn, all writes to refs) ────────────────────────────
  function buildLayout(canvas: HTMLCanvasElement, events: IpEventRow[]) {
    const DPR = window.devicePixelRatio || 1;
    const w = canvas.width / DPR;
    const h = canvas.height / DPR;
    const cx = w / 2;
    const cy = h / 2;
    sizeRef.current = { cx, cy };

    // Group events by IP
    const map = new Map<string, { failures: number; total: number }>();
    for (const ev of events) {
      const d = map.get(ev.ip) ?? { failures: 0, total: 0 };
      d.total++;
      if (ev.event_type === 'auth_failure') d.failures++;
      map.set(ev.ip, d);
    }
    const sorted = Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);

    const PER_RING = 18;
    const BASE_R   = Math.min(cx, cy) * 0.50;
    const RING_GAP = 30;

    layoutRef.current = sorted.map(([ip, d], i) => {
      const ring      = Math.floor(i / PER_RING);
      const pos       = i % PER_RING;
      const count     = Math.min(PER_RING, sorted.length - ring * PER_RING);
      const r         = BASE_R + ring * RING_GAP;
      const angle     = (pos / count) * Math.PI * 2 - Math.PI / 2;
      return { ip, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), failures: d.failures, totalEvents: d.total };
    });
  }

  // Rebuild layout when summary events change
  useEffect(() => {
    if (canvasRef.current) buildLayout(canvasRef.current, summaryEvents);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryEvents]);

  // ── Canvas setup + animation loop (mount only) ────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const DPR = window.devicePixelRatio || 1;

    function resize() {
      const parent = canvas!.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas!.width  = w * DPR;
      canvas!.height = h * DPR;
      canvas!.style.width  = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
      buildLayout(canvas!, summaryRef.current);
    }
    resize();

    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    function draw() {
      if (!ctx) return;
      const { cx, cy } = sizeRef.current;
      const nodes = layoutRef.current;
      ctx.clearRect(0, 0, cx * 2, cy * 2);

      if (cx === 0) { animRef.current = requestAnimationFrame(draw); return; }

      // Orbital rings
      const rings   = Math.max(1, Math.ceil(nodes.length / 18));
      const BASE_R  = Math.min(cx, cy) * 0.50;
      for (let ring = 0; ring < rings; ring++) {
        ctx.beginPath();
        ctx.arc(cx, cy, BASE_R + ring * 30, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(99,102,241,0.10)';
        ctx.lineWidth   = 1;
        ctx.stroke();
      }

      // Lines from IP nodes to agent centre
      for (const n of nodes) {
        ctx.beginPath();
        ctx.moveTo(n.x, n.y);
        ctx.lineTo(cx, cy);
        ctx.strokeStyle = n.failures > 0 ? 'rgba(249,115,22,0.08)' : 'rgba(99,102,241,0.07)';
        ctx.lineWidth   = 0.8;
        ctx.stroke();
      }

      // Particles (IP → agent centre)
      const alive: MiniParticle[] = [];
      for (const p of particlesRef.current) {
        p.t = Math.min(1, p.t + 0.013);
        const px = p.sx + (p.tx - p.sx) * p.t;
        const py = p.sy + (p.ty - p.sy) * p.t;
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle   = p.color;
        ctx.globalAlpha = (1 - p.t) * 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (p.t < 1) alive.push(p);
      }
      particlesRef.current = alive;

      // IP dots
      for (const n of nodes) {
        const r   = 3.5 + Math.min(3, Math.log1p(n.totalEvents));
        const col = n.failures > 5 ? '#ef4444' : n.failures > 0 ? '#f97316' : '#64748b';
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle   = col + '30';
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1;
        ctx.stroke();
      }

      // Agent centre node
      const agR  = 20;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, agR * 2.5);
      grad.addColorStop(0, 'rgba(99,102,241,0.30)');
      grad.addColorStop(1, 'rgba(99,102,241,0)');
      ctx.beginPath(); ctx.arc(cx, cy, agR * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();

      ctx.beginPath(); ctx.arc(cx, cy, agR, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(99,102,241,0.18)'; ctx.fill();
      ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2; ctx.stroke();

      ctx.fillStyle   = '#c7d2fe';
      ctx.font        = 'bold 10px ui-monospace, monospace';
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AGENT', cx, cy);

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Socket listener ───────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    function handleFlow(ev: { ip: string; eventType: string; deviceId: number }) {
      if (ev.deviceId !== deviceId) return;
      const { cx, cy } = sizeRef.current;
      const node  = layoutRef.current.find(n => n.ip === ev.ip);
      const sx    = node ? node.x : cx + (Math.random() - 0.5) * 250;
      const sy    = node ? node.y : cy + (Math.random() - 0.5) * 250;
      const color = MINI_EVENT_COLORS[ev.eventType] ?? '#64748b';
      particlesRef.current.push({ sx, sy, tx: cx, ty: cy, t: 0, color });
      if (particlesRef.current.length > 60) particlesRef.current.shift();
    }

    socket.on('ip:flow', handleFlow);
    return () => { socket.off('ip:flow', handleFlow); };
  }, [deviceId]);

  // ── Mouse interactions ────────────────────────────────────────────────────
  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const n of layoutRef.current) {
      const dx = n.x - mx; const dy = n.y - my;
      const r  = 3.5 + Math.min(3, Math.log1p(n.totalEvents));
      if (dx * dx + dy * dy <= (r + 6) * (r + 6)) {
        setTooltip({ ip: n.ip, x: mx + 12, y: my - 8 });
        return;
      }
    }
    setTooltip(null);
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const n of layoutRef.current) {
      const dx = n.x - mx; const dy = n.y - my;
      const r  = 3.5 + Math.min(3, Math.log1p(n.totalEvents));
      if (dx * dx + dy * dy <= (r + 6) * (r + 6)) {
        onSelectIp(n.ip);
        return;
      }
    }
  }

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
        onClick={handleClick}
        className="w-full h-full cursor-crosshair"
      />
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs shadow-xl"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <p className="font-mono font-semibold text-text-primary">{tooltip.ip}</p>
          {(() => {
            const n = layoutRef.current.find(x => x.ip === tooltip.ip);
            if (!n) return null;
            return (
              <p className="text-text-muted mt-0.5">
                {n.totalEvents} events · <span className="text-red-400">{n.failures} fails</span>
              </p>
            );
          })()}
        </div>
      )}
      {summaryEvents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-sm text-text-muted">No IP activity in the last 7 days</p>
        </div>
      )}
    </div>
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
  const [events, setEvents]   = useState<IpEventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    // Use the list endpoint with `ip` query param (ILIKE match — robust across IP formats).
    // The /:ip path-param endpoint uses exact inet cast equality which can silently fail.
    apiClient
      .get<{ success: boolean; data: IpEventRow[]; total: number }>(
        '/ip-events',
        { params: { ip, pageSize: 300 } },
      )
      .then(res => setEvents(res.data.data ?? []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [ip]);

  const failures = events.filter(e => e.event_type === 'auth_failure').length;
  const agents   = [...new Set(events.map(e => e.hostname).filter(Boolean))];
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
              <ShieldOff size={13} />Quick Ban
            </button>
            <button onClick={() => onWhitelist(ip)} className="inline-flex items-center gap-1.5 rounded bg-green-500/10 border border-green-500/20 px-3 py-1.5 text-sm text-green-400 hover:bg-green-500/20 transition-colors">
              <ShieldCheck size={13} />Whitelist
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

// ── AgentSettingsPanel ────────────────────────────────────────────────────────

function AgentSettingsPanel({
  device,
  onUpdate,
}: {
  device: AgentDevice;
  onUpdate: (d: AgentDevice) => void;
}) {
  // Per-param override detection
  const cisOverridden  = device.overrideGroupSettings ?? false;
  const mmpOverridden  = device.maxMissedPushes !== null;

  // Effective (resolved) values — inherited value shown in grey when not overriding
  const resolvedCIS = device.resolvedSettings?.checkIntervalSeconds ?? 60;
  const resolvedMMP = device.resolvedSettings?.maxMissedPushes ?? 2;

  const [checkInterval,  setCheckInterval]  = useState(String(device.checkIntervalSeconds ?? 60));
  const [maxMissed,      setMaxMissed]      = useState(String(device.maxMissedPushes ?? resolvedMMP));
  const [wanMatching,    setWanMatching]    = useState(device.wanMatchingEnabled ?? false);
  const [saving,         setSaving]         = useState(false);

  useEffect(() => {
    setCheckInterval(String(device.checkIntervalSeconds ?? 60));
    setMaxMissed(String(device.maxMissedPushes ?? (device.resolvedSettings?.maxMissedPushes ?? 2)));
    setWanMatching(device.wanMatchingEnabled ?? false);
  }, [device]);

  async function save(updates: Parameters<typeof agentApi.updateDevice>[1]) {
    setSaving(true);
    try {
      const updated = await agentApi.updateDevice(device.id, updates);
      onUpdate(updated);
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  }

  function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
    return (
      <button
        type="button"
        onClick={onChange}
        disabled={saving}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors focus:outline-none disabled:opacity-50 ${
          value ? 'bg-accent' : 'bg-bg-tertiary border border-border'
        }`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${
          value ? 'translate-x-4' : 'translate-x-0.5'
        }`} />
      </button>
    );
  }

  return (
    <div className="px-5 py-3 flex flex-wrap items-center gap-5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted flex-shrink-0">
        Agent Settings
      </span>

      {/* ── Check interval ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <span>Check every</span>
        <input
          type="number"
          min={10}
          value={cisOverridden ? checkInterval : resolvedCIS}
          onChange={e => { if (cisOverridden) setCheckInterval(e.target.value); }}
          onBlur={() => {
            if (cisOverridden) void save({ checkIntervalSeconds: Math.max(10, Number(checkInterval) || 60) });
          }}
          disabled={!cisOverridden}
          className={`w-14 rounded border border-border px-2 py-1 text-xs focus:outline-none focus:border-accent ${
            cisOverridden
              ? 'bg-bg-tertiary text-text-primary'
              : 'bg-bg-tertiary text-text-muted cursor-default'
          }`}
        />
        <span className="text-text-muted">s</span>
        {cisOverridden ? (
          <button
            type="button"
            onClick={() => void save({ overrideGroupSettings: false })}
            disabled={saving}
            className="text-[10px] text-text-muted hover:text-status-down border border-border rounded px-1.5 py-0.5 transition-colors disabled:opacity-50"
            title="Remove override — inherit from group / global settings"
          >
            Reset
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void save({ overrideGroupSettings: true, checkIntervalSeconds: resolvedCIS })}
            disabled={saving}
            className="text-[10px] text-accent border border-accent/40 rounded px-1.5 py-0.5 hover:bg-accent/10 transition-colors disabled:opacity-50"
            title="Override this setting at device level"
          >
            Override
          </button>
        )}
      </div>

      {/* ── Max missed pushes ───────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 text-xs text-text-secondary"
        title="Agent is marked offline after this many consecutive missed pushes"
      >
        <span>Max missed pushes</span>
        <input
          type="number"
          min={1}
          max={20}
          value={mmpOverridden ? maxMissed : resolvedMMP}
          onChange={e => { if (mmpOverridden) setMaxMissed(e.target.value); }}
          onBlur={() => {
            if (mmpOverridden) void save({ maxMissedPushes: Math.max(1, Number(maxMissed) || 2) });
          }}
          disabled={!mmpOverridden}
          className={`w-12 rounded border border-border px-2 py-1 text-xs focus:outline-none focus:border-accent ${
            mmpOverridden
              ? 'bg-bg-tertiary text-text-primary'
              : 'bg-bg-tertiary text-text-muted cursor-default'
          }`}
        />
        {mmpOverridden ? (
          <button
            type="button"
            onClick={() => void save({ maxMissedPushes: null })}
            disabled={saving}
            className="text-[10px] text-text-muted hover:text-status-down border border-border rounded px-1.5 py-0.5 transition-colors disabled:opacity-50"
            title="Remove override — inherit from group / global settings"
          >
            Reset
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void save({ maxMissedPushes: resolvedMMP })}
            disabled={saving}
            className="text-[10px] text-accent border border-accent/40 rounded px-1.5 py-0.5 hover:bg-accent/10 transition-colors disabled:opacity-50"
            title="Override this setting at device level"
          >
            Override
          </button>
        )}
      </div>

      {/* ── WAN Matching — opt-in for dedicated/static public IPs ───────── */}
      <label
        className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer select-none"
        title="Enable only if this agent has a dedicated/static public IP. Allows the NetMap to draw peer links for WAN traffic. Do not enable if behind a shared NAT."
      >
        <Toggle
          value={wanMatching}
          onChange={() => { const v = !wanMatching; setWanMatching(v); void save({ wanMatchingEnabled: v }); }}
        />
        <span>
          WAN matching
          {wanMatching && (
            <span className="ml-1 text-[10px] text-amber-400">(dedicated IP only)</span>
          )}
        </span>
      </label>

      {saving && <span className="text-[11px] text-text-muted animate-pulse">Saving…</span>}
    </div>
  );
}

// ── LocalTemplateModal ────────────────────────────────────────────────────────

function LocalTemplateModal({
  deviceId,
  onSave,
  onClose,
}: {
  deviceId: number;
  onSave: () => void;
  onClose: () => void;
}) {
  const [name,          setName]          = useState('');
  const [serviceType,   setServiceType]   = useState('');
  const [logPath,       setLogPath]       = useState('');
  const [threshold,     setThreshold]     = useState('5');
  const [windowSeconds, setWindowSeconds] = useState('600');
  const [mode,          setMode]          = useState<'ban' | 'track'>('ban');
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !serviceType.trim()) { setError('Name and Service Type are required.'); return; }
    setSaving(true);
    setError('');
    try {
      const data: CreateServiceTemplateRequest = {
        name:          name.trim(),
        serviceType:   serviceType.trim() as ServiceType,
        defaultLogPath: logPath.trim() || null,
        threshold:     Number(threshold) || 5,
        windowSeconds: Number(windowSeconds) || 600,
        mode,
        ownerScope:    'agent',
        ownerScopeId:  deviceId,
      };
      await serviceTemplatesApi.create(data);
      onSave();
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to create template');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-primary shadow-2xl p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-text-primary">Create Local Template</h2>
          <button onClick={onClose} className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover">
            <X size={16} />
          </button>
        </div>
        <p className="text-xs text-text-muted mb-4">
          This template is private to this agent and auto-assigned to it.
        </p>
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. SSH brute-force"
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Service Type</label>
            <input value={serviceType} onChange={e => setServiceType(e.target.value)} placeholder="e.g. ssh, rdp, ftp"
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Log Path</label>
            <input value={logPath} onChange={e => setLogPath(e.target.value)} placeholder="/var/log/auth.log"
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">Threshold (failures)</label>
              <input type="number" min={1} value={threshold} onChange={e => setThreshold(e.target.value)}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">Window (s)</label>
              <input type="number" min={60} value={windowSeconds} onChange={e => setWindowSeconds(e.target.value)}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Mode</label>
            <div className="flex gap-1 rounded-md border border-border bg-bg-tertiary p-1">
              {(['ban', 'track'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    mode === m
                      ? m === 'ban' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {m === 'ban' ? '🔴 Ban' : '👁 Track only'}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-muted">
              {mode === 'ban' ? 'Triggers auto-bans when threshold is exceeded.' : 'Logs events but never triggers bans.'}
            </p>
          </div>
          <div className="flex gap-2 pt-2">
            <button type="submit" disabled={saving}
              className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create template'}
            </button>
            <button type="button" onClick={onClose}
              className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── TemplatesSection ──────────────────────────────────────────────────────────

function TemplatesSection({ deviceId }: { deviceId: number }) {
  const [localTemplates, setLocalTemplates] = useState<ServiceTemplate[]>([]);
  const [localLoading,   setLocalLoading]   = useState(true);
  const [localExpanded,  setLocalExpanded]  = useState(true);
  const [showCreate,     setShowCreate]     = useState(false);
  const [deletingLocal,  setDeletingLocal]  = useState<ServiceTemplate | null>(null);
  const [deleteLoading,  setDeleteLoading]  = useState(false);

  const loadLocal = useCallback(async () => {
    setLocalLoading(true);
    try {
      const local = await serviceTemplatesApi.listLocal('agent', deviceId);
      setLocalTemplates(local);
    } finally {
      setLocalLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { void loadLocal(); }, [loadLocal]);

  async function handleDeleteLocal() {
    if (!deletingLocal) return;
    setDeleteLoading(true);
    try {
      await serviceTemplatesApi.delete(deletingLocal.id);
      setDeletingLocal(null);
      void loadLocal();
    } catch {
      setDeletingLocal(null);
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <>
      {/* Global service templates — opt-out model */}
      <ServiceTemplatesPanel
        scope="device"
        scopeId={deviceId}
        onCreateLocal={() => setShowCreate(true)}
      />

      {/* Local templates owned by this agent */}
      {(localTemplates.length > 0 || localLoading) && (
        <div className="mt-4 rounded-lg border border-border bg-bg-secondary">
          <div
            className="px-4 py-3 border-b border-border flex items-center justify-between cursor-pointer select-none"
            onClick={() => setLocalExpanded(v => !v)}
          >
            <div className="flex items-center gap-2">
              {localExpanded
                ? <ChevronUp size={14} className="text-text-muted" />
                : <ChevronDown size={14} className="text-text-muted" />}
              <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                Local Templates
              </h2>
              {!localLoading && (
                <span className="text-xs text-text-muted">{localTemplates.length} local</span>
              )}
            </div>
            <button
              onClick={e => { e.stopPropagation(); void loadLocal(); }}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Refresh"
            >
              <RefreshCw size={12} className={localLoading ? 'animate-spin' : ''} />
            </button>
          </div>

          {localExpanded && (
            <div className="divide-y divide-border">
              {localLoading ? (
                <div className="py-6 text-center text-sm text-text-muted">Loading…</div>
              ) : (
                localTemplates.map(tpl => (
                  <div key={tpl.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="w-2 h-2 rounded-full flex-shrink-0 bg-indigo-400" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary">{tpl.name}</span>
                        <span className="inline-flex items-center rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono text-text-muted border border-border">
                          {tpl.serviceType}
                        </span>
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/15 text-indigo-400">
                          local
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-text-muted">
                        Threshold: {tpl.threshold} / {tpl.windowSeconds}s
                        {tpl.defaultLogPath && (
                          <span className="ml-3 font-mono truncate max-w-[220px]" title={tpl.defaultLogPath}>
                            {tpl.defaultLogPath}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setDeletingLocal(tpl)}
                      title="Delete this local template"
                      className="p-1.5 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {showCreate && (
        <LocalTemplateModal
          deviceId={deviceId}
          onSave={() => { setShowCreate(false); void loadLocal(); }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {deletingLocal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-bg-primary shadow-2xl p-6">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={18} className="text-status-down shrink-0 mt-0.5" />
              <div>
                <h2 className="text-base font-semibold text-text-primary">Delete local template</h2>
                <p className="text-sm text-text-muted mt-1">
                  Permanently delete <strong className="text-text-primary">{deletingLocal.name}</strong>?
                  This template belongs to this agent only and will be removed completely.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button disabled={deleteLoading} onClick={() => void handleDeleteLocal()}
                className="flex-1 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleteLoading ? 'Deleting…' : 'Delete template'}
              </button>
              <button onClick={() => setDeletingLocal(null)}
                className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
type TabId = 'overview' | 'starmap';

export function AgentDetailPage() {
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const devId = deviceId ? parseInt(deviceId, 10) : null;

  // Device info
  const [device,        setDevice]        = useState<AgentDevice | null>(null);
  const [deviceLoading, setDeviceLoading] = useState(true);

  // Active tab
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  // Paginated events
  const [events,        setEvents]        = useState<IpEventRow[]>([]);
  const [total,         setTotal]         = useState(0);
  const [page,          setPage]          = useState(1);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Filters
  const [serviceFilter, setServiceFilter] = useState('');
  const [typeFilter,    setTypeFilter]    = useState('');

  // Summary events (7-day window)
  const [summaryEvents,  setSummaryEvents]  = useState<IpEventRow[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(true);

  // IP drawer
  const [selectedIp, setSelectedIp] = useState<string | null>(null);

  // Inline rename
  const [renaming,      setRenaming]      = useState(false);
  const [renameValue,   setRenameValue]   = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Cross-app companion links (resolved once after device loads)
  const [obliviewAgentUrl, setObliviewAgentUrl]   = useState<string | null>(null);
  const [obliviewSsoEnabled, setObliviewSsoEnabled] = useState(false);
  const [oblimapAgentUrl, setOblimapAgentUrl]     = useState<string | null>(null);
  const [oblimapSsoEnabled, setOblimapSsoEnabled] = useState(false);
  const [oblianceAgentUrl, setOblianceAgentUrl]   = useState<string | null>(null);
  const [oblianceSsoEnabled, setOblianceSsoEnabled] = useState(false);
  const [ssoSwitching, setSsoSwitching] = useState(false);

  // In-flight bans / whitelists
  const [banningIps,      setBanningIps]      = useState(new Set<string>());
  const [whitelistingIps, setWhitelistingIps] = useState(new Set<string>());

  // ── Load device ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!devId) return;
    agentApi.getDeviceById(devId)
      .then(d => setDevice(d))
      .finally(() => setDeviceLoading(false));
  }, [devId]);

  // ── Resolve cross-app links for this agent ──────────────────────────────────
  useEffect(() => {
    if (!device?.uuid) return;
    appConfigApi.getObliviewAgentLink(device.uuid).then(url => setObliviewAgentUrl(url)).catch(() => {});
    appConfigApi.getOblimapAgentLink(device.uuid).then(url => setOblimapAgentUrl(url)).catch(() => {});
    appConfigApi.getOblianceAgentLink(device.uuid).then(url => setOblianceAgentUrl(url)).catch(() => {});
    appConfigApi.getConfig()
      .then(cfg => {
        setObliviewSsoEnabled(cfg.enable_foreign_sso ?? false);
        setOblimapSsoEnabled(cfg.enable_oblimap_sso ?? false);
        setOblianceSsoEnabled(cfg.enable_obliance_sso ?? false);
      })
      .catch(() => {});
  }, [device?.uuid]);

  /** Generic SSO redirect to another app's agent page */
  const handleAgentSwitch = useCallback(async (targetUrl: string, ssoEnabled: boolean, source: string) => {
    if (!ssoEnabled) { window.location.href = targetUrl; return; }
    setSsoSwitching(true);
    try {
      const res = await fetch('/api/sso/generate-token', { method: 'POST', credentials: 'include' });
      const body = await res.json() as { success: boolean; data?: { token: string } };
      if (body.success && body.data?.token) {
        const agentUrl = new URL(targetUrl);
        const from     = encodeURIComponent(window.location.origin);
        const token    = encodeURIComponent(body.data.token);
        const redirect = encodeURIComponent(agentUrl.pathname + agentUrl.search);
        window.location.href = `${agentUrl.origin}/auth/foreign?token=${token}&from=${from}&source=${source}&redirect=${redirect}`;
      } else { window.location.href = targetUrl; }
    } catch { window.location.href = targetUrl; }
    finally { setSsoSwitching(false); }
  }, []);

  const handleObliviewAgentClick  = useCallback(() => obliviewAgentUrl  ? handleAgentSwitch(obliviewAgentUrl,  obliviewSsoEnabled,  'obliguard') : Promise.resolve(), [obliviewAgentUrl,  obliviewSsoEnabled,  handleAgentSwitch]);
  const handleOblimapAgentClick   = useCallback(() => oblimapAgentUrl   ? handleAgentSwitch(oblimapAgentUrl,   oblimapSsoEnabled,   'obliguard') : Promise.resolve(), [oblimapAgentUrl,   oblimapSsoEnabled,   handleAgentSwitch]);
  const handleOblianceAgentClick  = useCallback(() => oblianceAgentUrl  ? handleAgentSwitch(oblianceAgentUrl,  oblianceSsoEnabled,  'obliguard') : Promise.resolve(), [oblianceAgentUrl,  oblianceSsoEnabled,  handleAgentSwitch]);

  // ── Load paginated events ───────────────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    if (!devId) return;
    setEventsLoading(true);
    try {
      const params: Record<string, unknown> = { deviceId: devId, page, pageSize: PAGE_SIZE };
      if (serviceFilter) params.service = serviceFilter;
      if (typeFilter)    params.eventType = typeFilter;
      const res = await apiClient.get('/ip-events', { params });
      setEvents((res.data.data ?? []) as IpEventRow[]);
      setTotal(res.data.total ?? 0);
    } finally {
      setEventsLoading(false);
    }
  }, [devId, page, serviceFilter, typeFilter]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);
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

  // ── Today's stats ───────────────────────────────────────────────────────────
  const todayStart = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString();
  }, []);

  const todayEvents    = useMemo(() => summaryEvents.filter(e => e.timestamp >= todayStart),  [summaryEvents, todayStart]);
  const todayFailures  = useMemo(() => todayEvents.filter(e => e.event_type === 'auth_failure').length, [todayEvents]);
  const uniqueIpCount  = useMemo(() => new Set(summaryEvents.map(e => e.ip)).size, [summaryEvents]);
  const topService     = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of summaryEvents) counts.set(ev.service, (counts.get(ev.service) ?? 0) + 1);
    let top = '—'; let max = 0;
    for (const [svc, cnt] of counts) { if (cnt > max) { max = cnt; top = svc; } }
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
    } catch { alert(`Failed to ban ${ip}`); } finally {
      setBanningIps(prev => { const s = new Set(prev); s.delete(ip); return s; });
    }
  }, []);

  // ── Quick whitelist ─────────────────────────────────────────────────────────
  const handleWhitelist = useCallback(async (ip: string) => {
    if (!confirm(`Add ${ip} to the whitelist?`)) return;
    setWhitelistingIps(prev => new Set(prev).add(ip));
    try {
      await whitelistApi.create({ ip });
    } catch { alert(`Failed to whitelist ${ip}`); } finally {
      setWhitelistingIps(prev => { const s = new Set(prev); s.delete(ip); return s; });
    }
  }, []);

  // ── Inline rename ───────────────────────────────────────────────────────────
  async function saveRename() {
    if (!device) return;
    setRenaming(false);
    const trimmed = renameValue.trim();
    if (trimmed === (device.name ?? '')) return;
    try {
      const updated = await agentApi.updateDevice(device.id, { name: trimmed || null });
      setDevice(updated);
    } catch { /* ignore */ }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Loading / not found ─────────────────────────────────────────────────────
  if (deviceLoading) {
    return <div className="flex items-center justify-center h-64"><Spinner size={32} /></div>;
  }
  if (!device) {
    return (
      <div className="p-6 text-center text-text-muted">
        <p>Agent not found.</p>
        <button onClick={() => navigate(-1)} className="mt-3 text-accent hover:underline text-sm">Go back</button>
      </div>
    );
  }

  const displayName = device.name ?? device.hostname;
  const osLabel     = device.osInfo
    ? [device.osInfo.distro ?? device.osInfo.platform, device.osInfo.release].filter(Boolean).join(' ')
    : null;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="px-6 pt-6 flex items-start gap-3 flex-shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="mt-0.5 rounded p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors flex-shrink-0"
        >
          <ArrowLeft size={18} />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isOnline ? 'bg-status-up' : 'bg-status-down'}`} />
            {renaming ? (
              <form onSubmit={e => { e.preventDefault(); void saveRename(); }}>
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={() => void saveRename()}
                  onKeyDown={e => { if (e.key === 'Escape') setRenaming(false); }}
                  autoFocus
                  className="text-xl font-semibold bg-bg-secondary border border-accent/60 rounded px-2 py-0.5 text-text-primary focus:outline-none focus:border-accent min-w-[8rem]"
                />
              </form>
            ) : (
              <button
                type="button"
                onClick={() => { setRenameValue(device.name ?? ''); setRenaming(true); }}
                className="group flex items-center gap-1.5"
              >
                <h1 className="text-xl font-semibold text-text-primary">{displayName}</h1>
                <Pencil size={14} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
              </button>
            )}
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
              isOnline ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
            }`}>
              {isOnline ? 'ONLINE' : 'OFFLINE'}
            </span>
            {device.agentVersion && (
              <span className="text-xs text-text-muted font-mono">v{device.agentVersion}</span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
            {device.hostname !== displayName && (
              <span className="flex items-center gap-1"><Server size={11} className="text-text-muted" />{device.hostname}</span>
            )}
            {osLabel && (
              <span className="flex items-center gap-1">
                <Cpu size={11} className="text-text-muted" />
                {osLabel}{device.osInfo?.arch ? ` (${device.osInfo.arch})` : ''}
              </span>
            )}
            {device.ip && (
              <span className="flex items-center gap-1 font-mono">
                <Wifi size={11} className="text-text-muted" />{device.ip}
              </span>
            )}
            <span className="text-text-muted">Last seen: {new Date(device.updatedAt).toLocaleString()}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {obliviewAgentUrl && (
            <button
              type="button"
              onClick={() => { void handleObliviewAgentClick(); }}
              disabled={ssoSwitching}
              title="Open this agent in Obliview"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-[#58a6ff] border border-[#1d4ed8]/40 bg-[#0c1929]/50 hover:bg-[#0c1929]/70 hover:border-[#3b82f6] transition-colors disabled:opacity-60"
            >
              <ArrowLeftRight size={12} className={ssoSwitching ? 'animate-pulse' : ''} />
              Obliview
            </button>
          )}
          {oblimapAgentUrl && (
            <button
              type="button"
              onClick={() => { void handleOblimapAgentClick(); }}
              disabled={ssoSwitching}
              title="Open this agent in Oblimap"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-[#10b981] border border-[#047857]/40 bg-[#022c22]/50 hover:bg-[#022c22]/70 hover:border-[#10b981] transition-colors disabled:opacity-60"
            >
              <ArrowLeftRight size={12} className={ssoSwitching ? 'animate-pulse' : ''} />
              Oblimap
            </button>
          )}
          {oblianceAgentUrl && (
            <button
              type="button"
              onClick={() => { void handleOblianceAgentClick(); }}
              disabled={ssoSwitching}
              title="Open this agent in Obliance"
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-[#a78bfa] border border-[#7c3aed]/40 bg-[#2e1065]/50 hover:bg-[#2e1065]/70 hover:border-[#a78bfa] transition-colors disabled:opacity-60"
            >
              <ArrowLeftRight size={12} className={ssoSwitching ? 'animate-pulse' : ''} />
              Obliance
            </button>
          )}
          <button
            onClick={() => { void loadEvents(); void loadSummary(); }}
            className="rounded p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} className={eventsLoading || summaryLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Stats strip ──────────────────────────────────────────────────── */}
      <div className="px-6 pt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 flex-shrink-0">
        <MiniStat label="Events Today"   value={summaryLoading ? '…' : todayEvents.length}  colorClass="text-accent" />
        <MiniStat label="Failures Today" value={summaryLoading ? '…' : todayFailures}        colorClass={todayFailures > 0 ? 'text-status-down' : 'text-status-up'} />
        <MiniStat label="Unique IPs (7d)" value={summaryLoading ? '…' : uniqueIpCount}       colorClass="text-orange-400" />
        <MiniStat label="Top Service"    value={summaryLoading ? '…' : topService}            colorClass="text-text-primary" />
      </div>

      {/* ── Body: tab content + right icon sidebar ────────────────────────── */}
      <div className="flex mt-6 border-t border-border">

        {/* ── Tab content ─────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0">
          {activeTab === 'overview' ? (
            <div className="p-6 space-y-6">

              {/* Events table + IP Summary */}
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

                {/* Events table (2 cols) */}
                <div className="xl:col-span-2 rounded-lg border border-border bg-bg-secondary flex flex-col">
                  <div className="px-4 py-3 border-b border-border flex items-center gap-3 flex-wrap">
                    <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide flex-shrink-0">
                      Connection Events
                    </h2>
                    <span className="text-xs text-text-muted ml-auto">{total.toLocaleString()} total</span>
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

                  <div className="overflow-x-auto flex-1 min-h-[200px]">
                    {eventsLoading ? (
                      <div className="flex items-center justify-center py-16"><Spinner /></div>
                    ) : events.length === 0 ? (
                      <div className="py-12 text-center text-sm text-text-muted">No events found</div>
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
                              <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">{relativeTime(ev.timestamp)}</td>
                              <td className="px-4 py-2.5">
                                <button onClick={() => setSelectedIp(ev.ip)} className="font-mono text-accent hover:underline">
                                  {ev.ip}
                                </button>
                              </td>
                              <td className="px-4 py-2.5 text-text-secondary">{ev.service}</td>
                              <td className="px-4 py-2.5"><EventTypeBadge type={ev.event_type} /></td>
                              <td className="px-4 py-2.5 font-mono text-text-secondary">
                                {ev.username ?? <span className="text-text-muted">—</span>}
                              </td>
                              <td className="px-4 py-2.5 max-w-[160px]">
                                {ev.raw_log ? (
                                  <span title={ev.raw_log} className="truncate block text-text-muted cursor-help">
                                    {ev.raw_log.length > 48 ? `${ev.raw_log.slice(0, 48)}…` : ev.raw_log}
                                  </span>
                                ) : <span className="text-text-muted">—</span>}
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

                  {totalPages > 1 && (
                    <div className="px-4 py-2.5 border-t border-border flex items-center justify-between text-xs text-text-muted">
                      <span>Page {page} of {totalPages} ({total.toLocaleString()} events)</span>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                          className="rounded p-1.5 hover:bg-bg-hover disabled:opacity-30 transition-colors"
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                          className="rounded p-1.5 hover:bg-bg-hover disabled:opacity-30 transition-colors"
                        >
                          <ChevronRight size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* IP Summary panel (1 col) */}
                <div className="rounded-lg border border-border bg-bg-secondary flex flex-col">
                  <div className="px-4 py-3 border-b border-border flex-shrink-0 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">Top IPs (7 days)</h2>
                    {!summaryLoading && <span className="text-xs text-text-muted">{ipSummary.length} unique</span>}
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {summaryLoading ? (
                      <div className="flex items-center justify-center py-12"><Spinner size={20} /></div>
                    ) : ipSummary.length === 0 ? (
                      <div className="py-10 text-center text-sm text-text-muted">No activity in the last 7 days</div>
                    ) : (
                      <div className="divide-y divide-border">
                        {ipSummary.slice(0, 25).map(item => (
                          <div key={item.ip} className="px-4 py-3 hover:bg-bg-hover transition-colors">
                            <div className="flex items-start justify-between gap-2">
                              <button
                                onClick={() => setSelectedIp(item.ip)}
                                className="font-mono text-sm text-accent hover:underline text-left min-w-0 truncate"
                              >
                                {item.ip}
                              </button>
                              <div className="flex gap-0.5 flex-shrink-0">
                                <button onClick={() => void handleBan(item.ip)} disabled={banningIps.has(item.ip)} title="Quick ban"
                                  className="rounded p-1 text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                                >
                                  <ShieldOff size={12} />
                                </button>
                                <button onClick={() => void handleWhitelist(item.ip)} disabled={whitelistingIps.has(item.ip)} title="Whitelist"
                                  className="rounded p-1 text-text-muted hover:text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-40"
                                >
                                  <ShieldCheck size={12} />
                                </button>
                                <button onClick={() => setSelectedIp(item.ip)} title="View all events"
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
                                <span className="truncate max-w-[100px]" title={item.services.join(', ')}>
                                  {item.services.join(', ')}
                                </span>
                              )}
                              <span title={`First: ${item.firstSeen}`}>{relativeTime(item.lastSeen)}</span>
                            </div>
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

              {/* Templates section */}
              <TemplatesSection deviceId={devId!} />

              {/* Notification Types — per-agent overrides */}
              <NotificationTypesPanel
                config={device.notificationTypes ?? null}
                scope="device"
                onSave={async (notifTypes: NotificationTypeConfig | null) => {
                  const updated = await agentApi.updateDevice(device.id, { notificationTypes: notifTypes });
                  setDevice(updated);
                }}
              />
            </div>

          ) : (
            /* ── Star Map tab ─────────────────────────────────────────────── */
            <div className="p-6" style={{ height: 'max(480px, calc(100vh - 340px))' }}>
              <div className="h-full rounded-lg border border-border bg-bg-secondary overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                  <Network size={14} className="text-accent" />
                  <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                    Star Map — {displayName}
                  </h2>
                  <span className="text-xs text-text-muted ml-auto">
                    {summaryLoading ? '…' : `${uniqueIpCount} IPs (7d)`}
                  </span>
                </div>
                <div className="h-[calc(100%-45px)]">
                  <AgentMiniMap
                    deviceId={devId!}
                    summaryEvents={summaryEvents}
                    onSelectIp={setSelectedIp}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Right icon sidebar ────────────────────────────────────────────── */}
        <div className="w-14 flex-shrink-0 border-l border-border bg-bg-secondary flex flex-col items-center py-4 gap-1">
          <button
            onClick={() => setActiveTab('overview')}
            title="Overview"
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
              activeTab === 'overview'
                ? 'bg-accent/15 text-accent'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
            }`}
          >
            <LayoutGrid size={18} />
          </button>
          <button
            onClick={() => setActiveTab('starmap')}
            title="Star Map"
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
              activeTab === 'starmap'
                ? 'bg-accent/15 text-accent'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
            }`}
          >
            <Network size={18} />
          </button>
        </div>
      </div>

      {/* ── Settings panel — always visible at bottom ─────────────────────── */}
      <div className="border-t border-border bg-bg-secondary flex-shrink-0">
        <AgentSettingsPanel device={device} onUpdate={d => setDevice(d)} />
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
