/**
 * NetMapPage — Obliguard Star Map
 *
 * Agents = "star systems" (ARK Starmap style glowing nodes)
 * IPs    = "asteroids" orbiting their target agent in tilted ellipses
 * Live   = particles shooting from IP toward agent on each event
 *
 * Pure Canvas 2D — no WebGL, no extra dependencies.
 * Pan: drag · Zoom: scroll · Focus: click an agent · Reset: button
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Shield, Ban, Activity, RefreshCw, Zap, X } from 'lucide-react';
import { getSocket } from '../socket/socketClient';
import apiClient from '../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentNode {
  id: number;
  label: string;
  x: number; y: number;
  r: number;            // visual radius — based on event count
  eventCount: number;
  phase: number;        // animation phase offset
}

interface IpNode {
  key: string;              // `${ip}:${agentId}`
  ip: string;
  country: string;
  flag: string;
  targetAgentId: number;
  // Orbital params (fixed at creation)
  orbR: number;             // semi-major radius
  orbPhi: number;           // inclination angle → controls ellipse flatness
  orbTheta: number;         // current angle (animated)
  orbSpeed: number;         // rad/s (+/- for direction)
  // Computed world position (updated every frame)
  x: number; y: number;
  // Visual
  dotR: number;
  color: string;
  status: string;
  failures: number;
  services: string[];
  glowUntil: number;        // epoch ms
}

interface Particle {
  id: string;
  sx: number; sy: number;
  targetId: number;
  t: number;
  speed: number;
  color: string;
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

// ── Constants ─────────────────────────────────────────────────────────────────

const EVENT_COLORS = {
  auth_success: '#22d3ee',
  auth_failure: '#f97316',
  ban:          '#ef4444',
} as const;

const SVC_COLORS: Record<string, string> = {
  ssh: '#f97316', rdp: '#a855f7', ftp: '#eab308',
  mail: '#06b6d4', mysql: '#ec4899', nginx: '#22c55e',
  apache: '#22c55e', iis: '#3b82f6',
};

const MIN_ORB_R = 55;
const MAX_ORB_R = 118;

const CENTROIDS: Record<string, [number, number]> = {
  AF:[33.93,67.71],  AL:[41.15,20.17],  DZ:[28.03,1.66],   AO:[-11.20,17.87],
  AR:[-38.42,-63.62],AU:[-25.27,133.78],AT:[47.52,14.55],  AZ:[40.14,47.58],
  BD:[23.68,90.36],  BE:[50.50,4.47],   BG:[42.73,25.49],  BR:[-14.24,-51.93],
  CA:[56.13,-106.35],CN:[35.86,104.19], CO:[4.57,-74.30],  CZ:[49.82,15.47],
  DE:[51.17,10.45],  DK:[56.26,9.50],   EG:[26.82,30.80],  ES:[40.46,-3.75],
  ET:[9.15,40.49],   FI:[61.92,25.75],  FR:[46.23,2.21],   GB:[55.38,-3.44],
  GE:[42.32,43.36],  GH:[7.95,-1.02],   GR:[39.07,21.82],  HK:[22.30,114.18],
  HU:[47.16,19.50],  ID:[-0.79,113.92], IN:[20.59,78.96],  IQ:[33.22,43.68],
  IR:[32.43,53.69],  IT:[41.87,12.57],  JP:[36.20,138.25], KE:[-0.02,37.91],
  KP:[40.34,127.51], KR:[35.91,127.77], KZ:[48.02,66.92],  LY:[26.34,17.23],
  MA:[31.79,-7.09],  MD:[47.41,28.37],  MX:[23.63,-102.55],MY:[4.21,101.98],
  NG:[9.08,8.68],    NL:[52.13,5.29],   NO:[60.47,8.47],   NZ:[-40.90,174.89],
  PK:[30.38,69.35],  PL:[51.92,19.15],  PT:[39.40,-8.22],  RO:[45.94,24.97],
  RS:[44.02,21.01],  RU:[61.52,105.32], SA:[23.89,45.08],  SE:[60.13,18.64],
  SG:[1.35,103.82],  SY:[34.80,38.99],  TH:[15.87,100.99], TN:[33.89,9.54],
  TR:[38.96,35.24],  TW:[23.70,121.00], UA:[48.38,31.17],  US:[37.09,-95.71],
  UZ:[41.38,64.59],  VE:[6.42,-66.59],  VN:[14.06,108.28], ZA:[-30.56,22.94],
};

// ── Pure helpers (module-level — stable references) ───────────────────────────

function flagEmoji(code: string): string {
  if (!code || code.length !== 2) return '🌐';
  return Array.from(code.toUpperCase())
    .map(c => String.fromCodePoint(c.codePointAt(0)! + 127397))
    .join('');
}

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

/** Compute 2D elliptical orbit position for an IP around its parent agent. */
function ipWorldPos(ip: IpNode, agent: AgentNode): { x: number; y: number } {
  const semiA = ip.orbR;
  const semiB = ip.orbR * Math.abs(Math.cos(ip.orbPhi)); // squish → tilted ellipse
  return {
    x: agent.x + semiA * Math.cos(ip.orbTheta),
    y: agent.y + semiB * Math.sin(ip.orbTheta),
  };
}

