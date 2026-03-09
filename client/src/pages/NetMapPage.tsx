/**
 * NetMapPage — Obliguard Network Graph
 *
 * Force-directed graph style:
 * - Agents clustered near center, linked if they share attacking IPs
 * - IPs orbit their agent(s); multi-agent IPs placed between agents
 * - Labels only for banned / high-failure / multi-agent IPs
 * - IPs expire after 10 min of inactivity
 *
 * Pure Canvas 2D — no WebGL, no extra dependencies.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Shield, Ban, Activity, RefreshCw, Zap, X } from 'lucide-react';
import { getSocket } from '../socket/socketClient';
import apiClient from '../api/client';

// ── Types ──────────────────────────────────────────────────────────────────────

interface AgentNode {
  id: number;
  label: string;
  x: number; y: number;
  r: number;
  eventCount: number;
  phase: number;
}

interface IpNode {
  key: string;          // == ip string (one node per unique IP)
  ip: string;
  country: string;
  flag: string;
  agentIds: number[];   // primary = [0]; multi-agent IPs placed between agents
  x: number; y: number;
  dotR: number;
  color: string;
  status: string;
  failures: number;
  services: string[];
  eventCount: number;
  lastSeen: number;     // ms — for 10-min expiry
  glowUntil: number;
}

interface Particle {
  id: string;
  sx: number; sy: number;
  tx: number; ty: number;
  t: number; speed: number; color: string;
}

interface LiveEvent {
  id: string; ip: string; service: string; country: string;
  time: Date; color: string;
  eventType: 'auth_success' | 'auth_failure' | 'ban';
  failures?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const IP_TTL = 10 * 60 * 1000; // 10 minutes

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

// ── Pure helpers ───────────────────────────────────────────────────────────────

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

/** Seeded pseudo-random 0–1 from an IP string + salt integer. */
function ipRand(ip: string, salt: number): number {
  const seed = (ip.split('.').reduce((a, b) => a + Number(b), 0) * 31 + salt) >>> 0;
  return ((seed * 16807) % 2147483647) / 2147483647;
}

/** Place an IP near the centroid of its agents (or around a single agent). */
function placeIp(ip: IpNode, agentMap: Map<number, AgentNode>) {
  const ags = ip.agentIds.map(id => agentMap.get(id)).filter(Boolean) as AgentNode[];
  if (!ags.length) return;
  const cx = ags.reduce((s, a) => s + a.x, 0) / ags.length;
  const cy = ags.reduce((s, a) => s + a.y, 0) / ags.length;
  const angle = ipRand(ip.ip, 1) * Math.PI * 2;
  // Single-agent: scatter at orbit distance. Multi-agent: cluster near centroid.
  const dist = ags.length === 1
    ? 60 + ipRand(ip.ip, 3) * 65
    : 12 + ipRand(ip.ip, 5) * 32;
  ip.x = cx + Math.cos(angle) * dist;
  ip.y = cy + Math.sin(angle) * dist;
}

/** Spring relaxation — agents cluster near centre. */
function layoutAgents(agents: AgentNode[], w: number, h: number) {
  const n = agents.length;
  if (n === 0) return;
  if (n === 1) { agents[0].x = w / 2; agents[0].y = h / 2; return; }
  const initR = Math.min(w, h) * 0.20;
  agents.forEach((ag, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const seed  = ag.id > 0 ? ag.id : i + 1;
    ag.x = w / 2 + Math.cos(angle) * initR + ((seed * 1327) % 30) - 15;
    ag.y = h / 2 + Math.sin(angle) * initR + ((seed * 2417) % 30) - 15;
  });
  const targetDist = Math.max(150, Math.min(initR * 1.5, 270));
  const margin = 80;
  for (let iter = 0; iter < 160; iter++) {
    const alpha = 1 - iter / 160;
    for (let i = 0; i < n; i++) {
      let fx = 0, fy = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = agents[i].x - agents[j].x, dy = agents[i].y - agents[j].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < targetDist) {
          const f = ((targetDist - d) / targetDist) * 3;
          fx += (dx / d) * f; fy += (dy / d) * f;
        }
      }
      fx += (w / 2 - agents[i].x) * 0.022;
      fy += (h / 2 - agents[i].y) * 0.022;
      agents[i].x = Math.max(margin, Math.min(w - margin, agents[i].x + fx * alpha * 2));
      agents[i].y = Math.max(margin, Math.min(h - margin, agents[i].y + fy * alpha * 2));
    }
  }
}

