/**
 * NetMapPage — Obliguard Network Graph
 *
 * - Agents clustered near centre; repelled apart when their IP rings would collide
 * - IPs sorted by activity (most active = innermost ring), placed in 240° arc
 * - Faint orbital ring circles drawn at each ring radius around agents
 * - Multi-agent IPs at weighted centroid between agents, outside all rings
 * - Event particles ONLY on real socket events (no simulation)
 * - IPs refreshed via background API poll to stay alive while traffic continues
 *
 * Pure Canvas 2D — no WebGL, no extra dependencies.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Shield, Ban, Activity, RefreshCw, Zap, X, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { getSocket } from '../socket/socketClient';
import apiClient from '../api/client';
import { ipLabelsApi } from '../api/ipLabels.api';
import { anonHostname, anonIp } from '../utils/anonymize';

import type { AgentNode, IpNode, Particle, Ripple, LiveEvent, AgentPeerLink, WlEntry } from '../netmap/types';
import {
  IP_TTL, IP_FADE_AGE, IP_TTL_CLEAN, IP_TTL_SUSPICIOUS, IP_TTL_BANNED,
  PEER_LINK_TTL, RING_INNER_R,
  EVENT_COLORS, DANGEROUS_SVCS, PEER_LINK_COLOR, DEVICE_TYPE_COLORS,
} from '../netmap/constants';
import {
  flagEmoji, svcColor, isDangerousSvc, statusColor, agentExclusionR,
  ipToInt, matchWhitelist, makeOrbitalFields,
} from '../netmap/helpers';
import {
  placeIp, distributeIpsAroundAgents, relayoutIps, layoutAgents,
} from '../netmap/layout';
import { ForceSimulation } from '../netmap/physics';
import { useNetMapTabStore } from '../netmap/tabStore';


// ── Device type detection ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detectDeviceType(d: any): string {
  if (d.deviceType === 'mikrotik') return 'firewall';
  const os = (d.osInfo?.os ?? d.osInfo?.platform ?? '').toLowerCase();
  const host = (d.hostname ?? '').toLowerCase();
  if (os.includes('opnsense') || os.includes('pfsense') || host.includes('opn') || host.includes('pfsense')) return 'firewall';
  if (os.includes('routeros') || os.includes('mikrotik') || host.includes('mikrotik')) return 'firewall';
  if (os.includes('linux')) return 'server';
  if (os.includes('windows server') || os.includes('windows_server')) return 'server';
  if (os.includes('windows')) return 'windows';
  if (os.includes('darwin') || os.includes('macos')) return 'desktop';
  if (os.includes('freebsd')) return 'server';
  return 'default';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detectDeviceColor(d: any): string {
  return DEVICE_TYPE_COLORS[detectDeviceType(d)] ?? DEVICE_TYPE_COLORS.default;
}

/** Get IP TTL based on status. */
function ipTtlForStatus(status: string): number {
  if (status === 'banned') return IP_TTL_BANNED;
  if (status === 'suspicious') return IP_TTL_SUSPICIOUS;
  if (status === 'clean') return IP_TTL_CLEAN;
  return IP_TTL;
}

/** Compute orbit radius — spread IPs across varied distances from agent. */
function orbRadius(nodeR: number, slot: number, totalSlots: number): number {
  const minR = nodeR + 38;
  const maxR = nodeR + 38 + Math.min(80, totalSlots * 1.5);
  if (totalSlots <= 1) return minR + 10;
  // Distribute across the full range with some randomness per slot
  const t = slot / (totalSlots - 1);
  return minR + (maxR - minR) * t;
}

