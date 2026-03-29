// ── NetMap Types ──────────────────────────────────────────────────────────────

export interface AgentNode {
  id: number;
  label: string;
  x: number; y: number;
  r: number;
  eventCount: number;
  phase: number;
  lastPushAt: number;
  checkIntervalMs: number;
  maxMissedPushes: number;
  wsConnected: boolean;
  groupId: number | null;
  groupName: string | null;
  /** Device type color (firewall/router/server/windows/desktop). */
  deviceColor: string;
  /** Device type label for display. */
  deviceType: string;
}

export interface IpNode {
  key: string;
  ip: string;
  country: string;
  flag: string;
  agentIds: number[];
  /** Per-agent contact count — used for weighted centroid on multi-agent IPs. */
  agentWeights: Record<number, number>;
  x: number; y: number;
  dotR: number;
  color: string;
  status: string;
  failures: number;
  services: string[];
  eventCount: number;
  lastSeen: number;
  glowUntil: number;
  whitelistLabel?: string | null;
  /** Custom display label from ip_display_names — shown for any status. */
  displayLabel?: string | null;

  // ── Orbital motion ──────────────────────────────────────────────────────
  /** Current orbit angle (radians). */
  orbitAngle: number;
  /** Orbit speed (radians per frame). Positive = CCW, negative = CW. */
  orbitSpeed: number;
  /** Orbit slot index — determines distance from agent center. */
  orbitSlot: number;
  /** 0→1 arrival progress. When < 1, IP is flying in from spawn point. */
  arriveT: number;
  /** Spawn position (edge of canvas) for arrival animation. */
  spawnX: number;
  spawnY: number;
  /** Trail of recent positions for comet tail effect. */
  trail: { x: number; y: number }[];
  /** Per-IP ellipse eccentricity (0.55–0.85) for asteroid belt spread. */
  orbitEccentricity: number;
}

export interface Particle {
  id: string;
  sx: number; sy: number;
  tx: number; ty: number;
  t: number; speed: number; color: string;
}

/** Expanding ring shockwave emitted on a ban event. */
export interface Ripple {
  id: string;
  x: number; y: number;
  t: number;
}

export interface LiveEvent {
  id: string; ip: string; service: string; country: string;
  agentName: string;
  time: Date; color: string;
  eventType: 'auth_success' | 'auth_failure' | 'ban';
  failures?: number;
}

/**
 * Directed edge between two agent nodes.
 * Created when ip_events.source_agent_id is set (peer IP matched another agent).
 */
export interface AgentPeerLink {
  key: string;
  sourceId: number;
  targetId: number;
  type: 'lan' | 'wan';
  services: string[];
  count: number;
  lastSeen: number;
  glowUntil: number;
}

export interface WlEntry {
  networkInt: number;
  mask: number;
  label: string | null;
  /** The plain IP string for single-host (/32 or no prefix) entries, null for broader CIDRs. */
  plainIp: string | null;
}