/** Only show a badge for notable IPs. */
function shouldLabel(ip: IpNode): boolean {
  return ip.status === 'banned' || ip.failures > 2 || ip.eventCount >= 8 || ip.agentIds.length > 1;
}

// ── Badge helpers (module-level — stable refs, no closures) ───────────────────

const BADGE_H    = 13;
const BADGE_FONT = '7.5px "Inter", "Segoe UI", ui-sans-serif, sans-serif';

/** Format badge text: "US · 1.2.3.4" — plain ASCII, no emoji (no glyph on Windows Canvas). */
function badgeText(countryCode: string, ipStr: string): string {
  const cc = countryCode && countryCode.length === 2 && countryCode !== '??' ? countryCode : '??';
  return `${cc} · ${ipStr}`;
}

/** Draw a badge pill at an explicit (bx, by) position with pre-computed width. */
function drawBadgeAt(
  ctx: CanvasRenderingContext2D,
  text: string, bx: number, by: number, bw: number,
  color: string, alpha: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = BADGE_FONT;
  ctx.fillStyle = 'rgba(4,6,22,0.88)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, bw, BADGE_H, 3);
  else ctx.rect(bx, by, bw, BADGE_H);
  ctx.fill();
  ctx.strokeStyle = color + '72';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.fillStyle = '#c8d4df';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 4, by + BADGE_H / 2);
  ctx.restore();
}

// ── Component ──────────────────────────────────────────────────────────────────