/** Simple spring relaxation — distributes agents evenly without extra deps. */
function layoutAgents(agents: AgentNode[], w: number, h: number) {
  const n = agents.length;
  if (n === 0) return;
  if (n === 1) { agents[0].x = w / 2; agents[0].y = h / 2; return; }
  // Place on circle initially
  const initR = Math.min(w, h) * 0.29;
  // Use agent IDs as seeds for deterministic jitter
  agents.forEach((ag, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const seed  = ag.id > 0 ? ag.id : i + 1;
    const jx    = ((seed * 1327) % 40) - 20;
    const jy    = ((seed * 2417) % 40) - 20;
    ag.x = w / 2 + Math.cos(angle) * initR + jx;
    ag.y = h / 2 + Math.sin(angle) * initR + jy;
  });
  // Spring relaxation (120 iterations)
  const targetDist = Math.max(200, Math.min(initR * 1.5, 340));
  const margin     = 80;
  for (let iter = 0; iter < 120; iter++) {
    const alpha = 1 - iter / 120;
    for (let i = 0; i < n; i++) {
      let fx = 0, fy = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = agents[i].x - agents[j].x;
        const dy = agents[i].y - agents[j].y;
        const d  = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < targetDist) {
          const f = ((targetDist - d) / targetDist) * 3;
          fx += (dx / d) * f;
          fy += (dy / d) * f;
        }
      }
      fx += (w / 2 - agents[i].x) * 0.012;
      fy += (h / 2 - agents[i].y) * 0.012;
      agents[i].x = Math.max(margin, Math.min(w - margin, agents[i].x + fx * alpha * 2));
      agents[i].y = Math.max(margin, Math.min(h - margin, agents[i].y + fy * alpha * 2));
    }
  }
}

/** Draw an IP badge pill: flag + IP text in a styled container. */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  flagStr: string, ip: string,
  sx: number, sy: number, dotR: number,
  color: string, alpha: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '7.5px "Courier New", monospace';
  const text = `${flagStr} ${ip}`;
  const tw   = ctx.measureText(text).width;
  const pad = 5, bh = 13, bw = tw + pad * 2;
  const bx = sx - bw / 2;
  const by = sy + dotR + 5;
  // Background
  ctx.fillStyle = 'rgba(3,3,20,0.88)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, bw, bh, 3.5);
  else ctx.rect(bx, by, bw, bh);
  ctx.fill();
  // Border
  ctx.strokeStyle = color + '68';
  ctx.lineWidth = 0.65;
  ctx.stroke();
  // Text
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, sx, by + bh / 2);
  ctx.restore();
}

// ── Component ─────────────────────────────────────────────────────────────────

