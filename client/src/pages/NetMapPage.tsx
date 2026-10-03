/**
 * NetMapPage — Obliguard Network Graph
 *
 * - Agents clustered near centre; repelled apart when their IP rings would collide
 * - IPs sorted by activity (most active = innermost ring), placed in 240° arc
 * - Faint orbital ring circles drawn at each ring radius around agents
 * - Multi-agent IPs at weighted centroid between agents, outside all rings
 * - Event particles ONLY on real socket events (no simulation)
 * - Live data from the batched ip:events frames and the ban events; a 90 s
 *   soft refresh keeps statuses and counters in step
 *
 * Pure Canvas 2D — no WebGL, no extra dependencies. The map keeps a fixed dark
 * "space" look whatever the app theme; its colours come from NETMAP_PALETTE.
 */

import { useEffect, useRef, useState, useCallback, lazy, Suspense, type CSSProperties } from 'react';
import { Shield, Ban, Activity, RefreshCw, Zap, X, ExternalLink, Box, Grid2x2, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SOCKET_EVENTS } from '@obliview/shared';
import type {
  BanAutoEvent, BanBulkLiftedEvent, BanExclusionEvent, BanLiftedEvent, IpBan, IpEventsFrame, IpFlowEvent,
} from '@obliview/shared';
import { useIpsPermissions } from '@/hooks/useIpsPermissions';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useIpActions } from '@/components/ip/IpDetailDrawer';
import { useIpDrawer, useIpChanged, notifyIpChanged } from '@/hooks/useIpDrawer';
import { useTenantStore } from '@/store/tenantStore';
import { ipReputationApi, apiErrorMessage } from '@/api/ipReputation.api';

const NetMap3D = lazy(() => import('../netmap3d/NetMap3D'));
import type { NetMap3DLabels } from '../netmap3d/NetMap3D';
import { getSocket } from '../socket/socketClient';
import { useSocketStore } from '../store/socketStore';
import { SOCKET_RESYNC_EVENT } from '../hooks/useSocket';
import apiClient from '../api/client';
import { ipLabelsApi } from '../api/ipLabels.api';
import { anonHostname, anonIp } from '../utils/anonymize';

import type { AgentNode, IpNode, Particle, Ripple, LiveEvent, AgentPeerLink, WlEntry } from '../netmap/types';
import {
  IP_FADE_AGE, PEER_LINK_TTL, RING_INNER_R,
  EVENT_COLORS, PEER_LINK_COLOR, NETMAP_PALETTE, NETMAP_CSS_VARS, rgba,
} from '../netmap/constants';
import {
  flagEmoji, svcColor, isDangerousSvc, statusColor,
  ipToInt, matchWhitelist, makeOrbitalFields,
  detectDeviceType, detectDeviceColor, ipTtlForStatus, dotRgb, trailRgb, threatLineColor,
  liveEventColor, hexRgb, orbitRingCount, orbitRingRadius, agentOrbitOuterR, orbRadius,
} from '../netmap/helpers';
import {
  placeIp, distributeIpsAroundAgents, relayoutIps, layoutAgents,
} from '../netmap/layout';
import {
  type FlowRow, flowRowFromStream, flowRowFromLegacy, feedType, liveEventFromRest,
  mergeLiveEvents, appendOlderEvents, SEEN_EVENT_IDS_CAP,
} from '../netmap/liveEvents';
import { ForceSimulation } from '../netmap/physics';
import { useNetMapTabStore, type NetMapTab } from '../netmap/tabStore';
import { NetMapTabDialog } from '../netmap/NetMapTabDialog';

const P = NETMAP_PALETTE;
const FONT_UI = '"Inter", "Segoe UI", ui-sans-serif, sans-serif';
const FONT_MONO = '"Inconsolata", "JetBrains Mono", monospace';

/** Status order of the live path: an event never downgrades banned. */
const STATUS_RANK: Record<string, number> = { clean: 0, suspicious: 1, banned: 2 };

/** /agent/devices row as read by the map. */
interface MapDevice {
  id: number;
  hostname: string;
  name: string | null;
  status: string;
  updatedAt: string;
  wsConnected: boolean;
  groupId: number | null;
  groupName: string | null;
  deviceType?: string;
  evaluateOnly?: boolean;
  osInfo?: { platform?: string; os?: string; hostname?: string } | null;
  resolvedSettings: { checkIntervalSeconds: number; maxMissedPushes: number };
}