function hexRgb(h: string): [number, number, number] {
  const m = h.match(/#(..)(..)(..)/);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
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
  const ripplesRef   = useRef<Ripple[]>([]);
  /** Directed peer links between agent nodes (sourceId → targetId). */
  const agentLinksRef = useRef<Map<string, AgentPeerLink>>(new Map());

  /** Force-directed layout simulation. */
  const simRef = useRef<ForceSimulation | null>(null);
  /** Stars for animated flickering background. */
  const starsRef = useRef<{ x: number; y: number; s: number; b: number }[]>([]);

  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef      = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const selectedRef  = useRef<number | null>(null);
  const filtersRef   = useRef<Set<string>>(new Set(['auth_success', 'auth_failure', 'ban']));
  const sizeRef      = useRef({ w: 800, h: 600 });

  /** Debounce handles for per-agent mini-refresh triggered on pushHeartbeat. */
  const agentRefreshTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  /** Debounce handle for IP relayout after dynamic additions. */
  const relayoutTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Event IDs already added to live feed — deduplicates socket vs heartbeat. */
  const processedEventIdsRef      = useRef(new Set<number>());
  /** Timestamp of the oldest event in liveEvents — used as `to` cursor for scroll-load. */
  const oldestLiveTimestampRef    = useRef<string | undefined>(undefined);
  const liveEventsHasMoreRef      = useRef(true);
  const liveEventsLoadingMoreRef  = useRef(false);

  type FlowType = 'auth_success' | 'auth_failure' | 'ban';
  const [canvasSize,    setCanvasSize]    = useState({ w: 800, h: 600 });
  const [loading,       setLoading]       = useState(true);
  const [isDragging,    setIsDragging]    = useState(false);
  const [liveEvents,    setLiveEvents]    = useState<LiveEvent[]>([]);
  const [stats,         setStats]         = useState({ agents: 0, banned: 0, today: 0 });
  const [ipCount,       setIpCount]       = useState(0);
  const [filters,       setFilters]       = useState<Set<FlowType>>(new Set(['auth_success', 'auth_failure', 'ban']));
  const [selectedAgent, setSelectedAgent] = useState<AgentNode | null>(null);
  const [banningIp,     setBanningIp]     = useState<string | null>(null);
  const [socketOk,      setSocketOk]      = useState(false);
  const [orbitPaused,   setOrbitPaused]   = useState(false);
  const [clickedIp,     setClickedIp]     = useState<IpNode | null>(null);
  const [threatOnly,    setThreatOnly]    = useState(false);
  const [searchIp,      setSearchIp]      = useState('');
  const [searchHit,     setSearchHit]     = useState<string | null>(null);
  const orbitPausedRef  = useRef(false);
  const threatOnlyRef   = useRef(false);
  const searchHitRef    = useRef<string | null>(null);
  // Keep refs in sync
  orbitPausedRef.current = orbitPaused;
  threatOnlyRef.current = threatOnly;
  searchHitRef.current = searchHit;
  const [liveLoadingMore, setLiveLoadingMore] = useState(false);
  const [tooltip, setTooltip] = useState<{
    x: number; y: number;
    ip: string; flag: string; country: string;
    status: string; failures: number; services: string[]; color: string;
  } | null>(null);

  // ── Tab store ──────────────────────────────────────────────────────────────
  const { tabs, activeTabId, load: loadTabs, setActiveTab, addTab, updateTab, deleteTab } = useNetMapTabStore();
  const [showTabModal, setShowTabModal] = useState(false);
  const [tabFormName, setTabFormName] = useState('');
  const [tabFormAgentIds, setTabFormAgentIds] = useState<Set<number>>(new Set());
  const [editingTabId, setEditingTabId] = useState<string | null>(null);

  useEffect(() => { void loadTabs(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;
  const visibleAgentIdsRef = useRef<Set<number> | null>(null);
  visibleAgentIdsRef.current = activeTab ? new Set(activeTab.agentIds) : null;

  // ── Background ────────────────────────────────────────────────────────────

  const drawBg = useCallback((w: number, h: number) => {
    if (!bgRef.current) bgRef.current = document.createElement('canvas');
    const oc = bgRef.current;
    oc.width = w; oc.height = h;
    const ctx = oc.getContext('2d')!;
    ctx.fillStyle = '#06090f';
    ctx.fillRect(0, 0, w, h);
    // Nebulae (Oblimap style)
    const neb1 = ctx.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.4, w * 0.5);
    neb1.addColorStop(0, 'rgba(20,40,70,0.15)');
    neb1.addColorStop(0.5, 'rgba(15,25,50,0.08)');
    neb1.addColorStop(1, 'transparent');
    ctx.fillStyle = neb1; ctx.fillRect(0, 0, w, h);
    const neb2 = ctx.createRadialGradient(w * 0.75, h * 0.6, 0, w * 0.75, h * 0.6, w * 0.35);
    neb2.addColorStop(0, 'rgba(60,30,20,0.1)');
    neb2.addColorStop(1, 'transparent');
    ctx.fillStyle = neb2; ctx.fillRect(0, 0, w, h);
    // Generate star positions (drawn animated per-frame, not baked into bg)
    const starData: { x: number; y: number; s: number; b: number }[] = [];
    let s = 123456789;
    const rand = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
    for (let i = 0; i < 300; i++) {
      starData.push({ x: rand() * w, y: rand() * h, s: rand() * 1.2 + 0.3, b: rand() });
    }
    starsRef.current = starData;
    ctx.globalAlpha = 1;
  }, []);

  // ── Upsert IP ─────────────────────────────────────────────────────────────

  const upsertIp = useCallback((
    ip: string, country: string, agentId: number,
    status: string, failures: number, services: string[],
    evtCount = 0, glow = false,
  ) => {
    const agents = agentsRef.current;
    if (!agents.find(a => a.id === agentId)) return;
    const map = ipsRef.current;
    const now = Date.now();

    if (map.has(ip)) {
      const node = map.get(ip)!;
      // Never downgrade a whitelisted node on live events — the whitelist
      // takes permanent precedence over transient auth-failure/success events.
      if (node.status !== 'whitelisted') {
        node.status = status;
        node.color  = statusColor(status);
      }
      node.failures   = Math.max(node.failures, failures);
      node.services   = [...new Set([...node.services, ...services])];
      node.dotR       = 2.5 + Math.min(node.failures / 8, 5);
      node.lastSeen   = now;
      node.eventCount += evtCount;
      node.agentWeights[agentId] = (node.agentWeights[agentId] ?? 0) + evtCount;
      if (glow) node.glowUntil = now + 2500;
      if (!node.agentIds.includes(agentId)) {
        node.agentIds.push(agentId);
        placeIp(node, new Map(agents.map(a => [a.id, a])));
      }
    } else {
      const agentMap = new Map(agents.map(a => [a.id, a]));
      const ag = agentMap.get(agentId)!;
      const { w: cW, h: cH } = sizeRef.current;
      const node: IpNode = {
        key: ip, ip,
        country, flag: flagEmoji(country),
        agentIds: [agentId],
        agentWeights: { [agentId]: evtCount },
        x: ag.x, y: ag.y,
        dotR: 2.5 + Math.min(failures / 8, 5),
        color: statusColor(status),
        status, failures, services, eventCount: evtCount,
        lastSeen: now,
        glowUntil: glow ? now + 2500 : 0,
        ...makeOrbitalFields(ip, cW, cH),
      };
      placeIp(node, agentMap);
      map.set(ip, node);
      setIpCount(map.size);

      // Add to force simulation
      const sim = simRef.current;
      if (sim) {
        sim.addNode({
          id: `ip:${ip}`, x: node.x, y: node.y, vx: 0, vy: 0,
          pinned: false, mass: 0.5, kind: 'ip', radius: 0,
        });
        sim.upsertLink({
          sourceId: `ip:${ip}`, targetId: `a:${agentId}`,
          strength: 0.25, idealLength: RING_INNER_R + 10,
        });
        sim.reheat(0.15);
      }
    }
  }, []);

  // ── Event particle (real socket events only) ──────────────────────────────

  const spawnParticle = useCallback((ipNode: IpNode, agentId: number, color: string) => {
    const ag = agentsRef.current.find(a => a.id === agentId) ?? agentsRef.current[0];
    if (!ag) return;
    // Use the IP's current orbital position if it has arrived,
    // otherwise use its spawn position (edge of canvas) so the particle
    // visibly travels FROM the IP TO the agent.
    const srcX = ipNode.arriveT >= 1 ? ipNode.x : ipNode.spawnX;
    const srcY = ipNode.arriveT >= 1 ? ipNode.y : ipNode.spawnY;
    particlesRef.current = [...particlesRef.current.slice(-79), {
      id:    Math.random().toString(36).slice(2),
      sx: srcX, sy: srcY,
      tx: ag.x, ty: ag.y,
      t: 0, speed: 0.4 + Math.random() * 0.35, color,
    }];
  }, []);

  // ── Peer particle (agent → agent) ─────────────────────────────────────────

  const spawnPeerParticle = useCallback((sourceId: number, targetId: number, color: string) => {
    const src = agentsRef.current.find(a => a.id === sourceId);
    const tgt = agentsRef.current.find(a => a.id === targetId);
    if (!src || !tgt) return;
    particlesRef.current = [...particlesRef.current.slice(-79), {
      id: Math.random().toString(36).slice(2),
      sx: src.x, sy: src.y,
      tx: tgt.x, ty: tgt.y,
      t: 0, speed: 0.5 + Math.random() * 0.35, color,
    }];
  }, []);

  // ── Upsert peer link ───────────────────────────────────────────────────────

  const upsertPeerLink = useCallback((
    sourceId: number, targetId: number, type: 'lan' | 'wan', service: string,
  ) => {
    const key = `${sourceId}->${targetId}`;
    const now = Date.now();
    const map = agentLinksRef.current;
    const isNew = !map.has(key);
    if (!isNew) {
      const link = map.get(key)!;
      link.count++;
      link.lastSeen  = now;
      link.glowUntil = now + 2500;
      if (service && !link.services.includes(service)) link.services = [...link.services, service];
    } else {
      map.set(key, {
        key, sourceId, targetId, type,
        services: service ? [service] : [],
        count: 1, lastSeen: now, glowUntil: now + 2500,
      });
    }

    // Update force simulation spring between agents
    const sim = simRef.current;
    if (sim) {
      const count = map.get(key)?.count ?? 1;
      sim.upsertLink({
        sourceId: `a:${sourceId}`, targetId: `a:${targetId}`,
        strength: 0.04 * Math.log2(1 + count),
        idealLength: Math.max(60, 120 - Math.min(count * 2, 60)),
      });
      if (isNew) sim.reheat(0.8);
      else sim.reheat(0.1);
    }
  }, []);

  // ── Quick ban ─────────────────────────────────────────────────────────────

  const quickBan = useCallback(async (ip: string) => {
    setBanningIp(ip);
    try {
      await apiClient.post('/bans', { ip, reason: 'Manual ban from NetMap', scope: 'global' });
      const node = ipsRef.current.get(ip);
      if (node) {
        node.status    = 'banned';
        node.color     = EVENT_COLORS.ban;
        node.glowUntil = Date.now() + 3000;
        ripplesRef.current.push({ id: Math.random().toString(36).slice(2), x: node.x, y: node.y, t: 0 });
      }
      setStats(s => ({ ...s, banned: s.banned + 1 }));
      toast.success(`${ip} banned`);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || `Failed to ban ${ip}`);
    }
    finally { setBanningIp(null); }
  }, []);

  // ── Relayout IPs (debounced) ──────────────────────────────────────────────

  const scheduleRelayout = useCallback(() => {
    if (relayoutTimerRef.current) clearTimeout(relayoutTimerRef.current);
    relayoutTimerRef.current = setTimeout(() => {
      relayoutTimerRef.current = null;
      relayoutIps(agentsRef.current, [...ipsRef.current.values()]);
    }, 400);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live events scroll-load ───────────────────────────────────────────────

  const fetchOlderEvents = useCallback(async () => {
    if (liveEventsLoadingMoreRef.current || !liveEventsHasMoreRef.current) return;
    liveEventsLoadingMoreRef.current = true;
    setLiveLoadingMore(true);
    const to = oldestLiveTimestampRef.current;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await apiClient.get<{ data: any[] }>(
        '/ip-events',
        { params: { pageSize: 100, ...(to ? { to } : {}) } },
      ).catch(() => null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events = ((res?.data as any)?.data ?? []) as any[];
      if (events.length < 100) liveEventsHasMoreRef.current = false;

      const mapped: LiveEvent[] = events.map(ev => {
        const evType = (ev.event_type ?? ev.eventType ?? 'auth_success') as string;
        const svcKey = (ev.service ?? '').toLowerCase().split('/')[0];
        const col = DANGEROUS_SVCS.has(svcKey) ? '#ef4444'
          : evType === 'auth_success' ? EVENT_COLORS.auth_success : EVENT_COLORS.auth_failure;
        return {
          id: String(ev.id ?? Math.random()),
          ip: ev.ip as string,
          service: (ev.service ?? '') as string,
          country: '??',
          agentName: (ev.hostname ?? 'Agent') as string,
          time: new Date(ev.timestamp ?? ev.created_at),
          color: col,
          eventType: (evType === 'auth_success' ? 'auth_success' : 'auth_failure') as 'auth_success' | 'auth_failure',
        };
      });

      if (mapped.length > 0) {
        oldestLiveTimestampRef.current = mapped[mapped.length - 1].time.toISOString();
        setLiveEvents(prev => {
          const existingIds = new Set(prev.map(e => e.id));
          return [...prev, ...mapped.filter(e => !existingIds.has(e.id))];
        });
      }
    } finally {
      liveEventsLoadingMoreRef.current = false;
      setLiveLoadingMore(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Geo lookup ────────────────────────────────────────────────────────────

  const fetchGeoForUnknownIps = useCallback(async () => {
    const unknowns = [...ipsRef.current.values()]
      .filter(n => !n.country || n.country === '??')
      .map(n => n.ip).slice(0, 100);
    if (!unknowns.length) return;
    try {
      const res = await apiClient.post<{ data: { query: string; countryCode: string }[] }>(
        '/geo/batch', { ips: unknowns },
      );
      for (const row of (res.data?.data ?? [])) {
        const node = ipsRef.current.get(row.query);
        if (node && row.countryCode?.length === 2) {
          node.country = row.countryCode.toUpperCase();
          node.flag    = flagEmoji(node.country);
        }
      }
    } catch { /* ignore */ }
  }, []);

  // ── Background refresh (keeps IPs alive while traffic continues) ──────────

  useEffect(() => {
    const interval = setInterval(async () => {
      const agArr = agentsRef.current;
      if (!agArr.length) return;
      try {
        const now = Date.now();

        // 1. Events — refresh TTLs, merge services, upsert new IPs (no glow)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const evRes = await apiClient.get<{ data: any[] }>('/ip-events', { params: { pageSize: 300 } }).catch(() => null);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const ev of ((evRes?.data as any)?.data ?? []) as any[]) {
          const evIp = ev.ip as string | undefined;
          const aid  = (ev.deviceId ?? ev.device_id) as number | undefined;
          if (!evIp) continue;
          const node = ipsRef.current.get(evIp);
          if (node) {
            node.lastSeen = now;
            const svc = (ev.service ?? '') as string;
            if (svc && !node.services.includes(svc)) node.services = [...node.services, svc];
          } else if (aid && agArr.some(a => a.id === aid)) {
            const evType = (ev.eventType ?? ev.event_type) as string;
            const status = evType === 'auth_failure' ? 'suspicious' : 'clean';
            upsertIp(evIp, '??', aid, status, status === 'suspicious' ? 1 : 0,
              ev.service ? [ev.service as string] : [], 1, false);
          }
        }

        // 2. Reputation — update statuses + merge services
        const repRes = await apiClient.get<{
          data: { ip: string; status: string; totalFailures: number; affectedServices?: string[] }[]
        }>('/ip-reputation?limit=200').catch(() => null);
        for (const r of repRes?.data?.data ?? []) {
          const node = ipsRef.current.get(r.ip);
          if (!node) continue;
          if (node.status !== 'whitelisted') { node.status = r.status; node.color = statusColor(r.status); }
          node.failures = r.totalFailures;
          node.lastSeen = now;
          if (r.affectedServices?.length) node.services = [...new Set([...node.services, ...r.affectedServices])];
        }

        // 3. Ban stats
        const banRes = await apiClient.get<{ data: { active: number; today: number } }>('/bans/stats').catch(() => null);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bs = (banRes?.data as any)?.data;
        if (bs) setStats(s => ({ ...s, banned: bs.active, today: bs.today }));

        // 4. Agent online status — sync lastPushAt from updatedAt
        const devRes = await apiClient.get<{ data: { id: number; updatedAt: string }[] }>('/agent/devices').catch(() => null);
        for (const d of devRes?.data?.data ?? []) {
          const ag = agArr.find(a => a.id === d.id);
          if (ag && d.updatedAt) {
            const ts = new Date(d.updatedAt).getTime();
            if (ts > ag.lastPushAt) ag.lastPushAt = ts;
          }
        }

        setIpCount(ipsRef.current.size);
      } catch { /* ignore */ }
    }, 90_000); // every 90 s — full soft refresh (reputation, status); real-time updates via pushHeartbeat
    return () => clearInterval(interval);
  }, [upsertIp]);

  // ── Init ──────────────────────────────────────────────────────────────────

  const init = useCallback(async () => {
    setLoading(true);
    ipsRef.current       = new Map();
    agentLinksRef.current = new Map();
    particlesRef.current = [];
    ripplesRef.current   = [];
    setIpCount(0);

    try {
      const [devRes, evRes, banRes] = await Promise.all([
        apiClient.get<{ data: { id: number; hostname: string; name: string | null; status: string; updatedAt: string; wsConnected: boolean; groupId: number | null; groupName: string | null; deviceType?: string; osInfo?: { platform?: string; os?: string; hostname?: string } | null; resolvedSettings: { checkIntervalSeconds: number; maxMissedPushes: number } }[] }>('/agent/devices'),
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

      const agentEvtCount = new Map<number, number>();
      const ipToAgents    = new Map<string, Map<number, { count: number; failures: number; services: string[] }>>();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ev of evts as any[]) {
        const aid  = ev.deviceId ?? ev.device_id;
        const evIp = ev.ip;
        if (!aid || !evIp) continue;

        // Agent-to-agent peer event: record as a directed link, not as an IP node
        const srcAgentId = (ev.source_agent_id ?? ev.sourceAgentId) as number | null | undefined;
        if (srcAgentId) {
          const type = ((ev.source_ip_type ?? ev.sourceIpType) === 'wan' ? 'wan' : 'lan') as 'lan' | 'wan';
          const pKey = `${srcAgentId}->${aid}`;
          const existing = agentLinksRef.current.get(pKey);
          const svc = (ev.service ?? '') as string;
          if (existing) {
            existing.count++;
            if (svc && !existing.services.includes(svc)) existing.services = [...existing.services, svc];
          } else {
            agentLinksRef.current.set(pKey, {
              key: pKey, sourceId: srcAgentId, targetId: aid, type,
              services: svc ? [svc] : [],
              count: 1, lastSeen: Date.now(), glowUntil: 0,
            });
          }
          continue; // skip IP upsert for peer traffic
        }

        agentEvtCount.set(aid, (agentEvtCount.get(aid) ?? 0) + 1);
        if (!ipToAgents.has(evIp)) ipToAgents.set(evIp, new Map());
        const m = ipToAgents.get(evIp)!;
        if (!m.has(aid)) m.set(aid, { count: 0, failures: 0, services: [] });
        const e = m.get(aid)!;
        e.count++;
        if ((ev.eventType ?? ev.event_type) === 'auth_failure') e.failures++;
        const svc = ev.service ?? '';
        if (svc && !e.services.includes(svc)) e.services.push(svc);
      }

      const { w, h } = sizeRef.current;
      const placed = devs.length > 0
        ? devs.slice(0, 20)
        : [{ id: -1, hostname: 'Server', name: null, status: 'approved',
             updatedAt: '', wsConnected: true, groupId: null, groupName: null, deviceType: 'agent', osInfo: null, resolvedSettings: { checkIntervalSeconds: 60, maxMissedPushes: 2 } }];

      agentsRef.current = placed.map(d => {
        const lastPushAt      = d.updatedAt ? new Date(d.updatedAt).getTime() : 0;
        const checkIntervalMs = (d.resolvedSettings?.checkIntervalSeconds ?? 60) * 1000;
        const maxMissedPushes = d.resolvedSettings?.maxMissedPushes ?? 2;
        return {
          id:              d.id,
          label:           anonHostname((d.name ?? d.hostname)).slice(0, 22),
          x: w / 2, y: h / 2,
          r:               10 + Math.min((agentEvtCount.get(d.id) ?? 0) / 15, 22),
          eventCount:      agentEvtCount.get(d.id) ?? 0,
          phase:           ((d.id * 7919) % 100) / 100 * Math.PI * 2,
          lastPushAt,
          checkIntervalMs,
          maxMissedPushes,
          wsConnected:     d.wsConnected,
          groupId:         d.groupId ?? null,
          groupName:       d.groupName ?? null,
          deviceColor:     detectDeviceColor(d),
          deviceType:      detectDeviceType(d),
        };
      });
      layoutAgents(agentsRef.current, w, h);
      const agentMap = new Map(agentsRef.current.map(a => [a.id, a]));

      // IP reputation + whitelist labels + custom display names (parallel)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [repRes, wlRes, displayNamesRaw] = await Promise.all([
        apiClient.get<{
          data: { ip: string; geoCountryCode?: string | null; totalFailures: number; status: string; affectedServices?: string[] }[]
        }>('/ip-reputation?limit=200').catch(() => ({ data: { data: [] } })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apiClient.get<{ data: any[] }>('/whitelist').catch(() => ({ data: { data: [] } })),
        ipLabelsApi.list().catch(() => [] as import('../api/ipLabels.api').IpDisplayName[]),
      ]);
      // Build display-name lookup: ip → label
      const displayNameMap = new Map<string, string>();
      for (const entry of displayNamesRaw) {
        if (entry.ip && entry.label) displayNameMap.set(entry.ip, entry.label);
      }
      const repMap = new Map<string, { country: string; status: string; failures: number; services: string[] }>();
      for (const r of repRes.data?.data ?? []) {
        repMap.set(r.ip, {
          country:  r.geoCountryCode?.toUpperCase() ?? '??',
          status:   r.status,
          failures: r.totalFailures,
          services: r.affectedServices ?? [],
        });
      }
      // Build whitelist CIDR entries for matching.
      // Supports exact IPs, /32 single-host, and broader CIDRs like /24.
      const wlEntries: WlEntry[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const wl of (wlRes.data as any)?.data ?? []) {
        if (typeof wl.ip !== 'string') continue;
        const label = wl.label ?? null;
        if (!wl.ip.includes('/')) {
          const n = ipToInt(wl.ip);
          if (n >= 0) wlEntries.push({ networkInt: n, mask: 0xFFFFFFFF, label, plainIp: wl.ip });
        } else {
          const [net, pfxStr] = wl.ip.split('/');
          const pfx = parseInt(pfxStr, 10);
          if (isNaN(pfx) || pfx < 0 || pfx > 32) continue;
          const n = ipToInt(net);
          if (n < 0) continue;
          const mask = pfx === 0 ? 0 : (0xFFFFFFFF << (32 - pfx)) >>> 0;
          wlEntries.push({ networkInt: n, mask, label, plainIp: pfx === 32 ? net : null });
        }
      }

      // Build IP nodes
      const agArr = agentsRef.current;
      let cnt = 0;
      for (const [evIp, agentData] of ipToAgents) {
        if (cnt >= 200) break;
        const rep      = repMap.get(evIp);
        const validIds = [...agentData.keys()].filter(id => agArr.some(a => a.id === id));
        if (!validIds.length) continue;
        const allFailures = [...agentData.values()].reduce((s, e) => s + e.failures, 0);
        const allServices = [...new Set([...agentData.values()].flatMap(e => e.services))];
        const totalCount  = [...agentData.values()].reduce((s, e) => s + e.count, 0);
        const status      = rep?.status ?? (allFailures > 0 ? 'suspicious' : 'clean');
        // Skip clean IPs from history — they only appear via live socket events
        const wlMatch = matchWhitelist(evIp, wlEntries);
        if (status === 'clean' && !wlMatch) continue;
        // Build per-agent weight map
        const weights: Record<number, number> = {};
        for (const id of validIds) weights[id] = agentData.get(id)!.count;
        const node: IpNode = {
          key: evIp, ip: evIp,
          country:      rep?.country ?? '??',
          flag:         flagEmoji(rep?.country ?? '??'),
          agentIds:     validIds,
          agentWeights: weights,
          x: agArr[0]?.x ?? w / 2, y: agArr[0]?.y ?? h / 2,
          dotR:         2.5 + Math.min((rep?.failures ?? allFailures) / 8, 5),
          color:        statusColor(status),
          status, failures: rep?.failures ?? allFailures,
          services: allServices, eventCount: totalCount,
          lastSeen: Date.now(), glowUntil: 0,
          whitelistLabel: matchWhitelist(evIp, wlEntries)?.label,
          displayLabel:   displayNameMap.get(evIp) ?? null,
          ...makeOrbitalFields(evIp, w, h),
        };
        ipsRef.current.set(evIp, node);
        cnt++;
      }

      // Fill remaining from reputation
      for (const [repIp, rep] of repMap) {
        if (cnt >= 250) break;
        if (ipsRef.current.has(repIp)) continue;
        if (rep.status === 'clean') continue; // clean IPs only via live events
        let targetId = agArr[0]?.id ?? -1, minCnt = Infinity;
        for (const ag of agArr) {
          const c = [...ipsRef.current.values()].filter(n => n.agentIds[0] === ag.id).length;
          if (c < minCnt) { minCnt = c; targetId = ag.id; }
        }
        if (!agentMap.has(targetId)) continue;
        const node: IpNode = {
          key: repIp, ip: repIp,
          country: rep.country, flag: flagEmoji(rep.country),
          agentIds: [targetId], agentWeights: { [targetId]: 0 },
          x: agentMap.get(targetId)!.x, y: agentMap.get(targetId)!.y,
          dotR:     2.5 + Math.min(rep.failures / 8, 5),
          color:    statusColor(rep.status),
          status:   rep.status, failures: rep.failures, services: rep.services,
          eventCount: 0, lastSeen: Date.now(), glowUntil: 0,
          whitelistLabel: matchWhitelist(repIp, wlEntries)?.label,
          displayLabel:   displayNameMap.get(repIp) ?? null,
          ...makeOrbitalFields(repIp, w, h),
        };
        ipsRef.current.set(repIp, node);
        cnt++;
      }

      // Add single-host whitelist entries (/32 or exact IP) not yet on the map
      for (const wle of wlEntries) {
        if (!wle.plainIp || wle.mask !== 0xFFFFFFFF) continue; // skip broader CIDRs
        if (cnt >= 250) break;
        if (ipsRef.current.has(wle.plainIp)) continue; // handled by post-process pass below
        let targetId = agArr[0]?.id ?? -1, minCnt = Infinity;
        for (const ag of agArr) {
          const c = [...ipsRef.current.values()].filter(n => n.agentIds[0] === ag.id).length;
          if (c < minCnt) { minCnt = c; targetId = ag.id; }
        }
        if (!agentMap.has(targetId)) continue;
        const node: IpNode = {
          key: wle.plainIp, ip: wle.plainIp,
          country: '??', flag: flagEmoji('??'),
          agentIds: [targetId], agentWeights: { [targetId]: 0 },
          x: agentMap.get(targetId)!.x, y: agentMap.get(targetId)!.y,
          dotR: 3, color: '#22c55e',
          status: 'whitelisted', failures: 0, services: [],
          eventCount: 0, lastSeen: Date.now(), glowUntil: 0,
          whitelistLabel: wle.label,
          displayLabel:   displayNameMap.get(wle.plainIp) ?? null,
          ...makeOrbitalFields(wle.plainIp, w, h),
        };
        ipsRef.current.set(wle.plainIp, node);
        cnt++;
      }

      // Post-process: apply whitelist status + display names to ALL nodes.
      for (const node of ipsRef.current.values()) {
        const wlMatch = matchWhitelist(node.ip, wlEntries);
        if (wlMatch) {
          if (!node.whitelistLabel) node.whitelistLabel = wlMatch.label;
          node.status = 'whitelisted';
          node.color  = '#22c55e';
        }
        if (!node.displayLabel) node.displayLabel = displayNameMap.get(node.ip) ?? null;
      }

      // Batch layout with repulsion (initial geometric placement)
      distributeIpsAroundAgents(agentsRef.current, [...ipsRef.current.values()], w, h);

      // Assign orbit slots per agent — sequential so they don't overlap
      const slotCounters = new Map<number, number>();
      for (const ip of ipsRef.current.values()) {
        if (ip.agentIds.length === 1) {
          const aid = ip.agentIds[0];
          const slot = slotCounters.get(aid) ?? 0;
          ip.orbitSlot = slot;
          ip.arriveT = 1; // already on screen from init
          slotCounters.set(aid, slot + 1);
        } else {
          ip.orbitSlot = 0;
          ip.arriveT = 1;
        }
      }
      setIpCount(ipsRef.current.size);

      // ── Initialize force simulation with current positions ──────────────
      const sim = new ForceSimulation({ width: w, height: h });
      simRef.current = sim;

      // Add agent nodes
      for (const ag of agentsRef.current) {
        sim.addNode({
          id: `a:${ag.id}`, x: ag.x, y: ag.y, vx: 0, vy: 0,
          pinned: false, mass: 3.0, kind: 'agent',
          radius: agentExclusionR([...ipsRef.current.values()].filter(ip => ip.agentIds.length === 1 && ip.agentIds[0] === ag.id).length),
        });
      }

      // Add IP nodes
      for (const ip of ipsRef.current.values()) {
        sim.addNode({
          id: `ip:${ip.ip}`, x: ip.x, y: ip.y, vx: 0, vy: 0,
          pinned: false, mass: 0.5, kind: 'ip', radius: 0,
        });
        // Spring links from IP to each connected agent
        for (const aid of ip.agentIds) {
          const weight = ip.agentWeights[aid] ?? 1;
          const totalWeight = ip.agentIds.reduce((s, id) => s + (ip.agentWeights[id] ?? 1), 0) || 1;
          const ag = agentMap.get(aid);
          if (!ag) continue;
          const dist = Math.sqrt((ip.x - ag.x) ** 2 + (ip.y - ag.y) ** 2) || RING_INNER_R;
          sim.upsertLink({
            sourceId: `ip:${ip.ip}`, targetId: `a:${aid}`,
            strength: 0.25 * (weight / totalWeight),
            idealLength: dist,
          });
        }
      }

      // Add peer link springs (agent ↔ agent attraction)
      for (const pl of agentLinksRef.current.values()) {
        sim.upsertLink({
          sourceId: `a:${pl.sourceId}`, targetId: `a:${pl.targetId}`,
          strength: 0.04 * Math.log2(1 + pl.count),
          idealLength: Math.max(60, 120 - Math.min(pl.count * 2, 60)),
        });
      }

      // Let simulation settle with initial layout (don't animate from scratch)
      sim.alpha = 0.3;
    } catch (err) {
      console.error('NetMap init error:', err);
    }

    setLoading(false);
    void fetchGeoForUnknownIps();
  }, [fetchGeoForUnknownIps]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Animation loop ────────────────────────────────────────────────────────

  const animate = useCallback((ts: number) => {
    const canvas = canvasRef.current;
    if (!canvas) { rafRef.current = requestAnimationFrame(animate); return; }
    const ctx = canvas.getContext('2d')!;
    const { w, h } = sizeRef.current;
    const dt = Math.min((ts - lastTsRef.current) / 1000, 0.05);
    lastTsRef.current = ts;

    frameRef.current = (frameRef.current + 1) % 300;

    const now = Date.now(); // hoisted — used for age/fade throughout the frame

    // ── Force simulation tick (agents only — IPs orbit around them) ─────
    const sim = simRef.current;
    if (sim && sim.isActive) {
      sim.tick(3);
      for (const ag of agentsRef.current) {
        const sn = sim.getNode(`a:${ag.id}`);
        if (sn) { ag.x = sn.x; ag.y = sn.y; }
      }
    }

    // ── IP orbital motion ─────────────────────────────────────────────────
    const agMapFull = new Map(agentsRef.current.map(a => [a.id, a]));
    // Count IPs per agent for orbit scaling
    const ipsPerAgent = new Map<number, number>();
    for (const ip of ipsRef.current.values()) {
      if (ip.agentIds.length === 1) {
        const aid = ip.agentIds[0];
        ipsPerAgent.set(aid, (ipsPerAgent.get(aid) ?? 0) + 1);
      }
    }

    const paused = orbitPausedRef.current || clickedIp !== null;
    for (const ip of ipsRef.current.values()) {
      if (!paused) ip.orbitAngle += ip.orbitSpeed;

      // Arrival: fly from spawn point toward orbit target
      if (ip.arriveT < 1) ip.arriveT = Math.min(1, ip.arriveT + 0.0025);

      if (ip.agentIds.length === 1) {
        const ag = agMapFull.get(ip.agentIds[0]);
        if (!ag) continue;
        const totalIps = ipsPerAgent.get(ag.id) ?? 1;
        const orbR = orbRadius(ag.r, ip.orbitSlot, totalIps);
        const targetX = ag.x + Math.cos(ip.orbitAngle) * orbR;
        const targetY = ag.y + Math.sin(ip.orbitAngle) * orbR * ip.orbitEccentricity;
        if (ip.arriveT < 1) {
          ip.x = ip.spawnX + (targetX - ip.spawnX) * ip.arriveT;
          ip.y = ip.spawnY + (targetY - ip.spawnY) * ip.arriveT;
        } else {
          ip.x = targetX;
          ip.y = targetY;
        }
      } else if (ip.agentIds.length > 1) {
        // Multi-agent: elliptical orbit around weighted centroid
        const ags = ip.agentIds.map(id => agMapFull.get(id)).filter(Boolean) as AgentNode[];
        if (ags.length < 2) continue;
        const totalW = ags.reduce((s, ag) => s + (ip.agentWeights[ag.id] ?? 1), 0) || 1;
        let cx = 0, cy = 0;
        for (const ag of ags) { const wt = (ip.agentWeights[ag.id] ?? 1) / totalW; cx += ag.x * wt; cy += ag.y * wt; }
        const dx = ags[1].x - ags[0].x, dy = ags[1].y - ags[0].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 80;
        const linkAngle = Math.atan2(dy, dx);
        // Clamp ellipse to not exceed half the distance between agents
        const ex = Math.min(dist * 0.35, 60), ey = Math.min(Math.max(15, dist * 0.15), 35);
        const lx = ex * Math.cos(ip.orbitAngle), ly = ey * Math.sin(ip.orbitAngle);
        const cosA = Math.cos(linkAngle), sinA = Math.sin(linkAngle);
        const targetX = cx + lx * cosA - ly * sinA;
        const targetY = cy + lx * sinA + ly * cosA;
        if (ip.arriveT < 1) {
          ip.x = ip.spawnX + (targetX - ip.spawnX) * ip.arriveT;
          ip.y = ip.spawnY + (targetY - ip.spawnY) * ip.arriveT;
        } else {
          ip.x = targetX;
          ip.y = targetY;
        }
      }

      // Trail (shorter for perf)
      ip.trail.push({ x: ip.x, y: ip.y });
      if (ip.trail.length > 8) ip.trail.shift();
    }

    // IP + peer link expiry every ~5 s
    if (frameRef.current === 0) {
      let changed = false;
      for (const [key, ip] of ipsRef.current) {
        if (now - ip.lastSeen > ipTtlForStatus(ip.status)) { ipsRef.current.delete(key); changed = true; }
      }
      if (changed) setIpCount(ipsRef.current.size);
      // Peer link expiry
      for (const [key, link] of agentLinksRef.current) {
        if (now - link.lastSeen > PEER_LINK_TTL) agentLinksRef.current.delete(key);
      }
    }

    ctx.clearRect(0, 0, w, h);
    const bg = bgRef.current;
    if (bg && bg.width > 0) ctx.drawImage(bg, 0, 0);

    // Animated flickering stars (Oblimap style)
    for (const star of starsRef.current) {
      const flicker = 0.6 + 0.4 * Math.sin(ts * 0.002 + star.b * 100);
      ctx.fillStyle = `rgba(180,200,230,${flicker * 0.5})`;
      ctx.fillRect(star.x, star.y, star.s, star.s);
    }

    ctx.save();
    const { x, y, k } = transformRef.current;
    ctx.translate(x, y); ctx.scale(k, k);

    const selId   = selectedRef.current;
    const tabFilter = visibleAgentIdsRef.current;
    const agents  = tabFilter
      ? agentsRef.current.filter(a => tabFilter.has(a.id))
      : agentsRef.current;
    const agMap   = new Map(agents.map(a => [a.id, a]));
    let ipNodes = tabFilter
      ? [...ipsRef.current.values()].filter(ip => ip.agentIds.some(id => tabFilter.has(id)))
      : [...ipsRef.current.values()];
    // Threat-only filter
    if (threatOnlyRef.current) {
      ipNodes = ipNodes.filter(ip => ip.status === 'banned' || ip.status === 'suspicious');
    }

    // Precompute per-agent IP groups (for ring drawing, O(n) single pass)
    const ipsByAgent = new Map<number, number>(); // agentId → ip count
    for (const ip of ipNodes) {
      if (ip.agentIds.length === 1) {
        ipsByAgent.set(ip.agentIds[0], (ipsByAgent.get(ip.agentIds[0]) ?? 0) + 1);
      }
    }

    // ── Ripples (ban shockwaves) ─────────────────────────────────────────
    const aliveRipples: Ripple[] = [];
    for (const rip of ripplesRef.current) {
      rip.t += dt * 1.1;
      if (rip.t >= 1.0) continue;
      aliveRipples.push(rip);
      ctx.save();
      ctx.globalAlpha = (1 - rip.t) * 0.50;
      ctx.strokeStyle = '#ef4444';
      ctx.shadowBlur  = 10; ctx.shadowColor = '#ef4444';
      ctx.lineWidth   = 1.5 / k;
      ctx.beginPath(); ctx.arc(rip.x, rip.y, rip.t * 60, 0, Math.PI * 2);
      ctx.stroke(); ctx.restore();
    }
    ripplesRef.current = aliveRipples;

    // Build agent↔agent edges
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

    // ── Agent–agent edges (shared IP — undirected) ───────────────────────
    for (const edge of agentEdges) {
      const [ai, bi] = edge.split('-').map(Number);
      const a = agMap.get(ai), b = agMap.get(bi);
      if (!a || !b) continue;
      ctx.save();
      ctx.globalAlpha = selId !== null ? 0.04 : 0.14;
      ctx.strokeStyle = '#5588a0'; ctx.lineWidth = 0.9 / k;
      ctx.setLineDash([4, 8]); ctx.lineDashOffset = -(ts / 80) % 12;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }

    // ── Peer links (agent-to-agent real traffic — directed) ──────────────
    for (const link of agentLinksRef.current.values()) {
      const src = agMap.get(link.sourceId);
      const tgt = agMap.get(link.targetId);
      if (!src || !tgt) continue;
      const ageSec  = (now - link.lastSeen) / 1000;
      const fadeAge = PEER_LINK_TTL / 1000 - 15;
      const ageFade = ageSec < 15 ? 1 : Math.max(0, 1 - (ageSec - 15) / fadeAge);
      if (ageFade <= 0) continue;
      const color    = PEER_LINK_COLOR[link.type];
      const isRecent = ageSec < 8;
      const glow     = now < link.glowUntil;

      ctx.save();
      const linkThickness = Math.min(0.4 + Math.log2(1 + link.count) * 0.25, 1.5);
      ctx.globalAlpha = (selId !== null ? 0.20 : (isRecent ? 0.50 : 0.20)) * ageFade;
      ctx.strokeStyle = color;
      ctx.lineWidth   = (isRecent ? linkThickness * 1.1 : linkThickness * 0.6) / k;
      if (isRecent) {
        ctx.setLineDash([5, 8]);
        ctx.lineDashOffset = -(ts / 40) % 13; // animated dash flows src → tgt
        if (glow) { ctx.shadowBlur = 8; ctx.shadowColor = color; }
      }
      ctx.beginPath(); ctx.moveTo(src.x, src.y); ctx.lineTo(tgt.x, tgt.y);
      ctx.stroke(); ctx.setLineDash([]); ctx.shadowBlur = 0;

      // Arrowhead pointing at target
      const dx  = tgt.x - src.x, dy = tgt.y - src.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux  = dx / len, uy = dy / len;
      const tipX = tgt.x - ux * (tgt.r + 5), tipY = tgt.y - uy * (tgt.r + 5);
      const bx   = tipX - ux * 9,             by   = tipY - uy * 9;
      const px   = -uy * 4.5,                 py   = ux * 4.5;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(bx + px, by + py);
      ctx.lineTo(bx - px, by - py);
      ctx.closePath(); ctx.fill();

      // "LAN" / "WAN" midpoint label
      if (ageFade > 0.3 && len > 40) {
        const mx   = (src.x + tgt.x) / 2;
        const my   = (src.y + tgt.y) / 2;
        const lfs  = Math.round(Math.max(7, 9 * Math.min(k, 1.2)));
        ctx.font          = `600 ${lfs}px "Inter", "Segoe UI", ui-sans-serif, sans-serif`;
        ctx.globalAlpha   = 0.9 * ageFade;
        ctx.fillStyle     = color;
        ctx.textAlign     = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowBlur    = 5; ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.fillText(link.type.toUpperCase(), mx, my - 8);
        // Event count badge
        if (link.count > 1) {
          const cfs = Math.round(Math.max(6, 7.5 * Math.min(k, 1.2)));
          ctx.font      = `500 ${cfs}px "Inter", "Segoe UI", ui-sans-serif, sans-serif`;
          ctx.fillStyle = 'rgba(200,200,200,0.5)';
          ctx.fillText(`${link.count}×`, mx, my + 4);
        }
      }
      ctx.restore();
    }

    // ── Faint orbit ellipses around agents (mockup v5) ─────────────────
    for (const ag of agents) {
      const conns = ipsByAgent.get(ag.id) ?? 0;
      if (conns < 3) continue;
      const dimmed = selId !== null && selId !== ag.id;
      if (dimmed) continue;
      const maxR = orbRadius(ag.r, conns - 1, conns);
      const layers = Math.min(8, Math.ceil(Math.sqrt(conns * 2)));
      for (let i = 0; i < layers; i++) {
        const r = ag.r + (maxR - ag.r) * (i / layers);
        ctx.strokeStyle = `rgba(100,160,220,${0.02 + 0.005 * Math.min(conns, 50) / 50})`;
        ctx.lineWidth = 0.3;
        ctx.beginPath(); ctx.ellipse(ag.x, ag.y, r, r * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // ── IP orbit paths + link lines to agents ──────────────────────────────
    for (const ip of ipNodes) {
      if (ip.arriveT < 0.5) continue;
      const dimmed = selId !== null && !ip.agentIds.includes(selId);
      const ttl = ipTtlForStatus(ip.status);
      const ageMs = now - ip.lastSeen;
      const fadeStart = ttl * IP_FADE_AGE;
      const ageFade = ageMs < fadeStart ? 1 : Math.max(0, 1 - (ageMs - fadeStart) / (ttl - fadeStart));

      // Draw orbit ellipse path for multi-agent IPs
      if (ip.agentIds.length > 1 && !dimmed && ageFade > 0.1) {
        const ags = ip.agentIds.map(id => agMap.get(id)).filter(Boolean) as AgentNode[];
        if (ags.length >= 2) {
          const totalW = ags.reduce((s, ag) => s + (ip.agentWeights[ag.id] ?? 1), 0) || 1;
          let cx = 0, cy = 0;
          for (const ag of ags) { const wt = (ip.agentWeights[ag.id] ?? 1) / totalW; cx += ag.x * wt; cy += ag.y * wt; }
          const dx = ags[1].x - ags[0].x, dy = ags[1].y - ags[0].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 80;
          const linkAngle = Math.atan2(dy, dx);
          const ex = Math.min(dist * 0.35, 60), ey = Math.min(Math.max(15, dist * 0.15), 35);
          ctx.save();
          ctx.globalAlpha = 0.06 * ageFade;
          ctx.strokeStyle = ip.status === 'banned' ? '#ef4444' : ip.status === 'suspicious' ? '#f97316' : '#5a8aaa';
          ctx.lineWidth = 0.4 / k;
          ctx.setLineDash([2, 4]);
          ctx.translate(cx, cy); ctx.rotate(linkAngle);
          ctx.beginPath(); ctx.ellipse(0, 0, ex, ey, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      }

      const linkAlpha = (dimmed ? 0.02 : 0.06) * ageFade * ip.arriveT;
      for (const aid of ip.agentIds) {
        const ag = agMap.get(aid);
        if (!ag) continue;
        ctx.save();
        ctx.globalAlpha = linkAlpha;
        ctx.strokeStyle = ip.status === 'banned' ? '#ef4444' : ip.status === 'suspicious' ? '#f97316' : '#3a6a8a';
        ctx.lineWidth = 0.3 / k;
        ctx.beginPath(); ctx.moveTo(ip.x, ip.y); ctx.lineTo(ag.x, ag.y); ctx.stroke();
        ctx.restore();
      }
    }

    // ── IP dots ──────────────────────────────────────────────────────────

    for (const ip of ipNodes) {
      const dimmed  = selId !== null && !ip.agentIds.includes(selId);
      const glow    = now < ip.glowUntil;
      const ipTtl    = ipTtlForStatus(ip.status);
      const ipAgeMs  = now - ip.lastSeen;
      const ipFadeS  = ipTtl * IP_FADE_AGE;
      const ageFade  = ipAgeMs < ipFadeS ? 1 : Math.max(0, 1 - (ipAgeMs - ipFadeS) / (ipTtl - ipFadeS));
      const alpha   = (dimmed ? 0.10 : 0.85) * ageFade;

      // Trail (comet tail)
      if (ip.trail.length > 1 && !dimmed && alpha > 0.1) {
        for (let ti = 0; ti < ip.trail.length - 1; ti++) {
          const ta = (ti / ip.trail.length) * alpha * 0.2;
          ctx.fillStyle = `rgba(${ip.status === 'banned' ? '226,75,74' : ip.status === 'suspicious' ? '249,115,22' : ip.status === 'whitelisted' ? '93,202,165' : '130,160,195'},${ta})`;
          ctx.beginPath(); ctx.arc(ip.trail[ti].x, ip.trail[ti].y, 0.6 / k, 0, Math.PI * 2); ctx.fill();
        }
      }

      // Persistent banned pulse (slow throb)
      if (ip.status === 'banned' && !dimmed) {
        const pulse = (Math.sin(ts / 800) + 1) / 2;
        ctx.save();
        ctx.globalAlpha = 0.08 + 0.10 * pulse;
        ctx.shadowBlur  = ip.dotR * 4; ctx.shadowColor = '#ef4444';
        ctx.fillStyle   = '#ef444430';
        ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR * 2.5 + pulse * 3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      // Suspicious high-failure ripple (every ~3s)
      if (ip.status === 'suspicious' && ip.failures > 10 && !dimmed) {
        const cycle = (ts % 3000) / 3000;
        if (cycle < 0.4) {
          const t = cycle / 0.4;
          ctx.save();
          ctx.globalAlpha = (1 - t) * 0.15;
          ctx.strokeStyle = '#f97316'; ctx.lineWidth = 0.8 / k;
          ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR + t * 15, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
      }

      if (glow && !dimmed) {
        const pulse = (Math.sin(ts / 220) + 1) / 2;
        ctx.save();
        ctx.globalAlpha = 0.20 * pulse;
        ctx.shadowBlur  = ip.dotR * 5; ctx.shadowColor = ip.color;
        ctx.fillStyle   = ip.color + '40';
        ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR * 2.8, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      // IP dot — small and subtle, mockup v5 style
      const bc = ip.status === 'banned' ? [226, 75, 74]
               : ip.status === 'suspicious' ? [249, 168, 37]
               : ip.status === 'whitelisted' ? [93, 202, 165]
               : [130, 160, 195]; // clean = neutral blue-gray
      ctx.save();
      ctx.shadowBlur = 1.5 * Math.min(k, 2); ctx.shadowColor = `rgba(${bc[0]},${bc[1]},${bc[2]},${alpha * 0.25})`;
      ctx.fillStyle = `rgba(${bc[0]},${bc[1]},${bc[2]},${alpha * 0.95})`;
      ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();

      // IP label — only for IPs with a custom display label
      if (ip.displayLabel && !dimmed && alpha > 0.2 && k > 0.5) {
        ctx.save();
        ctx.font = `500 ${Math.round(7 * Math.min(k, 1.3))}px "Inter", "Segoe UI", ui-sans-serif, sans-serif`;
        ctx.fillStyle = `rgba(${bc[0]},${bc[1]},${bc[2]},${alpha * 0.6})`;
        ctx.textAlign = 'center';
        ctx.shadowBlur = 4; ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.fillText(ip.displayLabel, ip.x, ip.y - ip.dotR - 3 * Math.min(k, 1.3));
        ctx.restore();
      }

      // Search highlight — pulsing ring on matched IP
      if (searchHitRef.current === ip.ip) {
        const sp = (Math.sin(ts / 200) + 1) / 2;
        ctx.save();
        ctx.globalAlpha = 0.5 + sp * 0.3;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 / k;
        ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR + 6 + sp * 4, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }

    // ── Agent nodes (mockup v5 style) ─────────────────────────────────
    for (const agent of agents) {
      const isSel    = selId === agent.id;
      const dimmed   = selId !== null && !isSel;
      const isOnline = agent.wsConnected;
      const conns    = ipsByAgent.get(agent.id) ?? 0;
      const breathe  = 1 + Math.min(conns * 0.002, 0.06) * Math.sin(ts * 0.003 + agent.phase);
      const col      = agent.deviceColor;
      const rgb      = hexRgb(col);
      const effR     = agent.r * breathe;
      const sx       = agent.x, sy = agent.y;

      // Heat glow for heavily targeted agents
      if (conns > 25) {
        const heatR = effR + Math.min(conns, 120) * 1.2;
        const hg = ctx.createRadialGradient(sx, sy, effR, sx, sy, heatR);
        hg.addColorStop(0, `rgba(226,75,74,${Math.min(0.06, conns * 0.0005)})`);
        hg.addColorStop(0.6, `rgba(245,166,35,${Math.min(0.03, conns * 0.0003)})`);
        hg.addColorStop(1, 'transparent');
        ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(sx, sy, heatR, 0, Math.PI * 2); ctx.fill();
      }

      // Firewall shield arcs (rotating partial arcs)
      if (agent.deviceType === 'firewall') {
        for (let i = 1; i <= 2; i++) {
          const rr = effR * (1.3 + i * 0.5);
          const rot = ts * 0.0004 * (i % 2 ? 1 : -1);
          ctx.save(); ctx.translate(sx, sy); ctx.rotate(rot);
          ctx.beginPath(); ctx.arc(0, 0, rr, -0.2, Math.PI * 0.35);
          ctx.strokeStyle = `rgba(245,166,35,${0.03 / i})`; ctx.lineWidth = 0.5; ctx.stroke();
          ctx.beginPath(); ctx.arc(0, 0, rr, Math.PI * 0.7, Math.PI * 1.1);
          ctx.strokeStyle = `rgba(245,166,35,${0.02 / i})`; ctx.stroke();
          ctx.restore();
        }
      }

      // Body — gradient with bright core (mockup style)
      const grd = ctx.createRadialGradient(sx - effR * 0.2, sy - effR * 0.2, effR * 0.05, sx, sy, effR);
      grd.addColorStop(0, 'rgba(255,255,255,0.25)');
      grd.addColorStop(0.3, col);
      grd.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.1)`);
      ctx.globalAlpha = dimmed ? 0.2 : (isOnline ? 1 : 0.35);
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(sx, sy, effR, 0, Math.PI * 2); ctx.fill();

      // Bright inner core
      ctx.shadowBlur = effR * 0.5; ctx.shadowColor = col;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(sx, sy, effR * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;

      // Hover ring
      if (isSel) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sx, sy, agent.r + 5, 0, Math.PI * 2); ctx.stroke();
      }

      ctx.globalAlpha = 1;

      // Label BELOW agent (mockup style)
      if (k > 0.4) {
        const fs = Math.round((agent.r >= 15 ? 10 : 8.5) * Math.min(k, 1.3));
        ctx.font = `500 ${fs}px "Inter", "Segoe UI", ui-sans-serif, sans-serif`;
        ctx.fillStyle = dimmed ? 'rgba(200,220,240,0.2)' : 'rgba(200,220,240,0.8)';
        ctx.textAlign = 'center';
        ctx.fillText(agent.label, sx, sy + effR + 10 * Math.min(k, 1.3));

        // IP count + group name
        if (conns > 0 && k > 0.5 && !dimmed) {
          ctx.font = `${Math.round(7.5 * Math.min(k, 1.2))}px "Inconsolata", "JetBrains Mono", monospace`;
          ctx.fillStyle = conns > 50 ? 'rgba(226,75,74,0.55)' : conns > 15 ? 'rgba(245,166,35,0.45)' : 'rgba(93,202,165,0.4)';
          ctx.fillText(conns + ' IPs', sx, sy + effR + 19 * Math.min(k, 1.3));
        }

        // Group name (subtle)
        if (agent.groupName && k > 0.6 && !dimmed) {
          const yOff = conns > 0 ? 27 : 19;
          ctx.font = `${Math.round(6.5 * Math.min(k, 1.2))}px "Inter", "Segoe UI", ui-sans-serif, sans-serif`;
          ctx.fillStyle = 'rgba(100,140,190,0.28)';
          ctx.fillText(agent.groupName.toUpperCase(), sx, sy + effR + yOff * Math.min(k, 1.3));
        }

        // Offline label
        if (!isOnline) {
          ctx.font = `500 ${Math.round(7 * Math.min(k, 1.2))}px "Inter", ui-sans-serif, sans-serif`;
          ctx.fillStyle = 'rgba(226,75,74,0.5)';
          ctx.fillText('OFFLINE', sx, sy - effR - 6);
        }
      }
    }

    // ── Event particles (real socket events only — no simulation) ─────────
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

    // ── Minimap ──────────────────────────────────────────────────────────
    if (agents.length > 2) {
      const mmW = 150, mmH = 100;
      const mmX = w - mmW - 12, mmY = h - mmH - 12;

      // Compute world bounds from agents only
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const ag of agents) {
        minX = Math.min(minX, ag.x); minY = Math.min(minY, ag.y);
        maxX = Math.max(maxX, ag.x); maxY = Math.max(maxY, ag.y);
      }
      const pad = 40;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const wRange = maxX - minX || 1, hRange = maxY - minY || 1;
      const mmScale = Math.min(mmW / wRange, mmH / hRange);
      const toMmX = (px: number) => mmX + (px - minX) * mmScale;
      const toMmY = (py: number) => mmY + (py - minY) * mmScale;

      // Background
      ctx.save();
      ctx.fillStyle = 'rgba(3,2,2,0.75)';
      ctx.strokeStyle = 'rgba(80,60,30,0.3)';
      ctx.lineWidth = 1;
      ctx.fillRect(mmX, mmY, mmW, mmH);
      ctx.strokeRect(mmX, mmY, mmW, mmH);

      // Agent dots only (no IPs on minimap)
      for (const ag of agents) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = ag.wsConnected ? '#22d3ee' : '#64748b';
        ctx.beginPath(); ctx.arc(toMmX(ag.x), toMmY(ag.y), 2.5, 0, Math.PI * 2); ctx.fill();
      }

      // Viewport rectangle
      const vpLeft   = (-x / k - minX) * mmScale;
      const vpTop    = (-y / k - minY) * mmScale;
      const vpWidth  = (w / k) * mmScale;
      const vpHeight = (h / k) * mmScale;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(mmX + vpLeft, mmY + vpTop, vpWidth, vpHeight);

      ctx.restore();
    }

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
        // Update simulation bounds and sync positions
        if (simRef.current) {
          simRef.current.setBounds(w, h);
          for (const ag of agentsRef.current) {
            const sn = simRef.current.getNode(`a:${ag.id}`);
            if (sn) { sn.x = ag.x; sn.y = ag.y; }
          }
          for (const ip of ipsRef.current.values()) {
            const sn = simRef.current.getNode(`ip:${ip.ip}`);
            if (sn) { sn.x = ip.x; sn.y = ip.y; }
          }
          simRef.current.reheat(0.3);
        }
      }, 250);
    });
    obs.observe(el);
    return () => { obs.disconnect(); clearTimeout(timer); };
  }, [drawBg]);

  // ── Initial live events load ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    apiClient.get('/ip-events', { params: { pageSize: 100 } })
      .then(res => {
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const events = ((res.data as any).data ?? []) as any[];
        const mapped: LiveEvent[] = events.map(ev => {
          const evId   = ev.id as number | undefined;
          if (evId) processedEventIdsRef.current.add(evId);
          const evType = (ev.event_type ?? ev.eventType ?? 'auth_success') as string;
          const svcKey = (ev.service ?? '').toLowerCase().split('/')[0];
          const col = DANGEROUS_SVCS.has(svcKey) ? '#ef4444'
            : evType === 'auth_success' ? EVENT_COLORS.auth_success : EVENT_COLORS.auth_failure;
          return {
            id: String(evId ?? Math.random()),
            ip: ev.ip as string,
            service: (ev.service ?? '') as string,
            country: '??',
            agentName: (ev.hostname ?? 'Agent') as string,
            time: new Date(ev.timestamp ?? ev.created_at),
            color: col,
            eventType: (evType === 'auth_success' ? 'auth_success' : 'auth_failure') as 'auth_success' | 'auth_failure',
          };
        });
        setLiveEvents(mapped);
        if (mapped.length > 0) {
          oldestLiveTimestampRef.current = mapped[mapped.length - 1].time.toISOString();
        }
        if (events.length < 100) liveEventsHasMoreRef.current = false;
      })
      .catch(() => {}); // silently ignore — live events stay empty until socket fires
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Socket events ─────────────────────────────────────────────────────────

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const ccs = ['US', 'CN', 'RU', 'DE', 'FR', 'BR', 'IN', 'KR', 'IR', 'UA', 'TR', 'PL'];

    const onIpFlow = (data: {
      ip: string; service: string; eventType: 'auth_success' | 'auth_failure'; deviceId: number;
      sourceAgentId?: number | null; sourceIpType?: 'lan' | 'wan' | null;
    }) => {
      const agents = agentsRef.current;
      const agent  = agents.find(a => a.id === data.deviceId) ?? agents[0];
      if (!agent) return;
      if (!filtersRef.current.has(data.eventType)) return;

      // Agent-to-agent peer traffic: draw a directed link, don't show as IP node
      if (data.sourceAgentId) {
        const type    = (data.sourceIpType ?? 'lan') as 'lan' | 'wan';
        const col     = PEER_LINK_COLOR[type];
        upsertPeerLink(data.sourceAgentId, data.deviceId, type, data.service ?? '');
        spawnPeerParticle(data.sourceAgentId, data.deviceId, col);
        const srcAgent = agents.find(a => a.id === data.sourceAgentId);
        setLiveEvents(prev => [{
          id: Math.random().toString(36).slice(2),
          ip: data.ip, service: data.service, country: type.toUpperCase(),
          agentName: `${srcAgent?.label ?? '?'} → ${agent.label}`,
          time: new Date(), color: col, eventType: data.eventType,
        }, ...prev].slice(0, 100));
        return;
      }

      const svcKey = (data.service ?? '').toLowerCase().split('/')[0];
      const col = DANGEROUS_SVCS.has(svcKey)
        ? '#ef4444' // red for dangerous services (SSH, RDP, MySQL…) regardless of success/failure
        : data.eventType === 'auth_success' ? EVENT_COLORS.auth_success : EVENT_COLORS.auth_failure;
      const cc  = ccs[Math.floor(Math.random() * ccs.length)];
      upsertIp(data.ip, cc, agent.id,
        data.eventType === 'auth_failure' ? 'suspicious' : 'clean',
        data.eventType === 'auth_failure' ? 1 : 0,
        [data.service], 1, true);
      const node = ipsRef.current.get(data.ip);
      if (node) spawnParticle(node, agent.id, col);
      scheduleRelayout();
      setLiveEvents(prev => [{
        id: Math.random().toString(36).slice(2),
        ip: data.ip, service: data.service, country: cc,
        agentName: agent.label,
        time: new Date(), color: col, eventType: data.eventType,
      }, ...prev].slice(0, 100));
    };

    const onBanAuto = (data: { ip: string; service: string; failureCount: number; deviceId?: number }) => {
      const agents = agentsRef.current;
      const agent  = agents.find(a => a.id === data.deviceId) ?? agents[0];
      let node = ipsRef.current.get(data.ip);
      if (!node && agents[0]) {
        upsertIp(data.ip, '??', agents[0].id, 'banned', data.failureCount, [data.service], 1, true);
        node = ipsRef.current.get(data.ip);
      } else if (node) {
        node.status    = 'banned'; node.color = EVENT_COLORS.ban;
        node.glowUntil = Date.now() + 3000; node.lastSeen = Date.now();
      }
      if (node) {
        ripplesRef.current.push({ id: Math.random().toString(36).slice(2), x: node.x, y: node.y, t: 0 });
        if (filtersRef.current.has('ban')) spawnParticle(node, node.agentIds[0], EVENT_COLORS.ban);
      }
      setLiveEvents(prev => [{
        id: Math.random().toString(36).slice(2),
        ip: data.ip, service: data.service, country: node?.country ?? '??',
        agentName: agent?.label ?? 'Server',
        time: new Date(), color: EVENT_COLORS.ban, eventType: 'ban' as const,
        failures: data.failureCount,
      }, ...prev].slice(0, 100));
      setStats(s => ({ ...s, today: s.today + 1, banned: s.banned + 1 }));
    };

    const onPushHeartbeat = (data: { deviceId: number }) => {
      // 1. Immediately update lastPushAt so online indicator is accurate
      const agent = agentsRef.current.find(a => a.id === data.deviceId);
      if (agent) agent.lastPushAt = Date.now();

      // 2. Debounced mini-refresh per agent (1.5 s cooldown so a 2 s push cycle
      //    results in one fetch per agent shortly after each push, not per-event).
      const prev = agentRefreshTimersRef.current.get(data.deviceId);
      if (prev) clearTimeout(prev);
      const t = setTimeout(async () => {
        agentRefreshTimersRef.current.delete(data.deviceId);
        const tsNow = Date.now();
        const since = new Date(tsNow - 90_000).toISOString();
        try {
          // Fetch recent events for this agent only
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const evRes = await apiClient.get<{ data: any[] }>(
            '/ip-events',
            { params: { deviceId: data.deviceId, pageSize: 60, from: since } },
          ).catch(() => null);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const events = ((evRes?.data as any)?.data ?? []) as any[];
          const ag     = agentsRef.current.find(a => a.id === data.deviceId);
          let hasNew   = false;
          const newLive: LiveEvent[] = [];

          for (const ev of events) {
            const evIp = ev.ip as string | undefined;
            if (!evIp) continue;

            // Agent-to-agent peer event: update peer link, skip IP upsert
            const srcAgentId = (ev.source_agent_id ?? ev.sourceAgentId) as number | null | undefined;
            if (srcAgentId) {
              const type = ((ev.source_ip_type ?? ev.sourceIpType) === 'wan' ? 'wan' : 'lan') as 'lan' | 'wan';
              upsertPeerLink(srcAgentId, data.deviceId, type, (ev.service ?? '') as string);
              continue;
            }

            const node = ipsRef.current.get(evIp);
            if (node) {
              node.lastSeen = tsNow;
              const svc = (ev.service ?? '') as string;
              if (svc && !node.services.includes(svc)) node.services = [...node.services, svc];
            } else {
              // New IP not yet on the map
              const evType = (ev.event_type ?? ev.eventType ?? '') as string;
              const status = evType === 'auth_failure' ? 'suspicious' : 'clean';
              upsertIp(evIp, '??', data.deviceId, status,
                status === 'suspicious' ? 1 : 0,
                ev.service ? [ev.service as string] : [], 1, false);
              hasNew = true;
            }

            // Feed live events that are < 30 s old and not already shown
            const evId  = ev.id as number | undefined;
            const evTs  = new Date(ev.timestamp ?? ev.created_at ?? 0).getTime();
            if (tsNow - evTs < 30_000 && (!evId || !processedEventIdsRef.current.has(evId))) {
              if (evId) {
                processedEventIdsRef.current.add(evId);
                if (processedEventIdsRef.current.size > 500) {
                  const it = processedEventIdsRef.current.values();
                  processedEventIdsRef.current.delete(it.next().value!);
                }
              }
              const evType = (ev.event_type ?? ev.eventType ?? '') as string;
              const svcKey = (ev.service ?? '').toLowerCase().split('/')[0];
              const col    = DANGEROUS_SVCS.has(svcKey) ? '#ef4444'
                : evType === 'auth_success' ? EVENT_COLORS.auth_success : EVENT_COLORS.auth_failure;
              const liveNode = ipsRef.current.get(evIp);
              if (liveNode && ag) spawnParticle(liveNode, ag.id, col);
              newLive.push({
                id:        String(evId ?? Math.random()),
                ip:        evIp,
                service:   (ev.service ?? '') as string,
                country:   liveNode?.country ?? '??',
                agentName: ag?.label ?? 'Agent',
                time:      new Date(evTs),
                color:     col,
                eventType: evType === 'auth_success' ? 'auth_success' : 'auth_failure',
              });
            }
          }

          if (newLive.length > 0) {
            setLiveEvents(prev => [...newLive, ...prev].slice(0, 100));
          }
          if (hasNew) scheduleRelayout();

          // Refresh ban stats
          const banRes = await apiClient.get<{ data: { active: number; today: number } }>(
            '/bans/stats',
          ).catch(() => null);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bs = (banRes?.data as any)?.data;
          if (bs) setStats(s => ({ ...s, banned: bs.active, today: bs.today }));
          setIpCount(ipsRef.current.size);
        } catch { /* ignore */ }
      }, 1_500);
      agentRefreshTimersRef.current.set(data.deviceId, t);
    };

    socket.on('ip:flow',             onIpFlow);
    socket.on('ban:auto',            onBanAuto);
    socket.on('agent:pushHeartbeat', onPushHeartbeat);
    return () => {
      socket.off('ip:flow',             onIpFlow);
      socket.off('ban:auto',            onBanAuto);
      socket.off('agent:pushHeartbeat', onPushHeartbeat);
      // Clear any pending timers on cleanup
      agentRefreshTimersRef.current.forEach(t => clearTimeout(t));
      agentRefreshTimersRef.current.clear();
      if (relayoutTimerRef.current) clearTimeout(relayoutTimerRef.current);
    };
  }, [upsertIp, spawnParticle, spawnPeerParticle, upsertPeerLink, scheduleRelayout]);

  // ── Socket connection status ───────────────────────────────────────────────

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onConnect    = () => setSocketOk(true);
    const onDisconnect = () => setSocketOk(false);
    setSocketOk(socket.connected);
    socket.on('connect',    onConnect);
    socket.on('disconnect', onDisconnect);
    return () => { socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); };
  }, []);

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
      if ((wx - ip.x) ** 2 + (wy - ip.y) ** 2 <= (ip.dotR + 12) ** 2) {
        setTooltip({ x: mx, y: my, ip: anonIp(ip.ip), flag: ip.flag, country: ip.country,
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

    // IP click → open side panel
    for (const ip of ipsRef.current.values()) {
      if ((wx - ip.x) ** 2 + (wy - ip.y) ** 2 <= (ip.dotR + 12) ** 2) {
        setClickedIp(ip);
        return;
      }
    }

    // Agent click → focus
    for (const ag of agentsRef.current) {
      if ((wx - ag.x) ** 2 + (wy - ag.y) ** 2 <= (ag.r + 24) ** 2) {
        const newSel = selectedRef.current === ag.id ? null : ag.id;
        selectedRef.current = newSel;
        setSelectedAgent(newSel !== null ? agentsRef.current.find(a => a.id === newSel) ?? null : null);
        setClickedIp(null);
        return;
      }
    }
    selectedRef.current = null; setSelectedAgent(null); setClickedIp(null);
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
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-[#06090f] overflow-hidden select-none">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-[#110c04] shrink-0 bg-[#070502]">
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
          {/* Search IP */}
          <form onSubmit={(e) => {
            e.preventDefault();
            const q = searchIp.trim();
            if (!q) { setSearchHit(null); return; }
            const node = ipsRef.current.get(q);
            if (node) {
              setSearchHit(q);
              transformRef.current = { x: -node.x + sizeRef.current.w / 2, y: -node.y + sizeRef.current.h / 2, k: 2 };
              setTimeout(() => setSearchHit(null), 4000);
            } else {
              toast.error('IP not on map');
            }
            setSearchIp('');
          }} className="ml-2">
            <input
              type="text"
              value={searchIp}
              onChange={e => setSearchIp(e.target.value)}
              placeholder="Search IP…"
              className="w-28 px-2 py-0.5 rounded border border-slate-800 bg-transparent text-[11px] font-mono text-slate-400 placeholder-slate-700 focus:border-cyan-500/40 focus:outline-none"
            />
          </form>

          {/* Threat only toggle */}
          <button
            onClick={() => setThreatOnly(t => !t)}
            className={`px-2 py-0.5 rounded text-[10px] font-mono tracking-wider border transition-colors ${
              threatOnly
                ? 'bg-red-500/15 text-red-400 border-red-500/30'
                : 'text-slate-600 border-slate-800 hover:text-slate-400'
            }`}
          >
            {threatOnly ? '⚠ THREATS' : '⚠ ALL'}
          </button>

          <button
            onClick={() => void init()}
            className="ml-1 p-1.5 rounded border border-slate-800 text-slate-600 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Tab bar ──────────────────────────────────────────────────────────── */}
      {(tabs.length > 0 || activeTabId !== null) ? (
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-[#110c04] bg-[#050302] shrink-0 overflow-x-auto">
          <button
            onClick={() => setActiveTab(null)}
            className={`px-3 py-1 rounded text-[11px] font-mono tracking-wide transition-colors ${
              !activeTabId
                ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30'
                : 'text-slate-600 hover:text-slate-400 border border-transparent'
            }`}
          >
            All
          </button>
          {[...tabs].sort((a, b) => a.sortOrder - b.sortOrder).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setEditingTabId(tab.id);
                setTabFormName(tab.name);
                setTabFormAgentIds(new Set(tab.agentIds));
                setShowTabModal(true);
              }}
              className={`px-3 py-1 rounded text-[11px] font-mono tracking-wide transition-colors ${
                activeTabId === tab.id
                  ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                  : 'text-slate-600 hover:text-slate-400 border border-transparent'
              }`}
            >
              {tab.name}
              <span className="ml-1.5 text-[9px] text-slate-700">{tab.agentIds.length}</span>
            </button>
          ))}
          <button
            onClick={() => {
              setEditingTabId(null);
              setTabFormName('');
              setTabFormAgentIds(new Set());
              setShowTabModal(true);
            }}
            className="px-2 py-1 rounded text-[11px] font-mono text-slate-700 hover:text-cyan-400 border border-transparent hover:border-cyan-500/20 transition-colors"
            title="New tab"
          >
            +
          </button>
        </div>
      ) : (
        <div className="flex items-center px-4 py-1.5 border-b border-[#110c04] bg-[#050302] shrink-0">
          <button
            onClick={() => {
              setEditingTabId(null);
              setTabFormName('');
              setTabFormAgentIds(new Set());
              setShowTabModal(true);
            }}
            className="px-3 py-1 rounded text-[11px] font-mono text-slate-700 hover:text-cyan-400 border border-dashed border-slate-800 hover:border-cyan-500/20 transition-colors"
          >
            + Create view
          </button>
        </div>
      )}

      {/* ── Tab create/edit modal ──────────────────────────────────────────── */}
      {showTabModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowTabModal(false)}>
          <div className="bg-[#0a0806] border border-[#1a1408] rounded-lg p-5 w-80 max-h-[70vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-300 mb-3">
              {editingTabId ? 'Edit View' : 'New View'}
            </h3>
            <input
              type="text"
              value={tabFormName}
              onChange={e => setTabFormName(e.target.value)}
              placeholder="View name"
              className="w-full px-3 py-1.5 rounded border border-[#1a1408] bg-[#050302] text-sm text-slate-300 placeholder-slate-700 focus:border-cyan-500/30 focus:outline-none mb-3"
              autoFocus
            />
            <div className="text-[10px] text-slate-600 uppercase tracking-widest mb-2">Agents</div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {agentsRef.current.map(ag => (
                <label key={ag.id} className="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer py-0.5">
                  <input
                    type="checkbox"
                    checked={tabFormAgentIds.has(ag.id)}
                    onChange={() => {
                      const next = new Set(tabFormAgentIds);
                      if (next.has(ag.id)) next.delete(ag.id); else next.add(ag.id);
                      setTabFormAgentIds(next);
                    }}
                    className="accent-cyan-500"
                  />
                  {ag.label}
                </label>
              ))}
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => {
                  if (!tabFormName.trim() || tabFormAgentIds.size === 0) return;
                  if (editingTabId) {
                    updateTab(editingTabId, { name: tabFormName.trim(), agentIds: [...tabFormAgentIds] });
                  } else {
                    addTab({ name: tabFormName.trim(), agentIds: [...tabFormAgentIds] });
                  }
                  setShowTabModal(false);
                }}
                disabled={!tabFormName.trim() || tabFormAgentIds.size === 0}
                className="px-3 py-1.5 rounded text-xs font-medium bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 disabled:opacity-40 transition-colors"
              >
                {editingTabId ? 'Save' : 'Create'}
              </button>
              {editingTabId && (
                <button
                  onClick={() => { deleteTab(editingTabId); setShowTabModal(false); }}
                  className="px-3 py-1.5 rounded text-xs font-medium text-red-400 border border-red-500/20 hover:bg-red-500/10 transition-colors"
                >
                  Delete
                </button>
              )}
              <button
                onClick={() => setShowTabModal(false)}
                className="px-3 py-1.5 rounded text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

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
        <div className="absolute top-4 left-4 bg-[#070502]/95 border border-[#1a1208]/60 rounded-sm p-3 backdrop-blur-sm min-w-[152px] z-10">
          {selectedAgent ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="font-mono text-[8px] text-slate-500 tracking-widest uppercase">Agent Focus</div>
                <button onClick={() => { selectedRef.current = null; setSelectedAgent(null); }} className="text-slate-600 hover:text-cyan-400 transition-colors">
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
                      <span className="font-mono text-[8px] truncate" style={{ color: n.color }}>{n.flag} {anonIp(n.ip).slice(0, 14)}</span>
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
                {[{ label: 'Whitelisted', color: '#22c55e' }, { label: 'Banned', color: '#ef4444' }, { label: 'Suspicious', color: '#f97316' }, { label: 'Clean', color: '#475569' }].map(({ label, color }) => (
                  <div key={label} className="flex items-center gap-2 py-[2px]">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <span className="font-mono text-[8px] text-slate-500">{label}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-2 border-t border-slate-800/50">
                <div className="font-mono text-[8px] text-slate-400 leading-[1.8]">
                  <div>Drag · Pan</div><div>Scroll · Zoom</div><div>Click agent · Focus</div>
                </div>
                <button onClick={resetView} className="mt-1.5 w-full font-mono text-[8px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-500 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors">
                  ⌖ Reset View
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── Tooltip ─────────────────────────────────────────────────────── */}
        {tooltip && (
          <div
            className="absolute z-20 pointer-events-none rounded p-3 max-w-[280px]"
            style={{
              left: tooltip.x + 14,
              top: tooltip.y - 8,
              backgroundColor: 'rgba(7,5,2,0.97)',
              border: '1px solid rgba(60,45,20,0.7)',
              boxShadow: '0 4px 24px rgba(0,0,0,0.8)',
              transform: tooltip.x > canvasSize.w * 0.70 ? 'translateX(-110%)' : undefined,
            }}
          >
            <div className="font-mono text-[15px] mb-2 font-bold" style={{ color: tooltip.color }}>
              {tooltip.flag} {tooltip.ip}
            </div>
            {[
              { label: 'Country',  value: tooltip.country },
              { label: 'Status',   value: tooltip.status.toUpperCase(), color: tooltip.color },
              { label: 'Failures', value: tooltip.failures.toLocaleString(), color: '#fb923c' },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex items-center gap-2 mb-1.5">
                <span className="font-mono text-[11px] text-slate-500 uppercase tracking-wider w-16 shrink-0">{label}</span>
                <span className="font-mono text-[13px]" style={{ color: color ?? '#94a3b8' }}>{value}</span>
              </div>
            ))}
            {tooltip.services.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="font-mono text-[11px] text-slate-500 uppercase tracking-wider w-16 shrink-0 mt-px">Services</span>
                <span className="font-mono text-[12px] text-slate-400 leading-relaxed">
                  {tooltip.services.join(', ')}
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── Pause button ──────────────────────────────────────────────────── */}
        <button
          onClick={() => setOrbitPaused(p => !p)}
          className={`absolute bottom-3 left-3 z-20 px-2.5 py-1 rounded text-[10px] font-mono tracking-wider border transition-colors ${
            orbitPaused
              ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
              : 'text-slate-600 border-slate-800 hover:text-slate-400 hover:border-slate-600'
          }`}
        >
          {orbitPaused ? '▶ RESUME' : '❚❚ PAUSE'}
        </button>

        {/* ── Agent side panel (on click) ────────────────────────────────────── */}
        {selectedAgent && !clickedIp && (
          <div className="absolute top-0 right-0 z-30 w-72 h-full bg-[rgba(5,12,22,0.95)] border-l border-[rgba(90,138,181,0.2)] p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <span className="font-mono text-xs text-slate-500 uppercase tracking-widest">Agent Detail</span>
              <button onClick={() => { selectedRef.current = null; setSelectedAgent(null); }} className="text-slate-500 hover:text-white text-lg leading-none">&times;</button>
            </div>
            <div className="font-mono text-sm font-semibold mb-1" style={{ color: selectedAgent.deviceColor }}>
              {selectedAgent.label}
            </div>
            <div className="text-[10px] uppercase tracking-wider mb-4" style={{ color: selectedAgent.wsConnected ? '#5DCAA5' : '#E24B4A' }}>
              {selectedAgent.wsConnected ? 'ONLINE' : 'OFFLINE'} · {selectedAgent.deviceType}
            </div>
            <div className="space-y-2 text-xs mb-4">
              {[
                { label: 'Group', value: selectedAgent.groupName ?? '—' },
                { label: 'Events', value: String(selectedAgent.eventCount) },
                { label: 'Orbiting IPs', value: String([...ipsRef.current.values()].filter(n => n.agentIds.includes(selectedAgent.id)).length) },
              ].map(r => (
                <div key={r.label} className="flex justify-between">
                  <span className="text-slate-500">{r.label}</span>
                  <span className="text-slate-300 font-mono">{r.value}</span>
                </div>
              ))}
            </div>
            {/* Recent IPs */}
            <div className="mb-4">
              <div className="text-[9px] text-slate-600 uppercase tracking-widest mb-2">Recent IPs</div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {[...ipsRef.current.values()]
                  .filter(n => n.agentIds.includes(selectedAgent.id))
                  .sort((a, b) => b.lastSeen - a.lastSeen)
                  .slice(0, 15)
                  .map(n => (
                    <button key={n.key} onClick={() => setClickedIp(n)}
                      className="flex items-center gap-2 w-full text-left py-0.5 hover:bg-white/5 rounded px-1 transition-colors">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: n.status === 'banned' ? '#ef4444' : n.status === 'suspicious' ? '#f59e0b' : '#82a0c3' }} />
                      <span className="font-mono text-[10px] text-slate-400 truncate">{anonIp(n.ip)}</span>
                      <span className="ml-auto font-mono text-[9px] text-slate-600">{n.failures > 0 ? `${n.failures}×` : ''}</span>
                    </button>
                  ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Link to={`/agents/${selectedAgent.id}`} onClick={() => { selectedRef.current = null; setSelectedAgent(null); }}
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-cyan-400 border border-cyan-500/25 hover:bg-cyan-500/10 text-center transition-colors">
                View Agent Page
              </Link>
            </div>
          </div>
        )}

        {/* ── IP side panel (on click) ──────────────────────────────────────── */}
        {clickedIp && (
          <div className="absolute top-0 right-0 z-30 w-72 h-full bg-[rgba(5,12,22,0.95)] border-l border-[rgba(90,138,181,0.2)] p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <span className="font-mono text-xs text-slate-500 uppercase tracking-widest">IP Detail</span>
              <button onClick={() => setClickedIp(null)} className="text-slate-500 hover:text-white text-lg leading-none">&times;</button>
            </div>
            <div className="font-mono text-sm font-semibold mb-1" style={{ color: clickedIp.color }}>
              {clickedIp.flag} {anonIp(clickedIp.ip)}
            </div>
            <div className="text-[10px] uppercase tracking-wider mb-4" style={{ color: clickedIp.status === 'banned' ? '#E24B4A' : clickedIp.status === 'suspicious' ? '#F5A623' : '#5DCAA5' }}>
              {clickedIp.status}
            </div>
            <div className="space-y-2 text-xs mb-4">
              {[
                { label: 'Country', value: clickedIp.country },
                { label: 'Failures', value: String(clickedIp.failures) },
                { label: 'Events', value: String(clickedIp.eventCount) },
              ].map(r => (
                <div key={r.label} className="flex justify-between">
                  <span className="text-slate-500">{r.label}</span>
                  <span className="text-slate-300 font-mono">{r.value}</span>
                </div>
              ))}
            </div>
            {/* Per-agent per-service breakdown */}
            <div className="mb-4">
              <div className="text-[9px] text-slate-600 uppercase tracking-widest mb-2">Connections</div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {(() => {
                  // Build breakdown: for each agent this IP touched, count per service
                  const lines: { agentName: string; service: string; count: number }[] = [];
                  for (const aid of clickedIp.agentIds) {
                    const ag = agentsRef.current.find(a => a.id === aid);
                    const agName = ag?.label ?? `Agent #${aid}`;
                    // Count from live events matching this IP + agent
                    const svcCounts = new Map<string, number>();
                    for (const ev of liveEvents) {
                      if (ev.ip === anonIp(clickedIp.ip) && ev.agentName === agName) {
                        const svc = ev.service || 'unknown';
                        svcCounts.set(svc, (svcCounts.get(svc) ?? 0) + 1);
                      }
                    }
                    // Fallback: if no live events matched, show services from IP node
                    if (svcCounts.size === 0) {
                      for (const svc of clickedIp.services) {
                        svcCounts.set(svc, clickedIp.agentWeights[aid] ?? 1);
                      }
                    }
                    for (const [svc, cnt] of svcCounts) {
                      lines.push({ agentName: agName, service: svc, count: cnt });
                    }
                  }
                  if (lines.length === 0) {
                    return <div className="text-slate-600 text-[11px]">No connection data</div>;
                  }
                  return lines.sort((a, b) => b.count - a.count).map((l, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] font-mono">
                      <span className="text-amber-400/70 min-w-[2.5rem] text-right">{l.count}×</span>
                      <span className="text-cyan-400/80 uppercase text-[10px]">{l.service}</span>
                      <span className="text-slate-600">→</span>
                      <span className="text-slate-400 truncate">{l.agentName}</span>
                    </div>
                  ));
                })()}
              </div>
            </div>
            <div className="space-y-1.5">
              <button onClick={() => { void quickBan(clickedIp.ip); setClickedIp(null); }}
                className="w-full px-3 py-1.5 rounded text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/25 transition-colors">
                Ban IP
              </button>
              <a href={`https://www.abuseipdb.com/check/${clickedIp.ip}`} target="_blank" rel="noopener noreferrer"
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-slate-400 border border-slate-700 hover:border-slate-500 text-center transition-colors">
                AbuseIPDB
              </a>
              <a href={`https://www.shodan.io/host/${clickedIp.ip}`} target="_blank" rel="noopener noreferrer"
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-slate-400 border border-slate-700 hover:border-slate-500 text-center transition-colors">
                Shodan
              </a>
              <a href={`https://www.virustotal.com/gui/ip-address/${clickedIp.ip}`} target="_blank" rel="noopener noreferrer"
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-slate-400 border border-slate-700 hover:border-slate-500 text-center transition-colors">
                VirusTotal
              </a>
              <Link to={`/ip-reputation?search=${clickedIp.ip}`} onClick={() => setClickedIp(null)}
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-cyan-400 border border-cyan-500/25 hover:bg-cyan-500/10 text-center transition-colors">
                View in IP Reputation
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom live feed ────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-[#110c04] bg-[#070502]">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-1.5 border-b border-[#150e05]">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>
          <span className="font-mono text-[11px] text-slate-500 tracking-widest uppercase">Live Events</span>
          <span className="ml-auto flex items-center gap-3">
            <span className="font-mono text-[10px] text-slate-600">{liveEvents.length} captured</span>
            <Link
              to="/live-events"
              className="flex items-center gap-1 font-mono text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
              title="Open full live events page"
            >
              <ExternalLink size={11} />
              <span>View all</span>
            </Link>
            <span
              className={`w-2 h-2 rounded-full ${socketOk ? 'bg-cyan-500' : 'bg-red-600'}`}
              title={socketOk ? 'Socket connected' : 'Socket disconnected'}
            />
          </span>
        </div>

        {/* Scrollable event list */}
        <div
          className="h-[13rem] overflow-y-auto px-3 py-1.5"
          onScroll={e => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
              void fetchOlderEvents();
            }
          }}
        >
          {liveEvents.length === 0 ? (
            <span className="font-mono text-[11px] text-slate-700 pl-1">Monitoring for events…</span>
          ) : (
            <div className="flex flex-col gap-0.5">
              {liveEvents.map(ev => {
                const isBan     = ev.eventType === 'ban';
                const isFailure = ev.eventType === 'auth_failure';
                const dangerSvc = isDangerousSvc(ev.service);
                return (
                  <div
                    key={ev.id}
                    className={`flex items-center gap-2 font-mono rounded px-1.5 py-[3px] ${
                      isBan ? 'bg-red-950/35' : isFailure ? 'bg-orange-950/25' : ''
                    }`}
                  >
                    <span className="text-slate-600 w-[5.5rem] shrink-0 text-[11px]">
                      {ev.time.toLocaleTimeString()}
                    </span>
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: ev.color, boxShadow: `0 0 4px ${ev.color}` }}
                    />
                    <span
                      className="uppercase text-[11px] w-12 shrink-0 tracking-wide font-bold"
                      style={{ color: ev.color }}
                    >
                      {isBan ? '🔒 BAN' : isFailure ? 'FAIL' : 'OK'}
                    </span>
                    <span
                      className={`uppercase text-[11px] w-12 shrink-0 font-semibold ${dangerSvc ? 'text-red-400' : ''}`}
                      style={dangerSvc ? {} : { color: svcColor(ev.service) }}
                    >
                      {(ev.service || '?').slice(0, 8).toUpperCase()}
                    </span>
                    <button
                      onClick={() => {
                        const ipNode = ipsRef.current.get(ev.ip);
                        if (ipNode) setClickedIp(ipNode);
                      }}
                      className={`text-[12px] w-[7.5rem] shrink-0 truncate text-left hover:underline cursor-pointer ${
                        isBan ? 'line-through text-red-400/55' : isFailure ? 'text-orange-300/75' : 'text-slate-400'
                      }`}
                    >
                      {anonIp(ev.ip)}
                    </button>
                    <span className="text-slate-700 shrink-0 text-[10px]">▸</span>
                    <span className="text-slate-500 text-[11px] shrink-0">
                      {anonHostname(ev.agentName || 'Server')}
                    </span>
                    {ev.failures != null && ev.failures > 0 && (
                      <span className="text-orange-700/60 text-[11px] shrink-0">{ev.failures}×</span>
                    )}
                    {!isBan && (
                      <button
                        onClick={() => void quickBan(ev.ip)}
                        disabled={banningIp === ev.ip}
                        className="ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono border border-red-900/40 text-red-700/60 hover:text-red-400 hover:border-red-500/50 transition-colors disabled:opacity-40 leading-none"
                        title={`Ban ${anonIp(ev.ip)}`}
                      >
                        {banningIp === ev.ip ? '…' : '⛔'}
                      </button>
                    )}
                  </div>
                );
              })}

              {/* Scroll-load status */}
              {liveLoadingMore && (
                <div className="py-1.5 text-center">
                  <span className="font-mono text-[10px] text-slate-700">Loading older events…</span>
                </div>
              )}
              {!liveEventsHasMoreRef.current && liveEvents.length >= 100 && (
                <div className="py-1.5 text-center">
                  <span className="font-mono text-[10px] text-slate-800">— end of records —</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