export function NetMapPage() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bgRef        = useRef<HTMLCanvasElement | null>(null);
  const rafRef       = useRef<number>(0);
  const lastTsRef    = useRef<number>(0);

  // Scene data (mutated directly — never trigger re-renders)
  const agentsRef    = useRef<AgentNode[]>([]);
  const ipsRef       = useRef<Map<string, IpNode>>(new Map());
  const particlesRef = useRef<Particle[]>([]);

  // View transform
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef      = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const selectedRef  = useRef<number | null>(null);
  const filtersRef   = useRef<Set<string>>(new Set(['auth_success', 'auth_failure', 'ban']));

  // Canvas size
  const sizeRef = useRef({ w: 800, h: 600 });

  // React state (UI only)
  type FlowType = 'auth_success' | 'auth_failure' | 'ban';
  const [canvasSize,    setCanvasSize]    = useState({ w: 800, h: 600 });
  const [loading,       setLoading]       = useState(true);
  const [isDragging,    setIsDragging]    = useState(false);
  const [liveEvents,    setLiveEvents]    = useState<LiveEvent[]>([]);
  const [stats,         setStats]         = useState({ agents: 0, banned: 0, today: 0 });
  const [ipCount,       setIpCount]       = useState(0);
  const [filters,       setFilters]       = useState<Set<FlowType>>(new Set(['auth_success', 'auth_failure', 'ban']));
  const [selectedAgent, setSelectedAgent] = useState<AgentNode | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number; y: number;
    ip: string; flag: string; country: string;
    status: string; failures: number; services: string[]; color: string;
  } | null>(null);

  // ── Draw nebula background to offscreen canvas ───────────────────────────

  const drawBg = useCallback((w: number, h: number) => {
    if (!bgRef.current) bgRef.current = document.createElement('canvas');
    const oc  = bgRef.current;
    oc.width  = w; oc.height = h;
    const ctx = oc.getContext('2d')!;

    // Deep space base
    ctx.fillStyle = '#030310';
    ctx.fillRect(0, 0, w, h);

    // Nebula clouds — warm amber (right) + cool blue (left), like ARK Starmap
    const nebulae: [number, number, number, string][] = [
      [w * 0.80, h * 0.38, Math.min(w, h) * 0.50, 'rgba(155,65,15,0.20)'],
      [w * 0.72, h * 0.58, Math.min(w, h) * 0.32, 'rgba(185,100,8,0.13)'],
      [w * 0.88, h * 0.22, Math.min(w, h) * 0.28, 'rgba(120,45,8,0.14)'],
      [w * 0.18, h * 0.28, Math.min(w, h) * 0.38, 'rgba(18,38,110,0.22)'],
      [w * 0.12, h * 0.60, Math.min(w, h) * 0.26, 'rgba(35,12,80,0.16)'],
      [w * 0.48, h * 0.75, Math.min(w, h) * 0.20, 'rgba(55,18,8,0.10)'],
    ];
    for (const [nx, ny, nr, c] of nebulae) {
      const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
      g.addColorStop(0, c);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // Dense star field (deterministic via manual LCG)
    let s = 123456789;
    const rand = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
    for (let i = 0; i < 980; i++) {
      const px   = rand() * w;
      const py   = rand() * h;
      const sz   = rand() < 0.04 ? 1.25 : rand() < 0.18 ? 0.70 : 0.42;
      const alph = 0.07 + rand() * 0.55;
      const tint = rand() < 0.28 ? '#ffd8a0' : rand() < 0.18 ? '#a0c8ff' : '#e8eeff';
      ctx.globalAlpha = alph;
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.arc(px, py, sz, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, []);

  // ── Upsert IP node ───────────────────────────────────────────────────────

  const upsertIp = useCallback((
    ip: string, country: string, agentId: number,
    status: string, failures: number, services: string[],
    glow = false,
  ) => {
    const agents = agentsRef.current;
    if (!agents.find(a => a.id === agentId)) return;
    const key = `${ip}:${agentId}`;
    const map  = ipsRef.current;

    if (map.has(key)) {
      const node = map.get(key)!;
      node.status   = status;
      node.failures = failures;
      node.services = services;
      node.color    = statusColor(status);
      node.dotR     = 2.5 + Math.min(failures / 10, 8);
      if (glow) node.glowUntil = Date.now() + 2500;
    } else {
      const seed    = (ip.split('.').reduce((a, b) => a + Number(b), 0) * 31 + agentId) >>> 0;
      const lRand   = (n: number) => ((seed * n * 16807) % 2147483647) / 2147483647;
      const orbR    = MIN_ORB_R + lRand(1) * (MAX_ORB_R - MIN_ORB_R);
      const orbPhi  = 0.25 + lRand(3) * 0.75; // 0.25–1.0 rad → varied ellipses
      const agent   = agents.find(a => a.id === agentId)!;
      const node: IpNode = {
        key, ip,
        country, flag: flagEmoji(country),
        targetAgentId: agentId,
        orbR, orbPhi,
        orbTheta: lRand(7) * Math.PI * 2,
        orbSpeed: (0.12 + lRand(11) * 0.18) * (lRand(13) < 0.5 ? 1 : -1),
        x: agent.x, y: agent.y,
        dotR:  2.5 + Math.min(failures / 10, 8),
        color: statusColor(status),
        status, failures, services,
        glowUntil: glow ? Date.now() + 2500 : 0,
      };
      map.set(key, node);
      setIpCount(map.size);
    }
  }, []);

  // ── Spawn flow particle ──────────────────────────────────────────────────

  const spawnParticle = useCallback((ip: IpNode, color: string) => {
    particlesRef.current = [...particlesRef.current.slice(-79), {
      id:       Math.random().toString(36).slice(2),
      sx: ip.x, sy: ip.y,
      targetId: ip.targetAgentId,
      t:        0,
      speed:    0.4 + Math.random() * 0.35,
      color,
    }];
  }, []);

  // ── Load data and build scene ────────────────────────────────────────────

  const init = useCallback(async () => {
    setLoading(true);
    ipsRef.current = new Map();
    particlesRef.current = [];
    setIpCount(0);

    try {
      const [devRes, evRes, banRes] = await Promise.all([
        apiClient.get<{ data: { id: number; hostname: string; name: string | null; status: string }[] }>('/agent/devices'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apiClient.get<{ data: any[] }>('/ip-events', { params: { pageSize: 500 } })
          .catch(() => ({ data: { data: [] } })),
        apiClient.get<{ data: { active: number; today: number } }>('/bans/stats')
          .catch(() => ({ data: { data: { active: 0, today: 0 } } })),
      ]);

      const devs = (devRes.data?.data ?? []).filter(d => d.status === 'approved');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evts = (evRes.data as any)?.data ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bs   = (banRes.data as any)?.data ?? { active: 0, today: 0 };
      setStats({ agents: devs.length, banned: bs.active, today: bs.today });

      // Aggregate event counts
      const agentEvtCount = new Map<number, number>();
      const ipToAgent     = new Map<string, Map<number, { count: number; failures: number; services: string[] }>>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ev of evts as any[]) {
        const aid  = ev.deviceId ?? ev.device_id;
        const evIp = ev.ip;
        if (!aid || !evIp) continue;
        agentEvtCount.set(aid, (agentEvtCount.get(aid) ?? 0) + 1);
        if (!ipToAgent.has(evIp)) ipToAgent.set(evIp, new Map());
        const m = ipToAgent.get(evIp)!;
        if (!m.has(aid)) m.set(aid, { count: 0, failures: 0, services: [] });
        const e = m.get(aid)!;
        e.count++;
        const et = ev.eventType ?? ev.event_type ?? '';
        if (et === 'auth_failure') e.failures++;
        const svc = ev.service ?? '';
        if (svc && !e.services.includes(svc)) e.services.push(svc);
      }

      // Build agents with layout
      const { w, h } = sizeRef.current;
      const placed = devs.length > 0
        ? devs.slice(0, 20)
        : [{ id: -1, hostname: 'Server', name: null, status: 'approved' }];
      agentsRef.current = placed.map(d => ({
        id:         d.id,
        label:      (d.name ?? d.hostname).slice(0, 22),
        x: w / 2, y: h / 2,
        r:          10 + Math.min((agentEvtCount.get(d.id) ?? 0) / 15, 22),
        eventCount: agentEvtCount.get(d.id) ?? 0,
        phase:      ((d.id * 7919) % 100) / 100 * Math.PI * 2,
      }));
      layoutAgents(agentsRef.current, w, h);

      // Fetch IP reputation
      const repRes = await apiClient.get<{
        data: { ip: string; geoCountryCode?: string | null; totalFailures: number; status: string; affectedServices?: string[] }[]
      }>('/ip-reputation?limit=200').catch(() => ({ data: { data: [] } }));
      const repMap = new Map<string, { country: string; status: string; failures: number; services: string[] }>();
      for (const r of repRes.data?.data ?? []) {
        repMap.set(r.ip, {
          country:  r.geoCountryCode?.toUpperCase() ?? '??',
          status:   r.status,
          failures: r.totalFailures,
          services: r.affectedServices ?? [],
        });
      }

      // Build IP nodes from event data
      const agArr = agentsRef.current;
      let ipCount = 0;
      for (const [evIp, agentMap] of ipToAgent) {
        if (ipCount >= 200) break;
        let bestAid = agArr[0]?.id ?? -1, bestCount = 0;
        for (const [aid, e] of agentMap) {
          if (e.count > bestCount) { bestAid = aid; bestCount = e.count; }
        }
        const e   = agentMap.get(bestAid)!;
        const rep = repMap.get(evIp);
        upsertIp(
          evIp,
          rep?.country ?? '??',
          bestAid,
          rep?.status ?? (e.failures > 0 ? 'suspicious' : 'clean'),
          rep?.failures ?? e.failures,
          e.services,
        );
        ipCount++;
      }

      // Fill remaining IPs from reputation (not seen in events), spread across agents
      let aidIdx = 0;
      for (const [repIp, rep] of repMap) {
        if (ipCount >= 250) break;
        const alreadyPlaced = [...ipsRef.current.keys()].some(k => k.startsWith(repIp + ':'));
        if (alreadyPlaced) continue;
        // Assign to agent with fewest IPs
        let targetAid = agArr[0]?.id ?? -1, minCnt = Infinity;
        for (const ag of agArr) {
          const cnt = [...ipsRef.current.values()].filter(n => n.targetAgentId === ag.id).length;
          if (cnt < minCnt) { minCnt = cnt; targetAid = ag.id; }
        }
        upsertIp(repIp, rep.country, targetAid, rep.status, rep.failures, rep.services);
        ipCount++; aidIdx++;
      }
    } catch (err) {
      console.error('NetMap init error:', err);
    }
    setLoading(false);
  }, [upsertIp]);

  // ── Animation loop ───────────────────────────────────────────────────────

  const animate = useCallback((ts: number) => {
    const canvas = canvasRef.current;
    if (!canvas) { rafRef.current = requestAnimationFrame(animate); return; }
    const ctx = canvas.getContext('2d')!;
    const { w, h } = sizeRef.current;
    const dt = Math.min((ts - lastTsRef.current) / 1000, 0.05);
    lastTsRef.current = ts;

    ctx.clearRect(0, 0, w, h);

    // Background
    const bg = bgRef.current;
    if (bg && bg.width > 0) ctx.drawImage(bg, 0, 0);

    // Apply pan/zoom
    ctx.save();
    const { x, y, k } = transformRef.current;
    ctx.translate(x, y);
    ctx.scale(k, k);

    const selId    = selectedRef.current;
    const agents   = agentsRef.current;
    const agentMap = new Map(agents.map(a => [a.id, a]));
    const ipNodes  = [...ipsRef.current.values()];

    // ── Update IP orbital positions ──────────────────────────────────────
    for (const ip of ipNodes) {
      ip.orbTheta += ip.orbSpeed * dt;
      const ag = agentMap.get(ip.targetAgentId);
      if (ag) { const pos = ipWorldPos(ip, ag); ip.x = pos.x; ip.y = pos.y; }
    }

    // ── Orbital ellipses ─────────────────────────────────────────────────
    // When an agent is selected: draw each IP's exact orbit. Otherwise: zone ring.
    for (const agent of agents) {
      const isSel  = selId === agent.id;
      const dimmed = selId !== null && !isSel;

      if (isSel) {
        // Draw each IP's individual ellipse (ARK Starmap detail view)
        const agIps = ipNodes.filter(ip => ip.targetAgentId === agent.id);
        for (const ip of agIps) {
          const semiA = ip.orbR;
          const semiB = ip.orbR * Math.abs(Math.cos(ip.orbPhi));
          ctx.save();
          ctx.globalAlpha = 0.12;
          ctx.strokeStyle = ip.color;
          ctx.lineWidth   = 0.6 / k;
          ctx.setLineDash([2, 6]);
          ctx.lineDashOffset = -(ts / 110) % 8;
          ctx.beginPath();
          ctx.ellipse(agent.x, agent.y, semiA, semiB, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      } else {
        // Zone ring (dashed circle)
        ctx.save();
        ctx.globalAlpha = dimmed ? 0.02 : 0.055;
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth   = 0.65 / k;
        ctx.setLineDash([2, 7]);
        ctx.lineDashOffset = -(ts / 130) % 9;
        ctx.beginPath();
        ctx.arc(agent.x, agent.y, MAX_ORB_R + 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // ── Connection lines (IP → agent, animated dashed) ───────────────────
    for (const ip of ipNodes) {
      const ag = agentMap.get(ip.targetAgentId);
      if (!ag) continue;
      const belongs = ip.targetAgentId === selId;
      const alpha   = selId !== null ? (belongs ? 0.28 : 0.04) : 0.12;
      ctx.save();
      ctx.globalAlpha   = alpha;
      ctx.strokeStyle   = ip.color;
      ctx.lineWidth     = 0.60 / k;
      ctx.setLineDash([3, 6]);
      ctx.lineDashOffset = -(ts / 55) % 9;
      ctx.beginPath();
      ctx.moveTo(ip.x, ip.y);
      ctx.lineTo(ag.x, ag.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ── IP nodes ─────────────────────────────────────────────────────────
    const badges: { flag: string; ip: string; sx: number; sy: number; r: number; color: string; alpha: number }[] = [];

    for (const ip of ipNodes) {
      const belongs = ip.targetAgentId === selId;
      const dimmed  = selId !== null && !belongs;
      const glow    = Date.now() < ip.glowUntil;
      const alpha   = dimmed ? 0.12 : 0.85;
      const r       = ip.dotR;

      // Glow halo for recent events
      if (glow && !dimmed) {
        const pulse = (Math.sin(ts / 220) + 1) / 2;
        ctx.save();
        ctx.globalAlpha = 0.22 * pulse;
        ctx.shadowBlur  = r * 5;
        ctx.shadowColor = ip.color;
        ctx.fillStyle   = ip.color + '40';
        ctx.beginPath();
        ctx.arc(ip.x, ip.y, r * 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Core dot
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowBlur  = r * 2.5;
      ctx.shadowColor = ip.color;
      ctx.fillStyle   = ip.color;
      ctx.beginPath();
      ctx.arc(ip.x, ip.y, r, 0, Math.PI * 2);
      ctx.fill();
      // Specular highlight
      ctx.shadowBlur  = 0;
      ctx.globalAlpha = alpha * 0.50;
      ctx.fillStyle   = '#ffffff';
      ctx.beginPath();
      ctx.arc(ip.x - r * 0.26, ip.y - r * 0.26, Math.max(0.5, r * 0.34), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (!dimmed) {
        badges.push({ flag: ip.flag, ip: ip.ip, sx: ip.x, sy: ip.y, r, color: ip.color, alpha: Math.min(0.95, alpha + 0.08) });
      }
    }

    // ── Agent nodes (ARK Starmap "system" style) ─────────────────────────
    for (const agent of agents) {
      const isSel  = selId === agent.id;
      const dimmed = selId !== null && !isSel;
      const pulse  = (Math.sin(ts / 1100 + agent.phase) + 1) / 2;
      const alpha  = dimmed ? 0.22 : 1.0;
      const nr     = agent.r;

      // Outer halo ring 1
      ctx.save();
      ctx.globalAlpha = alpha * (0.055 + pulse * 0.095);
      ctx.strokeStyle = isSel ? '#aaffee' : '#22d3ee';
      ctx.shadowBlur  = 22;
      ctx.shadowColor = isSel ? '#aaffee' : '#22d3ee';
      ctx.lineWidth   = 0.85 / k;
      ctx.beginPath();
      ctx.arc(agent.x, agent.y, nr + 22 + pulse * 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Halo ring 2
      ctx.save();
      ctx.globalAlpha = alpha * (0.14 + pulse * 0.12);
      ctx.strokeStyle = '#4dd9f0';
      ctx.shadowBlur  = 14;
      ctx.shadowColor = '#22d3ee';
      ctx.lineWidth   = 0.90 / k;
      ctx.beginPath();
      ctx.arc(agent.x, agent.y, nr + 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Core radial glow
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowBlur  = 22;
      ctx.shadowColor = isSel ? '#ffffff' : '#22d3ee';
      const g = ctx.createRadialGradient(agent.x, agent.y, 0, agent.x, agent.y, nr);
      g.addColorStop(0,    '#ffffff');
      g.addColorStop(0.30, isSel ? '#ccffee' : '#88eeff');
      g.addColorStop(1,    'rgba(34,211,238,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(agent.x, agent.y, nr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Labels: NAME above · AGENT below (ARK Starmap)
      const fs = Math.round(Math.max(9, 12 * Math.min(k, 1.2)));
      ctx.save();
      ctx.globalAlpha  = alpha * 0.92;
      ctx.font         = `bold ${fs}px "Courier New", monospace`;
      ctx.fillStyle    = isSel ? '#ccffee' : '#d4f6ff';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(agent.label, agent.x, agent.y - nr - 8);
      ctx.font         = `${Math.max(8, fs - 2)}px "Courier New", monospace`;
      ctx.fillStyle    = '#22d3ee';
      ctx.textBaseline = 'top';
      ctx.fillText('AGENT', agent.x, agent.y + nr + 6);
      ctx.restore();
    }

    // ── IP badges (drawn after nodes so they appear on top) ──────────────
    for (const b of badges) {
      drawBadge(ctx, b.flag, b.ip, b.sx, b.sy, b.r, b.color, b.alpha);
    }

    // ── Flow particles ────────────────────────────────────────────────────
    const alive: Particle[] = [];
    for (const part of particlesRef.current) {
      part.t += dt * part.speed;
      if (part.t >= 1.0) continue;
      alive.push(part);
      const ag = agentMap.get(part.targetId);
      if (!ag) continue;
      const px   = part.sx + (ag.x - part.sx) * part.t;
      const py   = part.sy + (ag.y - part.sy) * part.t;
      const fade = part.t < 0.8 ? 1 : (1 - part.t) / 0.2;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.shadowBlur  = 14;
      ctx.shadowColor = part.color;
      ctx.fillStyle   = '#ffffff';
      ctx.beginPath();
      ctx.arc(px, py, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    particlesRef.current = alive;

    ctx.restore(); // end pan/zoom
    rafRef.current = requestAnimationFrame(animate);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mount ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      const { width, height } = el.getBoundingClientRect();
      const w = Math.floor(width) || 800;
      const h = Math.floor(height) || 600;
      sizeRef.current = { w, h };
      setCanvasSize({ w, h });
      if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h; }
      drawBg(w, h);
    }
    void init();
    lastTsRef.current = performance.now();
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ResizeObserver ───────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout>;
    const obs = new ResizeObserver(entries => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { width, height } = entries[0].contentRect;
        if (width <= 0 || height <= 0) return;
        const w = Math.floor(width), h = Math.floor(height);
        // Scale existing agent positions to new canvas
        const { w: oldW, h: oldH } = sizeRef.current;
        if (oldW > 0 && oldH > 0) {
          const sx = w / oldW, sy = h / oldH;
          for (const ag of agentsRef.current) { ag.x *= sx; ag.y *= sy; }
        }
        sizeRef.current = { w, h };
        setCanvasSize({ w, h });
        const c = canvasRef.current;
        if (c) { c.width = w; c.height = h; }
        drawBg(w, h);
      }, 250);
    });
    obs.observe(el);
    return () => { obs.disconnect(); clearTimeout(timer); };
  }, [drawBg]);

  // ── Socket events ────────────────────────────────────────────────────────

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const ccs = Object.keys(CENTROIDS);

    const onIpFlow = (data: { ip: string; service: string; eventType: 'auth_success' | 'auth_failure'; deviceId: number }) => {
      const agents = agentsRef.current;
      const agent  = agents.find(a => a.id === data.deviceId) ?? agents[0];
      if (!agent) return;
      const cc  = ccs[Math.floor(Math.random() * ccs.length)];
      const col = data.eventType === 'auth_success' ? EVENT_COLORS.auth_success : EVENT_COLORS.auth_failure;
      if (!filtersRef.current.has(data.eventType)) return;
      upsertIp(data.ip, cc, agent.id,
        data.eventType === 'auth_failure' ? 'suspicious' : 'clean',
        data.eventType === 'auth_failure' ? 1 : 0,
        [data.service], true);
      const node = ipsRef.current.get(`${data.ip}:${agent.id}`);
      if (node) spawnParticle(node, col);
      setLiveEvents(prev => [{
        id: Math.random().toString(36).slice(2),
        ip: data.ip, service: data.service, country: cc,
        time: new Date(), color: col, eventType: data.eventType,
      }, ...prev].slice(0, 40));
    };

    const onBanAuto = (data: { ip: string; service: string; failureCount: number }) => {
      const agents = agentsRef.current;
      let node: IpNode | undefined;
      for (const n of ipsRef.current.values()) { if (n.ip === data.ip) { node = n; break; } }
      if (!node && agents[0]) {
        upsertIp(data.ip, '??', agents[0].id, 'banned', data.failureCount, [data.service], true);
        node = ipsRef.current.get(`${data.ip}:${agents[0].id}`);
      } else if (node) {
        node.status = 'banned'; node.color = EVENT_COLORS.ban; node.glowUntil = Date.now() + 3000;
      }
      if (node && filtersRef.current.has('ban')) spawnParticle(node, EVENT_COLORS.ban);
      setLiveEvents(prev => [{
        id: Math.random().toString(36).slice(2),
        ip: data.ip, service: data.service, country: node?.country ?? '??',
        time: new Date(), color: EVENT_COLORS.ban, eventType: 'ban' as const,
        failures: data.failureCount,
      }, ...prev].slice(0, 40));
      setStats(s => ({ ...s, today: s.today + 1, banned: s.banned + 1 }));
    };

    socket.on('ip:flow',  onIpFlow);
    socket.on('ban:auto', onBanAuto);
    return () => { socket.off('ip:flow', onIpFlow); socket.off('ban:auto', onBanAuto); };
  }, [upsertIp, spawnParticle]);

  // ── Wheel zoom (non-passive) ─────────────────────────────────────────────

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
      const newK   = Math.min(Math.max(tr.k * factor, 0.15), 8);
      transformRef.current = {
        x: mx - (mx - tr.x) * (newK / tr.k),
        y: my - (my - tr.y) * (newK / tr.k),
        k: newK,
      };
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── Mouse handlers ───────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY };
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      dragRef.current = { ...dragRef.current, x: e.clientX, y: e.clientY };
      const tr = transformRef.current;
      transformRef.current = { ...tr, x: tr.x + dx, y: tr.y + dy };
      return;
    }
    // Hover: find IP node under cursor
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    const tr   = transformRef.current;
    const wx   = (mx - tr.x) / tr.k;
    const wy   = (my - tr.y) / tr.k;
    for (const ip of ipsRef.current.values()) {
      const hit = ip.dotR + 7;
      if ((wx - ip.x) ** 2 + (wy - ip.y) ** 2 <= hit ** 2) {
        setTooltip({ x: mx, y: my, ip: ip.ip, flag: ip.flag, country: ip.country,
          status: ip.status, failures: ip.failures, services: ip.services, color: ip.color });
        return;
      }
    }
    setTooltip(null);
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    dragRef.current = null;
    setIsDragging(false);
    setTooltip(null);
    if (!start) return;
    const moved = Math.sqrt((e.clientX - start.startX) ** 2 + (e.clientY - start.startY) ** 2);
    if (moved >= 5) return; // was a drag

    // Click: hit-test agents
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    const tr   = transformRef.current;
    const wx   = (mx - tr.x) / tr.k;
    const wy   = (my - tr.y) / tr.k;
    for (const ag of agentsRef.current) {
      const hit = ag.r + 24;
      if ((wx - ag.x) ** 2 + (wy - ag.y) ** 2 <= hit ** 2) {
        const newSel = selectedRef.current === ag.id ? null : ag.id;
        selectedRef.current = newSel;
        setSelectedAgent(newSel !== null ? agentsRef.current.find(a => a.id === newSel) ?? null : null);
        return;
      }
    }
    selectedRef.current = null;
    setSelectedAgent(null);
  }, []);

  const toggleFilter = useCallback((type: FlowType) => {
    setFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      filtersRef.current = next;
      return next;
    });
  }, []);

  const resetView = useCallback(() => {
    transformRef.current = { x: 0, y: 0, k: 1 };
  }, []);

  // ── JSX ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-[#030310] overflow-hidden select-none">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-[#0a0a28] shrink-0 bg-[#050514]">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
          </span>
          <span className="font-mono text-[11px] tracking-widest text-[#2a6070] uppercase">
            Obliguard · Star Map
          </span>
          {selectedAgent && (
            <span className="font-mono text-[10px] text-cyan-400/70 tracking-wide ml-1">
              ─ {selectedAgent.label}
            </span>
          )}
        </div>

        <div className="flex items-center gap-6">
          {[
            { Icon: Shield,   label: 'AGENTS',  value: stats.agents,  c: '#22d3ee' },
            { Icon: Ban,      label: 'BANNED',  value: stats.banned,  c: '#f87171' },
            { Icon: Activity, label: 'TODAY',   value: stats.today,   c: '#fb923c' },
            { Icon: Zap,      label: 'TRACKED', value: ipCount,       c: '#c084fc' },
          ].map(({ Icon, label, value, c }) => (
            <div key={label} className="flex items-center gap-1.5">
              <Icon size={11} style={{ color: c }} />
              <span className="font-mono text-sm font-bold" style={{ color: c }}>{value}</span>
              <span className="font-mono text-[9px] text-[#14142a] tracking-widest">{label}</span>
            </div>
          ))}
          <button
            onClick={() => void init()}
            className="ml-1 p-1.5 rounded border border-[#0d0d28] text-[#14142a] hover:text-[#22d3ee] hover:border-[#22d3ee44] transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Canvas area ───────────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden"
        style={{ cursor: isDragging ? 'grabbing' : 'crosshair' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { dragRef.current = null; setIsDragging(false); setTooltip(null); }}
      >
        <canvas
          ref={canvasRef}
          width={canvasSize.w}
          height={canvasSize.h}
          className="absolute inset-0 pointer-events-none"
        />

        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#030310]/90 z-10">
            <div className="w-10 h-10 border border-t-transparent border-cyan-500/40 rounded-full animate-spin mb-3" />
            <p className="font-mono text-[10px] text-cyan-900/80 tracking-widest">INITIALISING STAR MAP…</p>
          </div>
        )}

        {/* ── Left panel ────────────────────────────────────────────────── */}
        <div className="absolute top-4 left-4 bg-[#050514]/92 border border-[#0d0d28] rounded-sm p-3 backdrop-blur-sm min-w-[148px] z-10">
          {selectedAgent ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="font-mono text-[8px] text-[#1a1a38] tracking-widest uppercase">Agent Focus</div>
                <button
                  onClick={() => { selectedRef.current = null; setSelectedAgent(null); }}
                  className="text-[#1a1a38] hover:text-cyan-400 transition-colors"
                >
                  <X size={10} />
                </button>
              </div>
              <div className="font-mono text-[11px] text-cyan-400 mb-1 truncate font-bold">{selectedAgent.label}</div>
              <div className="font-mono text-[9px] text-[#1a1a38]">
                {[...ipsRef.current.values()].filter(n => n.targetAgentId === selectedAgent.id).length} tracked IPs
              </div>
              <div className="font-mono text-[9px] text-[#1a1a38] mb-2">{selectedAgent.eventCount} events</div>
              <div className="pt-2 border-t border-[#0d0d28]">
                <div className="font-mono text-[8px] text-[#1a1a38] tracking-widest mb-1.5 uppercase">Top Threats</div>
                {[...ipsRef.current.values()]
                  .filter(n => n.targetAgentId === selectedAgent.id)
                  .sort((a, b) => b.failures - a.failures)
                  .slice(0, 6)
                  .map(n => (
                    <div key={n.key} className="flex items-center gap-1.5 py-[2px]">
                      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: n.color, boxShadow: `0 0 4px ${n.color}` }} />
                      <span className="font-mono text-[8px] truncate" style={{ color: n.color }}>
                        {n.flag} {n.ip.slice(0, 14)}
                      </span>
                    </div>
                  ))}
              </div>
            </>
          ) : (
            <>
              <div className="font-mono text-[8px] text-[#1a1a38] tracking-widest mb-2 uppercase">Flow Types</div>
              {([
                { type: 'auth_success' as const, color: EVENT_COLORS.auth_success, label: 'Success' },
                { type: 'auth_failure' as const, color: EVENT_COLORS.auth_failure, label: 'Auth Failure' },
                { type: 'ban'          as const, color: EVENT_COLORS.ban,          label: 'Auto-Ban' },
              ]).map(({ type, color, label }) => {
                const on = filters.has(type);
                return (
                  <button key={type} onClick={() => toggleFilter(type)} className="flex items-center gap-2 py-[4px] w-full">
                    <div className="w-5 h-0.5 shrink-0 rounded" style={{ backgroundColor: on ? color : '#0d0d28', boxShadow: on ? `0 0 4px ${color}` : 'none' }} />
                    <span className="font-mono text-[9px]" style={{ color: on ? '#4a8890' : '#1a1a38' }}>{label}</span>
                  </button>
                );
              })}

              <div className="mt-3 pt-2 border-t border-[#0d0d28]">
                <div className="font-mono text-[8px] text-[#1a1a38] tracking-widest mb-1.5 uppercase">IP Status</div>
                {[
                  { label: 'Banned',     color: '#ef4444' },
                  { label: 'Suspicious', color: '#f97316' },
                  { label: 'Clean',      color: '#475569' },
                ].map(({ label, color }) => (
                  <div key={label} className="flex items-center gap-2 py-[2px]">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <span className="font-mono text-[8px] text-[#1a2030]">{label}</span>
                  </div>
                ))}
              </div>

              <div className="mt-3 pt-2 border-t border-[#0d0d28]">
                <div className="font-mono text-[8px] text-[#1a1a38] leading-[1.7]">
                  <div>Drag · Pan</div>
                  <div>Scroll · Zoom</div>
                  <div>Click agent · Focus</div>
                </div>
                <button
                  onClick={resetView}
                  className="mt-1.5 w-full font-mono text-[8px] px-1.5 py-0.5 rounded border border-[#0d0d28] text-[#1a2030] hover:text-cyan-400 hover:border-[#22d3ee30] transition-colors"
                >
                  ⌖ Reset View
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── IP tooltip ────────────────────────────────────────────────── */}
        {tooltip && (
          <div
            className="absolute z-20 pointer-events-none bg-[#050514]/96 border border-[#0d0d28] rounded p-2.5 backdrop-blur-sm"
            style={{
              left: tooltip.x + 14,
              top:  tooltip.y - 8,
              transform: tooltip.x > canvasSize.w * 0.70 ? 'translateX(-110%)' : undefined,
            }}
          >
            <div className="font-mono text-[11px] mb-1.5 font-bold" style={{ color: tooltip.color }}>
              {tooltip.flag} {tooltip.ip}
            </div>
            {[
              { label: 'Country',  value: tooltip.country },
              { label: 'Status',   value: tooltip.status.toUpperCase(), color: tooltip.color },
              { label: 'Failures', value: tooltip.failures.toLocaleString(), color: '#fb923c' },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex items-center gap-2 mb-1">
                <span className="font-mono text-[8px] text-[#1a1a38] uppercase tracking-wider w-14 shrink-0">{label}</span>
                <span className="font-mono text-[10px]" style={{ color: color ?? '#304050' }}>{value}</span>
              </div>
            ))}
            {tooltip.services.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[8px] text-[#1a1a38] uppercase tracking-wider w-14 shrink-0">Services</span>
                <span className="font-mono text-[10px] text-[#203040]">{tooltip.services.slice(0, 4).join(', ')}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Bottom live feed ──────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-[#0a0a28] bg-[#050514]">
        <div className="flex items-center gap-2 px-4 py-1 border-b border-[#080820]">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
          </span>
          <span className="font-mono text-[8px] text-[#14142a] tracking-widest uppercase">Live Events</span>
          <span className="ml-auto font-mono text-[8px] text-[#14142a]">{liveEvents.length} captured</span>
        </div>
        <div className="h-[5.5rem] overflow-hidden px-4 py-1.5">
          {liveEvents.length === 0 ? (
            <span className="font-mono text-[10px] text-[#0d0d28]">Monitoring for events…</span>
          ) : (
            <div className="flex flex-col gap-0.5">
              {liveEvents.slice(0, 5).map(ev => (
                <div key={ev.id} className="flex items-center gap-2.5 font-mono text-[10px]">
                  <span className="text-[#14142a] w-20 shrink-0">{ev.time.toLocaleTimeString()}</span>
                  <div className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: ev.color, boxShadow: `0 0 4px ${ev.color}` }} />
                  <span className="uppercase text-[8px] w-16 shrink-0 tracking-wide font-bold" style={{ color: ev.color }}>
                    {ev.eventType === 'auth_success' ? 'success' : ev.eventType === 'ban' ? '🔒 ban' : 'failure'}
                  </span>
                  <span className="uppercase w-10 shrink-0" style={{ color: svcColor(ev.service) }}>
                    {ev.service.slice(0, 8)}
                  </span>
                  <span className="text-[#182030] w-28 truncate shrink-0">{ev.ip}</span>
                  <span className="text-[#14142a] shrink-0">→</span>
                  <span className="text-[#182030]">{flagEmoji(ev.country)} {ev.country}</span>
                  {ev.failures != null && ev.failures > 0 && (
                    <span className="text-orange-900/60 text-[9px]">{ev.failures}×</span>
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
