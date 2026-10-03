import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { anonIp } from '@/utils/anonymize';
import { useAgentIpEvents, type IpEventRow } from './parts';

// ── AgentMiniMap (star map of the agent's IPs over the last 7 days) ───────────

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

const MINI_EVENT_COLORS: Record<string, string> = {
  auth_success: '#22d3ee',
  auth_failure: '#f97316',
  ban:          '#ef4444',
};

/** Most particles in flight at once. */
const MAX_PARTICLES = 60;

interface AgentMiniMapProps {
  deviceId: number;
  summaryEvents: IpEventRow[];
  onSelectIp: (ip: string) => void;
}

export function AgentMiniMap({ deviceId, summaryEvents, onSelectIp }: AgentMiniMapProps) {
  const { t } = useTranslation();
  const canvasRef     = useRef<HTMLCanvasElement>(null);
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

  // ── Live events: one particle per row of this agent (ip:events) ──────────
  useAgentIpEvents(deviceId, (rows) => {
    const { cx, cy } = sizeRef.current;
    for (const ev of rows) {
      const node  = layoutRef.current.find(n => n.ip === ev.ip);
      const sx    = node ? node.x : cx + (Math.random() - 0.5) * 250;
      const sy    = node ? node.y : cy + (Math.random() - 0.5) * 250;
      const color = MINI_EVENT_COLORS[ev.eventType] ?? '#64748b';
      particlesRef.current.push({ sx, sy, tx: cx, ty: cy, t: 0, color });
    }
    if (particlesRef.current.length > MAX_PARTICLES) {
      particlesRef.current.splice(0, particlesRef.current.length - MAX_PARTICLES);
    }
  });

  // ── Mouse interactions ────────────────────────────────────────────────────
  function handleMouseMove(e: MouseEvent<HTMLCanvasElement>) {
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

  function handleClick(e: MouseEvent<HTMLCanvasElement>) {
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
          <p className="font-mono font-semibold text-text-primary">{anonIp(tooltip.ip)}</p>
          {(() => {
            const n = layoutRef.current.find(x => x.ip === tooltip.ip);
            if (!n) return null;
            return (
              <p className="text-text-muted mt-0.5">
                {t('agentDetail.starMap.events', { defaultValue: '{{count}} events', count: n.totalEvents })} · <span className="text-red-400">{t('agentDetail.starMap.fails', { defaultValue: '{{count}} fails', count: n.failures })}</span>
              </p>
            );
          })()}
        </div>
      )}
      {summaryEvents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-sm text-text-muted">{t('agentDetail.starMap.empty', { defaultValue: 'No IP activity in the last 7 days' })}</p>
        </div>
      )}
    </div>
  );
}
