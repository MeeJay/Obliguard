import type { AgentCommand, AgentDeviceCreatedEvent, IpBan, IpEventType } from './types';

// Server → Client events
export const SOCKET_EVENTS = {
  // Connection
  INITIAL_DATA: 'initialData',

  // Group events
  GROUP_CREATED: 'group:created',
  GROUP_UPDATED: 'group:updated',
  GROUP_DELETED: 'group:deleted',
  GROUP_MOVED: 'group:moved',
  GROUP_REORDERED: 'group:reordered',

  // Notification events
  NOTIFICATION_SENT: 'notification:sent',

  // Settings events
  SETTINGS_UPDATED: 'settings:updated',

  // Agent device events
  AGENT_DEVICE_UPDATED: 'agent:deviceUpdated',
  /** Real-time UP/DOWN/UPDATING status (AgentLiveStatus) from the agent hub */
  AGENT_STATUS_CHANGED: 'agent:statusChanged',
  /** Emitted when a device is auto-deleted (e.g. after successful uninstall command) */
  AGENT_DEVICE_DELETED: 'agent:deviceDeleted',
  /** New pending enrolment (payload AgentDeviceCreatedEvent), tenant admins only */
  AGENT_DEVICE_CREATED: 'agent:deviceCreated',
  /** Legacy HTTP push received (NetMap pulse): `{ deviceId, tenantId, ... }` */
  AGENT_PUSH_HEARTBEAT: 'agent:pushHeartbeat',
  /** Agent command queue row changed (W14-1): `{ deviceId, command: AgentCommand }`, owning tenant + Default */
  AGENT_COMMAND_UPDATED: 'agent:commandUpdated',

  // IP activity
  /**
   * Batched rows of one agent flush (IpEventsFrame), at most IP_EVENTS_FRAME_CAP
   * per frame. Audience: the agent's tenant + Default (sockets without a team
   * restriction) and the sockets watching the agent (AGENT_WATCH / team grants).
   */
  IP_EVENTS: 'ip:events',
  /**
   * Legacy thin ping, one per (ip, eventType) of a flush (IpFlowEvent), same
   * audience as IP_EVENTS. Kept for one release: consumers move to IP_EVENTS.
   */
  IP_FLOW: 'ip:flow',

  // Bans (payload IpBan as the receiving tenant may see it, unless noted)
  BAN_CREATED: 'ban:created',
  BAN_UPDATED: 'ban:updated',
  /** `{ id, reason }` */
  BAN_LIFTED: 'ban:lifted',
  /** Bulk deactivation (wipe): `{ count, reason }` */
  BAN_BULK_LIFTED: 'ban:bulkLifted',
  /** A tenant opted out of a global ban: `{ banId, tenantId }` (that tenant + Default) */
  BAN_EXCLUDED: 'ban:excluded',
  /** The tenant exclusion was removed: `{ banId, tenantId }` */
  BAN_EXCLUSION_REMOVED: 'ban:exclusionRemoved',
  /** Ban engine auto-ban (BanAutoEvent); originTenantId is set for Default only */
  BAN_AUTO: 'ban:auto',

  // Whitelist / rate limits (refresh hints, WhitelistChangedEvent / RateLimitChangedEvent)
  WHITELIST_CHANGED: 'whitelist:changed',
  RATE_LIMIT_CHANGED: 'rateLimit:changed',

  // Live alert / notification events
  /** Emitted to tenant:{tenantId}:notifications when a new DB-backed alert is created */
  NOTIFICATION_NEW: 'notification:new',
  /** Live alerts marked read server-side: `{ tenantId, ids, readAt }` (user room + tenant notification rooms) */
  NOTIFICATION_READ: 'notification:read',
  /** Live alert incidents resolved (they leave every list): `{ tenantId, ids }` (tenant + Default notification rooms) */
  NOTIFICATION_RESOLVED: 'notification:resolved',
} as const;

// Client → Server events (acknowledged: the last argument is the ack callback)
export const CLIENT_SOCKET_EVENTS = {
  /**
   * Watch one agent's IP activity: `{ deviceId }` → AgentWatchAck. Needs read
   * access to the agent (tenant + team scope). Lasts AGENT_WATCH_TTL_SECONDS:
   * renew it before it ends (the ack gives ttlSeconds). At most
   * AGENT_WATCH_MAX agents per socket.
   */
  AGENT_WATCH: 'agent:watch',
  /** Stop watching: `{ deviceId }` → AgentWatchAck */
  AGENT_UNWATCH: 'agent:unwatch',
} as const;

/** Most events carried by one IP_EVENTS frame; the rest of a flush is counted in `dropped`. */
export const IP_EVENTS_FRAME_CAP = 200;
/** How long an AGENT_WATCH lasts without renewal. */
export const AGENT_WATCH_TTL_SECONDS = 600;
/** Most agents one socket may watch at once. */
export const AGENT_WATCH_MAX = 5;

// ── Payloads ────────────────────────────────────────────────────────────────