interface UpsertIpOpts {
  /** Country code when known ('??' otherwise). */
  country?: string;
  /** Observed status: raises clean → suspicious → banned, never lowers it. */
  status: string;
  /** Known absolute failure count (max-merged). */
  failures?: number;
  /** Live failures to add to the node's count. */
  addFailures?: number;
  services?: string[];
  evtCount?: number;
  glow?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function NetMapPage() {
  const { t } = useTranslation();
  // Manual bans follow the operating tenant (Default = global, else local);
  // the ban / whitelist actions are shown only with their capability.
  const { canBan, canWhitelist, isGodView } = useIpsPermissions();
  const confirm = useConfirm();
  const ipActions = useIpActions();
  const { open: openIpDrawer } = useIpDrawer();
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  const currentTenantIdRef = useRef(currentTenantId);
  currentTenantIdRef.current = currentTenantId;

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
  /** Per-agent orbit slot counter for golden-angle distribution. */
  const slotCountersRef = useRef(new Map<number, number>());
  /** Per-agent smooth ring count (float, lerps toward integer target). */
  const agentDisplayedRingsRef = useRef(new Map<number, number>());

  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef      = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const selectedRef  = useRef<number | null>(null);
  const filtersRef   = useRef<Set<string>>(new Set(['auth_success', 'auth_failure', 'ban']));
  const sizeRef      = useRef({ w: 800, h: 600 });

  /** Debounce handle for IP relayout after dynamic additions. */
  const relayoutTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Debounce handle for the geo lookup of new IPs. */
  const geoTimerRef           = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Event IDs already in the live feed — deduplicates the initial load vs. socket frames. */
  const processedEventIdsRef      = useRef(new Set<number>());
  /** Set by the first ip:events frame: the legacy ip:flow pings are then ignored. */
  const ipEventsSeenRef           = useRef(false);
  /** Ban id → IP, learnt from the ban events (a Lift only carries the id). */
  const banIpsRef                 = useRef(new Map<number, string>());
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
  const [viewMode,      setViewMode]      = useState<'2d' | '3d'>(() => {
    try { return localStorage.getItem('obliguard-netmap-viewmode') === '3d' ? '3d' : '2d'; } catch { return '2d'; }
  });
  const [searchIp,      setSearchIp]      = useState('');
  const [searchHit,     setSearchHit]     = useState<string | null>(null);
  const orbitPausedRef  = useRef(false);
  const threatOnlyRef   = useRef(false);
  const searchHitRef    = useRef<string | null>(null);
  const clickedIpRef    = useRef<IpNode | null>(null);
  // Keep refs in sync
  orbitPausedRef.current = orbitPaused;
  threatOnlyRef.current = threatOnly;
  searchHitRef.current = searchHit;
  clickedIpRef.current = clickedIp;
  const [liveLoadingMore, setLiveLoadingMore] = useState(false);
  const [tooltip, setTooltip] = useState<{
    x: number; y: number;
    ip: string; flag: string; country: string;
    status: string; failures: number; services: string[]; color: string;
  } | null>(null);

  // ── Translated labels ──────────────────────────────────────────────────────
  // The canvas and the 3D view are drawn outside React renders: they read the
  // current language's strings from this ref.
  const statusLabel = useCallback((status: string) => {
    switch (status) {
      case 'banned':      return t('netmap.status.banned', { defaultValue: 'Banned' });
      case 'suspicious':  return t('netmap.status.suspicious', { defaultValue: 'Suspicious' });
      case 'whitelisted': return t('netmap.status.whitelisted', { defaultValue: 'Whitelisted' });
      default:            return t('netmap.status.clean', { defaultValue: 'Clean' });
    }
  }, [t]);
  const deviceTypeLabel = useCallback((type: string) => {
    switch (type) {
      case 'firewall': return t('netmap.deviceType.firewall', { defaultValue: 'Firewall' });
      case 'router':   return t('netmap.deviceType.router', { defaultValue: 'Router' });
      case 'server':   return t('netmap.deviceType.server', { defaultValue: 'Server' });
      case 'windows':  return t('netmap.deviceType.windows', { defaultValue: 'Windows' });
      case 'desktop':  return t('netmap.deviceType.desktop', { defaultValue: 'Desktop' });
      default:         return t('netmap.deviceType.default', { defaultValue: 'Agent' });
    }
  }, [t]);
  // Filled on every render below, before the draw loop reads it.
  const canvasTextRef = useRef<{ offline: string; evaluateOnly: string; ips: (n: number) => string }>({
    offline: '', evaluateOnly: '', ips: () => '',
  });
  canvasTextRef.current = {
    offline: t('netmap.canvas.offline', { defaultValue: 'Offline' }),
    evaluateOnly: t('evaluateOnly.badge', { defaultValue: 'Evaluate-only' }),
    ips: (n: number) => t('netmap.canvas.ips', { count: n, defaultValue: '{{count}} IPs' }),
  };
  const labels3d: NetMap3DLabels = {
    offline: t('netmap.canvas.offline', { defaultValue: 'Offline' }),
    online: t('netmap.agent.online', { defaultValue: 'Online' }),
    evaluateOnly: t('evaluateOnly.badge', { defaultValue: 'Evaluate-only' }),
    evaluateOnlyTooltip: t('evaluateOnly.badgeTooltip', { defaultValue: 'Evaluate-only mode: events are observed but no bans are created or enforced.' }),
    status: statusLabel,
    deviceType: deviceTypeLabel,
    hiddenIps: (n: number) => t('netmap.hiddenIps', { count: n, defaultValue: '{{count}} IPs not rendered' }),
  };

  // ── Tab store ──────────────────────────────────────────────────────────────
  const { tabs, activeTabId, load: loadTabs, setActiveTab, addTab, updateTab, deleteTab } = useNetMapTabStore();
  const [tabDialog, setTabDialog] = useState<{ tab: NetMapTab | null } | null>(null);

  useEffect(() => { void loadTabs(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null;
  const visibleAgentIdsRef = useRef<Set<number> | null>(null);
  visibleAgentIdsRef.current = activeTab ? new Set(activeTab.agentIds) : null;

  // ── Background ────────────────────────────────────────────────────────────

  const drawBg = useCallback((w: number, h: number) => {
    if (!bgRef.current) bgRef.current = document.createElement('canvas');
    const oc = bgRef.current;
    oc.width = w; oc.height = h;
    const ctx = oc.getContext('2d')!;
    ctx.fillStyle = P.chrome.space;
    ctx.fillRect(0, 0, w, h);
    // Nebulae (Oblimap style)
    const neb1 = ctx.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.4, w * 0.5);
    neb1.addColorStop(0, rgba(P.nebulaCold, 0.15));
    neb1.addColorStop(0.5, rgba(P.nebulaDeep, 0.08));
    neb1.addColorStop(1, 'transparent');
    ctx.fillStyle = neb1; ctx.fillRect(0, 0, w, h);
    const neb2 = ctx.createRadialGradient(w * 0.75, h * 0.6, 0, w * 0.75, h * 0.6, w * 0.35);
    neb2.addColorStop(0, rgba(P.nebulaWarm, 0.1));
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

  const upsertIp = useCallback((ip: string, agentId: number, opts: UpsertIpOpts): { node: IpNode | null; created: boolean } => {
    const agents = agentsRef.current;
    if (!agents.find(a => a.id === agentId)) return { node: null, created: false };
    const map = ipsRef.current;
    const now = Date.now();
    const {
      country = '??', status, failures = 0, addFailures = 0,
      services = [], evtCount = 0, glow = false,
    } = opts;

    const existing = map.get(ip);
    if (existing) {
      const node = existing;
      // Never downgrade a whitelisted node on live events — the whitelist
      // takes permanent precedence over transient auth-failure/success events —
      // nor a banned one (only a Lift / the soft refresh lowers a status).
      if (node.status !== 'whitelisted' && (STATUS_RANK[status] ?? 0) > (STATUS_RANK[node.status] ?? 0)) {
        node.status = status;
        node.color  = statusColor(status);
      }
      if ((!node.country || node.country === '??') && country !== '??') {
        node.country = country;
        node.flag    = flagEmoji(country);
      }
      node.failures   = Math.max(node.failures + addFailures, failures);
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
      return { node, created: false };
    }

    const agentMap = new Map(agents.map(a => [a.id, a]));
    const ag = agentMap.get(agentId)!;
    const { w: cW, h: cH } = sizeRef.current;
    const startFailures = Math.max(failures, addFailures);
    const node: IpNode = {
      key: ip, ip,
      country, flag: flagEmoji(country),
      agentIds: [agentId],
      agentWeights: { [agentId]: evtCount },
      x: ag.x, y: ag.y,
      dotR: 2.5 + Math.min(startFailures / 8, 5),
      color: statusColor(status),
      status, failures: startFailures, services: [...services], eventCount: evtCount,
      lastSeen: now,
      glowUntil: glow ? now + 2500 : 0,
      ...makeOrbitalFields(ip, cW, cH),
    };
    // Assign orbit slot with golden angle spacing
    const slotMap = slotCountersRef.current;
    const slot = slotMap.get(agentId) ?? 0;
    node.orbitSlot = slot;
    node.orbitAngle = slot * 2.399963;
    slotMap.set(agentId, slot + 1);

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
    return { node, created: true };
  }, []);

  /** Set a node's status from an authoritative source (ban event, refresh, action). */
  const setIpStatus = useCallback((ip: string, status: string, glow = false) => {
    const node = ipsRef.current.get(ip);
    if (!node) return null;
    node.status = status;
    node.color  = statusColor(status);
    if (glow) {
      node.glowUntil = Date.now() + 3000;
      node.lastSeen  = Date.now();
    }
    return node;
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

  // ── IP drawer ─────────────────────────────────────────────────────────────

  /** Show an IP: map summary panel (when on the map) + the shared IP drawer. */
  const showIp = useCallback((ip: string) => {
    setClickedIp(ipsRef.current.get(ip) ?? null);
    openIpDrawer(ip);
  }, [openIpDrawer]);
  // Canvas / socket handlers are bound once: they call the latest showIp.
  const showIpRef = useRef(showIp);
  showIpRef.current = showIp;

  // ── Quick ban / whitelist ─────────────────────────────────────────────────

  const quickBan = useCallback(async (ip: string) => {
    if (!canBan) return;
    const shownIp = anonIp(ip);
    const ok = await confirm({
      title: t('bans.banIpTitle', { defaultValue: 'Ban IP' }),
      message: isGodView
        ? t('bans.confirmBanGlobal', { ip: shownIp, defaultValue: 'Ban IP {{ip}}?\n\nIt will be blocked on every agent of every tenant.' })
        : t('bans.confirmBanLocal', { ip: shownIp, defaultValue: 'Ban IP {{ip}}?\n\nIt will be blocked on the agents of this tenant.' }),
      confirmLabel: t('bans.banIpTitle', { defaultValue: 'Ban IP' }),
      danger: true,
    });
    if (!ok) return;
    setBanningIp(ip);
    try {
      // No scope: the server derives it from the operating tenant. The ban
      // counters follow the ban:created event.
      const created = await ipReputationApi.ban(ip, t('netmap.banReason', { defaultValue: 'Manual ban from NetMap' }));
      if (created?.id != null) banIpsRef.current.set(created.id, ip);
      const node = setIpStatus(ip, 'banned', true);
      if (node) ripplesRef.current.push({ id: Math.random().toString(36).slice(2), x: node.x, y: node.y, t: 0 });
      toast.success(created?.scope === 'global'
        ? t('bans.bannedGlobal', { defaultValue: '{{ip}} banned globally', ip: shownIp })
        : t('bans.bannedLocal', { defaultValue: '{{ip}} banned on this tenant', ip: shownIp }));
      notifyIpChanged(ip);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.ban', { defaultValue: 'Failed to ban the IP' })));
    }
    finally { setBanningIp(null); }
  }, [canBan, confirm, isGodView, t, setIpStatus]);

  const quickWhitelist = useCallback(async (ip: string) => {
    if (!canWhitelist) return;
    // Label prompt, scope hint, toast and change notification: the drawer's flow.
    if (await ipActions.whitelist({ ip })) setIpStatus(ip, 'whitelisted', true);
  }, [canWhitelist, ipActions, setIpStatus]);

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
      const res = await apiClient.get<{ data: Record<string, unknown>[] }>(
        '/ip-events',
        { params: { pageSize: 100, ...(to ? { to } : {}) } },
      ).catch(() => null);
      const events = res?.data?.data ?? [];
      if (events.length < 100) liveEventsHasMoreRef.current = false;

      const fallback = t('netmap.agentFallback', { defaultValue: 'Agent' });
      const mapped = events.map(ev => liveEventFromRest(ev, fallback));
      if (mapped.length > 0) {
        oldestLiveTimestampRef.current = mapped[mapped.length - 1].time.toISOString();
        setLiveEvents(prev => appendOlderEvents(prev, mapped));
      }
    } finally {
      liveEventsLoadingMoreRef.current = false;
      setLiveLoadingMore(false);
    }
  }, [t]);

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

  /** Geo lookup of the IPs that just arrived (debounced: one batch per burst). */
  const scheduleGeoLookup = useCallback(() => {
    if (geoTimerRef.current) return;
    geoTimerRef.current = setTimeout(() => {
      geoTimerRef.current = null;
      void fetchGeoForUnknownIps();
    }, 3000);
  }, [fetchGeoForUnknownIps]);

  // ── Soft refresh (keeps IPs alive while traffic continues) ────────────────

  const softRefresh = useCallback(async () => {
    const agArr = agentsRef.current;
    if (!agArr.length) return;
    try {
      const now = Date.now();

      // 1. Events — refresh TTLs, merge services, upsert new IPs (no glow)
      const evRes = await apiClient.get<{ data: Record<string, unknown>[] }>('/ip-events', { params: { pageSize: 300 } }).catch(() => null);
      for (const ev of evRes?.data?.data ?? []) {
        const evIp = ev.ip as string | undefined;
        const aid  = (ev.deviceId ?? ev.device_id) as number | undefined;
        if (!evIp || ev.source_agent_id || ev.sourceAgentId) continue;
        const node = ipsRef.current.get(evIp);
        if (node) {
          node.lastSeen = now;
          const svc = (ev.service ?? '') as string;
          if (svc && !node.services.includes(svc)) node.services = [...node.services, svc];
        } else if (aid && agArr.some(a => a.id === aid)) {
          const failure = feedType(String(ev.eventType ?? ev.event_type)) === 'auth_failure';
          upsertIp(evIp, aid, {
            status: failure ? 'suspicious' : 'clean', failures: failure ? 1 : 0,
            services: ev.service ? [ev.service as string] : [], evtCount: 1,
          });
        }
      }

      // 2. Reputation — authoritative statuses + merged services
      const repRes = await apiClient.get<{
        data: { ip: string; status: string; totalFailures: number; affectedServices?: string[] }[]
      }>('/ip-reputation?limit=200').catch(() => null);
      for (const r of repRes?.data?.data ?? []) {
        const node = ipsRef.current.get(r.ip);
        if (!node) continue;
        if (node.status !== 'whitelisted' || r.status === 'whitelisted') { node.status = r.status; node.color = statusColor(r.status); }
        node.failures = r.totalFailures;
        node.lastSeen = now;
        if (r.affectedServices?.length) node.services = [...new Set([...node.services, ...r.affectedServices])];
      }

      // 3. Ban counters (corrects the event-driven deltas)
      const banRes = await apiClient.get<{ data: { active: number; today: number } }>('/bans/stats').catch(() => null);
      const bs = banRes?.data?.data;
      if (bs) setStats(s => ({ ...s, banned: bs.active, today: bs.today }));

      // 4. Agents — online state, evaluate-only mode, last push
      const devRes = await apiClient.get<{ data: MapDevice[] }>('/agent/devices').catch(() => null);
      for (const d of devRes?.data?.data ?? []) {
        const ag = agArr.find(a => a.id === d.id);
        if (!ag) continue;
        ag.wsConnected  = d.wsConnected;
        ag.evaluateOnly = d.evaluateOnly === true;
        if (d.updatedAt) {
          const ts = new Date(d.updatedAt).getTime();
          if (ts > ag.lastPushAt) ag.lastPushAt = ts;
        }
      }

      setIpCount(ipsRef.current.size);
    } catch { /* ignore */ }
  }, [upsertIp]);

  // Socket handlers are bound once per socket: they call the latest softRefresh.
  const softRefreshRef = useRef(softRefresh);
  softRefreshRef.current = softRefresh;

  useEffect(() => {
    // Every 90 s — full soft refresh (reputation, status, counters); real-time
    // updates come from the ip:events / ban socket events.
    const interval = setInterval(() => { void softRefresh(); }, 90_000);
    return () => clearInterval(interval);
  }, [softRefresh]);

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
        apiClient.get<{ data: MapDevice[] }>('/agent/devices'),
        apiClient.get<{ data: Record<string, unknown>[] }>('/ip-events', { params: { pageSize: 500 } })
          .catch(() => ({ data: { data: [] as Record<string, unknown>[] } })),
        apiClient.get<{ data: { active: number; today: number } }>('/bans/stats')
          .catch(() => ({ data: { data: { active: 0, today: 0 } } })),
      ]);

      const devs = (devRes.data?.data ?? []).filter(d => d.status === 'approved');
      const evts = evRes.data?.data ?? [];
      const bs   = banRes.data?.data ?? { active: 0, today: 0 };
      setStats({ agents: devs.length, banned: bs.active, today: bs.today });

      const agentEvtCount = new Map<number, number>();
      const ipToAgents    = new Map<string, Map<number, { count: number; failures: number; services: string[] }>>();

      for (const ev of evts) {
        const aid  = (ev.deviceId ?? ev.device_id) as number | undefined;
        const evIp = ev.ip as string | undefined;
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
        const svc = (ev.service ?? '') as string;
        if (svc && !e.services.includes(svc)) e.services.push(svc);
      }

      const { w, h } = sizeRef.current;
      const placed: MapDevice[] = devs.length > 0
        ? devs
        : [{ id: -1, hostname: t('netmap.server', { defaultValue: 'Server' }), name: null, status: 'approved',
             updatedAt: '', wsConnected: true, groupId: null, groupName: null, deviceType: 'agent', osInfo: null,
             resolvedSettings: { checkIntervalSeconds: 60, maxMissedPushes: 2 } }];

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
          evaluateOnly:    d.evaluateOnly === true,
        };
      });
      layoutAgents(agentsRef.current, w, h);
      const agentMap = new Map(agentsRef.current.map(a => [a.id, a]));

      // IP reputation + whitelist labels + custom display names (parallel)
      const [repRes, wlRes, displayNamesRaw] = await Promise.all([
        apiClient.get<{
          data: { ip: string; geoCountryCode?: string | null; totalFailures: number; status: string; affectedServices?: string[] }[]
        }>('/ip-reputation?limit=200').catch(() => ({ data: { data: [] } })),
        apiClient.get<{ data: { ip?: unknown; label?: string | null }[] }>('/whitelist').catch(() => ({ data: { data: [] } })),
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
      for (const wl of wlRes.data?.data ?? []) {
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
        // Skip clean IPs from history unless they touch multiple agents
        const wlMatch = matchWhitelist(evIp, wlEntries);
        if (status === 'clean' && !wlMatch && validIds.length < 2) continue;
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
          whitelistLabel: wlMatch?.label,
          displayLabel:   displayNameMap.get(evIp) ?? null,
          ...makeOrbitalFields(evIp, w, h),
        };
        ipsRef.current.set(evIp, node);
        cnt++;
      }

      /** Agent with the fewest single-agent IPs (spread of reputation-only IPs). */
      const leastLoadedAgent = (): number => {
        let targetId = agArr[0]?.id ?? -1, minCnt = Infinity;
        for (const ag of agArr) {
          const c = [...ipsRef.current.values()].filter(n => n.agentIds[0] === ag.id).length;
          if (c < minCnt) { minCnt = c; targetId = ag.id; }
        }
        return targetId;
      };

      // Fill remaining from reputation
      for (const [repIp, rep] of repMap) {
        if (cnt >= 250) break;
        if (ipsRef.current.has(repIp)) continue;
        if (rep.status === 'clean') continue; // clean IPs only via live events
        const targetId = leastLoadedAgent();
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
        const targetId = leastLoadedAgent();
        if (!agentMap.has(targetId)) continue;
        const node: IpNode = {
          key: wle.plainIp, ip: wle.plainIp,
          country: '??', flag: flagEmoji('??'),
          agentIds: [targetId], agentWeights: { [targetId]: 0 },
          x: agentMap.get(targetId)!.x, y: agentMap.get(targetId)!.y,
          dotR: 3, color: P.status.whitelisted,
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
          node.color  = P.status.whitelisted;
        }
        if (!node.displayLabel) node.displayLabel = displayNameMap.get(node.ip) ?? null;
      }

      // Batch layout with repulsion (initial geometric placement)
      distributeIpsAroundAgents(agentsRef.current, [...ipsRef.current.values()], w, h);

      // Assign orbit slots per agent — golden angle spacing to avoid clustering
      const GOLDEN_ANGLE = 2.399963; // ~137.5° in radians — optimal uniform distribution
      slotCountersRef.current = new Map();
      const slotCounters = slotCountersRef.current;
      for (const ip of ipsRef.current.values()) {
        if (ip.agentIds.length === 1) {
          const aid = ip.agentIds[0];
          const slot = slotCounters.get(aid) ?? 0;
          ip.orbitSlot = slot;
          ip.orbitAngle = slot * GOLDEN_ANGLE; // evenly spaced initial angles
          ip.arriveT = 1;
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
          radius: agentOrbitOuterR(ag.r, [...ipsRef.current.values()].filter(ip => ip.agentIds.length === 1 && ip.agentIds[0] === ag.id).length),
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
  }, [fetchGeoForUnknownIps, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Animation loop ────────────────────────────────────────────────────────

  const animate = useCallback((ts: number) => {
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

    const paused = orbitPausedRef.current || clickedIpRef.current !== null;
    for (const ip of ipsRef.current.values()) {
      // Arrival: fly from spawn point toward orbit target
      if (ip.arriveT < 1) ip.arriveT = Math.min(1, ip.arriveT + 0.0025);

      if (ip.agentIds.length === 1) {
        const ag = agMapFull.get(ip.agentIds[0]);
        if (!ag) continue;
        const totalIps = ipsPerAgent.get(ag.id) ?? 1;
        const targetR = orbRadius(ag.r, ip.orbitSlot, totalIps);
        // Smooth lerp: orbit radius transitions smoothly when slot changes
        if (ip.orbitCurrentR <= 0) ip.orbitCurrentR = targetR; // init
        ip.orbitCurrentR += (targetR - ip.orbitCurrentR) * 0.05;
        const orbR = ip.orbitCurrentR;
        // Kepler: outer orbits rotate slower (speed ∝ 1/√r)
        const baseR = ag.r + 18;
        const keplerFactor = Math.sqrt(baseR / Math.max(orbR, baseR));
        if (!paused) ip.orbitAngle += ip.orbitSpeed * keplerFactor;
        const targetX = ag.x + Math.cos(ip.orbitAngle) * orbR;
        const targetY = ag.y + Math.sin(ip.orbitAngle) * orbR;
        if (ip.arriveT < 1) {
          ip.x = ip.spawnX + (targetX - ip.spawnX) * ip.arriveT;
          ip.y = ip.spawnY + (targetY - ip.spawnY) * ip.arriveT;
        } else {
          ip.x = targetX;
          ip.y = targetY;
        }
      } else if (ip.agentIds.length > 1) {
        // Multi-agent: elliptical orbit around weighted centroid
        if (!paused) ip.orbitAngle += ip.orbitSpeed * 0.7; // multi-agent orbits are slower
        const ags = ip.agentIds.map(id => agMapFull.get(id)).filter(Boolean) as AgentNode[];
        // Fallback: if only 1 agent resolved, orbit around that agent
        if (ags.length === 0) continue;
        if (ags.length === 1) {
          const ag = ags[0];
          const orbR = ag.r + 55 + 20;
          const targetX = ag.x + Math.cos(ip.orbitAngle) * orbR;
          const targetY = ag.y + Math.sin(ip.orbitAngle) * orbR * ip.orbitEccentricity;
          if (ip.arriveT < 1) {
            ip.x = ip.spawnX + (targetX - ip.spawnX) * ip.arriveT;
            ip.y = ip.spawnY + (targetY - ip.spawnY) * ip.arriveT;
          } else { ip.x = targetX; ip.y = targetY; }
          ip.trail.push({ x: ip.x, y: ip.y });
          if (ip.trail.length > 8) ip.trail.shift();
          continue;
        }
        const totalW = ags.reduce((s, ag) => s + (ip.agentWeights[ag.id] ?? 1), 0) || 1;
        let cx = 0, cy = 0;
        for (const ag of ags) { const wt = (ip.agentWeights[ag.id] ?? 1) / totalW; cx += ag.x * wt; cy += ag.y * wt; }
        const dx = ags[1].x - ags[0].x, dy = ags[1].y - ags[0].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 80;
        const linkAngle = Math.atan2(dy, dx);
        const ex = Math.max(dist * 0.35, 30), ey = Math.max(dist * 0.15, 15);
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
      if (changed) {
        setIpCount(ipsRef.current.size);
        // Reassign slots: surviving IPs pack into lowest rings
        const slotMap = new Map<number, number>();
        const sorted = [...ipsRef.current.values()]
          .filter(ip => ip.agentIds.length === 1)
          .sort((a, b) => a.lastSeen - b.lastSeen);
        for (const ip of sorted) {
          const aid = ip.agentIds[0];
          const slot = slotMap.get(aid) ?? 0;
          ip.orbitSlot = slot;
          slotMap.set(aid, slot + 1);
        }
        slotCountersRef.current = slotMap;
        // Update agent radii in force simulation
        const sim = simRef.current;
        if (sim) {
          for (const ag of agentsRef.current) {
            const sn = sim.getNode(`a:${ag.id}`);
            if (sn) sn.radius = agentOrbitOuterR(ag.r, slotMap.get(ag.id) ?? 0);
          }
          sim.reheat(0.3);
        }
      }
      // Peer link expiry
      for (const [key, link] of agentLinksRef.current) {
        if (now - link.lastSeen > PEER_LINK_TTL) agentLinksRef.current.delete(key);
      }
    }

    // ── 2D drawing (skip if canvas not mounted, e.g. in 3D mode) ─────────
    const canvas = canvasRef.current;
    if (!canvas) { rafRef.current = requestAnimationFrame(animate); return; }
    const ctx = canvas.getContext('2d')!;
    const { w, h } = sizeRef.current;
    const text = canvasTextRef.current;

    ctx.clearRect(0, 0, w, h);
    const bg = bgRef.current;
    if (bg && bg.width > 0) ctx.drawImage(bg, 0, 0);

    // Animated flickering stars (Oblimap style)
    for (const star of starsRef.current) {
      const flicker = 0.6 + 0.4 * Math.sin(ts * 0.002 + star.b * 100);
      ctx.fillStyle = rgba(P.star, flicker * 0.5);
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
    let ipNodes = [...ipsRef.current.values()]
      // Only show IPs whose agents are visible on the map
      .filter(ip => ip.agentIds.some(id => agMap.has(id)));
    if (tabFilter) {
      ipNodes = ipNodes.filter(ip => ip.agentIds.some(id => tabFilter.has(id)));
    }
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
      ctx.strokeStyle = P.status.banned;
      ctx.shadowBlur  = 10; ctx.shadowColor = P.status.banned;
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
      ctx.strokeStyle = P.sharedEdge; ctx.lineWidth = 0.9 / k;
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
        ctx.font          = `600 ${lfs}px ${FONT_UI}`;
        ctx.globalAlpha   = 0.9 * ageFade;
        ctx.fillStyle     = color;
        ctx.textAlign     = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowBlur    = 5; ctx.shadowColor = rgba(P.shadow, 0.9);
        ctx.fillText(link.type.toUpperCase(), mx, my - 8);
        // Event count badge
        if (link.count > 1) {
          const cfs = Math.round(Math.max(6, 7.5 * Math.min(k, 1.2)));
          ctx.font      = `500 ${cfs}px ${FONT_UI}`;
          ctx.fillStyle = P.peerCount;
          ctx.fillText(`${link.count}×`, mx, my + 4);
        }
      }
      ctx.restore();
    }

    // ── Orbit rings around agents (smooth fade-in/fade-out) ────────────
    for (const ag of agents) {
      const conns = ipsByAgent.get(ag.id) ?? 0;
      const targetRings = orbitRingCount(conns);
      const current = agentDisplayedRingsRef.current.get(ag.id) ?? targetRings;
      const smoothed = current + (targetRings - current) * 0.03;
      agentDisplayedRingsRef.current.set(ag.id, smoothed);
      if (smoothed < 0.05) continue;
      const dimmed = selId !== null && selId !== ag.id;
      const fullRings = Math.floor(smoothed);
      const partialFrac = smoothed - fullRings;
      for (let i = 0; i <= fullRings; i++) {
        const r = orbitRingRadius(ag.r, i);
        const ringAlpha = (i === fullRings && partialFrac < 0.99)
          ? partialFrac * (dimmed ? 0.04 : 0.10)
          : (dimmed ? 0.04 : 0.10);
        ctx.save();
        ctx.globalAlpha = ringAlpha;
        ctx.strokeStyle = ag.wsConnected ? P.orbitOnline : P.orbitOffline;
        ctx.lineWidth = 0.5 / k;
        ctx.beginPath(); ctx.arc(ag.x, ag.y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
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

      // Draw orbit ellipse path + link lines for multi-agent IPs
      if (ip.agentIds.length > 1 && !dimmed && ageFade > 0.1) {
        const ags = ip.agentIds.map(id => agMap.get(id)).filter(Boolean) as AgentNode[];
        if (ags.length >= 2) {
          const totalW = ags.reduce((s, ag) => s + (ip.agentWeights[ag.id] ?? 1), 0) || 1;
          let cx = 0, cy = 0;
          for (const ag of ags) { const wt = (ip.agentWeights[ag.id] ?? 1) / totalW; cx += ag.x * wt; cy += ag.y * wt; }
          const dx = ags[1].x - ags[0].x, dy = ags[1].y - ags[0].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 80;
          const linkAngle = Math.atan2(dy, dx);
          const ex = Math.max(dist * 0.35, 30), ey = Math.max(dist * 0.15, 15);
          const orbitCol = threatLineColor(ip.status, P.orbitClean);

          // Orbit ellipse
          ctx.save();
          ctx.globalAlpha = 0.18 * ageFade;
          ctx.strokeStyle = orbitCol;
          ctx.lineWidth = 0.8 / k;
          ctx.setLineDash([3, 5]);
          ctx.translate(cx, cy); ctx.rotate(linkAngle);
          ctx.beginPath(); ctx.ellipse(0, 0, ex, ey, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();

          // Lines from IP to each connected agent
          for (const ag of ags) {
            ctx.save();
            ctx.globalAlpha = 0.12 * ageFade;
            ctx.strokeStyle = orbitCol;
            ctx.lineWidth = 0.5 / k;
            ctx.setLineDash([2, 6]);
            ctx.beginPath(); ctx.moveTo(ip.x, ip.y); ctx.lineTo(ag.x, ag.y); ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }
      }

      // Thin line from IP to each connected agent (always visible)
      const lineCol = threatLineColor(ip.status, P.linkClean);
      const lineAlpha = (dimmed ? 0.04 : 0.15) * ageFade * ip.arriveT;
      for (const aid of ip.agentIds) {
        const ag = agMap.get(aid);
        if (!ag) continue;
        ctx.save();
        ctx.globalAlpha = lineAlpha;
        ctx.strokeStyle = lineCol;
        ctx.lineWidth = 0.6 / k;
        ctx.beginPath(); ctx.moveTo(ip.x, ip.y); ctx.lineTo(ag.x, ag.y); ctx.stroke();
        ctx.restore();
      }
    }

    // ── IP dots ──────────────────────────────────────────────────────────

    const focusedIp = clickedIpRef.current?.ip ?? null;
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
        const tc = trailRgb(ip.status);
        for (let ti = 0; ti < ip.trail.length - 1; ti++) {
          const ta = (ti / ip.trail.length) * alpha * 0.2;
          ctx.fillStyle = rgba(tc, ta);
          ctx.beginPath(); ctx.arc(ip.trail[ti].x, ip.trail[ti].y, 0.6 / k, 0, Math.PI * 2); ctx.fill();
        }
      }

      // Persistent banned pulse (slow throb)
      if (ip.status === 'banned' && !dimmed) {
        const pulse = (Math.sin(ts / 800) + 1) / 2;
        ctx.save();
        ctx.globalAlpha = 0.08 + 0.10 * pulse;
        ctx.shadowBlur  = ip.dotR * 4; ctx.shadowColor = P.status.banned;
        ctx.fillStyle   = rgba(hexRgb(P.status.banned), 0.19);
        ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR * 2.5 + pulse * 3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      // Suspicious high-failure ripple (every ~3s)
      if (ip.status === 'suspicious' && ip.failures > 10 && !dimmed) {
        const cycle = (ts % 3000) / 3000;
        if (cycle < 0.4) {
          const tt = cycle / 0.4;
          ctx.save();
          ctx.globalAlpha = (1 - tt) * 0.15;
          ctx.strokeStyle = P.status.suspicious; ctx.lineWidth = 0.8 / k;
          ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR + tt * 15, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
      }

      if (glow && !dimmed) {
        const pulse = (Math.sin(ts / 220) + 1) / 2;
        ctx.save();
        ctx.globalAlpha = 0.20 * pulse;
        ctx.shadowBlur  = ip.dotR * 5; ctx.shadowColor = ip.color;
        ctx.fillStyle   = rgba(hexRgb(ip.color), 0.25);
        ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR * 2.8, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      // IP dot — small and subtle, mockup v5 style
      const bc = dotRgb(ip.status);
      ctx.save();
      ctx.shadowBlur = 1.5 * Math.min(k, 2); ctx.shadowColor = rgba(bc, alpha * 0.25);
      ctx.fillStyle = rgba(bc, alpha * 0.95);
      ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();

      // IP label — only for IPs with a custom display label
      if (ip.displayLabel && !dimmed && alpha > 0.2 && k > 0.5) {
        ctx.save();
        ctx.font = `500 ${Math.round(7 * Math.min(k, 1.3))}px ${FONT_UI}`;
        ctx.fillStyle = rgba(bc, alpha * 0.6);
        ctx.textAlign = 'center';
        ctx.shadowBlur = 4; ctx.shadowColor = rgba(P.shadow, 0.8);
        ctx.fillText(ip.displayLabel, ip.x, ip.y - ip.dotR - 3 * Math.min(k, 1.3));
        ctx.restore();
      }

      // Search highlight — pulsing ring on matched IP; steady ring on the shown IP
      if (searchHitRef.current === ip.ip) {
        const sp = (Math.sin(ts / 200) + 1) / 2;
        ctx.save();
        ctx.globalAlpha = 0.5 + sp * 0.3;
        ctx.strokeStyle = rgbaWhite(1);
        ctx.lineWidth = 2 / k;
        ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR + 6 + sp * 4, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      } else if (focusedIp === ip.ip) {
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = rgbaWhite(1);
        ctx.lineWidth = 1.2 / k;
        ctx.beginPath(); ctx.arc(ip.x, ip.y, ip.dotR + 5, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }

    // ── Agent nodes (mockup v5 style) ─────────────────────────────────
    for (const agent of agents) {
      const isSel    = selId === agent.id;
      const dimmed   = selId !== null && !isSel;
      const isOnline = agent.wsConnected;
      const conns    = ipsByAgent.get(agent.id) ?? 0;
      const col      = agent.deviceColor;
      const rgb      = hexRgb(col);
      const effR     = agent.r;
      const sx       = agent.x, sy = agent.y;

      // Heat glow for heavily targeted agents
      if (conns > 25) {
        const heatR = effR + Math.min(conns, 120) * 1.2;
        const hg = ctx.createRadialGradient(sx, sy, effR, sx, sy, heatR);
        hg.addColorStop(0, rgba(P.threat, Math.min(0.06, conns * 0.0005)));
        hg.addColorStop(0.6, rgba(P.amber, Math.min(0.03, conns * 0.0003)));
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
          ctx.strokeStyle = rgba(P.amber, 0.03 / i); ctx.lineWidth = 0.5; ctx.stroke();
          ctx.beginPath(); ctx.arc(0, 0, rr, Math.PI * 0.7, Math.PI * 1.1);
          ctx.strokeStyle = rgba(P.amber, 0.02 / i); ctx.stroke();
          ctx.restore();
        }
      }

      // Evaluate-only marker: slowly turning dashed amber ring
      if (agent.evaluateOnly) {
        ctx.save();
        ctx.globalAlpha = dimmed ? 0.2 : 0.75;
        ctx.strokeStyle = rgba(P.amber, 0.9);
        ctx.lineWidth = 1.2 / Math.max(k, 0.5);
        ctx.setLineDash([3, 4]);
        ctx.lineDashOffset = -(ts / 120) % 7;
        ctx.beginPath(); ctx.arc(sx, sy, effR + 3.5, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Body — gradient with bright core (mockup style)
      const grd = ctx.createRadialGradient(sx - effR * 0.2, sy - effR * 0.2, effR * 0.05, sx, sy, effR);
      grd.addColorStop(0, rgbaWhite(0.25));
      grd.addColorStop(0.3, col);
      grd.addColorStop(1, rgba(rgb, 0.1));
      ctx.globalAlpha = dimmed ? 0.2 : (isOnline ? 1 : 0.35);
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(sx, sy, effR, 0, Math.PI * 2); ctx.fill();

      // Bright inner core
      ctx.shadowBlur = effR * 0.5; ctx.shadowColor = col;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(sx, sy, effR * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;

      // Hover ring
      if (isSel) {
        ctx.strokeStyle = rgbaWhite(0.35); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sx, sy, agent.r + 5, 0, Math.PI * 2); ctx.stroke();
      }

      ctx.globalAlpha = 1;

      // Label BELOW agent body (close, rings pass through)
      if (k > 0.4) {
        const labelY = sy + effR + 8;
        const kk = Math.min(k, 1.3);
        const fs = Math.round((agent.r >= 15 ? 10 : 8.5) * kk);
        ctx.font = `500 ${fs}px ${FONT_UI}`;
        ctx.fillStyle = rgba(P.label, dimmed ? 0.2 : 0.8);
        ctx.textAlign = 'center';
        ctx.fillText(agent.label, sx, labelY);

        // IP count + group name
        if (conns > 0 && k > 0.5 && !dimmed) {
          ctx.font = `${Math.round(7.5 * Math.min(k, 1.2))}px ${FONT_MONO}`;
          ctx.fillStyle = conns > 50 ? rgba(P.threat, 0.55) : conns > 15 ? rgba(P.amber, 0.45) : rgba(P.mint, 0.4);
          ctx.fillText(text.ips(conns), sx, labelY + 9 * kk);
        }

        // Group name (subtle)
        if (agent.groupName && k > 0.6 && !dimmed) {
          const gOff = conns > 0 ? 17 : 9;
          ctx.font = `${Math.round(6.5 * Math.min(k, 1.2))}px ${FONT_UI}`;
          ctx.fillStyle = rgba(P.groupLabel, 0.28);
          ctx.fillText(agent.groupName.toUpperCase(), sx, labelY + gOff * kk);
        }

        // State labels above the body: offline, evaluate-only
        let topY = sy - effR - 6;
        if (!isOnline) {
          ctx.font = `500 ${Math.round(7 * Math.min(k, 1.2))}px ${FONT_UI}`;
          ctx.fillStyle = rgba(P.threat, 0.5);
          ctx.fillText(text.offline.toUpperCase(), sx, topY);
          topY -= 9 * Math.min(k, 1.2);
        }
        if (agent.evaluateOnly && k > 0.5 && !dimmed) {
          ctx.font = `600 ${Math.round(6.5 * Math.min(k, 1.2))}px ${FONT_UI}`;
          ctx.fillStyle = rgba(P.amber, 0.75);
          ctx.fillText(text.evaluateOnly.toUpperCase(), sx, topY);
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
      ctx.fillStyle = rgbaWhite(1);
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
      ctx.fillStyle = P.minimap.bg;
      ctx.strokeStyle = P.minimap.border;
      ctx.lineWidth = 1;
      ctx.fillRect(mmX, mmY, mmW, mmH);
      ctx.strokeRect(mmX, mmY, mmW, mmH);

      // Agent dots only (no IPs on minimap)
      for (const ag of agents) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = ag.wsConnected ? P.minimap.online : P.minimap.offline;
        ctx.beginPath(); ctx.arc(toMmX(ag.x), toMmY(ag.y), 2.5, 0, Math.PI * 2); ctx.fill();
      }

      // Viewport rectangle
      const vpLeft   = (-x / k - minX) * mmScale;
      const vpTop    = (-y / k - minY) * mmScale;
      const vpWidth  = (w / k) * mmScale;
      const vpHeight = (h / k) * mmScale;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = rgbaWhite(1);
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
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (relayoutTimerRef.current) clearTimeout(relayoutTimerRef.current);
      if (geoTimerRef.current) clearTimeout(geoTimerRef.current);
    };
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
  }, [drawBg, viewMode]);

  // ── Initial live events load ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    apiClient.get<{ data: Record<string, unknown>[] }>('/ip-events', { params: { pageSize: 100 } })
      .then(res => {
        if (cancelled) return;
        const events = res.data?.data ?? [];
        const fallback = t('netmap.agentFallback', { defaultValue: 'Agent' });
        const mapped = events.map(ev => {
          const evId = ev.id as number | undefined;
          if (evId) processedEventIdsRef.current.add(Number(evId));
          return liveEventFromRest(ev, fallback);
        });
        setLiveEvents(prev => mergeLiveEvents(prev, mapped));
        if (mapped.length > 0) {
          oldestLiveTimestampRef.current = mapped[mapped.length - 1].time.toISOString();
        }
        if (events.length < 100) liveEventsHasMoreRef.current = false;
      })
      .catch(() => {}); // silently ignore — live events stay empty until socket fires
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Socket events ─────────────────────────────────────────────────────────

  // A server-initiated disconnect rebuilds the socket (new generation): the
  // effects below re-bind to the new instance.
  const socketGeneration = useSocketStore(s => s.generation);

  /** Remember a stored event id; false when it was already seen. */
  const rememberEventId = useCallback((id: number): boolean => {
    const seen = processedEventIdsRef.current;
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_EVENT_IDS_CAP) seen.delete(seen.values().next().value!);
    return true;
  }, []);

  /** Rows of a flush (newest first): IP nodes, peer links, particles, live feed. */
  const ingestFlow = useCallback((rows: FlowRow[]) => {
    const agents = agentsRef.current;
    const now    = Date.now();
    const fresh: LiveEvent[] = [];
    let added = false;

    // Oldest first, so particles and the feed keep the agent's order
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row.ip) continue;
      if (row.id != null && !rememberEventId(row.id)) continue;
      const agent = agents.find(a => a.id === row.deviceId);
      if (!agent) continue; // not on the map (pending, other view)
      agent.lastPushAt = now;
      const evType = feedType(row.eventType);
      const flowOn = filtersRef.current.has(evType);
      const id     = row.id != null ? String(row.id) : Math.random().toString(36).slice(2);
      const time   = new Date(row.timestamp);

      // Agent-to-agent peer traffic: draw a directed link, don't show as IP node
      if (row.sourceAgentId) {
        const type = row.sourceIpType === 'wan' ? 'wan' : 'lan';
        const col  = PEER_LINK_COLOR[type];
        upsertPeerLink(row.sourceAgentId, row.deviceId, type, row.service);
        if (flowOn) spawnPeerParticle(row.sourceAgentId, row.deviceId, col);
        const srcAgent = agents.find(a => a.id === row.sourceAgentId);
        fresh.push({
          id, ip: row.ip, service: row.service, country: type.toUpperCase(),
          agentName: `${srcAgent?.label ?? '?'} → ${agent.label}`,
          time, color: col, eventType: evType,
        });
        continue;
      }

      const failure = evType === 'auth_failure';
      const col = liveEventColor(row.service, evType);
      const { node, created } = upsertIp(row.ip, agent.id, {
        status: failure ? 'suspicious' : 'clean',
        addFailures: failure ? 1 : 0,
        services: row.service ? [row.service] : [],
        evtCount: 1,
        glow: true,
      });
      if (created) added = true;
      if (node && flowOn) spawnParticle(node, agent.id, col);
      fresh.push({
        id, ip: row.ip, service: row.service, country: node?.country ?? '??',
        agentName: agent.label,
        time, color: col, eventType: evType,
      });
    }

    if (fresh.length > 0) setLiveEvents(prev => mergeLiveEvents(fresh.reverse(), prev));
    if (added) { scheduleRelayout(); scheduleGeoLookup(); }
  }, [rememberEventId, upsertIp, upsertPeerLink, spawnParticle, spawnPeerParticle, scheduleRelayout, scheduleGeoLookup]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    // Batched rows of one agent flush (with their ids: no refetch needed).
    const onIpEvents = (frame: IpEventsFrame) => {
      ipEventsSeenRef.current = true;
      ingestFlow((frame?.events ?? []).map(flowRowFromStream));
    };

    // Legacy thin ping: only until this server proves it sends ip:events.
    const onIpFlow = (data: IpFlowEvent) => {
      if (ipEventsSeenRef.current) return;
      ingestFlow([flowRowFromLegacy(data)]);
    };

    const onBanAuto = (data: BanAutoEvent) => {
      banIpsRef.current.set(data.id, data.ip);
      const node = setIpStatus(data.ip, 'banned', true);
      if (node) {
        ripplesRef.current.push({ id: Math.random().toString(36).slice(2), x: node.x, y: node.y, t: 0 });
        if (filtersRef.current.has('ban')) spawnParticle(node, node.agentIds[0], EVENT_COLORS.ban);
      }
      const agent = node ? agentsRef.current.find(a => a.id === node.agentIds[0]) : undefined;
      setLiveEvents(prev => mergeLiveEvents([{
        id: `ban-${data.id}`,
        ip: data.ip, service: data.service, country: node?.country ?? '??',
        agentName: agent?.label ?? t('netmap.server', { defaultValue: 'Server' }),
        time: new Date(), color: EVENT_COLORS.ban, eventType: 'ban' as const,
        failures: data.failureCount,
      }], prev));
      setStats(s => ({ ...s, today: s.today + 1, banned: s.banned + 1 }));
    };

    const onBanCreated = (ban: IpBan) => {
      if (!ban?.ip) return;
      banIpsRef.current.set(ban.id, ban.ip);
      if (ban.isActive !== false) setIpStatus(ban.ip, 'banned', true);
      setStats(s => ({ ...s, today: s.today + 1, banned: s.banned + (ban.isActive !== false ? 1 : 0) }));
    };

    /** A ban stopped applying here: its IP falls back to its failure-based status. */
    const unban = (banId: number) => {
      const ip = banIpsRef.current.get(banId);
      const node = ip ? ipsRef.current.get(ip) : undefined;
      if (node && node.status === 'banned') setIpStatus(node.ip, node.failures > 0 ? 'suspicious' : 'clean');
    };

    const onBanLifted = (data: BanLiftedEvent) => {
      unban(data.id);
      setStats(s => ({ ...s, banned: Math.max(0, s.banned - 1) }));
    };

    // A bulk lift carries a count only (no ids, every tenant's bans counted):
    // the soft refresh re-reads the statuses and the counters.
    const onBanBulkLifted = (_data: BanBulkLiftedEvent) => {
      void softRefreshRef.current();
    };

    // A tenant exclusion only changes the counters of that tenant's view.
    const onBanExcluded = (data: BanExclusionEvent) => {
      if (data?.tenantId !== currentTenantIdRef.current) return;
      unban(data.banId);
      setStats(s => ({ ...s, banned: Math.max(0, s.banned - 1) }));
    };
    const onBanExclusionRemoved = (data: BanExclusionEvent) => {
      if (data?.tenantId !== currentTenantIdRef.current) return;
      const ip = banIpsRef.current.get(data.banId);
      if (ip) setIpStatus(ip, 'banned', true);
      setStats(s => ({ ...s, banned: s.banned + 1 }));
    };

    // Online pulse only: the IP activity itself arrives through ip:events.
    const onPushHeartbeat = (data: { deviceId: number }) => {
      const agent = agentsRef.current.find(a => a.id === data?.deviceId);
      if (agent) agent.lastPushAt = Date.now();
    };

    const onStatusChanged = (data: { deviceId?: number; wsConnected?: boolean }) => {
      const agent = agentsRef.current.find(a => a.id === data?.deviceId);
      if (agent && typeof data.wsConnected === 'boolean') agent.wsConnected = data.wsConnected;
    };

    socket.on(SOCKET_EVENTS.IP_EVENTS,             onIpEvents);
    socket.on(SOCKET_EVENTS.IP_FLOW,               onIpFlow);
    socket.on(SOCKET_EVENTS.BAN_AUTO,              onBanAuto);
    socket.on(SOCKET_EVENTS.BAN_CREATED,           onBanCreated);
    socket.on(SOCKET_EVENTS.BAN_LIFTED,            onBanLifted);
    socket.on(SOCKET_EVENTS.BAN_BULK_LIFTED,       onBanBulkLifted);
    socket.on(SOCKET_EVENTS.BAN_EXCLUDED,          onBanExcluded);
    socket.on(SOCKET_EVENTS.BAN_EXCLUSION_REMOVED, onBanExclusionRemoved);
    socket.on(SOCKET_EVENTS.AGENT_PUSH_HEARTBEAT,  onPushHeartbeat);
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED,  onStatusChanged);
    return () => {
      socket.off(SOCKET_EVENTS.IP_EVENTS,             onIpEvents);
      socket.off(SOCKET_EVENTS.IP_FLOW,               onIpFlow);
      socket.off(SOCKET_EVENTS.BAN_AUTO,              onBanAuto);
      socket.off(SOCKET_EVENTS.BAN_CREATED,           onBanCreated);
      socket.off(SOCKET_EVENTS.BAN_LIFTED,            onBanLifted);
      socket.off(SOCKET_EVENTS.BAN_BULK_LIFTED,       onBanBulkLifted);
      socket.off(SOCKET_EVENTS.BAN_EXCLUDED,          onBanExcluded);
      socket.off(SOCKET_EVENTS.BAN_EXCLUSION_REMOVED, onBanExclusionRemoved);
      socket.off(SOCKET_EVENTS.AGENT_PUSH_HEARTBEAT,  onPushHeartbeat);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED,  onStatusChanged);
    };
  }, [ingestFlow, setIpStatus, spawnParticle, t, socketGeneration]);

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
  }, [socketGeneration]);

  // Events missed while the socket was down: rebuild the map after a reconnect.
  const initRef = useRef(init);
  initRef.current = init;
  useEffect(() => {
    const onResync = () => { void initRef.current(); };
    window.addEventListener(SOCKET_RESYNC_EVENT, onResync);
    return () => window.removeEventListener(SOCKET_RESYNC_EVENT, onResync);
  }, []);

  // An IP changed through the drawer or another page (ban, lift, whitelist,
  // label…): re-read that IP; several IPs at once → soft refresh.
  useIpChanged((ip) => {
    if (ip === null) { void softRefresh(); return; }
    const node = ipsRef.current.get(ip);
    if (!node) return;
    void Promise.all([
      ipReputationApi.getDetail(ip).catch(() => null),
      ipLabelsApi.list().catch(() => null),
    ]).then(([detail, labelRows]) => {
      const status = detail?.reputation?.status;
      if (status) setIpStatus(ip, status);
      if (detail?.reputation) node.failures = detail.reputation.totalFailures;
      if (labelRows) node.displayLabel = labelRows.find(l => l.ip === ip)?.label ?? null;
      setClickedIp(prev => (prev?.ip === ip ? { ...node } : prev));
    });
  });

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
  }, [viewMode]);

  // ── Mouse ─────────────────────────────────────────────────────────────────

  /** IP drawn by the canvas (tab view + threat filter): only those are hit-tested. */
  const isIpDrawn = (ip: IpNode): boolean => {
    const tabFilter = visibleAgentIdsRef.current;
    if (tabFilter && !ip.agentIds.some(id => tabFilter.has(id))) return false;
    return !threatOnlyRef.current || ip.status === 'banned' || ip.status === 'suspicious';
  };
  const isIpDrawnRef = useRef(isIpDrawn);
  isIpDrawnRef.current = isIpDrawn;

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
    // Find the CLOSEST IP within hit range (not just the first match)
    let closestIp: IpNode | null = null;
    let closestDist = Infinity;
    for (const ip of ipsRef.current.values()) {
      if (!isIpDrawnRef.current(ip)) continue;
      const d2 = (wx - ip.x) ** 2 + (wy - ip.y) ** 2;
      const hitR = ip.dotR + 12;
      if (d2 <= hitR * hitR && d2 < closestDist) {
        closestDist = d2;
        closestIp = ip;
      }
    }
    if (closestIp) {
      setTooltip({ x: mx, y: my, ip: anonIp(closestIp.ip), flag: closestIp.flag, country: closestIp.country,
        status: closestIp.status, failures: closestIp.failures, services: closestIp.services, color: closestIp.color });
    } else {
      setTooltip(null);
    }
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

    // IP click → summary panel + the shared IP drawer
    for (const ip of ipsRef.current.values()) {
      if (!isIpDrawnRef.current(ip)) continue;
      if ((wx - ip.x) ** 2 + (wy - ip.y) ** 2 <= (ip.dotR + 12) ** 2) {
        showIpRef.current(ip.ip);
        return;
      }
    }

    // Agent click → focus (agents of the active view only)
    const tabFilter = visibleAgentIdsRef.current;
    for (const ag of agentsRef.current) {
      if (tabFilter && !tabFilter.has(ag.id)) continue;
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

  const toggleViewMode = useCallback(() => {
    // The IP summary panel (and the orbit pause it holds) belongs to the 2D view.
    setClickedIp(null);
    setTooltip(null);
    setViewMode(prev => {
      const next = prev === '2d' ? '3d' : '2d';
      try { localStorage.setItem('obliguard-netmap-viewmode', next); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

  const searchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const q = searchIp.trim();
    if (!q) { setSearchHit(null); return; }
    const node = ipsRef.current.get(q);
    if (node) {
      setSearchHit(q);
      // Centre the node at zoom 2: screen = world × k + offset.
      const k = 2;
      transformRef.current = { x: sizeRef.current.w / 2 - node.x * k, y: sizeRef.current.h / 2 - node.y * k, k };
      setTimeout(() => setSearchHit(cur => (cur === q ? null : cur)), 4000);
    } else {
      toast.error(t('netmap.search.notFound', { defaultValue: 'IP not on the map' }));
    }
    setSearchIp('');
  }, [searchIp, t]);

  const agentIpCount = (agentId: number) => [...ipsRef.current.values()].filter(n => n.agentIds.includes(agentId)).length;

  /** Amber evaluate-only pill (agent panels). */
  const evaluatePill = (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-[1px] text-[9px] font-mono uppercase tracking-wider border"
      style={{ color: rgba(P.amber, 0.9), borderColor: rgba(P.amber, 0.35), backgroundColor: rgba(P.amber, 0.1) }}
      title={t('evaluateOnly.badgeTooltip', { defaultValue: 'Evaluate-only mode: events are observed but no bans are created or enforced.' })}
    >
      <Eye size={9} />
      {t('evaluateOnly.badge', { defaultValue: 'Evaluate-only' })}
    </span>
  );

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-[calc(100vh-4rem)] bg-[color:var(--nm-space)] overflow-hidden select-none"
      style={NETMAP_CSS_VARS as CSSProperties}
    >

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-[color:var(--nm-border)] shrink-0 bg-[color:var(--nm-panel)]">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
          </span>
          <span className="font-mono text-[11px] tracking-widest text-cyan-900/50 uppercase">
            {t('netmap.title', { defaultValue: 'Obliguard · Network Graph' })}
          </span>
          {selectedAgent && (
            <span className="font-mono text-[10px] text-cyan-400/70 tracking-wide ml-1">
              ─ {selectedAgent.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-6">
          {[
            { Icon: Shield,   key: 'agents',  label: t('netmap.stats.agents', { defaultValue: 'Agents' }),   value: stats.agents, c: P.stats.agents },
            { Icon: Ban,      key: 'banned',  label: t('netmap.stats.banned', { defaultValue: 'Banned' }),   value: stats.banned, c: P.stats.banned },
            { Icon: Activity, key: 'today',   label: t('netmap.stats.today', { defaultValue: 'Today' }),     value: stats.today,  c: P.stats.today },
            { Icon: Zap,      key: 'tracked', label: t('netmap.stats.tracked', { defaultValue: 'Tracked' }), value: ipCount,      c: P.stats.tracked },
          ].map(({ Icon, key, label, value, c }) => (
            <div key={key} className="flex items-center gap-1.5">
              <Icon size={11} style={{ color: c }} />
              <span className="font-mono text-sm font-bold" style={{ color: c }}>{value}</span>
              <span className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">{label}</span>
            </div>
          ))}
          {/* Search IP */}
          <form onSubmit={searchSubmit} className="ml-2">
            <input
              type="text"
              value={searchIp}
              onChange={e => setSearchIp(e.target.value)}
              placeholder={t('netmap.search.placeholder', { defaultValue: 'Search IP…' })}
              aria-label={t('netmap.search.placeholder', { defaultValue: 'Search IP…' })}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              className="w-28 px-2 py-0.5 rounded border border-slate-800 bg-transparent text-[11px] font-mono text-slate-400 placeholder-slate-700 focus:border-cyan-500/40 focus:outline-none"
            />
          </form>

          {/* Threat only toggle */}
          <button
            onClick={() => setThreatOnly(v => !v)}
            aria-pressed={threatOnly}
            className={`px-2 py-0.5 rounded text-[10px] font-mono tracking-wider border uppercase transition-colors ${
              threatOnly
                ? 'bg-red-500/15 text-red-400 border-red-500/30'
                : 'text-slate-600 border-slate-800 hover:text-slate-400'
            }`}
          >
            ⚠ {threatOnly
              ? t('netmap.threatOnly.on', { defaultValue: 'Threats' })
              : t('netmap.threatOnly.off', { defaultValue: 'All' })}
          </button>

          {/* 2D/3D toggle */}
          <button
            onClick={toggleViewMode}
            title={viewMode === '2d'
              ? t('netmap.view.to3d', { defaultValue: 'Switch to the 3D view' })
              : t('netmap.view.to2d', { defaultValue: 'Switch to the 2D view' })}
            aria-label={viewMode === '2d'
              ? t('netmap.view.to3d', { defaultValue: 'Switch to the 3D view' })
              : t('netmap.view.to2d', { defaultValue: 'Switch to the 2D view' })}
            className={`px-2 py-0.5 rounded text-[10px] font-mono tracking-wider border transition-colors ${
              viewMode === '3d'
                ? 'bg-purple-500/15 text-purple-400 border-purple-500/30'
                : 'text-slate-600 border-slate-800 hover:text-slate-400'
            }`}
          >
            {viewMode === '2d' ? <Box size={11} /> : <Grid2x2 size={11} />}
          </button>

          <button
            onClick={() => void init()}
            className="ml-1 p-1.5 rounded border border-slate-800 text-slate-600 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors"
            title={t('common.refresh', { defaultValue: 'Refresh' })}
            aria-label={t('common.refresh', { defaultValue: 'Refresh' })}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Tab bar ──────────────────────────────────────────────────────────── */}
      {(tabs.length > 0 || activeTabId !== null) ? (
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-[color:var(--nm-border)] bg-[color:var(--nm-panel-deep)] shrink-0 overflow-x-auto">
          <button
            onClick={() => setActiveTab(null)}
            className={`px-3 py-1 rounded text-[11px] font-mono tracking-wide transition-colors ${
              !activeTabId
                ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30'
                : 'text-slate-600 hover:text-slate-400 border border-transparent'
            }`}
          >
            {t('netmap.tabs.all', { defaultValue: 'All' })}
          </button>
          {[...tabs].sort((a, b) => a.sortOrder - b.sortOrder).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabDialog({ tab });
              }}
              title={t('netmap.tabs.editHint', { defaultValue: 'Right-click to edit' })}
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
            onClick={() => setTabDialog({ tab: null })}
            className="px-2 py-1 rounded text-[11px] font-mono text-slate-700 hover:text-cyan-400 border border-transparent hover:border-cyan-500/20 transition-colors"
            title={t('netmap.tabs.new', { defaultValue: 'New view' })}
            aria-label={t('netmap.tabs.new', { defaultValue: 'New view' })}
          >
            +
          </button>
        </div>
      ) : (
        <div className="flex items-center px-4 py-1.5 border-b border-[color:var(--nm-border)] bg-[color:var(--nm-panel-deep)] shrink-0">
          <button
            onClick={() => setTabDialog({ tab: null })}
            className="px-3 py-1 rounded text-[11px] font-mono text-slate-700 hover:text-cyan-400 border border-dashed border-slate-800 hover:border-cyan-500/20 transition-colors"
          >
            + {t('netmap.tabs.createView', { defaultValue: 'Create view' })}
          </button>
        </div>
      )}

      {/* ── Tab create/edit dialog ───────────────────────────────────────────── */}
      <NetMapTabDialog
        open={tabDialog !== null}
        tab={tabDialog?.tab ?? null}
        agents={agentsRef.current.map(ag => ({ id: ag.id, label: ag.label }))}
        onClose={() => setTabDialog(null)}
        onSave={(data) => {
          if (tabDialog?.tab) updateTab(tabDialog.tab.id, data);
          else addTab(data);
          setTabDialog(null);
        }}
        onDelete={(id) => { deleteTab(id); setTabDialog(null); }}
      />

      {/* ── Canvas area ─────────────────────────────────────────────────────── */}
      {viewMode === '3d' ? (
        <div className="flex-1 relative overflow-hidden">
          <Suspense fallback={(
            <div className="flex-1 h-full flex items-center justify-center bg-[color:var(--nm-space-3d)] text-slate-600 text-sm">
              {t('netmap.loading3d', { defaultValue: 'Loading the 3D engine…' })}
            </div>
          )}>
            <NetMap3D
              agentsRef={agentsRef}
              ipsRef={ipsRef}
              agentLinksRef={agentLinksRef}
              visibleAgentIds={visibleAgentIdsRef.current}
              threatOnly={threatOnly}
              searchHit={searchHit}
              labels={labels3d}
              onSelectAgent={(ag) => { selectedRef.current = ag?.id ?? null; setSelectedAgent(ag); }}
              // 3D has no summary panel: an IP opens the shared drawer only
              // (a clickedIp would also hold the orbits paused).
              onSelectIp={(ip) => { if (ip) openIpDrawer(ip.ip); }}
            />
          </Suspense>
        </div>
      ) : (
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
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[color:var(--nm-veil)] z-10">
            <div className="w-10 h-10 border border-t-transparent border-cyan-500/40 rounded-full animate-spin mb-3" />
            <p className="font-mono text-[10px] text-cyan-700 tracking-widest uppercase">
              {t('netmap.building', { defaultValue: 'Building the network graph…' })}
            </p>
          </div>
        )}

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div className="absolute top-4 left-4 bg-[color:var(--nm-panel-glass)] border border-[color:var(--nm-panel-glass-border)] rounded-sm p-3 backdrop-blur-sm min-w-[152px] z-10">
          {selectedAgent ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="font-mono text-[8px] text-slate-500 tracking-widest uppercase">{t('netmap.panel.agentFocus', { defaultValue: 'Agent focus' })}</div>
                <button
                  onClick={() => { selectedRef.current = null; setSelectedAgent(null); }}
                  className="text-slate-600 hover:text-cyan-400 transition-colors"
                  aria-label={t('common.close', { defaultValue: 'Close' })}
                >
                  <X size={10} />
                </button>
              </div>
              <div className="font-mono text-[11px] text-cyan-400 mb-1 truncate font-bold">{selectedAgent.label}</div>
              {selectedAgent.evaluateOnly && <div className="mb-1">{evaluatePill}</div>}
              <div className="font-mono text-[9px] text-slate-500">
                {t('netmap.panel.trackedIps', { count: agentIpCount(selectedAgent.id), defaultValue: 'Tracked IPs: {{count}}' })}
              </div>
              <div className="font-mono text-[9px] text-slate-500 mb-2">
                {t('netmap.panel.events', { count: selectedAgent.eventCount, defaultValue: 'Events: {{count}}' })}
              </div>
              <div className="pt-2 border-t border-slate-800/50">
                <div className="font-mono text-[8px] text-slate-500 tracking-widest mb-1.5 uppercase">{t('netmap.panel.topThreats', { defaultValue: 'Top threats' })}</div>
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
              <div className="font-mono text-[8px] text-slate-500 tracking-widest mb-2 uppercase">{t('netmap.panel.flowTypes', { defaultValue: 'Flow types' })}</div>
              {([
                { type: 'auth_success' as const, color: EVENT_COLORS.auth_success, label: t('netmap.flow.success', { defaultValue: 'Success' }) },
                { type: 'auth_failure' as const, color: EVENT_COLORS.auth_failure, label: t('netmap.flow.failure', { defaultValue: 'Auth failure' }) },
                { type: 'ban'          as const, color: EVENT_COLORS.ban,          label: t('netmap.flow.ban', { defaultValue: 'Auto-ban' }) },
              ]).map(({ type, color, label }) => {
                const on = filters.has(type);
                return (
                  <button key={type} onClick={() => toggleFilter(type)} aria-pressed={on} className="flex items-center gap-2 py-[4px] w-full">
                    <div className="w-5 h-0.5 shrink-0 rounded" style={{ backgroundColor: on ? color : P.chrome.swatchOff, boxShadow: on ? `0 0 4px ${color}` : 'none' }} />
                    <span className="font-mono text-[9px]" style={{ color: on ? P.chrome.textOn : P.chrome.textOff }}>{label}</span>
                  </button>
                );
              })}
              <div className="mt-3 pt-2 border-t border-slate-800/50">
                <div className="font-mono text-[8px] text-slate-500 tracking-widest mb-1.5 uppercase">{t('netmap.panel.ipStatus', { defaultValue: 'IP status' })}</div>
                {(['whitelisted', 'banned', 'suspicious', 'clean'] as const).map(status => (
                  <div key={status} className="flex items-center gap-2 py-[2px]">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: P.status[status] }} />
                    <span className="font-mono text-[8px] text-slate-500">{statusLabel(status)}</span>
                  </div>
                ))}
                <div className="flex items-center gap-2 py-[2px]">
                  <div className="w-2 h-2 rounded-full shrink-0 border border-dashed" style={{ borderColor: rgba(P.amber, 0.9) }} />
                  <span className="font-mono text-[8px] text-slate-500">{t('evaluateOnly.badge', { defaultValue: 'Evaluate-only' })}</span>
                </div>
              </div>
              <div className="mt-3 pt-2 border-t border-slate-800/50">
                <div className="font-mono text-[8px] text-slate-400 leading-[1.8]">
                  <div>{t('netmap.help.pan', { defaultValue: 'Drag · Pan' })}</div>
                  <div>{t('netmap.help.zoom', { defaultValue: 'Scroll · Zoom' })}</div>
                  <div>{t('netmap.help.focus', { defaultValue: 'Click agent · Focus' })}</div>
                  <div>{t('netmap.help.ip', { defaultValue: 'Click IP · Details' })}</div>
                </div>
                <button onClick={resetView} className="mt-1.5 w-full font-mono text-[8px] px-1.5 py-0.5 rounded border border-slate-800 text-slate-500 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors">
                  ⌖ {t('netmap.resetView', { defaultValue: 'Reset view' })}
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
              backgroundColor: P.chrome.tooltip,
              border: `1px solid ${P.chrome.tooltipBorder}`,
              boxShadow: `0 4px 24px ${P.chrome.tooltipShadow}`,
              transform: tooltip.x > canvasSize.w * 0.70 ? 'translateX(-110%)' : undefined,
            }}
          >
            <div className="font-mono text-[15px] mb-2 font-bold" style={{ color: tooltip.color }}>
              {tooltip.flag} {tooltip.ip}
            </div>
            {[
              { key: 'country',  label: t('netmap.tooltip.country', { defaultValue: 'Country' }),   value: tooltip.country },
              { key: 'status',   label: t('netmap.tooltip.status', { defaultValue: 'Status' }),    value: statusLabel(tooltip.status).toUpperCase(), color: tooltip.color },
              { key: 'failures', label: t('netmap.tooltip.failures', { defaultValue: 'Failures' }), value: tooltip.failures.toLocaleString(), color: P.stats.today },
            ].map(({ key, label, value, color }) => (
              <div key={key} className="flex items-center gap-2 mb-1.5">
                <span className="font-mono text-[11px] text-slate-500 uppercase tracking-wider w-16 shrink-0">{label}</span>
                <span className="font-mono text-[13px]" style={{ color: color ?? P.chrome.textOn }}>{value}</span>
              </div>
            ))}
            {tooltip.services.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="font-mono text-[11px] text-slate-500 uppercase tracking-wider w-16 shrink-0 mt-px">{t('netmap.tooltip.services', { defaultValue: 'Services' })}</span>
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
          aria-pressed={orbitPaused}
          className={`absolute bottom-3 left-3 z-20 px-2.5 py-1 rounded text-[10px] font-mono tracking-wider uppercase border transition-colors ${
            orbitPaused
              ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
              : 'text-slate-600 border-slate-800 hover:text-slate-400 hover:border-slate-600'
          }`}
        >
          {orbitPaused
            ? `▶ ${t('netmap.resume', { defaultValue: 'Resume' })}`
            : `❚❚ ${t('netmap.pause', { defaultValue: 'Pause' })}`}
        </button>

        {/* ── Agent side panel (on click) ────────────────────────────────────── */}
        {selectedAgent && !clickedIp && (
          <div className="absolute top-0 right-0 z-30 w-72 h-full bg-[color:var(--nm-side)] border-l border-[color:var(--nm-side-border)] p-4 overflow-y-auto overscroll-contain" onWheel={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <span className="font-mono text-xs text-slate-500 uppercase tracking-widest">{t('netmap.agent.title', { defaultValue: 'Agent detail' })}</span>
              <button
                onClick={() => { selectedRef.current = null; setSelectedAgent(null); }}
                className="text-slate-500 hover:text-white text-lg leading-none"
                aria-label={t('common.close', { defaultValue: 'Close' })}
              >&times;</button>
            </div>
            <div className="font-mono text-sm font-semibold mb-1" style={{ color: selectedAgent.deviceColor }}>
              {selectedAgent.label}
            </div>
            <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: rgba(selectedAgent.wsConnected ? P.mint : P.threat, 1) }}>
              {selectedAgent.wsConnected
                ? t('netmap.agent.online', { defaultValue: 'Online' })
                : t('netmap.canvas.offline', { defaultValue: 'Offline' })} · {deviceTypeLabel(selectedAgent.deviceType)}
            </div>
            {selectedAgent.evaluateOnly && <div className="mb-3">{evaluatePill}</div>}
            <div className="space-y-2 text-xs mb-4 mt-2">
              {[
                { key: 'group',  label: t('netmap.agent.group', { defaultValue: 'Group' }),          value: selectedAgent.groupName ?? '—' },
                { key: 'events', label: t('netmap.agent.events', { defaultValue: 'Events' }),        value: String(selectedAgent.eventCount) },
                { key: 'ips',    label: t('netmap.agent.orbitingIps', { defaultValue: 'Orbiting IPs' }), value: String(agentIpCount(selectedAgent.id)) },
              ].map(r => (
                <div key={r.key} className="flex justify-between">
                  <span className="text-slate-500">{r.label}</span>
                  <span className="text-slate-300 font-mono">{r.value}</span>
                </div>
              ))}
            </div>
            {/* Recent IPs */}
            <div className="mb-4">
              <div className="text-[9px] text-slate-600 uppercase tracking-widest mb-2">{t('netmap.agent.recentIps', { defaultValue: 'Recent IPs' })}</div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {[...ipsRef.current.values()]
                  .filter(n => n.agentIds.includes(selectedAgent.id))
                  .sort((a, b) => b.lastSeen - a.lastSeen)
                  .slice(0, 15)
                  .map(n => (
                    <button key={n.key} onClick={() => showIp(n.ip)}
                      className="flex items-center gap-2 w-full text-left py-0.5 hover:bg-white/5 rounded px-1 transition-colors">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: n.status === 'clean' ? P.recentClean : statusColor(n.status) }} />
                      <span className="font-mono text-[10px] text-slate-400 truncate">{anonIp(n.ip)}</span>
                      <span className="ml-auto font-mono text-[9px] text-slate-600">{n.failures > 0 ? `${n.failures}×` : ''}</span>
                    </button>
                  ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Link to={`/agents/${selectedAgent.id}`} onClick={() => { selectedRef.current = null; setSelectedAgent(null); }}
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-cyan-400 border border-cyan-500/25 hover:bg-cyan-500/10 text-center transition-colors">
                {t('netmap.agent.viewAgent', { defaultValue: 'View agent page' })}
              </Link>
            </div>
          </div>
        )}

        {/* ── IP summary panel (the actions live in the shared IP drawer) ────── */}
        {clickedIp && (
          <div className="absolute top-0 right-0 z-30 w-72 h-full bg-[color:var(--nm-side)] border-l border-[color:var(--nm-side-border)] p-4 overflow-y-auto overscroll-contain" onWheel={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <span className="font-mono text-xs text-slate-500 uppercase tracking-widest">{t('netmap.ip.title', { defaultValue: 'IP detail' })}</span>
              <button
                onClick={() => setClickedIp(null)}
                className="text-slate-500 hover:text-white text-lg leading-none"
                aria-label={t('common.close', { defaultValue: 'Close' })}
              >&times;</button>
            </div>
            <div className="font-mono text-sm font-semibold mb-1" style={{ color: clickedIp.color }}>
              {clickedIp.flag} {anonIp(clickedIp.ip)}
            </div>
            {clickedIp.displayLabel && (
              <div className="font-mono text-[10px] text-slate-400 mb-1 truncate">{clickedIp.displayLabel}</div>
            )}
            <div className="text-[10px] uppercase tracking-wider mb-4" style={{ color: statusColor(clickedIp.status) }}>
              {statusLabel(clickedIp.status)}
            </div>
            <div className="space-y-2 text-xs mb-4">
              {[
                { key: 'country',  label: t('netmap.tooltip.country', { defaultValue: 'Country' }),   value: clickedIp.country },
                { key: 'failures', label: t('netmap.tooltip.failures', { defaultValue: 'Failures' }), value: String(clickedIp.failures) },
                { key: 'events',   label: t('netmap.agent.events', { defaultValue: 'Events' }),       value: String(clickedIp.eventCount) },
              ].map(r => (
                <div key={r.key} className="flex justify-between">
                  <span className="text-slate-500">{r.label}</span>
                  <span className="text-slate-300 font-mono">{r.value}</span>
                </div>
              ))}
            </div>
            {/* Per-agent per-service breakdown */}
            <div className="mb-4">
              <div className="text-[9px] text-slate-600 uppercase tracking-widest mb-2">{t('netmap.ip.connections', { defaultValue: 'Connections' })}</div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {(() => {
                  // Build breakdown: for each agent this IP touched, count per service
                  const lines: { agentName: string; service: string; count: number }[] = [];
                  for (const aid of clickedIp.agentIds) {
                    const ag = agentsRef.current.find(a => a.id === aid);
                    const agName = ag?.label ?? t('netmap.ip.agentNumber', { id: aid, defaultValue: 'Agent #{{id}}' });
                    // Count from live events matching this IP + agent
                    const svcCounts = new Map<string, number>();
                    for (const ev of liveEvents) {
                      if (ev.ip === clickedIp.ip && ev.agentName === agName) {
                        const svc = ev.service || t('netmap.ip.unknownService', { defaultValue: 'unknown' });
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
                    return <div className="text-slate-600 text-[11px]">{t('netmap.ip.noConnections', { defaultValue: 'No connection data' })}</div>;
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
              <button onClick={() => openIpDrawer(clickedIp.ip)}
                className="w-full px-3 py-1.5 rounded text-xs font-medium text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 hover:bg-cyan-500/20 transition-colors">
                {t('netmap.ip.openDetails', { defaultValue: 'Details & actions' })}
              </button>
              {canBan && clickedIp.status !== 'banned' && clickedIp.status !== 'whitelisted' && (
                <button onClick={() => void quickBan(clickedIp.ip)}
                  className="w-full px-3 py-1.5 rounded text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/25 transition-colors">
                  {t('bans.banIpTitle', { defaultValue: 'Ban IP' })}
                </button>
              )}
              {canWhitelist && clickedIp.status !== 'whitelisted' && (
                <button onClick={() => void quickWhitelist(clickedIp.ip)}
                  className="w-full px-3 py-1.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 transition-colors">
                  {t('ipReputation.actions.whitelist', { defaultValue: 'Whitelist' })}
                </button>
              )}
              <a href={`https://www.abuseipdb.com/check/${encodeURIComponent(clickedIp.ip)}`} target="_blank" rel="noopener noreferrer"
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-slate-400 border border-slate-700 hover:border-slate-500 text-center transition-colors">
                AbuseIPDB
              </a>
              <a href={`https://www.shodan.io/host/${encodeURIComponent(clickedIp.ip)}`} target="_blank" rel="noopener noreferrer"
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-slate-400 border border-slate-700 hover:border-slate-500 text-center transition-colors">
                Shodan
              </a>
              <a href={`https://www.virustotal.com/gui/ip-address/${encodeURIComponent(clickedIp.ip)}`} target="_blank" rel="noopener noreferrer"
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-slate-400 border border-slate-700 hover:border-slate-500 text-center transition-colors">
                VirusTotal
              </a>
              <Link to={`/ip-reputation?search=${encodeURIComponent(clickedIp.ip)}`} onClick={() => setClickedIp(null)}
                className="block w-full px-3 py-1.5 rounded text-xs font-medium text-cyan-400 border border-cyan-500/25 hover:bg-cyan-500/10 text-center transition-colors">
                {t('netmap.ip.viewInReputation', { defaultValue: 'View in IP Reputation' })}
              </Link>
            </div>
          </div>
        )}
      </div>
      )}

      {/* ── Bottom live feed ────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-[color:var(--nm-border)] bg-[color:var(--nm-panel)]">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-1.5 border-b border-[color:var(--nm-border-soft)]">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>
          <span className="font-mono text-[11px] text-slate-500 tracking-widest uppercase">{t('netmap.live.title', { defaultValue: 'Live events' })}</span>
          <span className="ml-auto flex items-center gap-3">
            <span className="font-mono text-[10px] text-slate-600">
              {t('netmap.live.captured', { count: liveEvents.length, defaultValue: 'Captured: {{count}}' })}
            </span>
            <Link
              to="/live-events"
              className="flex items-center gap-1 font-mono text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
              title={t('netmap.live.viewAllTitle', { defaultValue: 'Open the full live events page' })}
            >
              <ExternalLink size={11} />
              <span>{t('netmap.live.viewAll', { defaultValue: 'View all' })}</span>
            </Link>
            <span
              className={`w-2 h-2 rounded-full ${socketOk ? 'bg-cyan-500' : 'bg-red-600'}`}
              title={socketOk
                ? t('netmap.live.socketOn', { defaultValue: 'Real-time connection active' })
                : t('netmap.live.socketOff', { defaultValue: 'Real-time connection lost' })}
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
            <span className="font-mono text-[11px] text-slate-700 pl-1">{t('netmap.live.empty', { defaultValue: 'Monitoring for events…' })}</span>
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
                      {isBan
                        ? `🔒 ${t('netmap.live.ban', { defaultValue: 'Ban' })}`
                        : isFailure ? t('netmap.live.fail', { defaultValue: 'Fail' }) : t('netmap.live.ok', { defaultValue: 'OK' })}
                    </span>
                    <span
                      className={`uppercase text-[11px] w-12 shrink-0 font-semibold ${dangerSvc ? 'text-red-400' : ''}`}
                      style={dangerSvc ? {} : { color: svcColor(ev.service) }}
                    >
                      {(ev.service || '?').slice(0, 8).toUpperCase()}
                    </span>
                    <button
                      onClick={() => showIp(ev.ip)}
                      className={`text-[12px] w-[7.5rem] shrink-0 truncate text-left hover:underline cursor-pointer ${
                        isBan ? 'line-through text-red-400/55' : isFailure ? 'text-orange-300/75' : 'text-slate-400'
                      }`}
                    >
                      {anonIp(ev.ip)}
                    </button>
                    <span className="text-slate-700 shrink-0 text-[10px]">▸</span>
                    <span className="text-slate-500 text-[11px] shrink-0">
                      {anonHostname(ev.agentName || t('netmap.server', { defaultValue: 'Server' }))}
                    </span>
                    {ev.failures != null && ev.failures > 0 && (
                      <span className="text-orange-700/60 text-[11px] shrink-0">{ev.failures}×</span>
                    )}
                    {!isBan && canBan && (
                      <button
                        onClick={() => void quickBan(ev.ip)}
                        disabled={banningIp === ev.ip}
                        className="ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono border border-red-900/40 text-red-700/60 hover:text-red-400 hover:border-red-500/50 transition-colors disabled:opacity-40 leading-none"
                        title={t('netmap.live.banTitle', { ip: anonIp(ev.ip), defaultValue: 'Ban {{ip}}' })}
                        aria-label={t('netmap.live.banTitle', { ip: anonIp(ev.ip), defaultValue: 'Ban {{ip}}' })}
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
                  <span className="font-mono text-[10px] text-slate-700">{t('netmap.live.loadingOlder', { defaultValue: 'Loading older events…' })}</span>
                </div>
              )}
              {!liveEventsHasMoreRef.current && liveEvents.length >= 100 && (
                <div className="py-1.5 text-center">
                  <span className="font-mono text-[10px] text-slate-800">{t('netmap.live.end', { defaultValue: '— end of records —' })}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** White with an alpha (particles, highlight rings, gradient cores). */
function rgbaWhite(a: number): string {
  return rgba(NETMAP_PALETTE.white, a);
}
