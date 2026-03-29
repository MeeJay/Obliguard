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