export function NetMapPage() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bgRef        = useRef<HTMLCanvasElement | null>(null);
  const rafRef       = useRef<number>(0);
  const lastTsRef    = useRef<number>(0);
  const frameRef     = useRef<number>(0);

  const agentsRef    = useRef<AgentNode[]>([]);
  const ipsRef       = useRef<Map<string, IpNode>>(new Map());
  const particlesRef = useRef<Particle[]>([]);

  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef      = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const selectedRef  = useRef<number | null>(null);
  const filtersRef   = useRef<Set<string>>(new Set(['auth_success', 'auth_failure', 'ban']));
  const sizeRef      = useRef({ w: 800, h: 600 });

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

  // ── Background ────────────────────────────────────────────────────────────

  const drawBg = useCallback((w: number, h: number) => {
    if (!bgRef.current) bgRef.current = document.createElement('canvas');
    const oc = bgRef.current;
    oc.width = w; oc.height = h;
    const ctx = oc.getContext('2d')!;
    ctx.fillStyle = '#030310';
    ctx.fillRect(0, 0, w, h);
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
      g.addColorStop(0, c); g.addColorStop(1, 'transparent');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    let s = 123456789;
    const rand = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
    for (let i = 0; i < 980; i++) {
      const px = rand() * w, py = rand() * h;
      const sz = rand() < 0.04 ? 1.25 : rand() < 0.18 ? 0.70 : 0.42;
      const al = 0.07 + rand() * 0.55;
      const tint = rand() < 0.28 ? '#ffd8a0' : rand() < 0.18 ? '#a0c8ff' : '#e8eeff';
      ctx.globalAlpha = al; ctx.fillStyle = tint;
      ctx.beginPath(); ctx.arc(px, py, sz, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, []);

  // ── Upsert IP (socket / live) ─────────────────────────────────────────────

  const upsertIp = useCallback((
    ip: string, country: string, agentId: number,
    status: string, failures: number, services: string[],
    evtCount = 0, glow = false,
  ) => {
    const agents = agentsRef.current;
    if (!agents.find(a => a.id === agentId)) return;
    const map = ipsRef.current;

    if (map.has(ip)) {
      const node = map.get(ip)!;
      node.status     = status;
      node.failures   = Math.max(node.failures, failures);
      node.services   = [...new Set([...node.services, ...services])];
      node.color      = statusColor(status);
      node.dotR       = 2.5 + Math.min(node.failures / 10, 8);
      node.lastSeen   = Date.now();
      node.eventCount += evtCount;
      if (glow) node.glowUntil = Date.now() + 2500;
      if (!node.agentIds.includes(agentId)) {
        node.agentIds.push(agentId);
        placeIp(node, new Map(agents.map(a => [a.id, a])));
      }
    } else {
      const agentMap = new Map(agents.map(a => [a.id, a]));
      const ag = agentMap.get(agentId)!;
      const node: IpNode = {
        key: ip, ip,
        country, flag: flagEmoji(country),
        agentIds: [agentId],
        x: ag.x, y: ag.y,
        dotR: 2.5 + Math.min(failures / 10, 8),
        color: statusColor(status),
        status, failures, services, eventCount: evtCount,
        lastSeen:  Date.now(),
        glowUntil: glow ? Date.now() + 2500 : 0,
      };
      placeIp(node, agentMap);
      map.set(ip, node);
      setIpCount(map.size);
    }
  }, []);

  // ── Particle ──────────────────────────────────────────────────────────────

  const spawnParticle = useCallback((ipNode: IpNode, agentId: number, color: string) => {
    const ag = agentsRef.current.find(a => a.id === agentId) ?? agentsRef.current[0];
    if (!ag) return;
    particlesRef.current = [...particlesRef.current.slice(-79), {
      id:    Math.random().toString(36).slice(2),
      sx: ipNode.x, sy: ipNode.y,
      tx: ag.x, ty: ag.y,
      t: 0, speed: 0.4 + Math.random() * 0.35, color,
    }];
  }, []);

  // ── Init ──────────────────────────────────────────────────────────────────

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

      // Aggregate: ip → Map<agentId, {count, failures, services}>
      const agentEvtCount = new Map<number, number>();
      const ipToAgents    = new Map<string, Map<number, { count: number; failures: number; services: string[] }>>();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ev of evts as any[]) {
        const aid  = ev.deviceId ?? ev.device_id;
        const evIp = ev.ip;
        if (!aid || !evIp) continue;
        agentEvtCount.set(aid, (agentEvtCount.get(aid) ?? 0) + 1);
        if (!ipToAgents.has(evIp)) ipToAgents.set(evIp, new Map());
        const m = ipToAgents.get(evIp)!;
        if (!m.has(aid)) m.set(aid, { count: 0, failures: 0, services: [] });
        const e = m.get(aid)!;
        e.count++;
        const et = ev.eventType ?? ev.event_type ?? '';
        if (et === 'auth_failure') e.failures++;
        const svc = ev.service ?? '';
        if (svc && !e.services.includes(svc)) e.services.push(svc);
      }

      // Build agents
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
      const agentMap = new Map(agentsRef.current.map(a => [a.id, a]));

      // IP reputation
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

      // Build IP nodes from event data (one per unique IP)
      const agArr = agentsRef.current;
      let cnt = 0;
      for (const [evIp, agentData] of ipToAgents) {
        if (cnt >= 200) break;
        const rep         = repMap.get(evIp);
        const validIds    = [...agentData.keys()].filter(id => agArr.some(a => a.id === id));
        if (!validIds.length) continue;
        const allFailures = [...agentData.values()].reduce((s, e) => s + e.failures, 0);
        const allServices = [...new Set([...agentData.values()].flatMap(e => e.services))];
        const totalCount  = [...agentData.values()].reduce((s, e) => s + e.count, 0);
        const status      = rep?.status ?? (allFailures > 0 ? 'suspicious' : 'clean');
        const node: IpNode = {
          key: evIp, ip: evIp,
          country:    rep?.country ?? '??',
          flag:       flagEmoji(rep?.country ?? '??'),
          agentIds:   validIds,
          x: agArr[0]?.x ?? w / 2,
          y: agArr[0]?.y ?? h / 2,
          dotR:       2.5 + Math.min((rep?.failures ?? allFailures) / 10, 8),
          color:      statusColor(status),
          status,
          failures:   rep?.failures ?? allFailures,
          services:   allServices,
          eventCount: totalCount,
          lastSeen:   Date.now(),
          glowUntil:  0,
        };
        placeIp(node, agentMap);
        ipsRef.current.set(evIp, node);
        cnt++;
      }

      // Fill remaining from reputation (not seen in events)
      for (const [repIp, rep] of repMap) {
        if (cnt >= 250) break;
        if (ipsRef.current.has(repIp)) continue;
        let targetId = agArr[0]?.id ?? -1, minCnt = Infinity;
        for (const ag of agArr) {
          const c = [...ipsRef.current.values()].filter(n => n.agentIds[0] === ag.id).length;
          if (c < minCnt) { minCnt = c; targetId = ag.id; }
        }
        if (!agentMap.has(targetId)) continue;
        const node: IpNode = {
          key: repIp, ip: repIp,
          country:    rep.country, flag: flagEmoji(rep.country),
          agentIds:   [targetId],
          x: agentMap.get(targetId)!.x,
          y: agentMap.get(targetId)!.y,
          dotR:       2.5 + Math.min(rep.failures / 10, 8),
          color:      statusColor(rep.status),
          status:     rep.status, failures: rep.failures, services: rep.services,
          eventCount: 0, lastSeen: Date.now(), glowUntil: 0,
        };
        placeIp(node, agentMap);
        ipsRef.current.set(repIp, node);
        cnt++;
      }

      setIpCount(ipsRef.current.size);
    } catch (err) {
      console.error('NetMap init error:', err);
    }
    setLoading(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Animation loop ────────────────────────────────────────────────────────

  const animate = useCallback((ts: number) => {
    const canvas = canvasRef.current;
    if (!canvas) { rafRef.current = requestAnimationFrame(animate); return; }
    const ctx = canvas.getContext('2d')!;
    const { w, h } = sizeRef.current;
    const dt = Math.min((ts - lastTsRef.current) / 1000, 0.05);
    lastTsRef.current = ts;

    // Expiry check every ~5 s (300 frames @ 60 fps)
    frameRef.current = (frameRef.current + 1) % 300;
    if (frameRef.current === 0) {
      const now = Date.now();
      let changed = false;
      for (const [key, ip] of ipsRef.current) {
        if (now - ip.lastSeen > IP_TTL) { ipsRef.current.delete(key); changed = true; }
      }
      if (changed) setIpCount(ipsRef.current.size);
    }

    ctx.clearRect(0, 0, w, h);
    const bg = bgRef.current;
    if (bg && bg.width > 0) ctx.drawImage(bg, 0, 0);

    ctx.save();
    const { x, y, k } = transformRef.current;
    ctx.translate(x, y); ctx.scale(k, k);

    const selId   = selectedRef.current;
    const agents  = agentsRef.current;
    const agMap   = new Map(agents.map(a => [a.id, a]));
    const ipNodes = [...ipsRef.current.values()];

    // Build agent↔agent edges from shared IPs
    const agentEdges = new Set<string>();
    for (const ip of ipNodes) {
      for (let i = 0; i < ip.agentIds.length; i++) {
        for (let j = i + 1; j < ip.agentIds.length; j++) {
          const a = Math.min(ip.agentIds[i], ip.agentIds[j]);
          const b = Math.max(ip.agentIds[i], ip.agentIds[j]);
          agentEdges.add(`${a}-${b}`);
        }
      }
    }

    // ── Agent–agent edges ────────────────────────────────────────────────
    for (const edge of agentEdges) {
      const [ai, bi] = edge.split('-').map(Number);
      const a = agMap.get(ai), b = agMap.get(bi);
      if (!a || !b) continue;
      ctx.save();
      ctx.globalAlpha = selId !== null ? 0.04 : 0.14;
      ctx.strokeStyle = '#5588a0';
      ctx.lineWidth   = 0.9 / k;
      ctx.setLineDash([4, 8]);
      ctx.lineDashOffset = -(ts / 80) % 12;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }

    // ── IP–agent edges (thin dashed) ────────────────────────────────────
    for (const ip of ipNodes) {
      const dimmed = selId !== null && !ip.agentIds.includes(selId);
      const alpha  = dimmed ? 0.03 : selId !== null ? 0.24 : 0.09;
      for (const aid of ip.agentIds) {
        const ag = agMap.get(aid);
        if (!ag) continue;
        ctx.save();
        ctx.globalAlpha   = alpha;
        ctx.strokeStyle   = ip.color;
        ctx.lineWidth     = 0.55 / k;
        ctx.setLineDash([2, 5]);
        ctx.lineDashOffset = -(ts / 60) % 7;
        ctx.beginPath(); ctx.moveTo(ip.x, ip.y); ctx.lineTo(ag.x, ag.y);
        ctx.stroke(); ctx.setLineDash([]); ctx.restore();
      }
    }

    // ── IP dots ──────────────────────────────────────────────────────────
    const badges: { flag: string; ip: string; sx: number; sy: number; r: number; color: string; alpha: number }[] = [];

    for (const ip of ipNodes) {
      const dimmed = selId !== null && !ip.agentIds.includes(selId);
      const glow   = Date.now() < ip.glowUntil;
      const alpha  = dimmed ? 0.10 : 0.85;
      const r      = ip.dotR;

      if (glow && !dimmed) {
        const pulse = (Math.sin(ts / 220) + 1) / 2;
        ctx.save();
        ctx.globalAlpha = 0.20 * pulse;
        ctx.shadowBlur  = r * 5; ctx.shadowColor = ip.color;
        ctx.fillStyle   = ip.color + '40';
        ctx.beginPath(); ctx.arc(ip.x, ip.y, r * 2.8, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowBlur  = r * 1.8; ctx.shadowColor = ip.color;
      ctx.fillStyle   = '#c2cedd';
      ctx.beginPath(); ctx.arc(ip.x, ip.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      if (!dimmed && shouldLabel(ip)) {
        // Use country code (not emoji flag) — emoji flags have no glyph in Canvas on Windows
        badges.push({ flag: ip.country, ip: ip.ip, sx: ip.x, sy: ip.y, r, color: ip.color, alpha: Math.min(0.95, alpha + 0.1) });
      }
    }

    // ── Agent nodes ──────────────────────────────────────────────────────
    for (const agent of agents) {
      const isSel  = selId === agent.id;
      const dimmed = selId !== null && !isSel;
      const pulse  = (Math.sin(ts / 1100 + agent.phase) + 1) / 2;
      const alpha  = dimmed ? 0.22 : 1.0;
      const nr     = agent.r;

      ctx.save();
      ctx.globalAlpha = alpha * (0.04 + pulse * 0.05);
      ctx.strokeStyle = '#ddeeff'; ctx.shadowBlur = 16; ctx.shadowColor = '#ddeeff';
      ctx.lineWidth   = 0.7 / k;
      ctx.beginPath(); ctx.arc(agent.x, agent.y, nr + 20 + pulse * 5, 0, Math.PI * 2);
      ctx.stroke(); ctx.restore();

      ctx.save();
      ctx.globalAlpha = alpha; ctx.shadowBlur = 18; ctx.shadowColor = '#ffffff';
      const g = ctx.createRadialGradient(agent.x, agent.y, 0, agent.x, agent.y, nr);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.42, 'rgba(220,235,255,0.48)');
      g.addColorStop(1, 'rgba(200,220,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(agent.x, agent.y, nr, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      const fs = Math.round(Math.max(9, 12 * Math.min(k, 1.2)));
      ctx.save();
      ctx.globalAlpha  = alpha * 0.90;
      ctx.font         = `600 ${fs}px "Inter", "Segoe UI", ui-sans-serif, sans-serif`;
      ctx.fillStyle    = isSel ? '#f0f8ff' : '#ddeeff';
      ctx.textAlign    = 'center'; ctx.textBaseline = 'bottom';
      ctx.shadowBlur   = 7; ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.fillText(agent.label, agent.x, agent.y - nr - 7);
      ctx.restore();
    }

    // ── Smart badge placement ─────────────────────────────────────────────
    // Labels for suspicious/banned IPs only; placed so they don't cover other dots.
    // Tries 4 candidate positions (below → above → right → left), skips if all blocked.

    // All IP dot footprints (used for collision — exclude own dot per badge)
    const dotFP = ipNodes.map(ip => ({ x: ip.x, y: ip.y, r: ip.dotR + 2 }));

    // Already-placed badge rects
    const placedRects: { x: number; y: number; w: number }[] = [];

    /** True if a candidate rect (rx,ry,rw×BADGE_H) intersects any dot or placed badge.
     *  ownX/ownY: the badge's own IP dot, excluded from dot collision. */
    const badgeCollides = (rx: number, ry: number, rw: number, ownX: number, ownY: number): boolean => {
      for (const dot of dotFP) {
        if (dot.x === ownX && dot.y === ownY) continue;
        if (dot.x >= rx - dot.r && dot.x <= rx + rw + dot.r &&
            dot.y >= ry - dot.r && dot.y <= ry + BADGE_H + dot.r) return true;
      }
      for (const pr of placedRects) {
        if (rx < pr.x + pr.w && rx + rw > pr.x &&
            ry < pr.y + BADGE_H && ry + BADGE_H > pr.y) return true;
      }
      return false;
    };

    ctx.font = BADGE_FONT;
    for (const b of badges) {
      const txt = badgeText(b.flag, b.ip);
      const bw  = ctx.measureText(txt).width + 9; // 2×pad(4) + border

      // 4 candidate positions: below (preferred), above, right, left
      const gap = b.r + 4;
      const candidates: [number, number][] = [
        [b.sx - bw / 2,   b.sy + gap],               // below
        [b.sx - bw / 2,   b.sy - gap - BADGE_H],     // above
        [b.sx + gap,      b.sy - BADGE_H / 2],        // right
        [b.sx - bw - gap, b.sy - BADGE_H / 2],        // left
      ];

      for (const [bx, by] of candidates) {
        if (!badgeCollides(bx, by, bw, b.sx, b.sy)) {
          drawBadgeAt(ctx, txt, bx, by, bw, b.color, b.alpha);
          placedRects.push({ x: bx, y: by, w: bw });
          break; // found a clear spot — move to next badge
        }
      }
      // All 4 positions blocked → skip cleanly (don't render overlapping label)
    }

    // ── Flow particles ───────────────────────────────────────────────────
    const alive: Particle[] = [];
    for (const part of particlesRef.current) {
      part.t += dt * part.speed;
      if (part.t >= 1.0) continue;
      alive.push(part);
      const px   = part.sx + (part.tx - part.sx) * part.t;
      const py   = part.sy + (part.ty - part.sy) * part.t;
      const fade = part.t < 0.8 ? 1 : (1 - part.t) / 0.2;
      ctx.save();
      ctx.globalAlpha = fade; ctx.shadowBlur = 14; ctx.shadowColor = part.color;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(px, py, 2.8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    particlesRef.current = alive;

    ctx.restore();
    rafRef.current = requestAnimationFrame(animate);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mount ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      const { width, height } = el.getBoundingClientRect();
      const w = Math.floor(width) || 800, h = Math.floor(height) || 600;
      sizeRef.current = { w, h }; setCanvasSize({ w, h });
      if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h; }
      drawBg(w, h);
    }
    void init();
    lastTsRef.current = performance.now();
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Resize ────────────────────────────────────────────────────────────────

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
        const { w: oldW, h: oldH } = sizeRef.current;
        if (oldW > 0 && oldH > 0) {
          const sx = w / oldW, sy = h / oldH;
          for (const ag of agentsRef.current) { ag.x *= sx; ag.y *= sy; }
          for (const ip of ipsRef.current.values()) { ip.x *= sx; ip.y *= sy; }
        }
        sizeRef.current = { w, h }; setCanvasSize({ w, h });
        const c = canvasRef.current;
        if (c) { c.width = w; c.height = h; }
        drawBg(w, h);
      }, 250);
    });
    obs.observe(el);
    return () => { obs.disconnect(); clearTimeout(timer); };
  }, [drawBg]);

  // ── Socket events ─────────────────────────────────────────────────────────

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const ccs = ['US', 'CN', 'RU', 'DE', 'FR', 'BR', 'IN', 'KR', 'IR', 'UA', 'TR', 'PL'];

    const onIpFlow = (data: { ip: string; service: string; eventType: 'auth_success' | 'auth_failure'; deviceId: number }) => {
      const agents = agentsRef.current;
      const agent  = agents.find(a => a.id === data.deviceId) ?? agents[0];
      if (!agent) return;
      if (!filtersRef.current.has(data.eventType)) return;
      const col = data.eventType === 'auth_success' ? EVENT_COLORS.auth_success : EVENT_COLORS.auth_failure;
      const cc  = ccs[Math.floor(Math.random() * ccs.length)];
      upsertIp(data.ip, cc, agent.id,
        data.eventType === 'auth_failure' ? 'suspicious' : 'clean',
        data.eventType === 'auth_failure' ? 1 : 0,
        [data.service], 1, true);
      const node = ipsRef.current.get(data.ip);
      if (node) spawnParticle(node, agent.id, col);
      setLiveEvents(prev => [{
        id: Math.random().toString(36).slice(2),
        ip: data.ip, service: data.service, country: cc,
        time: new Date(), color: col, eventType: data.eventType,
      }, ...prev].slice(0, 40));
    };

    const onBanAuto = (data: { ip: string; service: string; failureCount: number }) => {
      const agents = agentsRef.current;
      let node = ipsRef.current.get(data.ip);
      if (!node && agents[0]) {
        upsertIp(data.ip, '??', agents[0].id, 'banned', data.failureCount, [data.service], 1, true);
        node = ipsRef.current.get(data.ip);
      } else if (node) {
        node.status = 'banned'; node.color = EVENT_COLORS.ban;
        node.glowUntil = Date.now() + 3000; node.lastSeen = Date.now();
      }
      if (node && filtersRef.current.has('ban')) spawnParticle(node, node.agentIds[0], EVENT_COLORS.ban);
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

  // ── Wheel zoom ────────────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const tr = transformRef.current;
      const newK = Math.min(Math.max(tr.k * factor, 0.15), 8);
      transformRef.current = {
        x: mx - (mx - tr.x) * (newK / tr.k),
        y: my - (my - tr.y) * (newK / tr.k),
        k: newK,
      };
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── Mouse ─────────────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY };
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x, dy = e.clientY - dragRef.current.y;
      dragRef.current = { ...dragRef.current, x: e.clientX, y: e.clientY };
      const tr = transformRef.current;
      transformRef.current = { ...tr, x: tr.x + dx, y: tr.y + dy };
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const tr = transformRef.current;
    const wx = (mx - tr.x) / tr.k, wy = (my - tr.y) / tr.k;
    for (const ip of ipsRef.current.values()) {
      if ((wx - ip.x) ** 2 + (wy - ip.y) ** 2 <= (ip.dotR + 7) ** 2) {
        setTooltip({ x: mx, y: my, ip: ip.ip, flag: ip.flag, country: ip.country,
          status: ip.status, failures: ip.failures, services: ip.services, color: ip.color });
        return;
      }
    }
    setTooltip(null);
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    dragRef.current = null; setIsDragging(false); setTooltip(null);
    if (!start) return;
    if (Math.sqrt((e.clientX - start.startX) ** 2 + (e.clientY - start.startY) ** 2) >= 5) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const tr = transformRef.current;
    const wx = (mx - tr.x) / tr.k, wy = (my - tr.y) / tr.k;
    for (const ag of agentsRef.current) {
      if ((wx - ag.x) ** 2 + (wy - ag.y) ** 2 <= (ag.r + 24) ** 2) {
        const newSel = selectedRef.current === ag.id ? null : ag.id;
        selectedRef.current = newSel;
        setSelectedAgent(newSel !== null ? agentsRef.current.find(a => a.id === newSel) ?? null : null);
        return;
      }
    }
    selectedRef.current = null; setSelectedAgent(null);
  }, []);

  const toggleFilter = useCallback((type: FlowType) => {
    setFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      filtersRef.current = next;
      return next;
    });
  }, []);

  const resetView = useCallback(() => { transformRef.current = { x: 0, y: 0, k: 1 }; }, []);

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-[#030310] overflow-hidden select-none">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-[#0a0a28] shrink-0 bg-[#050514]">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
          </span>
          <span className="font-mono text-[11px] tracking-widest text-cyan-900/50 uppercase">
            Obliguard · Network Graph
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
              <span className="font-mono text-[9px] text-slate-600 tracking-widest">{label}</span>
            </div>
          ))}
          <button
            onClick={() => void init()}
            className="ml-1 p-1.5 rounded border border-slate-800 text-slate-600 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Canvas area ─────────────────────────────────────────────────────── */}
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
            <p className="font-mono text-[10px] text-cyan-700 tracking-widest">BUILDING NETWORK GRAPH…</p>
          </div>
        )}

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div className="absolute top-4 left-4 bg-[#050514]/95 border border-slate-800/60 rounded-sm p-3 backdrop-blur-sm min-w-[152px] z-10">
          {selectedAgent ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="font-mono text-[8px] text-slate-500 tracking-widest uppercase">Agent Focus</div>
                <button
                  onClick={() => { selectedRef.current = null; setSelectedAgent(null); }}
                  className="text-slate-600 hover:text-cyan-400 transition-colors"
                >
                  <X size={10} />
                </button>
              </div>
              <div className="font-mono text-[11px] text-cyan-400 mb-1 truncate font-bold">{selectedAgent.label}</div>
              <div className="font-mono text-[9px] text-slate-500">
                {[...ipsRef.current.values()].filter(n => n.agentIds.includes(selectedAgent.id)).length} tracked IPs
              </div>
              <div className="font-mono text-[9px] text-slate-500 mb-2">{selectedAgent.eventCount} events</div>
              <div className="pt-2 border-t border-slate-800/50">
                <div className="font-mono text-[8px] text-slate-500 tracking-widest mb-1.5 uppercase">Top Threats</div>
                {[...ipsRef.current.values()]
                  .filter(n => n.agentIds.includes(selectedAgent.id))
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
              <div className="font-mono text-[8px] text-slate-500 tracking-widest mb-2 uppercase">Flow Types</div>
              {([
                { type: 'auth_success' as const, color: EVENT_COLORS.auth_success, label: 'Success' },
                { type: 'auth_failure' as const, color: EVENT_COLORS.auth_failure, label: 'Auth Failure' },
                { type: 'ban'          as const, color: EVENT_COLORS.ban,          label: 'Auto-Ban' },
              ]).map(({ type, color, label }) => {
                const on = filters.has(type);
                return (
                  <button key={type} onClick={() => toggleFilter(type)} className="flex items-center gap-2 py-[4px] w-full">
                    <div className="w-5 h-0.5 shrink-0 rounded" style={{ backgroundColor: on ? color : '#1e293b', boxShadow: on ? `0 0 4px ${color}` : 'none' }} />
                    <span className="font-mono text-[9px]" style={{ color: on ? '#94a3b8' : '#334155' }}>{label}</span>
                  </button>
                );
              })}

              <div className="mt-3 pt-2 border-t border-slate-800/50">
                <div className="font-mono text-[8px] text-slate-500 tracking-widest mb-1.5 uppercase">IP Status</div>
                {[
                  { label: 'Banned',     color: '#ef4444' },
                  { label: 'Suspicious', color: '#f97316' },
                  { label: 'Clean',      color: '#475569' },
                ].map(({ label, color }) => (
                  <div key={label} className="flex items-center gap-2 py-[2px]">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <span className="font-mono text-[8px] text-slate-500">{label}</span>
                  </div>
                ))}
              </div>

              <div className="mt-3 pt-2 border-t border-slate-800/50">
                <div className="font-mono text-[8px] text-slate-400 leading-[1.8]">
                  <div>Drag · Pan</div>
                  <div>Scroll · Zoom</div>
                  <div>Click agent · Focus</div>
                </div>
                <button
                  onClick={resetView}
                  className="mt-1.5 w-full font-mono text-[8px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-500 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors"
                >
                  ⌖ Reset View
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── Tooltip ─────────────────────────────────────────────────────── */}
        {tooltip && (
          <div
            className="absolute z-20 pointer-events-none bg-[#050514]/96 border border-slate-800/60 rounded p-2.5 backdrop-blur-sm"
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
                <span className="font-mono text-[8px] text-slate-600 uppercase tracking-wider w-14 shrink-0">{label}</span>
                <span className="font-mono text-[10px]" style={{ color: color ?? '#94a3b8' }}>{value}</span>
              </div>
            ))}
            {tooltip.services.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[8px] text-slate-600 uppercase tracking-wider w-14 shrink-0">Services</span>
                <span className="font-mono text-[10px] text-slate-500">{tooltip.services.slice(0, 4).join(', ')}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Bottom live feed ────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-[#0a0a28] bg-[#050514]">
        <div className="flex items-center gap-2 px-4 py-1 border-b border-[#080820]">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
          </span>
          <span className="font-mono text-[8px] text-slate-600 tracking-widest uppercase">Live Events</span>
          <span className="ml-auto font-mono text-[8px] text-slate-700">{liveEvents.length} captured</span>
        </div>
        <div className="h-[5.5rem] overflow-hidden px-4 py-1.5">
          {liveEvents.length === 0 ? (
            <span className="font-mono text-[10px] text-slate-700">Monitoring for events…</span>
          ) : (
            <div className="flex flex-col gap-0.5">
              {liveEvents.slice(0, 5).map(ev => (
                <div key={ev.id} className="flex items-center gap-2.5 font-mono text-[10px]">
                  <span className="text-slate-700 w-20 shrink-0">{ev.time.toLocaleTimeString()}</span>
                  <div className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: ev.color, boxShadow: `0 0 4px ${ev.color}` }} />
                  <span className="uppercase text-[8px] w-16 shrink-0 tracking-wide font-bold" style={{ color: ev.color }}>
                    {ev.eventType === 'auth_success' ? 'success' : ev.eventType === 'ban' ? '🔒 ban' : 'failure'}
                  </span>
                  <span className="uppercase w-10 shrink-0" style={{ color: svcColor(ev.service) }}>
                    {ev.service.slice(0, 8)}
                  </span>
                  <span className="text-slate-600 w-28 truncate shrink-0">{ev.ip}</span>
                  <span className="text-slate-700 shrink-0">→</span>
                  <span className="text-slate-600">{flagEmoji(ev.country)} {ev.country}</span>
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
