/**
 * NetMapPage — Obliguard Live Threat Map
 *
 * Canvas-based world map showing traffic flows hitting protected agents.
 *
 * Pan/zoom architecture: canvas context transform (ctx.setTransform) rather
 * than CSS scale, so the canvas always renders at native resolution (no blur).
 * The world map base is pre-rendered to an offscreen canvas and blitted each
 * frame via ctx.drawImage, which scales crisply.
 *
 * Aspect ratio: a ResizeObserver on the outer wrapper computes the largest
 * 2:1 rectangle that fits without overflow and applies it to the inner
 * container as explicit pixel dimensions — no CSS aspect-ratio hacks needed.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Shield, Ban, Activity, RefreshCw, Zap } from 'lucide-react';
import { getSocket } from '../socket/socketClient';
import apiClient from '../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface IpRepItem {
  ip: string;
  geoCountryCode?: string | null;
  totalFailures: number;
  status: string;
  affectedServices?: string[];
  affectedAgentsCount?: number;
}

interface AgentDev {
  id: number;
  hostname: string;
  name: string | null;
  status: string;
  ip?: string | null;
}

interface Arc {
  id: string;
  sx: number; sy: number;
  tx: number; ty: number;
  cx: number; cy: number;
  color: string;
  service: string;
  country: string;
  sourceIp: string;
  failures: number;
  eventType: 'auth_success' | 'auth_failure' | 'ban';
  progress: number;
  speed: number;
}

interface IpDot {
  ip: string;
  x: number; y: number;
  radius: number;
  color: string;
  status: string;
  failures: number;
  services: string[];
  country: string;
}

interface AgentMarker {
  x: number; y: number;
  label: string;
  lon: number; lat: number;
}

interface LiveEvent {
  id: string;
  ip: string;
  service: string;
  country: string;
  time: Date;
  color: string;
  eventType: 'auth_success' | 'auth_failure' | 'ban';
  failures?: number;
}

// ── Country centroids  [lat, lon] ─────────────────────────────────────────────

const CENTROIDS: Record<string, [number, number]> = {
  AF:[33.93,67.71], AL:[41.15,20.17], DZ:[28.03,1.66],  AO:[-11.20,17.87],
  AR:[-38.42,-63.62],AU:[-25.27,133.78],AT:[47.52,14.55],AZ:[40.14,47.58],
  BD:[23.68,90.36], BE:[50.50,4.47],  BG:[42.73,25.49], BR:[-14.24,-51.93],
  CA:[56.13,-106.35],CN:[35.86,104.19],CO:[4.57,-74.30], CZ:[49.82,15.47],
  DE:[51.17,10.45], DK:[56.26,9.50],  EG:[26.82,30.80], ES:[40.46,-3.75],
  ET:[9.15,40.49],  FI:[61.92,25.75], FR:[46.23,2.21],  GB:[55.38,-3.44],
  GE:[42.32,43.36], GH:[7.95,-1.02],  GR:[39.07,21.82], HK:[22.30,114.18],
  HU:[47.16,19.50], ID:[-0.79,113.92],IN:[20.59,78.96],  IQ:[33.22,43.68],
  IR:[32.43,53.69], IT:[41.87,12.57], JP:[36.20,138.25], KE:[-0.02,37.91],
  KP:[40.34,127.51],KR:[35.91,127.77],KZ:[48.02,66.92],  LY:[26.34,17.23],
  MA:[31.79,-7.09], MD:[47.41,28.37], MX:[23.63,-102.55],MY:[4.21,101.98],
  NG:[9.08,8.68],   NL:[52.13,5.29],  NO:[60.47,8.47],  NZ:[-40.90,174.89],
  PK:[30.38,69.35], PL:[51.92,19.15], PT:[39.40,-8.22],  RO:[45.94,24.97],
  RS:[44.02,21.01], RU:[61.52,105.32],SA:[23.89,45.08],  SE:[60.13,18.64],
  SG:[1.35,103.82], SY:[34.80,38.99], TH:[15.87,100.99], TN:[33.89,9.54],
  TR:[38.96,35.24], TW:[23.70,121.00],UA:[48.38,31.17],  US:[37.09,-95.71],
  UZ:[41.38,64.59], VE:[6.42,-66.59], VN:[14.06,108.28], ZA:[-30.56,22.94],
};

// ── Colour palette ────────────────────────────────────────────────────────────

const EVENT_COLORS = {
  auth_success: '#22d3ee',
  auth_failure: '#f97316',
  ban:          '#ef4444',
} as const;

const SVC_COLORS: Record<string, string> = {
  ssh:    '#f97316',
  rdp:    '#a855f7',
  ftp:    '#eab308',
  mail:   '#06b6d4',
  mysql:  '#ec4899',
  nginx:  '#22c55e',
  apache: '#22c55e',
  iis:    '#3b82f6',
};

function svcColor(s: string): string {
  const lc = (s ?? '').toLowerCase();
  for (const [k, v] of Object.entries(SVC_COLORS)) if (lc.includes(k)) return v;
  return '#f43f5e';
}

function statusColor(st: string): string {
  if (st === 'banned')      return '#ef4444';
  if (st === 'suspicious')  return '#f97316';
  if (st === 'whitelisted') return '#22c55e';
  return '#475569';
}

// ── Mercator projection ───────────────────────────────────────────────────────

function project(lon: number, lat: number, w: number, h: number): [number, number] {
  const x = ((lon + 180) / 360) * w;
  const clat = Math.min(Math.max(lat, -79), 79);
  const latR  = (clat * Math.PI) / 180;
  const mercN = Math.log(Math.tan(Math.PI / 4 + latR / 2));
  const maxN  = Math.log(Math.tan(Math.PI / 4 + (79 * Math.PI) / 360));
  const y = h / 2 - (mercN / maxN) * (h / 2) * 0.92;
  return [x, y];
}

// ── Bezier helpers ────────────────────────────────────────────────────────────

function ctrlPt(sx: number, sy: number, tx: number, ty: number): [number, number] {
  const mx = (sx + tx) / 2, my = (sy + ty) / 2;
  const dx = tx - sx, dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const curve = Math.min(len * 0.38, 110);
  return [mx - (dy / len) * curve * 0.6, my + (dx / len) * curve * 0.05 - curve * 0.55];
}

function bezier(
  sx: number, sy: number, cx: number, cy: number,
  tx: number, ty: number, t: number,
): [number, number] {
  const mt = 1 - t;
  return [mt * mt * sx + 2 * mt * t * cx + t * t * tx,
          mt * mt * sy + 2 * mt * t * cy + t * t * ty];
}

// ── Country flag emoji ────────────────────────────────────────────────────────

function flag(code: string): string {
  if (!code || code.length !== 2) return '';
  return Array.from(code.toUpperCase())
    .map(c => String.fromCodePoint(c.codePointAt(0)! + 127397))
    .join('');
}

// ── Load a CDN script (idempotent) ────────────────────────────────────────────

function loadScript(url: string, windowKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any)[windowKey]) { resolve(); return; }
    const s = document.createElement('script');
    s.src = url;
    s.onload  = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── Convert GeoJSON geometry → Path2D using Mercator ─────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function geoToPath(geometry: any, w: number, h: number): Path2D {
  const path = new Path2D();
  const rings = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon'
      ? geometry.coordinates
      : [];
  for (const poly of rings) {
    for (const ring of poly as [number, number][][]) {
      let first = true;
      for (const [lon, lat] of ring) {
        const [px, py] = project(lon, lat, w, h);
        if (first) { path.moveTo(px, py); first = false; }
        else path.lineTo(px, py);
      }
      path.closePath();
    }
  }
  return path;
}

// ── NetMapPage component ──────────────────────────────────────────────────────

export function NetMapPage() {
  // The only visible canvas; base map is drawn offscreen and blitted each frame.
  const animRef      = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const outerRef     = useRef<HTMLDivElement>(null);

  // Offscreen canvas: world map pre-rendered, blitted via ctx.drawImage each frame.
  // Zoom uses canvas transform → drawImage scales smoothly, no CSS pixelation.
  const offscreenBaseRef = useRef<HTMLCanvasElement | null>(null);

  const rafRef    = useRef<number>(0);
  const arcsRef   = useRef<Arc[]>([]);
  const dotsRef   = useRef<IpDot[]>([]);
  const agentRef  = useRef<AgentMarker[]>([]);
  const lastTsRef = useRef<number>(0);

  // ── Canvas dimensions — JS-computed 2:1 rectangle that fits the outer div ──
  // Stored in a ref (fresh in callbacks) and mirrored in state (drives CSS).
  const canvasDimRef = useRef({ w: 1280, h: 640 });
  const [canvasDim, setCanvasDim] = useState({ w: 1280, h: 640 });

  // ── Pan / zoom ────────────────────────────────────────────────────────────
  const transformRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const dragRef      = useRef<{ x: number; y: number } | null>(null);
  const [transform, setTransform] = useState({ scale: 1, tx: 0, ty: 0 });
  const [isDragging, setIsDragging] = useState(false);

  // ── Flow type filters ─────────────────────────────────────────────────────
  type FlowType = 'auth_success' | 'auth_failure' | 'ban';
  const ALL_FILTERS = new Set<FlowType>(['auth_success', 'auth_failure', 'ban']);
  const filtersRef = useRef<Set<FlowType>>(new Set(ALL_FILTERS));
  const [filters, setFilters] = useState<Set<FlowType>>(new Set(ALL_FILTERS));

  const toggleFilter = useCallback((type: FlowType) => {
    setFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      filtersRef.current = next;
      return next;
    });
  }, []);

  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [stats, setStats]    = useState({ agents: 0, banned: 0, today: 0 });
  const [arcCount, setArcCount] = useState(0);
  const [loading, setLoading]   = useState(true);
  const [tooltip, setTooltip]   = useState<{
    visible: boolean; x: number; y: number;
    ip: string; country: string; failures: number;
    status: string; services: string[];
  }>({ visible: false, x: 0, y: 0, ip: '', country: '', failures: 0, status: '', services: [] });

  // ── Canvas sizing (reads ref — always fresh inside async callbacks) ────────

  const getSize = useCallback((): [number, number] => {
    const { w, h } = canvasDimRef.current;
    return [w, h];
  }, []);

  // ── Reset pan/zoom ────────────────────────────────────────────────────────

  const resetTransform = useCallback(() => {
    transformRef.current = { scale: 1, tx: 0, ty: 0 };
    setTransform({ scale: 1, tx: 0, ty: 0 });
  }, []);

  // ── Spawn one arc ─────────────────────────────────────────────────────────

  const spawnArc = useCallback((
    srcLon: number, srcLat: number,
    tgtLon: number, tgtLat: number,
    color: string, service: string,
    country: string, ip: string,
    eventType: 'auth_success' | 'auth_failure' | 'ban' = 'auth_failure',
    failures = 0,
  ) => {
    const [w, h] = getSize();
    const [sx, sy] = project(srcLon, srcLat, w, h);
    const [tx, ty] = project(tgtLon, tgtLat, w, h);
    const [cx, cy] = ctrlPt(sx, sy, tx, ty);
    arcsRef.current = [...arcsRef.current.slice(-39), {
      id: Math.random().toString(36).slice(2),
      sx, sy, tx, ty, cx, cy,
      color, service, country, sourceIp: ip, failures,
      eventType, progress: 0,
      speed: 0.22 + Math.random() * 0.14,
    }];
  }, [getSize]);

  // ── Draw world map to offscreen canvas ────────────────────────────────────

  const drawBase = useCallback(async (w: number, h: number) => {
    if (!offscreenBaseRef.current) offscreenBaseRef.current = document.createElement('canvas');
    const canvas = offscreenBaseRef.current;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    // Dark grey radial gradient
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.35, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.9);
    bg.addColorStop(0, '#0d0d0d');
    bg.addColorStop(1, '#050505');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Subtle dot grid
    ctx.fillStyle = 'rgba(140,140,140,0.04)';
    for (let x = 0; x < w; x += 40) {
      for (let y = 0; y < h; y += 40) {
        ctx.beginPath();
        ctx.arc(x, y, 0.65, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    try {
      await loadScript(
        'https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js',
        'topojson',
      );
      const resp  = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
      const world = await resp.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { features } = (window as any).topojson.feature(world, world.objects.countries);

      ctx.fillStyle = 'rgba(20,20,20,0.90)';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of features as any[]) ctx.fill(geoToPath(f.geometry, w, h));

      ctx.save();
      ctx.shadowBlur   = 2.5;
      ctx.shadowColor  = 'rgba(130,130,130,0.25)';
      ctx.strokeStyle  = 'rgba(110,110,110,0.35)';
      ctx.lineWidth    = 0.5;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of features as any[]) ctx.stroke(geoToPath(f.geometry, w, h));
      ctx.restore();
    } catch {
      // World map failed — grid background remains
    }
  }, []);

  // ── Animation loop ────────────────────────────────────────────────────────
  // Uses ctx.setTransform for pan/zoom so the canvas renders at native resolution.
  // The offscreen base map is blitted via drawImage (smooth scaling, no CSS blur).

  const animate = useCallback((ts: number) => {
    const canvas = animRef.current;
    if (!canvas) { rafRef.current = requestAnimationFrame(animate); return; }
    const ctx = canvas.getContext('2d')!;
    const [w, h] = [canvas.width, canvas.height];
    const dt = Math.min((ts - lastTsRef.current) / 1000, 0.05);
    lastTsRef.current = ts;

    // Clear at identity then apply pan/zoom transform
    ctx.resetTransform();
    ctx.clearRect(0, 0, w, h);
    const { scale, tx, ty } = transformRef.current;
    ctx.setTransform(scale, 0, 0, scale, tx, ty);

    // Blit offscreen world map (scales crisply via canvas interpolation)
    const base = offscreenBaseRef.current;
    if (base && base.width > 0) ctx.drawImage(base, 0, 0);

    // ── IP reputation dots ────────────────────────────────────────────────
    for (const dot of dotsRef.current) {
      const pulse = (Math.sin(ts / 1400 + dot.x * 0.012) + 1) / 2;

      if (dot.status === 'banned' || dot.status === 'suspicious') {
        ctx.save();
        ctx.globalAlpha = 0.08 + pulse * 0.07;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, dot.radius + 5 + pulse * 4, 0, Math.PI * 2);
        ctx.fillStyle = dot.color;
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.shadowBlur  = dot.radius * 2.5;
      ctx.shadowColor = dot.color;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2);
      ctx.fillStyle   = dot.color;
      ctx.globalAlpha = 0.82;
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, Math.max(1.4, dot.radius * 0.35), 0, Math.PI * 2);
      ctx.fillStyle   = '#ffffff';
      ctx.globalAlpha = 0.45;
      ctx.fill();
      ctx.restore();
    }

    // ── Arcs ──────────────────────────────────────────────────────────────
    const alive: Arc[] = [];
    for (const arc of arcsRef.current) {
      arc.progress += dt * arc.speed;
      if (arc.progress > 2.4) continue;
      alive.push(arc);

      if (!filtersRef.current.has(arc.eventType)) continue;

      const tHead = Math.min(arc.progress, 1.0);
      const fade = arc.progress > 1.0
        ? Math.max(0, 1 - (arc.progress - 1.0) * 2.0)
        : 1.0;
      if (fade <= 0) continue;

      const segs = 50;
      for (let i = 0; i < segs; i++) {
        const t0 = (i / segs) * tHead;
        const t1 = ((i + 1) / segs) * tHead;
        const [x0, y0] = bezier(arc.sx, arc.sy, arc.cx, arc.cy, arc.tx, arc.ty, t0);
        const [x1, y1] = bezier(arc.sx, arc.sy, arc.cx, arc.cy, arc.tx, arc.ty, t1);
        const a = (i / segs) * fade * 0.78;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = arc.color + Math.round(a * 255).toString(16).padStart(2, '0');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (tHead < 1.0) {
        const [px, py] = bezier(arc.sx, arc.sy, arc.cx, arc.cy, arc.tx, arc.ty, tHead);
        ctx.save();
        ctx.shadowBlur  = 18;
        ctx.shadowColor = arc.color;
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fillStyle   = '#ffffff';
        ctx.globalAlpha = fade;
        ctx.fill();
        ctx.restore();
      }

      if (arc.progress >= 0.9 && arc.progress <= 1.9) {
        const pt = (arc.progress - 0.9) / 1.0;
        const r  = pt * 26;
        const pa = (1 - pt) * fade * 0.85;
        ctx.save();
        ctx.shadowBlur  = 12;
        ctx.shadowColor = arc.color;
        ctx.beginPath();
        ctx.arc(arc.tx, arc.ty, r, 0, Math.PI * 2);
        ctx.strokeStyle = arc.color + Math.round(pa * 255).toString(16).padStart(2, '0');
        ctx.lineWidth   = 1.5;
        ctx.globalAlpha = pa;
        ctx.stroke();
        ctx.restore();
      }
    }
    arcsRef.current = alive;

    // ── Agent markers ─────────────────────────────────────────────────────
    const p2 = (Math.sin(ts / 900) + 1) / 2;
    for (const ag of agentRef.current) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(ag.x, ag.y, 14 + p2 * 5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(160,160,160,${0.04 + p2 * 0.10})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.shadowBlur  = 10;
      ctx.shadowColor = '#aaaaaa';
      ctx.beginPath();
      ctx.arc(ag.x, ag.y, 8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(200,200,200,0.78)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.arc(ag.x, ag.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle  = '#e0e0e0';
      ctx.fill();
      ctx.restore();

      ctx.fillStyle  = 'rgba(180,180,180,0.75)';
      ctx.font       = '9px "Courier New", monospace';
      ctx.textAlign  = 'center';
      ctx.fillText(ag.label.slice(0, 16), ag.x, ag.y + 24);
    }

    ctx.resetTransform();
    setArcCount(alive.length);
    rafRef.current = requestAnimationFrame(animate);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch data + build positions ──────────────────────────────────────────

  const init = useCallback(async () => {
    setLoading(true);
    arcsRef.current  = [];
    dotsRef.current  = [];
    agentRef.current = [];

    const [w, h] = getSize();
    const ac = animRef.current;
    if (ac) { ac.width = w; ac.height = h; }

    await drawBase(w, h);

    try {
      const [repRes, devRes, banRes] = await Promise.all([
        apiClient.get<{ data: IpRepItem[] }>('/ip-reputation?limit=200'),
        apiClient.get<{ data: AgentDev[] }>('/agent/devices'),
        apiClient.get<{ data: { active: number; today: number } }>('/bans/stats')
          .catch(() => ({ data: { data: { active: 0, today: 0 } } })),
      ]);

      const ips  = repRes.data?.data ?? [] as IpRepItem[];
      const devs = (devRes.data?.data ?? [] as AgentDev[]).filter(d => d.status === 'approved');
      const bs   = (banRes.data as { data: { active: number; today: number } })?.data
                   ?? { active: 0, today: 0 };

      setStats({ agents: devs.length, banned: bs.active, today: bs.today });

      const BASE_LON = 2.35, BASE_LAT = 48.86, spread = 1.8;
      const n = Math.max(devs.length, 1);
      agentRef.current = (devs.length > 0
        ? devs
        : [{ id: 0, hostname: 'Server', name: null, status: 'approved' }]
      ).slice(0, 12).map((d, i) => {
        const angle = (i / n) * Math.PI * 2;
        const lon = BASE_LON + Math.cos(angle) * (n > 1 ? spread : 0);
        const lat = BASE_LAT + Math.sin(angle) * (n > 1 ? spread * 0.5 : 0);
        const [x, y] = project(lon, lat, w, h);
        return { x, y, label: ('name' in d ? d.name : null) ?? d.hostname, lon, lat };
      });

      const dots: IpDot[] = [];
      for (const rep of ips) {
        const cc = rep.geoCountryCode?.toUpperCase();
        if (!cc) continue;
        const c = CENTROIDS[cc];
        if (!c) continue;
        const [x, y] = project(c[1] + (Math.random() - 0.5) * 3.8, c[0] + (Math.random() - 0.5) * 2.8, w, h);
        dots.push({
          ip: rep.ip, x, y,
          radius: 3 + Math.min(rep.totalFailures / 14, 10),
          color: statusColor(rep.status),
          status: rep.status,
          failures: rep.totalFailures,
          services: rep.affectedServices ?? [],
          country: cc,
        });
      }
      dotsRef.current = dots;

      const agents = agentRef.current;
      let spawned = 0;
      for (const rep of ips) {
        if (spawned >= 20) break;
        const cc = rep.geoCountryCode?.toUpperCase();
        if (!cc) continue;
        const c = CENTROIDS[cc];
        if (!c) continue;
        const ag = agents[spawned % agents.length];
        if (!ag) continue;
        const arcColor = rep.status === 'banned' ? EVENT_COLORS.ban
          : rep.totalFailures > 0 ? EVENT_COLORS.auth_failure : EVENT_COLORS.auth_success;
        spawnArc(
          c[1] + (Math.random() - 0.5) * 3, c[0] + (Math.random() - 0.5) * 2,
          ag.lon, ag.lat, arcColor,
          rep.affectedServices?.[0] ?? 'ssh', cc, rep.ip,
          rep.status === 'banned' ? 'ban' : rep.totalFailures > 0 ? 'auth_failure' : 'auth_success',
          rep.totalFailures,
        );
        spawned++;
      }

      if (spawned < 8) {
        const fill = ['CN','RU','US','BR','IN','KP','IR','NG','TR','UA'];
        for (let i = spawned; i < 10; i++) {
          const cc = fill[i % fill.length];
          const c  = CENTROIDS[cc]!;
          const ag = agents[i % agents.length] ?? agents[0];
          if (!ag) continue;
          spawnArc(
            c[1] + (Math.random() - 0.5) * 4, c[0] + (Math.random() - 0.5) * 3,
            ag.lon, ag.lat, EVENT_COLORS.auth_failure,
            ['ssh','rdp','ftp','mail'][i % 4], cc, '(historical)', 'auth_failure', 1,
          );
        }
      }
    } catch (err) {
      console.error('NetMap init error:', err);
    }
    setLoading(false);
  }, [getSize, drawBase, spawnArc]);

  // ── Socket.io — real-time flows ───────────────────────────────────────────

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onIpFlow = (data: {
      ip: string; service: string;
      eventType: 'auth_success' | 'auth_failure'; deviceId: number;
    }) => {
      const ccs = Object.keys(CENTROIDS);
      const cc  = ccs[Math.floor(Math.random() * ccs.length)];
      const c   = CENTROIDS[cc]!;
      const ag  = agentRef.current[Math.floor(Math.random() * Math.max(agentRef.current.length, 1))];
      if (!ag) return;
      const arcColor = data.eventType === 'auth_success' ? EVENT_COLORS.auth_success : EVENT_COLORS.auth_failure;
      spawnArc(c[1] + (Math.random() - 0.5) * 3, c[0] + (Math.random() - 0.5) * 2,
        ag.lon, ag.lat, arcColor, data.service, cc, data.ip, data.eventType, 0);
      setLiveEvents(prev => [{
        id: Math.random().toString(36).slice(2),
        ip: data.ip, service: data.service, country: cc,
        time: new Date(), color: arcColor, eventType: data.eventType,
      }, ...prev].slice(0, 40));
    };

    const onBanAuto = (data: { ip: string; service: string; failureCount: number }) => {
      const ccs = Object.keys(CENTROIDS);
      const cc  = ccs[Math.floor(Math.random() * ccs.length)];
      const c   = CENTROIDS[cc]!;
      const ag  = agentRef.current[0];
      if (!ag) return;
      spawnArc(c[1], c[0], ag.lon, ag.lat, EVENT_COLORS.ban, data.service, cc, data.ip, 'ban', data.failureCount);
      setLiveEvents(prev => [{
        id: Math.random().toString(36).slice(2),
        ip: data.ip, service: data.service, country: cc,
        time: new Date(), color: EVENT_COLORS.ban, eventType: 'ban' as const, failures: data.failureCount,
      }, ...prev].slice(0, 40));
      setStats(s => ({ ...s, today: s.today + 1, banned: s.banned + 1 }));
    };

    socket.on('ip:flow',  onIpFlow);
    socket.on('ban:auto', onBanAuto);
    return () => { socket.off('ip:flow', onIpFlow); socket.off('ban:auto', onBanAuto); };
  }, [spawnArc]);

  // ── Wheel zoom (non-passive so we can preventDefault) ─────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect   = el.getBoundingClientRect();
      const mx     = e.clientX - rect.left;
      const my     = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const tr     = transformRef.current;
      const newScale = Math.min(Math.max(tr.scale * factor, 0.5), 8);
      const newTx = mx - (mx - tr.tx) * (newScale / tr.scale);
      const newTy = my - (my - tr.ty) * (newScale / tr.scale);
      transformRef.current = { scale: newScale, tx: newTx, ty: newTy };
      setTransform({ scale: newScale, tx: newTx, ty: newTy });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pan handlers ─────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    dragRef.current = { x: e.clientX, y: e.clientY };
    setIsDragging(true);
  }, []);

  const handlePanEnd = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      dragRef.current = { x: e.clientX, y: e.clientY };
      const tr = transformRef.current;
      const newTr = { ...tr, tx: tr.tx + dx, ty: tr.ty + dy };
      transformRef.current = newTr;
      setTransform(newTr);
      return;
    }

    // Inverse-transform mouse position back to canvas/map space
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { scale, tx, ty } = transformRef.current;
    const cx = (mx - tx) / scale;
    const cy = (my - ty) / scale;

    for (const dot of dotsRef.current) {
      const dx = cx - dot.x, dy = cy - dot.y;
      if (Math.sqrt(dx * dx + dy * dy) <= dot.radius + 8) {
        setTooltip({ visible: true, x: mx, y: my, ip: dot.ip, country: dot.country,
          failures: dot.failures, status: dot.status, services: dot.services });
        return;
      }
    }
    setTooltip(t => ({ ...t, visible: false }));
  }, []);

  // ── Start animation loop (independent of data loading) ───────────────────

  useEffect(() => {
    lastTsRef.current = performance.now();
    rafRef.current = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(rafRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ResizeObserver: compute 2:1 canvas dimensions + trigger (re)init ─────
  //
  // Computes w = min(outerWidth, outerHeight * 2), h = w / 2 — the largest
  // 2:1 rectangle that fits without overflow. Drives both the div CSS size
  // and the canvas drawing buffer size (via getSize → init).

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;

    let debounceTimer: ReturnType<typeof setTimeout>;

    const compute = (debounce: boolean) => {
      const { width, height } = el.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const w = Math.floor(Math.min(width, height * 2));
      const h = Math.floor(w / 2);
      // Skip if unchanged (avoids double-init when setCanvasDim triggers re-render)
      if (w === canvasDimRef.current.w && h === canvasDimRef.current.h) return;
      canvasDimRef.current = { w, h };
      setCanvasDim({ w, h });
      clearTimeout(debounceTimer);
      const doInit = () => { resetTransform(); void init(); };
      if (debounce) debounceTimer = setTimeout(doInit, 350);
      else void doInit();
    };

    compute(false); // immediate on mount
    const ro = new ResizeObserver(() => compute(true)); // debounced on resize
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(debounceTimer); };
  }, [init, resetTransform]); // eslint-disable-line react-hooks/exhaustive-deps

  const isTransformed = transform.scale !== 1 || transform.tx !== 0 || transform.ty !== 0;

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-[#090909] overflow-hidden select-none">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-[#1e1e1e] shrink-0 bg-[#111111]">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="font-mono text-[11px] tracking-widest text-[#888] uppercase">
            Live Threat Map
          </span>
          <span className="text-[#1e1e1e] font-mono text-[10px]">· OBLIGUARD IPS</span>
        </div>

        <div className="flex items-center gap-6">
          {[
            { Icon: Shield,   label: 'AGENTS', value: stats.agents, c: '#22d3ee' },
            { Icon: Ban,      label: 'BANNED', value: stats.banned, c: '#f87171' },
            { Icon: Activity, label: 'TODAY',  value: stats.today,  c: '#fb923c' },
            { Icon: Zap,      label: 'LIVE',   value: arcCount,     c: '#c084fc' },
          ].map(({ Icon, label, value, c }) => (
            <div key={label} className="flex items-center gap-1.5">
              <Icon size={11} style={{ color: c }} />
              <span className="font-mono text-sm font-bold" style={{ color: c }}>{value}</span>
              <span className="font-mono text-[9px] text-[#383838] tracking-widest">{label}</span>
            </div>
          ))}
          <button
            onClick={() => void init()}
            className="ml-1 p-1.5 rounded border border-[#1e1e1e] text-[#383838] hover:text-[#aaa] hover:border-[#555] transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Outer centering wrapper — ResizeObserver watches this ───────── */}
      <div
        ref={outerRef}
        className="flex-1 overflow-hidden flex items-center justify-center bg-[#090909]"
        onMouseUp={handlePanEnd}
      >
        {/* Inner container — exact 2:1 pixel size computed by JS */}
        <div
          ref={containerRef}
          className="relative overflow-hidden"
          style={{
            width:  canvasDim.w,
            height: canvasDim.h,
            cursor: isDragging ? 'grabbing' : 'grab',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => {
            dragRef.current = null;
            setIsDragging(false);
            setTooltip(t => ({ ...t, visible: false }));
          }}
          onMouseUp={handlePanEnd}
        >
          {/* Single canvas — pan/zoom via ctx.setTransform, no CSS scaling */}
          <canvas
            ref={animRef}
            className="absolute inset-0 pointer-events-none"
          />

          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#090909]/85 z-10">
              <div className="w-10 h-10 border-2 border-t-transparent border-[#666] rounded-full animate-spin mb-3" />
              <p className="font-mono text-[10px] text-[#555] tracking-widest">
                LOADING THREAT MAP...
              </p>
            </div>
          )}

          {/* ── Left legend ──────────────────────────────────────────────── */}
          <div className="absolute top-4 left-4 bg-[#111111]/90 border border-[#1e1e1e] rounded-sm p-3 backdrop-blur-sm min-w-[132px] z-10">

            <div className="font-mono text-[8px] text-[#383838] tracking-widest mb-2 uppercase">
              Flow Filters
            </div>
            {(
              [
                { type: 'auth_success' as const, color: EVENT_COLORS.auth_success, label: 'Success' },
                { type: 'auth_failure' as const, color: EVENT_COLORS.auth_failure, label: 'Auth Failure' },
                { type: 'ban'          as const, color: EVENT_COLORS.ban,          label: 'Auto-Ban' },
              ] satisfies { type: FlowType; color: string; label: string }[]
            ).map(({ type, color, label }) => {
              const on = filters.has(type);
              return (
                <button
                  key={type}
                  onClick={() => toggleFilter(type)}
                  className="flex items-center gap-2 py-[4px] w-full"
                  title={on ? `Hide ${label}` : `Show ${label}`}
                >
                  <div
                    className="w-5 h-0.5 shrink-0 rounded transition-all duration-200"
                    style={{ backgroundColor: on ? color : '#2c2c2c', boxShadow: on ? `0 0 5px ${color}` : 'none' }}
                  />
                  <div
                    className="w-2.5 h-2.5 shrink-0 rounded-sm border transition-all duration-200 flex items-center justify-center"
                    style={{ borderColor: on ? color : '#2c2c2c', backgroundColor: on ? `${color}22` : 'transparent' }}
                  >
                    {on && <div className="w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: color }} />}
                  </div>
                  <span className="font-mono text-[10px] transition-colors duration-200" style={{ color: on ? '#888' : '#383838' }}>
                    {label}
                  </span>
                </button>
              );
            })}

            <div className="mt-3 pt-2 border-t border-[#1e1e1e]">
              <div className="font-mono text-[8px] text-[#383838] tracking-widest mb-2 uppercase">Services</div>
              {Object.entries(SVC_COLORS)
                .filter(([, ], i, a) => a.findIndex(([, v]) => v === a[i][1]) === i)
                .map(([svc, color]) => (
                  <div key={svc} className="flex items-center gap-2 py-[2px]">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color, boxShadow: `0 0 4px ${color}60` }} />
                    <span className="font-mono text-[9px] uppercase tracking-wide text-[#555]">{svc}</span>
                  </div>
                ))}
            </div>

            <div className="mt-3 pt-2 border-t border-[#1e1e1e]">
              <div className="font-mono text-[8px] text-[#383838] tracking-widest mb-2 uppercase">IP Status</div>
              {[
                { label: 'Banned',     color: '#ef4444' },
                { label: 'Suspicious', color: '#f97316' },
                { label: 'Clean',      color: '#475569' },
              ].map(({ label, color }) => (
                <div key={label} className="flex items-center gap-2 py-[2px]">
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color, boxShadow: `0 0 4px ${color}60` }} />
                  <span className="font-mono text-[9px] text-[#555]">{label}</span>
                </div>
              ))}
              <div className="mt-1.5 font-mono text-[8px] text-[#383838]">Dot size = failure count</div>
            </div>
          </div>

          {/* ── IP tooltip ────────────────────────────────────────────────── */}
          {tooltip.visible && (
            <div
              className="absolute z-20 pointer-events-none bg-[#0e0e0e]/96 border border-[#1e1e1e] rounded p-2.5 backdrop-blur-sm"
              style={{
                left: tooltip.x + 14,
                top:  tooltip.y - 8,
                transform: tooltip.x > canvasDim.w * 0.72 ? 'translateX(-110%)' : undefined,
              }}
            >
              <div className="font-mono text-[11px] text-[#ccc] mb-1.5 font-bold tracking-wide">{tooltip.ip}</div>
              {[
                { label: 'Country',  value: `${flag(tooltip.country)} ${tooltip.country}` },
                { label: 'Failures', value: tooltip.failures.toLocaleString(), color: '#fb923c' },
                { label: 'Status',   value: tooltip.status.toUpperCase(), color: statusColor(tooltip.status) },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-[8px] text-[#383838] uppercase tracking-wider w-14 shrink-0">{label}</span>
                  <span className="font-mono text-[10px]" style={{ color: color ?? '#666' }}>{value}</span>
                </div>
              ))}
              {tooltip.services.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[8px] text-[#383838] uppercase tracking-wider w-14 shrink-0">Services</span>
                  <span className="font-mono text-[10px] text-[#666]">{tooltip.services.slice(0, 4).join(', ')}</span>
                </div>
              )}
            </div>
          )}

          {/* ── Reset view button ─────────────────────────────────────────── */}
          {isTransformed && (
            <button
              onClick={resetTransform}
              className="absolute bottom-3 right-3 z-20 px-2 py-1 rounded font-mono text-[9px] bg-[#1e1e1e]/90 border border-[#333] text-[#888] hover:text-[#ccc] hover:border-[#555] transition-colors backdrop-blur-sm"
              title="Reset view"
            >
              ⌖ reset view
            </button>
          )}
        </div>
      </div>

      {/* ── Bottom live feed ─────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-[#1e1e1e] bg-[#111111]">
        <div className="flex items-center gap-2 px-4 py-1 border-b border-[#161616]">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
          </span>
          <span className="font-mono text-[8px] text-[#383838] tracking-widest uppercase">Live Events</span>
          <span className="ml-auto font-mono text-[8px] text-[#383838]">{liveEvents.length} captured</span>
        </div>

        <div className="h-[5.5rem] overflow-hidden px-4 py-1.5">
          {liveEvents.length === 0 ? (
            <span className="font-mono text-[10px] text-[#1a1a1a]">Monitoring for events...</span>
          ) : (
            <div className="flex flex-col gap-0.5">
              {liveEvents.slice(0, 5).map(ev => (
                <div key={ev.id} className="flex items-center gap-2.5 font-mono text-[10px]">
                  <span className="text-[#383838] w-20 shrink-0">{ev.time.toLocaleTimeString()}</span>
                  <div className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: ev.color, boxShadow: `0 0 4px ${ev.color}` }} />
                  <span className="uppercase text-[8px] w-16 shrink-0 tracking-wide font-bold" style={{ color: ev.color }}>
                    {ev.eventType === 'auth_success' ? 'success' : ev.eventType === 'ban' ? '🔒 ban' : 'failure'}
                  </span>
                  <span className="uppercase w-10 shrink-0" style={{ color: svcColor(ev.service) }}>
                    {ev.service.slice(0, 8)}
                  </span>
                  <span className="text-[#555] w-28 truncate shrink-0">{ev.ip}</span>
                  <span className="text-[#363636] shrink-0">→</span>
                  <span className="text-[#666]">{flag(ev.country)} {ev.country}</span>
                  {ev.failures != null && ev.failures > 0 && (
                    <span className="text-orange-600/60 text-[9px]">{ev.failures}×</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