/** One stored ip_events row, as streamed by IP_EVENTS. */
export interface IpEventStreamRow {
  /** ip_events.id (monotonic: the newest row has the highest id) */
  id: number;
  ip: string;
  service: string;
  eventType: IpEventType;
  username: string | null;
  deviceId: number;
  tenantId: number;
  /** ISO 8601 */
  timestamp: string;
  trackOnly: boolean;
  sourceAgentId: number | null;
  sourceIpType: 'lan' | 'wan' | null;
}

export interface IpEventsFrame {
  /** Newest first, at most IP_EVENTS_FRAME_CAP rows. */
  events: IpEventStreamRow[];
  /** Rows of the same flush left out of this frame (refetch to see them). */
  dropped: number;
}

export interface IpFlowEvent {
  ip: string;
  service: string;
  eventType: IpEventType;
  deviceId: number;
  tenantId: number;
  sourceAgentId: number | null;
  sourceIpType: 'lan' | 'wan' | null;
}

export interface BanLiftedEvent { id: number; reason?: string | null }
export interface BanBulkLiftedEvent { count: number; reason?: string | null }
export interface BanExclusionEvent { banId: number; tenantId: number }

export interface BanAutoEvent {
  id: number;
  ip: string;
  service: string;
  failureCount: number;
  /** The tenant whose agents triggered the ban: Default sockets only, null elsewhere. */
  originTenantId: number | null;
}

/** Refresh hint: re-read the whitelist. */
export interface WhitelistChangedEvent {
  action: 'created' | 'updated' | 'deleted';
  ids?: number[];
  tenantId?: number | null;
}

/** Refresh hint: re-read the rate-limit policies. */
export interface RateLimitChangedEvent {
  action: 'created' | 'updated' | 'deleted';
  id?: number;
  tenantId?: number | null;
}

export interface AgentWatchRequest { deviceId: number }

export type AgentWatchFailure = 'invalid' | 'session' | 'not_found' | 'too_many' | 'superseded' | 'error';

export type AgentWatchAck =
  | { ok: true; on: boolean; deviceId?: number; ttlSeconds?: number }
  | { ok: false; code: AgentWatchFailure };

/**
 * Server → client contract of the IPS events (Socket.IO `ServerToClientEvents`
 * shape). Events without a fixed payload type are `unknown` here; read them
 * through their own interfaces above or in types.ts.
 */
export interface ServerToClientEvents {
  [SOCKET_EVENTS.IP_EVENTS]: (frame: IpEventsFrame) => void;
  [SOCKET_EVENTS.IP_FLOW]: (event: IpFlowEvent) => void;
  [SOCKET_EVENTS.BAN_CREATED]: (ban: IpBan) => void;
  [SOCKET_EVENTS.BAN_UPDATED]: (ban: IpBan) => void;
  [SOCKET_EVENTS.BAN_LIFTED]: (event: BanLiftedEvent) => void;
  [SOCKET_EVENTS.BAN_BULK_LIFTED]: (event: BanBulkLiftedEvent) => void;
  [SOCKET_EVENTS.BAN_EXCLUDED]: (event: BanExclusionEvent) => void;
  [SOCKET_EVENTS.BAN_EXCLUSION_REMOVED]: (event: BanExclusionEvent) => void;
  [SOCKET_EVENTS.BAN_AUTO]: (event: BanAutoEvent) => void;
  [SOCKET_EVENTS.WHITELIST_CHANGED]: (event: WhitelistChangedEvent) => void;
  [SOCKET_EVENTS.RATE_LIMIT_CHANGED]: (event: RateLimitChangedEvent) => void;
  [SOCKET_EVENTS.AGENT_DEVICE_CREATED]: (event: AgentDeviceCreatedEvent) => void;
  [SOCKET_EVENTS.AGENT_DEVICE_DELETED]: (event: { deviceId: number }) => void;
  [SOCKET_EVENTS.AGENT_DEVICE_UPDATED]: (event: unknown) => void;
  [SOCKET_EVENTS.AGENT_STATUS_CHANGED]: (event: unknown) => void;
  [SOCKET_EVENTS.AGENT_PUSH_HEARTBEAT]: (event: unknown) => void;
  [SOCKET_EVENTS.AGENT_COMMAND_UPDATED]: (event: { deviceId: number; command: AgentCommand }) => void;
  [SOCKET_EVENTS.NOTIFICATION_NEW]: (event: unknown) => void;
  [SOCKET_EVENTS.NOTIFICATION_READ]: (event: { tenantId: number; ids: number[]; readAt: string }) => void;
  [SOCKET_EVENTS.NOTIFICATION_RESOLVED]: (event: { tenantId: number; ids: number[] }) => void;
}

/** Client → server contract (acknowledged requests). */
export interface ClientToServerEvents {
  [CLIENT_SOCKET_EVENTS.AGENT_WATCH]: (req: AgentWatchRequest, ack?: (r: AgentWatchAck) => void) => void;
  [CLIENT_SOCKET_EVENTS.AGENT_UNWATCH]: (req: AgentWatchRequest, ack?: (r: AgentWatchAck) => void) => void;
}

/** Payload type of a server → client event of the contract. */
export type ServerEventPayload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];
