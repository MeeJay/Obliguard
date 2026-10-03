import type { Server as SocketIOServer } from 'socket.io';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { isIP } from 'net';
import * as path from 'path';
import { db } from '../db';
import { obliguardHub } from './obliguardHub.service';
import { agentCommandService, hasAgentCapability, isAgentCommandType } from './agentCommand.service';
import { agentKeyService } from './agentKey.service';
import { emitAgentActivity, emitToTenantAdmins, emitToTenantAudience } from '../utils/socketRooms';
import type {
  AgentDevice,
  AgentDisplayConfig,
  AgentGlobalConfig,
  AgentGroupConfig,
  AgentThresholds,
  NotificationTypeConfig,
  ObliguardPushBody,
  ObliguardPushResponse,
  AgentServiceConfig,
  AgentIpEvent,
  RateLimitRule,
  AgentUpdatePolicy,
  AgentUpdatePhase,
  AgentUpdateAttemptInfo,
  AgentUpdateRequestResult,
  AgentVersionDistribution,
  AgentDeviceUpdatedEvent,
  AgentDeviceCreatedEvent,
  AgentTenantUpdatePolicyInfo,
  WindowsFirewallBackend,
  IpEventsFrame,
  IpEventStreamRow,
  IpEventType,
  IpFlowEvent,
} from '@obliview/shared';
import {
  IP_EVENTS_FRAME_CAP,
  DEFAULT_AGENT_THRESHOLDS,
  DEFAULT_AGENT_GLOBAL_CONFIG,
  DEFAULT_AGENT_UPDATE_POLICY,
  SOCKET_EVENTS,
  isMasterTenant,
} from '@obliview/shared';
import {
  AGENT_UPDATE_REQUEST_TTL_MS,
  PROGRESS_UPDATE_PHASES,
  UPDATE_ATTEMPT_TIMEOUT_MS,
  UPDATE_OFFER_MIN_INTERVAL_MS,
  UPDATE_REQUEST_MAX_OFFERS,
  agentRootCandidates,
  buildMatchesServed,
  isAgentUpdatePolicy,
  isStrictlyNewerAgentVersion,
  isUpdateRequestLive,
  isValidServedAgentVersion,
  mergeAgentManifests,
  missingBuildsFor,
  parseAgentManifest,
  resolveAgentUpdatePolicy,
  sanitizeAgentCapabilities,
  shouldAdvertiseUpdate,
  type AgentManifest,
  type GroupPolicyEntry,
  type ParsedUpdateStatus,
} from '../utils/agentUpdate';
import { appConfigService } from './appConfig.service';
import { reserveRolloutSlot, releaseRolloutSlot, __resetRolloutStateForTest } from './agentUpdateRollout.service';
import { notificationService } from './notification.service';
import { liveAlertService, incidentStableKey } from './liveAlert.service';
import type { LiveAlertIncidentKind } from './liveAlert.service';
import { logger } from '../utils/logger';
import { obligateService } from './obligate.service';
import { whitelistService } from './whitelist.service';
import { banService } from './ban.service';
import { ipReputationService } from './ipReputation.service';
import { serviceTemplateService } from './serviceTemplate.service';
import {
  agentKeyMayActForDevice,
  agentKeyMayRebindDevice,
  type AgentKeyRef,
  type DeviceBindingRow,
} from '../utils/agentIdentity';
import { agentConfigService, type ResolvedAgentSettings } from './agentConfig.service';
import { settingsService, writableDefinition, normalizeSettingValue, legacyTypesToFlags } from './settings.service';

// ── Agent ↔ API-key binding (A5) ─────────────────────────────
/**
 * strict (default): a device answers only to the key it enrolled with (an admin
 * releases the binding after a re-key). tenant: any key of the device's tenant
 * re-binds it — first-deploy / mass re-keying only. Cross-tenant and MikroTik
 * refusals apply in both modes.
 */
export const AGENT_KEY_BINDING: 'strict' | 'tenant' = process.env.AGENT_KEY_BINDING === 'tenant' ? 'tenant' : 'strict';
if (AGENT_KEY_BINDING === 'tenant') {
  logger.warn('AGENT_KEY_BINDING=tenant: any API key of a device\'s tenant may re-bind it (first-deploy mode)');
}

/** Max devices waiting for approval per API key. 0 = unlimited. */
export const AGENT_MAX_PENDING_PER_KEY = (() => {
  // Empty / whitespace = unset (Number('') would be 0 = unlimited).
  const raw = process.env.AGENT_MAX_PENDING_PER_KEY?.trim();
  const n = raw ? Number(raw) : 500;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 500;
})();

/** Bounded "recently seen" map helper: refresh with delete-then-set, evict the oldest. */
function _touchBounded<K>(map: Map<K, number>, key: K, ts: number, max: number): void {
  map.delete(key);
  map.set(key, ts);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

const _bindingWarnAt = new Map<string, number>();
const _rebindWarnAt = new Map<string, number>();
const _pendingCapWarnAt = new Map<number, number>();
const _keyUsageAt = new Map<number, number>();

export interface BindingRefusedCtx {
  deviceUuid: string;
  deviceId: number | null;
  apiKeyId: number;
  keyTenantId: number;
  deviceTenantId: number | null;
  boundKeyId: number | null;
  deviceType: string | null;
  via: 'ws' | 'ws-live' | 'push' | 'notify';
}

/** Throttled (1 line / min per uuid + key) warning for a refused device/key pair. */
export function warnBindingRefused(ctx: BindingRefusedCtx): void {
  const k = `${ctx.deviceUuid}|${ctx.apiKeyId}`;
  const now = Date.now();
  const last = _bindingWarnAt.get(k);
  if (last !== undefined && now - last < 60_000) return;
  _touchBounded(_bindingWarnAt, k, now, 1000);
  logger.warn(ctx, 'Agent refused: device/API-key mismatch');
}

/**
 * Socket event of a new pending enrolment (payload AgentDeviceCreatedEvent),
 * sent to the tenant's admins.
 */
export const AGENT_DEVICE_CREATED_EVENT = SOCKET_EVENTS.AGENT_DEVICE_CREATED;

export type HandlePushResult = ObliguardPushResponse & {
  enrolmentDeferred?: true;
  /**
   * Windows agents only (W13-1, settings cascade): the firewall backend to use.
   * Sent on every config frame so a switch back to 'auto' applies too; agents
   * that predate the switch ignore it (absent = 'auto').
   */
  firewallBackend?: WindowsFirewallBackend;
};

export interface HandlePushOptions {
  /**
   * WS channel: the caller writes the config frame and then counts the offer
   * (recordUpdateOffer). HTTP push: the offer is counted here, just before
   * the response is written, and latestVersion is dropped when it was not.
   */
  deferOfferRecord?: boolean;
  /** When the WS channel carrying this heartbeat was registered (ms). */
  connectedAt?: number;
}

// ── MikroTik online detection ────────────────────────────────
// A MikroTik device is considered online if we received a syslog packet
// or had a successful API connection within the last 5 minutes.
const MIKROTIK_ONLINE_TIMEOUT_MS = 5 * 60 * 1000;
const mikrotikLastSeen = new Map<number, number>(); // deviceId → timestamp ms
// Track whether a device has EVER been seen (syslog or API)
const mikrotikEverSeen = new Set<number>();

/** Mark a MikroTik device as seen (called from syslog listener and API test). */
export function markMikrotikSeen(deviceId: number): void {
  mikrotikLastSeen.set(deviceId, Date.now());
  mikrotikEverSeen.add(deviceId);
}

function isMikrotikOnline(deviceId: number): boolean {
  const last = mikrotikLastSeen.get(deviceId);
  if (!last) return false;
  return (Date.now() - last) < MIKROTIK_ONLINE_TIMEOUT_MS;
}

function getMikrotikStatus(deviceId: number, dbLastSyslog?: Date | null, dbLastApi?: Date | null): 'online' | 'offline' | 'misconfigured' {
  // Check in-memory first (most recent)
  if (isMikrotikOnline(deviceId)) return 'online';

  // Misconfigured = syslog never received OR API never succeeded
  const everSyslog = mikrotikEverSeen.has(deviceId) || !!dbLastSyslog;
  const everApi = !!dbLastApi;
  if (!everSyslog || !everApi) return 'misconfigured';

  // Both worked at some point but not recently → offline
  return 'offline';
}

// ── RFC-1918 helper ─────────────────────────────────────────
function isRfc1918(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// ── Event address validation ────────────────────────────────
// Agents validate addresses since W4-3, but older agents can still send a
// non-IP string; one bad inet value would fail the whole ip_events batch
// insert. Returns the canonical address (::ffff:a.b.c.d folded to IPv4) or
// null when the value is not a literal IP.
export function normalizeEventIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const mapped = /^::ffff:([0-9.]+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v === 6) return ip.toLowerCase();
  return null;
}

/** Keeps the events whose IP is a literal address, with the IP normalized. */
function withValidEventIps(events: AgentIpEvent[]): AgentIpEvent[] {
  const out: AgentIpEvent[] = [];
  for (const ev of events) {
    const ip = normalizeEventIp(ev?.ip);
    if (ip) out.push(ip === ev.ip ? ev : { ...ev, ip });
  }
  return out;
}

// ── Socket.io instance (set from index.ts) ──────────────────
let _io: SocketIOServer | null = null;
export function setAgentServiceIO(io: SocketIOServer): void {
  _io = io;
}
export function getAgentServiceIO(): SocketIOServer | null {
  return _io;
}

// ── Presence (AGENT_STATUS_CHANGED 'up' on real transitions only) ───────────
// deviceId → time of the last push that was announced or refreshed. 'up' is
// emitted when a device is not known online: first push since boot, after the
// hub declared it offline (markAgentOffline), or after a gap longer than its
// offline grace window (HTTP-push agents have no disconnect event).
const _presence = new Map<number, number>();

/** Record a push; true when it is an offline → online transition. */
function notePresence(deviceId: number, graceMs: number, now = Date.now()): boolean {
  const prev = _presence.get(deviceId);
  _presence.set(deviceId, now);
  return prev === undefined || now - prev > graceMs;
}

/** The hub declared the device offline: its next push announces 'up' again. */
export function markAgentOffline(deviceId: number): void {
  _presence.delete(deviceId);
}

// ── last_seen_at (W2-1) ──────────────────────────────────────────────────────
// Written on heartbeat / push / events frames, at most once a minute per
// device (in memory, bounded). updated_at stays an audit field.
const LAST_SEEN_THROTTLE_MS = 60_000;
const _lastSeenWriteAt = new Map<number, number>();

/** True (and remembered) when last_seen_at of this device is due for a write. */
function lastSeenDue(deviceId: number, now = Date.now()): boolean {
  const last = _lastSeenWriteAt.get(deviceId);
  if (last !== undefined && now - last < LAST_SEEN_THROTTLE_MS) return false;
  _touchBounded(_lastSeenWriteAt, deviceId, now, 50_000);
  return true;
}

/** Throttled fire-and-forget last_seen_at write. */
function touchLastSeen(deviceId: number): void {
  if (!lastSeenDue(deviceId)) return;
  db('agent_devices').where({ id: deviceId }).update({ last_seen_at: new Date() })
    .catch((err) => logger.warn({ err, deviceId }, 'agent presence: last_seen_at write failed'));
}

// ── Event timestamps (W6-2) ──────────────────────────────────────────────────
// Agent-supplied timestamps are clamped: a clock far in the future would keep
// events inside every ban window (and on top of every list) forever, a very
// old one would bypass the windows of a replayed log.

/** Tolerated agent clock lead. */
export const EVENT_TS_MAX_FUTURE_MS = 5 * 60_000;
/** Oldest accepted event age. */
export const EVENT_TS_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Stored timestamp of an agent event: invalid or more than 5 min ahead →
 * now; older than 24 h → now - 24 h; otherwise as reported.
 */
export function clampEventTimestamp(raw: unknown, now = Date.now()): Date {
  const t = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(t) || t > now + EVENT_TS_MAX_FUTURE_MS) return new Date(now);
  if (t < now - EVENT_TS_MAX_AGE_MS) return new Date(now - EVENT_TS_MAX_AGE_MS);
  return new Date(t);
}

// ── Live IP activity (W8-3) ──────────────────────────────────────────────────
// After a flush is stored, its rows go out as ONE batched ip:events frame
// (full rows with their ids, newest first, at most IP_EVENTS_FRAME_CAP) to the
// agent's tenant feed, the Default feed and the agent's watchers
// (socketRooms.emitAgentActivity: nothing is built when nobody listens). The
// legacy ip:flow ping (one per ip + event type) keeps the same audience for
// one release.

/** One ip_events row as inserted by a flush. */
interface StoredIpEvent {
  device_id: number;
  ip: string;
  username: string | null;
  service: string;
  event_type: string;
  timestamp: Date;
  track_only: boolean;
  tenant_id: number;
  source_agent_id: number | null;
  source_ip_type: 'lan' | 'wan' | null;
}

/** The ip:events frame of one stored flush (`ids`: RETURNING ids, in insert order). */
export function buildIpEventsFrame(rows: StoredIpEvent[], ids: unknown[]): IpEventsFrame {
  const events: IpEventStreamRow[] = [];
  rows.forEach((r, i) => {
    const raw = ids[i];
    const id = Number(typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : raw);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    events.push({
      id,
      ip: r.ip,
      service: r.service,
      eventType: r.event_type as IpEventType,
      username: r.username,
      deviceId: r.device_id,
      tenantId: r.tenant_id,
      timestamp: r.timestamp.toISOString(),
      trackOnly: r.track_only,
      sourceAgentId: r.source_agent_id,
      sourceIpType: r.source_ip_type,
    });
  });
  events.sort((a, b) => b.id - a.id);
  const kept = events.slice(0, IP_EVENTS_FRAME_CAP);
  return { events: kept, dropped: rows.length - kept.length };
}

/** Realtime fan-out of one stored flush of `deviceId` (never throws). */
function emitStoredIpEvents(tenantId: number, deviceId: number, rows: StoredIpEvent[], ids: unknown[]): void {
  if (!_io || rows.length === 0) return;
  try {
    emitAgentActivity(_io, tenantId, deviceId, SOCKET_EVENTS.IP_EVENTS, () => buildIpEventsFrame(rows, ids));
    // Legacy ip:flow (NetMap, AgentDetail): one thin ping per (ip, event type).
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.ip}:${r.event_type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const flow: IpFlowEvent = {
        ip: r.ip,
        service: r.service,
        eventType: r.event_type as IpEventType,
        deviceId,
        tenantId,
        sourceAgentId: r.source_agent_id,
        sourceIpType: r.source_ip_type,
      };
      if (!emitAgentActivity(_io, tenantId, deviceId, SOCKET_EVENTS.IP_FLOW, () => flow)) break;
    }
  } catch (err) {
    logger.warn({ err, deviceId }, 'live IP activity emit failed');
  }
}

// ── Threat notifications (W6-2) ──────────────────────────────────────────────
// A device's flushed auth failures send ONE 'threat' notification per
// cooldown window: last_threat_at is claimed with an atomic conditional
// UPDATE, so concurrent flushes (HTTP push + WS frames) cannot both notify.

/** Minimum gap between two threat notifications of a device. */
export const THREAT_NOTIFY_COOLDOWN_SECONDS = 180;

/**
 * Mark the device under threat and notify its channels, at most once per
 * cooldown window, with the busiest failing source of the batch (ip,
 * service, count, username). Never throws.
 */
async function noteThreat(deviceId: number, events: AgentIpEvent[]): Promise<void> {
  const failures = events.filter((ev) => ev.eventType === 'auth_failure');
  if (failures.length === 0) return;
  try {
    const claimed = await db('agent_devices')
      .where({ id: deviceId })
      .where((q) => q.whereNull('last_threat_at')
        .orWhereRaw('last_threat_at < now() - make_interval(secs => ?)', [THREAT_NOTIFY_COOLDOWN_SECONDS]))
      .update({ last_threat_at: db.fn.now() })
      .returning(['id', 'name', 'hostname']) as Array<{ id: number; name: string | null; hostname: string }>;
    if (claimed.length === 0) return;

    // Busiest (ip, service) of the batch.
    const bySource = new Map<string, { ip: string; service: string; count: number; username?: string }>();
    for (const ev of failures) {
      const key = `${ev.ip}|${ev.service}`;
      const cur = bySource.get(key) ?? { ip: ev.ip, service: ev.service, count: 0 };
      cur.count++;
      if (ev.username) cur.username = ev.username;
      bySource.set(key, cur);
    }
    let top: { ip: string; service: string; count: number; username?: string } | undefined;
    for (const s of bySource.values()) if (!top || s.count > top.count) top = s;

    const label = claimed[0].name || claimed[0].hostname || String(deviceId);
    await notificationService.sendForAgent(deviceId, label, 'threat', 'ok', [], 'threat', top
      ? { ip: top.ip, service: top.service, failureCount: top.count, username: top.username }
      : undefined);
  } catch (err) {
    logger.warn({ err, deviceId }, 'Threat notification failed');
  }
}

// ── Device incidents (W6-2) ──────────────────────────────────────────────────

/** Resolve a device's open incidents (all kinds, or `kinds`). Never throws. */
async function resolveDeviceIncidents(deviceId: number, kinds?: LiveAlertIncidentKind[]): Promise<void> {
  try {
    if (!kinds) {
      await liveAlertService.resolveIncidents({ deviceId });
      return;
    }
    for (const kind of kinds) await liveAlertService.resolveIncidents({ deviceId, kind });
  } catch (err) {
    logger.warn({ err, deviceId }, 'agent incidents: resolve failed');
  }
}

/** A new device waits for approval: an 'agent_pending' incident for its tenant. Never throws. */
async function raisePendingIncident(device: { id: number; tenantId: number; hostname: string }, clientIp: string): Promise<void> {
  try {
    await liveAlertService.raiseIncident({
      tenantId: device.tenantId,
      kind: 'agent_pending',
      stableKey: incidentStableKey('agent_pending', `device:${device.id}`),
      deviceId: device.id,
      severity: 'info',
      title: `Agent awaiting approval: ${device.hostname || `#${device.id}`}`,
      message: `A new agent (${device.hostname || 'unknown host'}, ${clientIp}) enrolled and waits for approval.`,
      link: '/manage/agents',
    });
    // Approved / refused / deleted while the alert was raised: close it.
    const row = await db('agent_devices').where({ id: device.id }).first('status') as { status: string } | undefined;
    if (!row || row.status !== 'pending') await resolveDeviceIncidents(device.id, ['agent_pending']);
  } catch (err) {
    logger.warn({ err, deviceId: device.id }, 'agent incidents: pending alert failed');
  }
}

/** An update attempt became 'failed': an 'agent_update_failed' incident (one per device). Never throws. */
async function raiseUpdateFailedIncident(deviceId: number, targetVersion: string, reason: string): Promise<void> {
  try {
    const row = await db('agent_devices').where({ id: deviceId })
      .first('tenant_id', 'name', 'hostname') as { tenant_id: number; name: string | null; hostname: string } | undefined;
    if (!row) return;
    const label = row.name || row.hostname || `#${deviceId}`;
    await liveAlertService.raiseIncident({
      tenantId: row.tenant_id,
      kind: 'agent_update_failed',
      stableKey: incidentStableKey('agent_update_failed', `device:${deviceId}`),
      deviceId,
      severity: 'warning',
      title: `Agent update failed: ${label}`,
      // reason may come from the agent (update_status error): bounded.
      message: `${label} did not update to ${targetVersion} (${String(reason).slice(0, 200)}).`,
      link: `/agents/${deviceId}`,
    });
  } catch (err) {
    logger.warn({ err, deviceId }, 'agent incidents: update failure alert failed');
  }
}

// ============================================================
// Row ↔ Model helpers
// ============================================================

interface AgentDeviceRow {
  id: number;
  uuid: string;
  hostname: string;
  name: string | null;
  ip: string | null;
  os_info: unknown;
  agent_version: string | null;
  api_key_id: number | null;
  status: string;
  heartbeat_monitoring: boolean;
  check_interval_seconds: number;
  agent_max_missed_pushes: number | null;  // migration 021
  approved_by: number | null;
  approved_at: Date | null;
  group_id: number | null;
  created_at: Date;
  updated_at: Date;
  // migration 025
  sensor_display_names: unknown;
  // migration 026
  override_group_settings: boolean;
  // migration 032
  display_config: unknown;
  // migration 033
  pending_command: string | null;
  uninstall_commanded_at: Date | null;
  // migration 039
  tenant_id: number;
  // migration 040
  updating_since: Date | null;
  // migration 042
  notification_types: unknown;
  // migration 004 (Obliguard)
  last_threat_at: Date | null;
  last_attack_at: Date | null;
  // migration 005 (Obliguard)
  wan_matching_enabled: boolean;
  // migration 023 (Obliguard) — evaluate-only / dry-run mode
  evaluate_only?: boolean;
  // migration 017 (MikroTik)
  device_type: string;
  // Joined from mikrotik_credentials (nullable — only present for MikroTik devices)
  mt_last_syslog_at?: Date | null;
  mt_last_api_connected_at?: Date | null;
  // migration 027 (Obliguard) — agent update control (C17-1)
  update_policy?: string | null;
  update_requested_at?: Date | null;
  update_requested_version?: string | null;
  update_requested_by?: number | null;
  // migration 031 (Obliguard) — presence + capabilities (W2-1)
  last_seen_at?: Date | null;
  last_online_at?: Date | null;
  last_offline_at?: Date | null;
  capabilities?: unknown;
}

/** agent_update_attempts row (migration 031). */
interface UpdateAttemptRow {
  id: number;
  device_id: number;
  target_version: string;
  offered_count: number;
  last_offered_at: Date | null;
  phase: AgentUpdatePhase;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

function attemptToInfo(a: UpdateAttemptRow | null | undefined): AgentUpdateAttemptInfo | null {
  if (!a) return null;
  return {
    targetVersion: a.target_version,
    phase: a.phase,
    attempts: Number(a.offered_count) || 0,
    lastError: a.last_error ?? null,
    updatedAt: new Date(a.updated_at).toISOString(),
  };
}

function isoOrNull(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function capabilitiesOf(raw: unknown): string[] {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// ============================================================
// Agent update control (C17-1)
// ============================================================
//
// latestVersion is advertised to an agent only when its resolved update
// policy allows it ('auto', or a live explicit "Update now"), at most once per
// device every 10 minutes. Every deployed agent build ignores an absent /
// empty latestVersion, so omitting it is a verified no-op for them.

let _agentRoot: string | null | undefined;

/** The repo-level agent/ folder (dist layout, then src layout under tsx). Null results are not cached. */
export function resolveAgentRoot(): string | null {
  if (_agentRoot) return _agentRoot;
  for (const root of agentRootCandidates(__dirname)) {
    if (fs.existsSync(path.join(root, 'VERSION')) || fs.existsSync(path.join(root, 'dist'))) {
      _agentRoot = root;
      return root;
    }
  }
  return null;
}

/** agent/VERSION, else the agentVersion literal of agent/main.go (not 'dev'), else null. Never '0.0.0'. */
function readAgentVersionFromDisk(): string | null {
  const root = resolveAgentRoot();
  if (!root) return null;
  try {
    const v = fs.readFileSync(path.join(root, 'VERSION'), 'utf-8').trim();
    if (v) return v;
  } catch { /* not found, try main.go */ }
  try {
    const content = fs.readFileSync(path.join(root, 'main.go'), 'utf-8');
    const match = content.match(/(?:var|const)\s+agentVersion\s*=\s*"([^"]+)"/);
    if (match?.[1] && match[1] !== 'dev') return match[1];
  } catch { /* not found */ }
  return null;
}

let _served: { v: string | null; at: number } | null = null;
let _servedOverride: string | null | undefined;

/**
 * The agent version this server serves (agent/VERSION), validated; null when
 * unreadable or invalid (then nothing is advertised and no request is cleaned
 * up). Cached 30 s (5 s for a null result).
 */
export function getServedAgentVersion(): string | null {
  if (_servedOverride !== undefined) return _servedOverride;
  const now = Date.now();
  if (_served && now - _served.at < (_served.v === null ? 5_000 : 30_000)) return _served.v;
  const raw = readAgentVersionFromDisk();
  const v = raw !== null && isValidServedAgentVersion(raw) ? raw : null;
  if (raw !== null && v === null) {
    logger.warn({ raw: raw.slice(0, 80) }, 'agent/VERSION is not a valid version; agent updates are not advertised');
  }
  _served = { v, at: now };
  return v;
}

// ── Build manifest (agent/dist/manifest.json, W2-1) ──────────────────────────
//
// The build scripts write agent/dist/manifest.json (version, sha256 and size
// of every artifact). Builds made on other hosts may be dropped next to it as
// manifest.<host>.json fragments; later files win per artifact. The served
// version is advertised only to the os-arch whose artifact embeds it, so a
// stale binary is never downloaded in a loop. No manifest at all = legacy
// layout (no check, logged once).

const MANIFEST_RECHECK_MS = 5_000;
let _manifest: { key: string; manifest: AgentManifest | null; checkedAt: number } | null = null;
let _manifestOverride: AgentManifest | null | undefined;
let _manifestWarned = '';

function manifestFiles(distDir: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(distDir); } catch { return []; }
  const frags = names.filter((n) => /^manifest\.[A-Za-z0-9_-]{1,32}\.json$/.test(n)).sort();
  return [...(names.includes('manifest.json') ? ['manifest.json'] : []), ...frags];
}

/** The merged build manifest (re-read when a file's mtime or size changes), or null. */
export function getAgentManifest(): AgentManifest | null {
  if (_manifestOverride !== undefined) return _manifestOverride;
  // Tests that pin the served version never depend on the local dist/ folder.
  if (_servedOverride !== undefined) return null;
  const now = Date.now();
  if (_manifest && now - _manifest.checkedAt < MANIFEST_RECHECK_MS) return _manifest.manifest;
  const root = resolveAgentRoot();
  const distDir = root ? path.join(root, 'dist') : null;
  const files = distDir ? manifestFiles(distDir) : [];
  const stats: Array<{ name: string; mtimeMs: number; size: number }> = [];
  for (const name of files) {
    try {
      const st = fs.statSync(path.join(distDir!, name));
      stats.push({ name, mtimeMs: st.mtimeMs, size: st.size });
    } catch { /* vanished */ }
  }
  const key = stats.map((x) => `${x.name}:${x.mtimeMs}:${x.size}`).join('|');
  if (_manifest && _manifest.key === key) {
    _manifest.checkedAt = now;
    return _manifest.manifest;
  }
  const parsed: AgentManifest[] = [];
  for (const x of stats.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    try {
      const m = parseAgentManifest(JSON.parse(fs.readFileSync(path.join(distDir!, x.name), 'utf-8')));
      if (m) parsed.push(m);
      else logger.warn({ file: x.name }, 'agent build manifest is malformed; ignored');
    } catch (err) {
      logger.warn({ err, file: x.name }, 'agent build manifest unreadable; ignored');
    }
  }
  const manifest = mergeAgentManifests(parsed);
  _manifest = { key, manifest, checkedAt: now };
  const served = getServedAgentVersion();
  const missing = missingBuildsFor(manifest, served);
  const warnKey = `${key}|${served}|${manifest ? 'm' : 'none'}`;
  if (warnKey !== _manifestWarned) {
    _manifestWarned = warnKey;
    if (!manifest) {
      logger.warn('agent/dist/manifest.json not found: served agent builds are not checked against agent/VERSION');
    } else if (missing.length > 0) {
      logger.warn({ served, missingBuilds: missing }, 'agent builds missing or not matching agent/VERSION: no update advertised to these platforms');
    }
  }
  return manifest;
}

// Read once at startup so a missing or stale build is logged before the first heartbeat.
setImmediate(() => { try { getAgentManifest(); } catch { /* logged on next use */ } });

/** os-arch artifacts that do not embed the served version (empty without a manifest). */
export function getMissingAgentBuilds(): string[] {
  return missingBuildsFor(getAgentManifest(), getServedAgentVersion());
}

// ── Download integrity (X-Content-SHA256) ────────────────────────────────────

const _fileHashes = new Map<string, { mtimeMs: number; size: number; sha256: Promise<string> }>();

/**
 * SHA-256 of a dist file, streamed and cached per (mtime, size): a fleet
 * fetching the same build hashes it once. A failed computation is not cached.
 */
export async function agentFileSha256(filePath: string): Promise<string> {
  const st = await fs.promises.stat(filePath);
  const hit = _fileHashes.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.sha256;
  const sha256 = new Promise<string>((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
  _fileHashes.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, sha256 });
  sha256.catch(() => { if (_fileHashes.get(filePath)?.sha256 === sha256) _fileHashes.delete(filePath); });
  return sha256;
}

let _now: () => number = () => Date.now();

/** Clock of the update control (the harness may freeze it): the rollout window counts on it. */
export function getAgentUpdateClock(): number {
  return _now();
}

const REQUEST_NULLS = { update_requested_at: null, update_requested_version: null, update_requested_by: null };

let _updPolicyCache: { map: Map<number, GroupPolicyEntry[]> | null; at: number } | null = null;
let _chainsLoaderOverride: (() => Promise<Map<number, GroupPolicyEntry[]>>) | null = null;
const UPD_POLICY_CACHE_TTL_MS = 15_000;
/** A failed lookup is cached briefly so a persistent failure does not re-query (and warn) on every heartbeat. */
const UPD_POLICY_FAILURE_TTL_MS = 5_000;

let _tenantPolicyCache: { map: Map<number, AgentUpdatePolicy> | null; at: number } | null = null;
let _tenantPoliciesLoaderOverride: (() => Promise<Map<number, AgentUpdatePolicy>>) | null = null;

/** Drop the cached group and tenant policies (group / tenant policy edited, import). */
export function invalidateAgentUpdatePolicyCache(): void {
  _updPolicyCache = null;
  _tenantPolicyCache = null;
}

/** descendant group id → groups with an explicit policy in its ancestor chain, nearest first. */
async function loadGroupUpdatePolicyChains(): Promise<Map<number, GroupPolicyEntry[]>> {
  const rows = await db('group_closure as gc')
    .join('monitor_groups as g', 'g.id', 'gc.ancestor_id')
    .whereRaw("jsonb_typeof(g.agent_group_config::jsonb) = 'object'")
    .whereRaw("g.agent_group_config::jsonb->>'updatePolicy' IN ('auto','manual','off')")
    .select(
      'gc.descendant_id as descendantId',
      'gc.ancestor_id as groupId',
      'gc.depth as depth',
      'g.tenant_id as tenantId',
      db.raw("g.agent_group_config::jsonb->>'updatePolicy' as policy"),
    )
    .orderBy([{ column: 'gc.descendant_id' }, { column: 'gc.depth', order: 'asc' }]) as Array<{
      descendantId: number; groupId: number; depth: number; tenantId: number; policy: AgentUpdatePolicy;
    }>;
  const map = new Map<number, GroupPolicyEntry[]>();
  for (const r of rows) {
    let chain = map.get(r.descendantId);
    if (!chain) { chain = []; map.set(r.descendantId, chain); }
    chain.push({ groupId: r.groupId, tenantId: r.tenantId, policy: r.policy });
  }
  return map;
}

/** Group policy chains (15 s cache), or null when the lookup failed (failure cached 5 s: fail closed). */
export async function getGroupUpdatePolicyChains(): Promise<Map<number, GroupPolicyEntry[]> | null> {
  if (_updPolicyCache) {
    const ttl = _updPolicyCache.map === null ? UPD_POLICY_FAILURE_TTL_MS : UPD_POLICY_CACHE_TTL_MS;
    if (Date.now() - _updPolicyCache.at < ttl) return _updPolicyCache.map;
  }
  try {
    const map = await (_chainsLoaderOverride ?? loadGroupUpdatePolicyChains)();
    _updPolicyCache = { map, at: Date.now() };
    return map;
  } catch (err) {
    logger.warn({ err }, 'agent update policy: group chain lookup failed; updates not advertised until it succeeds');
    _updPolicyCache = { map: null, at: Date.now() };
    return null;
  }
}

/** tenant id → explicit tenant policy (tenants without one are absent). */
async function loadTenantUpdatePolicies(): Promise<Map<number, AgentUpdatePolicy>> {
  const rows = await db('tenants').whereNotNull('agent_update_policy')
    .select('id', 'agent_update_policy') as Array<{ id: number; agent_update_policy: string }>;
  const map = new Map<number, AgentUpdatePolicy>();
  for (const r of rows) if (isAgentUpdatePolicy(r.agent_update_policy)) map.set(Number(r.id), r.agent_update_policy);
  return map;
}

/** Tenant policies (one query for every tenant, 15 s cache), or null when the lookup failed (fail closed). */
export async function getTenantUpdatePolicies(): Promise<Map<number, AgentUpdatePolicy> | null> {
  if (_tenantPolicyCache) {
    const ttl = _tenantPolicyCache.map === null ? UPD_POLICY_FAILURE_TTL_MS : UPD_POLICY_CACHE_TTL_MS;
    if (Date.now() - _tenantPolicyCache.at < ttl) return _tenantPolicyCache.map;
  }
  try {
    const map = await (_tenantPoliciesLoaderOverride ?? loadTenantUpdatePolicies)();
    _tenantPolicyCache = { map, at: Date.now() };
    return map;
  } catch (err) {
    logger.warn({ err }, 'agent update policy: tenant policy lookup failed; updates not advertised until it succeeds');
    _tenantPolicyCache = { map: null, at: Date.now() };
    return null;
  }
}

/** Latest update attempt of each device (by last change), or an empty map on failure (display only). */
async function loadLatestAttempts(deviceIds: number[]): Promise<Map<number, UpdateAttemptRow>> {
  const map = new Map<number, UpdateAttemptRow>();
  if (deviceIds.length === 0) return map;
  try {
    const rows = await db.raw(
      `SELECT DISTINCT ON (device_id) * FROM agent_update_attempts
        WHERE device_id = ANY(?::int[])
        ORDER BY device_id, updated_at DESC, id DESC`,
      [deviceIds],
    ) as { rows: UpdateAttemptRow[] };
    for (const r of rows.rows) map.set(Number(r.device_id), r);
  } catch (err) {
    logger.warn({ err }, 'agent update: attempt lookup failed');
  }
  return map;
}

// ── Test seams (verification harness only) ──
export function __setServedAgentVersionForTest(v: string | null | undefined): void {
  _servedOverride = v;
  _served = null;
}
export function __setAgentUpdateClockForTest(fn: (() => number) | null): void {
  _now = fn ?? (() => Date.now());
}
export function __setGroupUpdatePolicyChainsLoaderForTest(fn: (() => Promise<Map<number, GroupPolicyEntry[]>>) | null): void {
  _chainsLoaderOverride = fn;
  _updPolicyCache = null;
}
export function __setTenantUpdatePoliciesLoaderForTest(fn: (() => Promise<Map<number, AgentUpdatePolicy>>) | null): void {
  _tenantPoliciesLoaderOverride = fn;
  _tenantPolicyCache = null;
}
/** undefined = read agent/dist; null = no manifest; a manifest = use it. */
export function __setAgentManifestForTest(m: AgentManifest | null | undefined): void {
  _manifestOverride = m;
  _manifest = null;
}
export function __resetAgentUpdateStateForTest(): void {
  _served = null;
  _servedOverride = undefined;
  _agentRoot = undefined;
  _updPolicyCache = null;
  _chainsLoaderOverride = null;
  _tenantPolicyCache = null;
  _tenantPoliciesLoaderOverride = null;
  _manifest = null;
  _manifestOverride = undefined;
  _lastSeenWriteAt.clear();
  _now = () => Date.now();
  __resetRolloutStateForTest();
}

type UpdCtx = {
  groupChain: GroupPolicyEntry[] | null;
  /** Explicit tenant policies, or null when the lookup failed. */
  tenantPolicies: Map<number, AgentUpdatePolicy> | null;
  served: string | null;
  attempt?: UpdateAttemptRow | null;
};

/** A device with no group needs no chain, so a failed group lookup never freezes it. */
function updCtx(
  row: AgentDeviceRow,
  chains: Map<number, GroupPolicyEntry[]> | null,
  served: string | null,
  tenantPolicies: Map<number, AgentUpdatePolicy> | null,
  attempt?: UpdateAttemptRow | null,
): UpdCtx {
  return {
    groupChain: row.group_id == null ? [] : chains === null ? null : (chains.get(row.group_id) ?? []),
    tenantPolicies,
    served,
    attempt,
  };
}

/** Update-control fields of an AgentDevice. */
function updateFieldsFor(row: AgentDeviceRow, globalConfig: AgentGlobalConfig | null | undefined, upd: UpdCtx | undefined) {
  const dp = isAgentUpdatePolicy(row.update_policy) ? row.update_policy : null;
  const gp = isAgentUpdatePolicy(globalConfig?.updatePolicy) ? globalConfig!.updatePolicy! : null;
  // Only groups of the device's own tenant count (legacy cross-tenant nesting is ignored).
  const chain = upd?.groupChain === null ? null : (upd?.groupChain ?? []).filter((e) => Number(e.tenantId) === Number(row.tenant_id));
  // No context (internal callers) = no tenant level; a failed tenant lookup fails closed.
  const tenantPolicies = upd ? upd.tenantPolicies : new Map<number, AgentUpdatePolicy>();
  const r: { policy: AgentUpdatePolicy; source: NonNullable<AgentDevice['updatePolicySource']>; sourceGroupId: number | null } =
    chain === null || tenantPolicies === null
      ? (gp === 'off'
          ? { policy: 'off', source: 'global', sourceGroupId: null }
          : { policy: 'off', source: 'unresolved', sourceGroupId: null })
      : resolveAgentUpdatePolicy(dp, chain, tenantPolicies.get(Number(row.tenant_id)) ?? null, gp);
  const served = upd ? upd.served : null;
  const updateAvailable = row.device_type !== 'mikrotik' && row.status === 'approved' && served !== null
    && !!row.agent_version && isStrictlyNewerAgentVersion(served, row.agent_version);
  const live = isUpdateRequestLive({
    requestedAt: row.update_requested_at ?? null,
    requestedVersion: row.update_requested_version ?? null,
    served,
    now: _now(),
  });
  return {
    updatePolicy: dp,
    resolvedUpdatePolicy: r.policy,
    updatePolicySource: r.source,
    updatePolicySourceGroupId: r.sourceGroupId,
    latestAgentVersion: served,
    updateAvailable,
    updateRequestedAt: row.update_requested_at ? new Date(row.update_requested_at).toISOString() : null,
    updateRequestedVersion: row.update_requested_version ?? null,
    updatePending: live && r.policy !== 'off' && updateAvailable,
    ...(upd && upd.attempt !== undefined ? { update: attemptToInfo(upd.attempt) } : {}),
  };
}

/** Emit an AGENT_DEVICE_UPDATED patch to the device's tenant audience. */
function emitDevicePatch(tenantId: number, deviceId: number, patch: Partial<AgentDevice>): void {
  const payload: AgentDeviceUpdatedEvent = { deviceId, patch };
  emitToTenantAudience(_io, tenantId, SOCKET_EVENTS.AGENT_DEVICE_UPDATED, payload);
}

/** Emit the latest attempt of a device (after a phase change). Never throws. */
async function emitAttemptPatch(deviceId: number, tenantId?: number): Promise<void> {
  try {
    const tid = tenantId ?? await agentService.getDeviceTenantId(deviceId);
    if (tid == null) return;
    const latest = (await loadLatestAttempts([deviceId])).get(deviceId) ?? null;
    emitDevicePatch(tid, deviceId, { update: attemptToInfo(latest) });
  } catch { /* display only */ }
}

/**
 * Close the open attempts of these devices ('cancelled'): the update became
 * impossible (policy off, suspended, refused, request cancelled). The next
 * offer, if any, starts a fresh budget.
 */
async function cancelOpenAttempts(deviceIds: number[], now = _now()): Promise<void> {
  if (deviceIds.length === 0) return;
  try {
    await db('agent_update_attempts')
      .whereIn('device_id', deviceIds)
      .whereIn('phase', ['offered', ...PROGRESS_UPDATE_PHASES])
      .update({ phase: 'cancelled', finished_at: new Date(now), updated_at: new Date(now) });
  } catch (err) {
    logger.warn({ err }, 'agent update: cancelling open attempts failed');
  }
}

/**
 * Conditional clear of an update request: only the request read at
 * `readAtMs` is cleared (2 ms tolerance for µs→ms truncation); a newer click
 * landing in between survives.
 */
export async function clearUpdateRequestIfUnchanged(id: number, readAtMs: number): Promise<boolean> {
  const n = await db('agent_devices').where({ id })
    .whereRaw('abs(extract(epoch from update_requested_at) * 1000 - ?) < 2', [readAtMs])
    .update(REQUEST_NULLS);
  return n > 0;
}

/**
 * Close a request that can no longer be honoured (status, policy off, done,
 * expired, superseded). A null served version or an 'unresolved' policy never
 * clears anything. Never throws.
 */
async function reconcileUpdateRequest(device: AgentDevice, reported: string, now: number): Promise<AgentDevice> {
  try {
    const served = getServedAgentVersion();
    if (!device.updateRequestedAt) return device;
    const reqAtMs = Date.parse(device.updateRequestedAt);
    const reqV = device.updateRequestedVersion ?? null;
    let reason: string | null = null;
    if (device.status !== 'approved') reason = 'status';
    else if (device.resolvedUpdatePolicy === 'off' && device.updatePolicySource !== 'unresolved') reason = 'policy_off';
    else if (!reqV) reason = 'invalid';
    else if (!isStrictlyNewerAgentVersion(reqV, reported)) reason = 'done';
    else if (now - reqAtMs >= AGENT_UPDATE_REQUEST_TTL_MS) reason = 'expired';
    else if (served !== null && reqV !== served) reason = 'superseded';
    if (reason === null) return device;
    const cleared = await clearUpdateRequestIfUnchanged(device.id, reqAtMs);
    if (!cleared) return device;
    logger.info({
      event: 'agent_update_request_closed', deviceId: device.id, tenantId: device.tenantId, reason, requestedVersion: reqV, reported,
    }, 'Agent update request closed');
    return { ...device, updateRequestedAt: null, updateRequestedVersion: null, updatePending: false };
  } catch (err) {
    logger.warn({ err, deviceId: device.id }, 'agent update: request reconciliation skipped');
    return device;
  }
}

/**
 * Outcome of the update attempts on a heartbeat (FLEET-AGENT-1/9):
 *   - the agent reports a version >= the target: 'succeeded';
 *   - it reconnected (a channel opened after the phase change; for HTTP push,
 *     2 min later) still on an older version after 'installing' /
 *     'restarting': 'failed' ('reverted_or_failed').
 * Never throws.
 */
async function reconcileUpdateAttempts(
  device: AgentDevice,
  reported: string,
  now: number,
  connectedAt: number | undefined,
): Promise<void> {
  if (!reported) return;
  try {
    const open = await db('agent_update_attempts')
      .where({ device_id: device.id })
      .whereNot({ phase: 'succeeded' })
      .select('*') as UpdateAttemptRow[];
    let changed = false;
    for (const a of open) {
      if (!isStrictlyNewerAgentVersion(a.target_version, reported)) {
        const n = await db('agent_update_attempts').where({ id: a.id }).whereNot({ phase: 'succeeded' })
          .update({ phase: 'succeeded', last_error: null, finished_at: new Date(now), updated_at: new Date(now) });
        if (n > 0) {
          changed = true;
          logger.info({
            event: 'agent_update_succeeded', deviceId: device.id, tenantId: device.tenantId, targetVersion: a.target_version, reported,
          }, 'Agent update succeeded');
          await resolveDeviceIncidents(device.id, ['agent_update_failed']);
        }
        continue;
      }
      if (a.phase !== 'installing' && a.phase !== 'restarting') continue;
      const phaseAt = new Date(a.updated_at).getTime();
      const reconnected = connectedAt !== undefined ? connectedAt > phaseAt : now - phaseAt >= 2 * 60_000;
      if (!reconnected) continue;
      const n = await db('agent_update_attempts').where({ id: a.id, phase: a.phase })
        .update({ phase: 'failed', last_error: 'reverted_or_failed', finished_at: new Date(now), updated_at: new Date(now) });
      if (n > 0) {
        changed = true;
        logger.warn({
          event: 'agent_update_failed', deviceId: device.id, tenantId: device.tenantId, targetVersion: a.target_version, reported, reason: 'reverted_or_failed',
        }, 'Agent update failed: the agent came back on its previous version');
        await raiseUpdateFailedIncident(device.id, a.target_version, 'the agent came back on its previous version');
      }
    }
    if (changed) await emitAttemptPatch(device.id, device.tenantId);
  } catch (err) {
    logger.warn({ err, deviceId: device.id }, 'agent update: attempt reconciliation skipped');
  }
}

/**
 * The latestVersion to put in this config frame, or undefined. Does NOT count
 * the offer: the caller records it once the frame is written
 * (recordUpdateOffer). Never throws.
 *
 * Gates, in order: policy / request (shouldAdvertiseUpdate), a build of the
 * served version for the agent's os-arch (manifest), the 10-min spacing of
 * offers, then the cap of UPDATE_REQUEST_MAX_OFFERS offers per (device,
 * target) under every policy: past it the attempt is 'failed'
 * ('no_progress'), a pending request is dropped, and nothing is advertised
 * until a retry. Last, the fleet-wide rollout window (W12-4,
 * agentUpdateRollout.service): a frame that would carry latestVersion takes a
 * slot of the window, or waits for a later heartbeat when it is full.
 */
async function resolveAdvertisedVersion(device: AgentDevice, reported: string, now: number): Promise<string | undefined> {
  try {
    const served = getServedAgentVersion();
    const policy = device.resolvedUpdatePolicy ?? DEFAULT_AGENT_UPDATE_POLICY;
    const requestLive = isUpdateRequestLive({
      requestedAt: device.updateRequestedAt ?? null,
      requestedVersion: device.updateRequestedVersion ?? null,
      served,
      now,
    });
    if (!shouldAdvertiseUpdate({ served, reported, policy, requestLive, deviceType: device.deviceType ?? 'agent', status: device.status })) {
      return undefined;
    }
    if (!buildMatchesServed(getAgentManifest(), served!, device.osInfo)) return undefined;
    const a = await db('agent_update_attempts')
      .where({ device_id: device.id, target_version: served! })
      .first() as UpdateAttemptRow | undefined;
    if (!a) return await withRolloutSlot(device.id, served!, now);
    const fresh = a.phase === 'cancelled' || a.phase === 'succeeded';
    if (a.last_offered_at && now - new Date(a.last_offered_at).getTime() < UPDATE_OFFER_MIN_INTERVAL_MS) return undefined;
    // An update in flight (progress phase, younger than the timeout) is neither
    // re-offered (that would reset its phase and hide a revert) nor abandoned.
    if ((PROGRESS_UPDATE_PHASES as readonly string[]).includes(a.phase)
      && now - new Date(a.updated_at).getTime() < UPDATE_ATTEMPT_TIMEOUT_MS) return undefined;
    if (fresh || a.offered_count < UPDATE_REQUEST_MAX_OFFERS) return await withRolloutSlot(device.id, served!, now);

    // Cap reached without the agent reporting the target.
    const n = await db('agent_update_attempts')
      .where({ id: a.id })
      .whereNotIn('phase', ['failed', 'succeeded', 'cancelled'])
      .update({ phase: 'failed', last_error: 'no_progress', finished_at: new Date(now), updated_at: new Date(now) });
    if (device.updateRequestedAt) await clearUpdateRequestIfUnchanged(device.id, Date.parse(device.updateRequestedAt));
    if (n > 0) {
      logger.warn(
        { event: 'agent_update_request_abandoned', deviceId: device.id, tenantId: device.tenantId, served, reported, offers: a.offered_count },
        'Agent update abandoned after 3 offers without the agent reporting the new version',
      );
      await emitAttemptPatch(device.id, device.tenantId);
      await raiseUpdateFailedIncident(device.id, served!, 'no progress after 3 offers');
    }
    return undefined;
  } catch (err) {
    logger.warn({ err, deviceId: device.id }, 'agent update: advertisement skipped');
    return undefined;
  }
}

/** `served` when the rollout window has a slot for this device (W12-4), else undefined (offered later). */
async function withRolloutSlot(deviceId: number, served: string, now: number): Promise<string | undefined> {
  return (await reserveRolloutSlot(deviceId, now)) ? served : undefined;
}

/**
 * Count an offer of `version` to a device, AFTER the config frame carrying it
 * was written. Conditional: at most one counted offer per 10 minutes and
 * UPDATE_REQUEST_MAX_OFFERS per (device, target) — a 'cancelled' or
 * 'succeeded' attempt restarts its budget. Returns false when the offer was
 * not counted (a concurrent frame won, or the cap was reached). Never throws.
 * Releases the device's rollout slot: once counted, the offer is in the window.
 */
export async function recordUpdateOffer(deviceId: number, version: string, now = _now()): Promise<boolean> {
  try {
    const at = new Date(now);
    const cutoff = new Date(now - UPDATE_OFFER_MIN_INTERVAL_MS);
    const r = await db.raw(
      `INSERT INTO agent_update_attempts AS a
         (device_id, target_version, offered_count, last_offered_at, phase, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'offered', ?, ?)
       ON CONFLICT (device_id, target_version) DO UPDATE SET
         offered_count = CASE WHEN a.phase IN ('cancelled', 'succeeded') THEN 1 ELSE a.offered_count + 1 END,
         last_offered_at = EXCLUDED.last_offered_at,
         phase = 'offered',
         last_error = NULL,
         finished_at = NULL,
         updated_at = EXCLUDED.updated_at
       WHERE (a.last_offered_at IS NULL OR a.last_offered_at < ?)
         AND (a.phase IN ('cancelled', 'succeeded') OR a.offered_count < ?)
       RETURNING a.offered_count`,
      [deviceId, version, at, at, at, cutoff, UPDATE_REQUEST_MAX_OFFERS],
    ) as { rows: Array<{ offered_count: number }> };
    const counted = r.rows.length > 0;
    if (counted) {
      logger.info({ event: 'agent_update_offered', deviceId, version, offer: r.rows[0].offered_count }, 'Agent update offered');
      void emitAttemptPatch(deviceId);
    }
    return counted;
  } catch (err) {
    logger.warn({ err, deviceId }, 'agent update: offer bookkeeping failed');
    return false;
  } finally {
    releaseRolloutSlot(deviceId);
  }
}

type ListRow = AgentDeviceRow & { _group_agent_config: unknown; _group_agent_thresholds: unknown; _group_name: string | null };

/** Select of listDevices / getDevicesByIdsInTenant (device + group config + MikroTik status). */
function deviceListQuery() {
  return db('agent_devices as d')
    .leftJoin('monitor_groups as g', 'g.id', 'd.group_id')
    .leftJoin('mikrotik_credentials as mt', 'mt.device_id', 'd.id')
    .select(
      'd.*',
      db.raw('g.agent_group_config as _group_agent_config'),
      db.raw('g.agent_thresholds as _group_agent_thresholds'),
      db.raw('g.name as _group_name'),
      db.raw('mt.last_syslog_at as mt_last_syslog_at'),
      db.raw('mt.last_api_connected_at as mt_last_api_connected_at'),
    );
}

/** Context shared by every device hydration (one query each, cached where possible). */
interface HydrationCtx {
  globalConfig: AgentGlobalConfig | null;
  evalGroupIds: Set<number>;
  chains: Map<number, GroupPolicyEntry[]> | null;
  tenantPolicies: Map<number, AgentUpdatePolicy> | null;
}

async function loadHydrationCtx(): Promise<HydrationCtx> {
  const [globalConfig, evalGroupIds, chains, tenantPolicies] = await Promise.all([
    appConfigService.getAgentGlobal(),
    getEvaluateOnlyGroupIds(),
    getGroupUpdatePolicyChains(),
    getTenantUpdatePolicies(),
  ]);
  return { globalConfig, evalGroupIds, chains, tenantPolicies };
}

/** A legacy check interval column as a valid cascade value (older rows may hold < 10 s). */
function clampCheckInterval(v: number | null | undefined): number {
  return Math.min(86400, Math.max(10, Math.round(Number(v) || 60)));
}

/** A device row as the settings cascade needs it (agentConfig.service). */
function cascadeRef(row: AgentDeviceRow) {
  return { id: row.id, tenantId: row.tenant_id, groupId: row.group_id, evaluateOnly: row.evaluate_only ?? false };
}

/** Cascade settings of many rows (one resolver snapshot). */
function resolveCascade(rows: AgentDeviceRow[]): Promise<Map<number, ResolvedAgentSettings>> {
  return agentConfigService.resolveForDevices(rows.map(cascadeRef));
}

/**
 * Hydrate one device row (group config + thresholds read for its group).
 * withAttempt=false (agent channel hot path) leaves AgentDevice.update out.
 */
async function hydrateDeviceRow(row: AgentDeviceRow, withAttempt = true): Promise<AgentDevice> {
  const [groupConfig, groupThresholds, ctx, attempts, cascade] = await Promise.all([
    row.group_id ? getGroupAgentConfig(row.group_id) : null,
    row.group_id ? getGroupAgentThresholds(row.group_id) : null,
    loadHydrationCtx(),
    withAttempt ? loadLatestAttempts([row.id]) : null,
    agentConfigService.resolveForDevice(cascadeRef(row)),
  ]);
  return rowToDevice(
    row, groupConfig, groupThresholds, ctx.globalConfig, evalStateFor(row, ctx.evalGroupIds),
    updCtx(row, ctx.chains, getServedAgentVersion(), ctx.tenantPolicies, attempts ? (attempts.get(row.id) ?? null) : undefined),
    cascade,
  );
}

function hydrateDeviceRows(
  rows: ListRow[],
  ctx: HydrationCtx,
  attempts: Map<number, UpdateAttemptRow>,
  cascade: Map<number, ResolvedAgentSettings>,
): AgentDevice[] {
  const { globalConfig, evalGroupIds, chains, tenantPolicies } = ctx;
  const served = getServedAgentVersion();
  return rows.map((r) => {
    const gc = r._group_agent_config
      ? (typeof r._group_agent_config === 'string'
        ? JSON.parse(r._group_agent_config)
        : r._group_agent_config) as AgentGroupConfig
      : null;
    const gt = r._group_agent_thresholds
      ? (typeof r._group_agent_thresholds === 'string'
        ? JSON.parse(r._group_agent_thresholds)
        : r._group_agent_thresholds) as AgentThresholds
      : null;
    const dev = rowToDevice(
      r, gc, gt, globalConfig, evalStateFor(r, evalGroupIds),
      updCtx(r, chains, served, tenantPolicies, attempts.get(r.id) ?? null), cascade.get(r.id),
    );
    (dev as AgentDevice & { groupName?: string | null }).groupName = r._group_name ?? null;
    return dev;
  });
}

function rowToDevice(
  row: AgentDeviceRow,
  groupConfig?: AgentGroupConfig | null,
  groupThresholds?: AgentThresholds | null,
  globalConfig?: AgentGlobalConfig | null,
  evalState?: { evaluateOnly: boolean; source: 'agent' | 'group' | null },
  upd?: UpdCtx,
  cascade?: ResolvedAgentSettings,
): AgentDevice {
  const override = row.override_group_settings ?? false;

  // Effective evaluate-only: explicit evalState (resolved with group ancestry)
  // wins; otherwise fall back to the device's own flag so at least a direct
  // device-level setting is reflected even without ancestry resolution.
  const evaluateOnly = evalState?.evaluateOnly ?? (row.evaluate_only ?? false);
  const evaluateOnlySource: 'agent' | 'group' | null =
    evalState !== undefined ? evalState.source : (row.evaluate_only ? 'agent' : null);

  // Effective heartbeat settings: the IPS settings cascade (W13-1, global ->
  // tenant -> group chain -> agent). Without it (a row just inserted, never
  // read back) the legacy columns give the same answer for the device / group /
  // global levels.
  const deviceMMP = row.agent_max_missed_pushes ?? null;
  const resolvedSettings: AgentDevice['resolvedSettings'] = cascade
    ? { checkIntervalSeconds: cascade.checkIntervalSeconds, maxMissedPushes: cascade.maxMissedPushes }
    : {
        checkIntervalSeconds: override
          ? row.check_interval_seconds
          : (groupConfig?.pushIntervalSeconds ?? globalConfig?.checkIntervalSeconds ?? DEFAULT_AGENT_GLOBAL_CONFIG.checkIntervalSeconds),
        maxMissedPushes: deviceMMP ?? groupConfig?.maxMissedPushes ?? globalConfig?.maxMissedPushes ?? DEFAULT_AGENT_GLOBAL_CONFIG.maxMissedPushes,
      };

  return {
    id: row.id,
    uuid: row.uuid,
    hostname: row.hostname,
    tenantId: row.tenant_id as number,
    name: row.name ?? null,
    ip: row.ip,
    osInfo: typeof row.os_info === 'string' ? JSON.parse(row.os_info) : (row.os_info as AgentDevice['osInfo']),
    agentVersion: row.agent_version,
    apiKeyId: row.api_key_id,
    status: row.status as AgentDevice['status'],
    checkIntervalSeconds: row.check_interval_seconds,
    maxMissedPushes: deviceMMP,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    groupId: row.group_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sensorDisplayNames: (row.sensor_display_names as Record<string, string> | null) ?? null,
    overrideGroupSettings: override,
    resolvedSettings,
    groupSettings: groupConfig ?? null,
    groupThresholds: groupThresholds ?? null,
    displayConfig: (typeof row.display_config === 'string'
      ? JSON.parse(row.display_config)
      : (row.display_config as AgentDisplayConfig | null)) ?? null,
    pendingCommand: row.pending_command ?? null,
    uninstallCommandedAt: row.uninstall_commanded_at ? row.uninstall_commanded_at.toISOString() : null,
    updatingSince: row.updating_since ? row.updating_since.toISOString() : null,
    notificationTypes: row.notification_types
      ? (typeof row.notification_types === 'string'
          ? JSON.parse(row.notification_types)
          : row.notification_types as NotificationTypeConfig)
      : null,
    lastThreatAt: row.last_threat_at ? row.last_threat_at.toISOString() : null,
    lastAttackAt: row.last_attack_at ? row.last_attack_at.toISOString() : null,
    wanMatchingEnabled: row.wan_matching_enabled ?? false,
    wsConnected: row.device_type === 'mikrotik'
      ? isMikrotikOnline(row.id)
      : obliguardHub.isConnected(row.uuid),
    evaluateOnly,
    evaluateOnlySource,
    deviceType: (row.device_type as 'agent' | 'mikrotik') ?? 'agent',
    ...(row.device_type === 'mikrotik' ? {
      mikrotikStatus: getMikrotikStatus(row.id, row.mt_last_syslog_at, row.mt_last_api_connected_at),
    } : {}),
    lastSeenAt: isoOrNull(row.last_seen_at),
    lastOnlineAt: isoOrNull(row.last_online_at),
    lastOfflineAt: isoOrNull(row.last_offline_at),
    capabilities: capabilitiesOf(row.capabilities),
    ...updateFieldsFor(row, globalConfig, upd),
  };
}

/** Fetch the agent_group_config for a group (null if group not found or has no config). */
async function getGroupAgentConfig(groupId: number): Promise<AgentGroupConfig | null> {
  const g = await db('monitor_groups').where({ id: groupId }).select('agent_group_config').first() as
    { agent_group_config: unknown } | undefined;
  if (!g?.agent_group_config) return null;
  return (typeof g.agent_group_config === 'string'
    ? JSON.parse(g.agent_group_config)
    : g.agent_group_config) as AgentGroupConfig;
}

/** Fetch the agent_thresholds for a group (null if group not found or has none). */
async function getGroupAgentThresholds(groupId: number): Promise<AgentThresholds | null> {
  const g = await db('monitor_groups').where({ id: groupId }).select('agent_thresholds').first() as
    { agent_thresholds: unknown } | undefined;
  if (!g?.agent_thresholds) return null;
  return (typeof g.agent_thresholds === 'string'
    ? JSON.parse(g.agent_thresholds)
    : g.agent_thresholds) as AgentThresholds;
}

/**
 * Returns the set of group IDs that resolve to evaluate-only — i.e. the group
 * itself OR any ancestor has evaluate_only=true (walked via group_closure).
 * A device whose group_id is in this set inherits evaluate-only (dry-run) mode.
 * One lookup serves a whole device list, avoiding per-device ancestry queries.
 */
// Short TTL cache: this runs inside getDeviceByUuid, which is called on every
// agent heartbeat — re-querying two tables per heartbeat just to learn the
// (rarely-changing) evaluate-only group set added needless pool pressure. A 15s
// cache cuts that to ~zero; a toggle change is reflected within 15s.
let _evalGroupCache: { set: Set<number>; at: number } | null = null;
const EVAL_GROUP_CACHE_TTL_MS = 15_000;

/** Drop the evaluate-only group cache (a group's flag changed). */
export function invalidateEvaluateOnlyCache(): void {
  _evalGroupCache = null;
}

async function getEvaluateOnlyGroupIds(): Promise<Set<number>> {
  const nowMs = Date.now();
  if (_evalGroupCache && nowMs - _evalGroupCache.at < EVAL_GROUP_CACHE_TTL_MS) {
    return _evalGroupCache.set;
  }
  const flagged = await db('monitor_groups').where('evaluate_only', true).pluck('id') as number[];
  const set = flagged.length === 0
    ? new Set<number>()
    : new Set<number>(
        await db('group_closure').whereIn('ancestor_id', flagged).pluck('descendant_id') as number[],
      );
  _evalGroupCache = { set, at: nowMs };
  return set;
}

/** Resolve the effective evaluate-only state for a device row given the eval group set. */
function evalStateFor(
  row: AgentDeviceRow,
  evalGroupIds: Set<number>,
): { evaluateOnly: boolean; source: 'agent' | 'group' | null } {
  if (row.evaluate_only) return { evaluateOnly: true, source: 'agent' };
  if (row.group_id != null && evalGroupIds.has(row.group_id)) {
    return { evaluateOnly: true, source: 'group' };
  }
  return { evaluateOnly: false, source: null };
}

// ============================================================
// Agent Service
// ============================================================

export const agentService = {

  // ── Agent ↔ API-key binding (A5) ────────────────────────

  /**
   * UNSAFE without tenant scope — agent channel only, always followed by
   * ensureAgentBinding.
   */
  async findDeviceBindingByUuid(uuid: string): Promise<DeviceBindingRow | null> {
    const row = await db('agent_devices')
      .where({ uuid })
      .first('id', 'tenant_id', 'api_key_id', 'device_type', 'status') as DeviceBindingRow | undefined;
    return row ?? null;
  },

  /**
   * Enforce the device ↔ key binding before any write. A NULL api_key_id (key
   * deleted or binding released) is claimed atomically by the first same-tenant
   * key that presents the uuid. With AGENT_KEY_BINDING=tenant, a key of the same
   * tenant takes an existing binding over (logged). Mutates row.api_key_id when
   * it binds. Never touches updated_at (the UI uses it as "last seen").
   * A suspended or refused row is never claimed nor re-bound: the caller refuses
   * it anyway, so the verdict is pure and the binding state stays unchanged.
   */
  async ensureAgentBinding(key: AgentKeyRef, row: DeviceBindingRow): Promise<boolean> {
    if (row.status === 'suspended' || row.status === 'refused') {
      return agentKeyMayActForDevice(key, row)
        || (AGENT_KEY_BINDING === 'tenant' && agentKeyMayRebindDevice(key, row));
    }
    if (agentKeyMayActForDevice(key, row)) {
      if (row.api_key_id != null) return true;
      const n = await db('agent_devices')
        .where({ id: row.id, tenant_id: key.tenant_id })
        .whereNull('api_key_id')
        .update({ api_key_id: key.id });
      if (n === 1) {
        logger.info({ deviceId: row.id, apiKeyId: key.id }, 'Agent device bound to API key');
        row.api_key_id = key.id;
        return true;
      }
      const fresh = await db('agent_devices').where({ id: row.id })
        .first('tenant_id', 'api_key_id', 'device_type') as Pick<DeviceBindingRow, 'tenant_id' | 'api_key_id' | 'device_type'> | undefined;
      return !!fresh && agentKeyMayActForDevice(key, fresh);
    }

    if (AGENT_KEY_BINDING === 'tenant' && agentKeyMayRebindDevice(key, row) && row.api_key_id != null) {
      const fromKeyId = row.api_key_id;
      const n = await db('agent_devices')
        .where({ id: row.id, tenant_id: key.tenant_id, api_key_id: fromKeyId })
        .update({ api_key_id: key.id });
      if (n === 1) {
        const wk = `${row.id}|${key.id}`;
        const now = Date.now();
        const last = _rebindWarnAt.get(wk);
        if (last === undefined || now - last >= 60_000) {
          _touchBounded(_rebindWarnAt, wk, now, 1000);
          logger.warn(
            { deviceId: row.id, fromKeyId, toKeyId: key.id },
            'Agent device re-bound to another API key of the same tenant (AGENT_KEY_BINDING=tenant)',
          );
        }
        row.api_key_id = key.id;
        return true;
      }
      const fresh = await db('agent_devices').where({ id: row.id })
        .first('tenant_id', 'api_key_id', 'device_type') as Pick<DeviceBindingRow, 'tenant_id' | 'api_key_id' | 'device_type'> | undefined;
      return !!fresh && agentKeyMayActForDevice(key, fresh);
    }

    return false;
  },

  /** Binding check for a uuid: no row → ok (enrolment); otherwise ensureAgentBinding. */
  async checkAgentBinding(
    key: AgentKeyRef,
    uuid: string,
  ): Promise<{ ok: true; device: DeviceBindingRow | null } | { ok: false; device: DeviceBindingRow }> {
    const device = await this.findDeviceBindingByUuid(uuid);
    if (!device) return { ok: true, device: null };
    const ok = await this.ensureAgentBinding(key, device);
    return ok ? { ok: true, device } : { ok: false, device };
  },

  /** Throttled (60 s per key) fire-and-forget agent_api_keys.last_used_at update. */
  touchApiKeyUsage(apiKeyId: number): void {
    const now = Date.now();
    const last = _keyUsageAt.get(apiKeyId);
    if (last !== undefined && now - last < 60_000) return;
    _touchBounded(_keyUsageAt, apiKeyId, now, 10_000);
    db('agent_api_keys').where({ id: apiKeyId }).update({ last_used_at: new Date() }).catch(() => {});
  },

  async countPendingForKey(apiKeyId: number): Promise<number> {
    const [row] = await db('agent_devices')
      .where({ api_key_id: apiKeyId, status: 'pending' })
      .count({ c: '*' }) as Array<{ c: string | number }>;
    return Number(row?.c ?? 0);
  },

  /**
   * Release a device's API-key binding (after a re-key). The caller closes the
   * device's live channel (otherwise its next heartbeat re-claims the binding
   * for the old key); the first key of the tenant that reconnects claims it.
   */
  async releaseKeyBinding(id: number, tenantId: number, byUserId: number | null): Promise<boolean> {
    const n = await db('agent_devices')
      .where({ id, tenant_id: tenantId })
      .where((q) => q.whereNull('device_type').orWhereNot('device_type', 'mikrotik'))
      .update({ api_key_id: null });
    logger.info({ deviceId: id, tenantId, byUserId }, 'Agent device API-key binding released');
    return n > 0;
  },

  /** A group id that exists in the tenant (kind not checked: legacy groups default to 'monitor'). */
  async isGroupInTenant(groupId: number, tenantId: number): Promise<boolean> {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    return !!(await db('monitor_groups').where({ id: groupId, tenant_id: tenantId }).first('id'));
  },

  /**
   * Returns the raw key string for a key id, scoped to the tenant — used by the
   * offline-wizard download endpoints to bake the key into the installer. Same
   * tenant scope and capability as the key list; a disabled key is never baked
   * (null, the wizard is then served without a key).
   */
  async getKeyById(id: number, tenantId: number): Promise<string | null> {
    return agentKeyService.reveal(id, tenantId);
  },

  // ── Devices ─────────────────────────────────────────────

  /**
   * Devices of the tenant (Default: every tenant — read god view). Optional
   * filters: status; groupId (that group only, or with recursive its whole
   * subtree through group_closure; null = ungrouped devices); visibleIds (the
   * caller's team scope, permissionService.getVisibleAgentIds: 'all' or
   * undefined = no restriction).
   */
  async listDevices(
    tenantId: number,
    status?: AgentDevice['status'],
    filter: { groupId?: number | null; recursive?: boolean; visibleIds?: number[] | 'all' } = {},
  ): Promise<AgentDevice[]> {
    // LEFT JOIN to fetch agent_group_config in one round-trip so resolvedSettings
    // can be computed without N+1 queries.
    const query = deviceListQuery().orderBy('d.created_at', 'desc');
    if (!isMasterTenant(tenantId)) query.where({ 'd.tenant_id': tenantId });
    if (status) query.where({ 'd.status': status });
    if (Array.isArray(filter.visibleIds)) query.whereIn('d.id', filter.visibleIds);
    if (filter.groupId === null) {
      query.whereNull('d.group_id');
    } else if (filter.groupId !== undefined) {
      if (filter.recursive) {
        query.whereIn('d.group_id', db('group_closure').where({ ancestor_id: filter.groupId }).select('descendant_id'));
      } else {
        query.where({ 'd.group_id': filter.groupId });
      }
    }
    const [rows, ctx] = await Promise.all([query as Promise<ListRow[]>, loadHydrationCtx()]);
    const [attempts, cascade] = await Promise.all([loadLatestAttempts(rows.map((r) => r.id)), resolveCascade(rows)]);
    return hydrateDeviceRows(rows, ctx, attempts, cascade);
  },

  /** Devices of `ids` that belong to `tenantId` — strict, no Default god view (writes). */
  async getDevicesByIdsInTenant(ids: number[], tenantId: number): Promise<AgentDevice[]> {
    if (ids.length === 0) return [];
    const [rows, ctx] = await Promise.all([
      deviceListQuery().whereIn('d.id', ids).andWhere({ 'd.tenant_id': tenantId }) as Promise<ListRow[]>,
      loadHydrationCtx(),
    ]);
    const [attempts, cascade] = await Promise.all([loadLatestAttempts(rows.map((r) => r.id)), resolveCascade(rows)]);
    return hydrateDeviceRows(rows, ctx, attempts, cascade);
  },

  async getDeviceById(id: number): Promise<AgentDevice | null> {
    const row = await db('agent_devices as d')
      .leftJoin('mikrotik_credentials as mt', 'mt.device_id', 'd.id')
      .where({ 'd.id': id })
      .select(
        'd.*',
        db.raw('mt.last_syslog_at as mt_last_syslog_at'),
        db.raw('mt.last_api_connected_at as mt_last_api_connected_at'),
      )
      .first() as AgentDeviceRow | undefined;
    if (!row) return null;
    return hydrateDeviceRow(row);
  },

  /** Tenant id that owns a device, or null if it doesn't exist. */
  async getDeviceTenantId(deviceId: number): Promise<number | null> {
    const row = await db('agent_devices').where({ id: deviceId }).select('tenant_id').first() as
      { tenant_id: number } | undefined;
    return row ? row.tenant_id : null;
  },

  /** Of the given ids, return only those that belong to the tenant (for bulk ops). */
  async filterDeviceIdsByTenant(ids: number[], tenantId: number): Promise<number[]> {
    if (ids.length === 0) return [];
    const rows = await db('agent_devices')
      .whereIn('id', ids)
      .andWhere({ tenant_id: tenantId })
      .select('id') as { id: number }[];
    return rows.map((r) => r.id);
  },

  /** Approved devices of the tenant (Default: all), within `visibleIds` when given (team scope). */
  async countOnlineDevices(tenantId: number, visibleIds?: number[] | 'all'): Promise<number> {
    const q = db('agent_devices').where({ status: 'approved' });
    if (!isMasterTenant(tenantId)) q.where({ tenant_id: tenantId });
    if (Array.isArray(visibleIds)) q.whereIn('id', visibleIds);
    const [row] = await q.count<Array<{ count: string }>>({ count: '*' });
    return Number(row?.count ?? 0);
  },

  /**
   * UNSAFE without binding check: callers must run ensureAgentBinding. Kept
   * unscoped on purpose: uuid is globally unique (001).
   */
  async getDeviceByUuid(uuid: string): Promise<AgentDevice | null> {
    const row = await db('agent_devices').where({ uuid }).first() as AgentDeviceRow | undefined;
    if (!row) return null;
    // Agent channel hot path (every heartbeat): no attempt lookup.
    return hydrateDeviceRow(row, false);
  },

  /** Id-only: the caller must have enforced write access (deviceAccess.checkDeviceAccess). */
  async updateDevice(id: number, data: {
    status?: AgentDevice['status'];
    groupId?: number | null;
    checkIntervalSeconds?: number;
    maxMissedPushes?: number | null;
    approvedBy?: number;
    approvedAt?: Date;
    name?: string | null;
    sensorDisplayNames?: Record<string, string> | null;
    overrideGroupSettings?: boolean;
    displayConfig?: AgentDisplayConfig | null;
    notificationTypes?: NotificationTypeConfig | null;
    wanMatchingEnabled?: boolean;
    evaluateOnly?: boolean;
    updatePolicy?: AgentUpdatePolicy | null;
  }): Promise<AgentDevice | null> {
    // IPS settings cascade (W13-1): the agent-level knobs are settings rows,
    // validated before anything is written (AppError 400); the legacy columns
    // below are kept in sync for their remaining readers.
    const cascadeWrites: Array<{ key: string; value: unknown }> = [];
    if (data.checkIntervalSeconds !== undefined || data.overrideGroupSettings !== undefined) {
      const cur = await db('agent_devices').where({ id }).first('check_interval_seconds', 'override_group_settings') as
        { check_interval_seconds: number; override_group_settings: boolean } | undefined;
      if (cur) {
        const overriding = data.overrideGroupSettings ?? cur.override_group_settings;
        cascadeWrites.push({
          key: 'checkIntervalSeconds',
          value: !overriding ? null : (data.checkIntervalSeconds ?? clampCheckInterval(cur.check_interval_seconds)),
        });
      }
    }
    if ('maxMissedPushes' in data && data.maxMissedPushes !== undefined) cascadeWrites.push({ key: 'maxMissedPushes', value: data.maxMissedPushes });
    if ('notificationTypes' in data) cascadeWrites.push({ key: 'notificationTypes', value: legacyTypesToFlags(data.notificationTypes ?? null) });
    for (const w of cascadeWrites) {
      if (w.value !== null) normalizeSettingValue(writableDefinition(w.key, 'agent'), w.value);
    }

    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.status !== undefined) update.status = data.status;
    if (data.groupId !== undefined) update.group_id = data.groupId;
    if (data.checkIntervalSeconds !== undefined) update.check_interval_seconds = data.checkIntervalSeconds;
    if (data.maxMissedPushes !== undefined) update.agent_max_missed_pushes = data.maxMissedPushes;
    if (data.approvedBy !== undefined) update.approved_by = data.approvedBy;
    if (data.approvedAt !== undefined) update.approved_at = data.approvedAt;
    if (data.name !== undefined) update.name = data.name;
    if (data.sensorDisplayNames !== undefined) update.sensor_display_names = data.sensorDisplayNames;
    if (data.overrideGroupSettings !== undefined) update.override_group_settings = data.overrideGroupSettings;
    if (data.displayConfig !== undefined) update.display_config = data.displayConfig;
    if ('notificationTypes' in data) update.notification_types = data.notificationTypes
      ? JSON.stringify(data.notificationTypes)
      : null;
    if (data.wanMatchingEnabled !== undefined) update.wan_matching_enabled = data.wanMatchingEnabled;
    if (data.evaluateOnly !== undefined) update.evaluate_only = data.evaluateOnly;
    if (data.updatePolicy !== undefined) update.update_policy = data.updatePolicy;
    // Freezing, suspending or refusing an agent drops its pending update request.
    const dropRequest = data.updatePolicy === 'off' || data.status === 'refused' || data.status === 'suspended';
    if (dropRequest) Object.assign(update, REQUEST_NULLS);

    const [row] = await db('agent_devices')
      .where({ id })
      .update(update)
      .returning('*') as AgentDeviceRow[];
    if (!row) return null;
    if (cascadeWrites.length > 0) {
      await settingsService.writeMany({ level: 'agent', scopeId: id, tenantId: row.tenant_id }, cascadeWrites, { mirror: false });
    }
    if (dropRequest) await cancelOpenAttempts([id]);
    if (data.status === 'suspended' || data.status === 'refused') {
      obliguardHub.disconnectDevice(row.uuid, `Device ${data.status}`);
    }
    // Incidents (W6-2): approval / refusal closes the pending alert; a
    // suspended or refused device is not expected online (all closed).
    if (data.status === 'suspended' || data.status === 'refused') await resolveDeviceIncidents(id);
    else if (data.status === 'approved') await resolveDeviceIncidents(id, ['agent_pending']);
    const device = await hydrateDeviceRow(row);

    // Broadcast so the sidebar can update without polling: the owning
    // tenant's members and the Default god view. The patch is the whole
    // device (clients merge it, DATA-REALTIME-4).
    emitDevicePatch(row.tenant_id, device.id, device);

    return device;
  },

  /** Tenant-scoped delete; closes the device's live agent channel. */
  async deleteDevice(id: number, tenantId: number): Promise<boolean> {
    const rows = await db('agent_devices').where({ id, tenant_id: tenantId }).del(['uuid']) as Array<{ uuid: string }>;
    for (const r of rows) obliguardHub.disconnectDevice(r.uuid, 'Device deleted');
    if (rows.length > 0) {
      await settingsService.removeScopes('agent', [id]);
      _presence.delete(id);
      _lastSeenWriteAt.delete(id);
      emitToTenantAudience(_io, tenantId, SOCKET_EVENTS.AGENT_DEVICE_DELETED, { deviceId: id });
      await resolveDeviceIncidents(id);
    }
    return rows.length > 0;
  },

  // ── Bulk operations ──────────────────────────────────────────────────────

  /**
   * Delete devices of `tenantId`. tenantId null = internal job only
   * (UNSAFE without tenant scope). Returns the number of deleted rows.
   */
  async bulkDeleteDevices(ids: number[], tenantId: number | null): Promise<number> {
    if (ids.length === 0) return 0;
    const q = db('agent_devices').whereIn('id', ids);
    if (tenantId !== null) q.where({ tenant_id: tenantId });
    const rows = await q.del(['id', 'uuid', 'tenant_id']) as Array<{ id: number; uuid: string; tenant_id: number }>;
    await settingsService.removeScopes('agent', rows.map((r) => r.id));
    for (const r of rows) {
      obliguardHub.disconnectDevice(r.uuid, 'Device deleted');
      _presence.delete(r.id);
      _lastSeenWriteAt.delete(r.id);
    }
    // Broadcast deletion events so the frontend updates in real-time
    for (const r of rows) {
      emitToTenantAudience(_io, r.tenant_id, SOCKET_EVENTS.AGENT_DEVICE_DELETED, { deviceId: r.id });
      await resolveDeviceIncidents(r.id);
    }
    return rows.length;
  },

  async bulkUpdateDevices(ids: number[], data: {
    groupId?: number | null;
    overrideGroupSettings?: boolean;
    status?: 'approved' | 'suspended';
    updatePolicy?: AgentUpdatePolicy | null;
  }, tenantId: number): Promise<number> {
    if (ids.length === 0) return 0;
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.updatePolicy !== undefined)         update.update_policy          = data.updatePolicy;
    if (data.updatePolicy === 'off' || data.status === 'suspended') Object.assign(update, REQUEST_NULLS);
    if (data.groupId !== undefined)             update.group_id               = data.groupId;
    if (data.overrideGroupSettings !== undefined) update.override_group_settings = data.overrideGroupSettings;
    if (data.status !== undefined)               update.status                 = data.status;
    const rows = await db('agent_devices')
      .whereIn('id', ids)
      .where({ tenant_id: tenantId })
      .update(update, ['id', 'uuid', 'check_interval_seconds']) as Array<{ id: number; uuid: string; check_interval_seconds: number }>;
    // Settings cascade (W13-1): the override switch sets / resets the agent-level check interval.
    if (data.overrideGroupSettings !== undefined) {
      for (const r of rows) {
        await settingsService.write(
          { level: 'agent', scopeId: r.id, tenantId },
          'checkIntervalSeconds',
          data.overrideGroupSettings ? clampCheckInterval(r.check_interval_seconds) : null,
          { mirror: false },
        );
      }
    }
    if (data.status === 'suspended') {
      for (const r of rows) obliguardHub.disconnectDevice(r.uuid, 'Device suspended');
    }
    // Incidents (W6-2): same rules as updateDevice.
    if (data.status !== undefined) {
      for (const r of rows) {
        await resolveDeviceIncidents(r.id, data.status === 'suspended' ? undefined : ['agent_pending']);
      }
    }
    if (data.updatePolicy === 'off' || data.status === 'suspended') {
      await cancelOpenAttempts(rows.map((r) => r.id));
    }
    // Notify frontend of each updated device (rows are all of `tenantId`):
    // a patch of the written fields only, merged by the clients.
    const patch: Partial<AgentDevice> = {};
    if (data.groupId !== undefined) patch.groupId = data.groupId;
    if (data.overrideGroupSettings !== undefined) patch.overrideGroupSettings = data.overrideGroupSettings;
    if (data.status !== undefined) patch.status = data.status;
    if (data.updatePolicy !== undefined) patch.updatePolicy = data.updatePolicy;
    if (data.updatePolicy === 'off' || data.status === 'suspended') {
      Object.assign(patch, { updateRequestedAt: null, updateRequestedVersion: null, updatePending: false });
    }
    for (const r of rows) emitDevicePatch(tenantId, r.id, patch);
    return rows.length;
  },

  /**
   * Queue a command for a device of `tenantId`. Queue commands (uninstall,
   * restart, firewall_resync) go to agent_commands (W14-1; an uninstall also
   * sets pending_command, the legacy fallback) and throw 409
   * commandOutstanding while the same one is pending. Any other value keeps
   * the legacy pending_command path. False when the device is not found.
   */
  async sendCommand(id: number, command: string, tenantId: number, createdBy: number | null = null): Promise<boolean> {
    if (isAgentCommandType(command)) {
      try {
        await agentCommandService.enqueue({ deviceId: id, tenantId, type: command, createdBy });
        return true;
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 404) return false;
        throw err;
      }
    }
    const count = await db('agent_devices')
      .where({ id, tenant_id: tenantId })
      .update({ pending_command: command, updated_at: new Date() });
    return count > 0;
  },

  /**
   * Queue a command for multiple devices of `tenantId` at once. Queue
   * commands skip the devices that already have it pending. Returns the ids
   * the command was queued for.
   */
  async bulkSendCommand(ids: number[], command: string, tenantId: number, createdBy: number | null = null): Promise<number[]> {
    if (ids.length === 0) return [];
    if (isAgentCommandType(command)) {
      return agentCommandService.enqueueMany(ids, tenantId, command, createdBy);
    }
    const rows = await db('agent_devices')
      .whereIn('id', ids)
      .where({ tenant_id: tenantId })
      .update({ pending_command: command, updated_at: new Date() }, ['id']) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  },

  /**
   * The full ban list a device must enforce now (firewall_resync payload,
   * W14-1): same resolution as the push ban delta against an empty firewall
   * (scopes, tenant exclusions, whitelist, CIDR capability). An evaluate-only
   * agent enforces nothing: []. Null when the device does not exist.
   */
  async resolveFullBanList(deviceId: number): Promise<string[] | null> {
    const device = await this.getDeviceById(deviceId);
    if (!device || device.tenantId == null) return null;
    if (device.evaluateOnly) return [];
    let groupIds: number[] = [];
    if (device.groupId) {
      const groupRows = await db('group_closure')
        .where('descendant_id', device.groupId)
        .select('ancestor_id')
        .orderBy('depth', 'asc') as { ancestor_id: number }[];
      groupIds = groupRows.map((r) => r.ancestor_id);
    }
    const whitelist = await whitelistService.resolveWhitelistForAgent(deviceId, groupIds, device.tenantId);
    const full = await banService.computeBanDelta(deviceId, groupIds, device.tenantId, [], whitelist);
    return full.add;
  },

  /**
   * Cleanup job: auto-delete devices whose 'uninstall' command was delivered
   * more than 10 minutes ago (they've had enough time to uninstall and stop pushing).
   * Should be called periodically (e.g. every 5 minutes).
   */
  async cleanupUninstalledDevices(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const rows = await db('agent_devices')
      .whereNotNull('uninstall_commanded_at')
      .where('uninstall_commanded_at', '<', cutoff)
      .select('id') as { id: number }[];

    if (rows.length === 0) return;

    const ids = rows.map(r => r.id);
    await this.bulkDeleteDevices(ids, null);
    logger.info(`Agent cleanup: auto-deleted ${ids.length} device(s) after uninstall command.`);
  },

  /** Suspend a device: set status=suspended */
  async suspendDevice(id: number): Promise<void> {
    await db('agent_devices').where({ id }).update({ status: 'suspended', updated_at: new Date(), ...REQUEST_NULLS });
    await cancelOpenAttempts([id]);
    await resolveDeviceIncidents(id);
  },

  /** Reinstate a suspended device: set status=approved */
  async reinstateDevice(id: number): Promise<void> {
    await db('agent_devices').where({ id }).update({ status: 'approved', updated_at: new Date() });
  },

  // ── Approval ─────────────────────────────────────────────

  /**
   * Approve a device: set status=approved, create ONE monitor with all thresholds.
   * groupId undefined = no choice made: the device keeps the group it got at
   * registration, else its API key's default group (W10-2); null = no group.
   */
  async approveDevice(
    deviceId: number,
    approvedBy: number,
    groupIdInput: number | null | undefined,
    customThresholds?: AgentThresholds,
  ): Promise<AgentDevice | null> {
    const device = await this.getDeviceById(deviceId);
    if (!device) return null;
    let groupId: number | null = groupIdInput ?? null;
    if (groupIdInput === undefined) {
      groupId = device.groupId ?? null;
      if (groupId == null && device.apiKeyId != null) {
        const keyGroup = await agentKeyService.defaultGroupFor(device.apiKeyId);
        // Only a group of the device's own tenant (the key may have been re-bound).
        if (keyGroup != null && await this.isGroupInTenant(keyGroup, device.tenantId)) groupId = keyGroup;
      }
    }

    // Update device status and reset interval to 60s on approval
    const updated = await this.updateDevice(deviceId, {
      status: 'approved',
      groupId,
      approvedBy,
      approvedAt: new Date(),
      checkIntervalSeconds: 60,
    });

    // Determine thresholds: custom > group defaults > system defaults
    let thresholds: AgentThresholds = { ...DEFAULT_AGENT_THRESHOLDS };
    if (groupId) {
      const groupRow = await db('monitor_groups')
        .where({ id: groupId })
        .select('agent_thresholds')
        .first() as { agent_thresholds: AgentThresholds | null } | undefined;
      if (groupRow?.agent_thresholds) {
        thresholds = groupRow.agent_thresholds;
      }
    }
    if (customThresholds) {
      thresholds = customThresholds;
    }

    return updated;
  },

  // ── Update device thresholds ─────────────────────────────
  // Thresholds in Obliguard are stored on the group or resolved from defaults.
  // This method is a no-op kept for API compatibility.
  async updateDeviceThresholds(
    _deviceId: number,
    _thresholds: AgentThresholds,
  ): Promise<boolean> {
    return true;
  },

  // ── Push endpoint logic ───────────────────────────────────

  async handlePush(
    agentApiKeyId: number,
    agentTenantId: number,
    deviceUuid: string,
    clientIp: string,
    body: ObliguardPushBody,
    opts: HandlePushOptions = {},
  ): Promise<HandlePushResult> {
    // ── a. Find or register device ────────────────────────
    // The device ↔ key binding is enforced BEFORE any write (A5): a key of
    // another tenant, another bound key or a MikroTik row gets 'refused' and
    // the row is left untouched.
    const key: AgentKeyRef = { id: agentApiKeyId, tenant_id: agentTenantId };
    let device = await this.getDeviceByUuid(deviceUuid);

    if (device) {
      const ok = await this.ensureAgentBinding(key, {
        id: device.id,
        tenant_id: device.tenantId,
        api_key_id: device.apiKeyId,
        device_type: device.deviceType ?? null,
        status: device.status,
      });
      if (!ok) {
        warnBindingRefused({
          deviceUuid, deviceId: device.id, apiKeyId: agentApiKeyId, keyTenantId: agentTenantId,
          deviceTenantId: device.tenantId, boundKeyId: device.apiKeyId, deviceType: device.deviceType ?? null, via: 'push',
        });
        return { status: 'refused' };
      }
    }

    if (!device) {
      // Pending cap per API key: beyond it, enrolment is deferred (no row).
      if (AGENT_MAX_PENDING_PER_KEY > 0 && (await this.countPendingForKey(agentApiKeyId)) >= AGENT_MAX_PENDING_PER_KEY) {
        const now = Date.now();
        const last = _pendingCapWarnAt.get(agentApiKeyId);
        if (last === undefined || now - last >= 10 * 60_000) {
          _touchBounded(_pendingCapWarnAt, agentApiKeyId, now, 1000);
          logger.warn(
            { apiKeyId: agentApiKeyId, tenantId: agentTenantId, cap: AGENT_MAX_PENDING_PER_KEY },
            'Pending device cap reached for API key — enrolment deferred',
          );
        }
        return { status: 'pending', enrolmentDeferred: true };
      }
      // Register new device as pending (race-safe: uuid is UNIQUE), in the
      // key's default group when it has one in the key's tenant (W10-2).
      const caps = sanitizeAgentCapabilities(body.capabilities);
      const defaultGroupId = await agentKeyService.defaultGroupFor(agentApiKeyId);
      const [row] = await db('agent_devices')
        .insert({
          uuid: deviceUuid,
          ...(defaultGroupId != null ? { group_id: defaultGroupId } : {}),
          hostname: body.hostname,
          ip: clientIp,
          os_info: body.osInfo ? JSON.stringify(body.osInfo) : null,
          agent_version: body.agentVersion,
          api_key_id: agentApiKeyId,
          tenant_id: agentTenantId,
          status: 'pending',
          check_interval_seconds: 300, // pending: check every 5 min
          last_seen_at: new Date(),
          ...(caps ? { capabilities: JSON.stringify(caps) } : {}),
        })
        .onConflict('uuid')
        .ignore()
        .returning('*') as AgentDeviceRow[];
      // Lost a race with a concurrent first push: the next heartbeat re-evaluates the binding.
      if (!row) return { status: 'pending' };
      device = rowToDevice(row);
      lastSeenDue(device.id);
      // A new enrolment waits for approval: tell the tenant's admins (DATA-REALTIME-4).
      const created: AgentDeviceCreatedEvent = { deviceId: device.id, device };
      emitToTenantAdmins(_io, agentTenantId, AGENT_DEVICE_CREATED_EVENT, created);
      // ...and the bell (W6-2): resolved on approval, refusal or deletion.
      // Not awaited: enrolment answers do not wait for the alert. Never throws.
      void raisePendingIncident({ id: device.id, tenantId: agentTenantId, hostname: device.hostname }, clientIp);
    } else {
      // ── b. Update device metadata ─────────────────────
      // Clear updating_since if set (agent came back after update)
      const metadataUpdate: Record<string, unknown> = {
        hostname: body.hostname,
        ip: clientIp,
        agent_version: body.agentVersion,
        os_info: body.osInfo ? JSON.stringify(body.osInfo) : null,
        updated_at: new Date(),
      };
      if (lastSeenDue(device.id)) metadataUpdate.last_seen_at = new Date();
      const caps = sanitizeAgentCapabilities(body.capabilities);
      if (caps) metadataUpdate.capabilities = JSON.stringify(caps);
      if (device.updatingSince) {
        metadataUpdate.updating_since = null;
        logger.info(`Agent ${device.id} (${device.hostname}) came back online after update.`);
      }
      await db('agent_devices')
        .where({ id: device.id })
        .update(metadataUpdate);

      // Refresh device from DB
      device = (await this.getDeviceByUuid(deviceUuid))!;
    }

    // ── b2. Update request reconciliation (C17-1) ─────────
    // Closes a request that can no longer be honoured (agent now current,
    // expired, superseded, policy off, not approved). Never throws.
    device = await reconcileUpdateRequest(device, body.agentVersion || '', _now());
    // ── b3. Update attempt outcome (W2-1): succeeded / reverted. Never throws.
    if (device.status === 'approved' && device.deviceType === 'agent') {
      await reconcileUpdateAttempts(device, body.agentVersion || '', _now(), opts.connectedAt);
    }

    // ── c. Pending status ─────────────────────────────────
    if (device.status === 'pending') {
      return { status: 'pending' };
    }

    // ── d. Refused status ─────────────────────────────────
    if (device.status === 'refused') {
      return { status: 'refused' };
    }

    // Also treat suspended as refused — agent should stop pushing
    if (device.status === 'suspended') {
      return { status: 'refused' };
    }

    const deviceId = device.id;

    // Register/update device UUID with Obligate for cross-app linking (non-blocking,
    // idempotent, throttled) — approved, bound devices only.
    obligateService.registerDeviceLink(deviceUuid, `/agents/${device.id}`).catch(() => {});

    // ── e0. Rebuild LAN IP registry for this device ───────
    // agent_ips is a fast-lookup table: ip_address → agent_id (within tenant).
    // We delete + reinsert on every push so stale IPs (e.g. after NIC changes) are removed.
    if (body.lanIPs && body.lanIPs.length > 0) {
      try {
        // Dedupe the reported IPs (an agent can list the same address twice —
        // e.g. multiple NICs / aliases) so the batch insert can't violate the
        // (agent_id, ip_address) unique constraint on its own. onConflict.ignore()
        // then makes it race-safe vs a concurrent push for the same device
        // (HTTP push + WS heartbeat) — previously this produced 23505 spam.
        const uniqueIPs = [...new Set(body.lanIPs)];
        await db('agent_ips').where({ agent_id: deviceId }).del();
        await db('agent_ips')
          .insert(uniqueIPs.map((ip: string) => ({ agent_id: deviceId, ip_address: ip })))
          .onConflict(['agent_id', 'ip_address'])
          .ignore();
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to upsert agent_ips');
      }
    }

    // ── e. Process services ───────────────────────────────
    if (body.services && body.services.length > 0) {
      try {
        // Dedupe by service_type (an agent can report the same type on more than
        // one port) and UPSERT in one statement. This replaces the old
        // delete-then-insert, which (a) raced with concurrent pushes for the same
        // device — HTTP push + WS heartbeat — and (b) could violate the
        // (device_id, service_type) unique constraint from duplicates in the
        // batch, producing the 23505 errors. onConflict.merge() updates
        // port/active/last_seen_at in place; idempotent + race-safe.
        const seen = new Set<string>();
        const uniqueServices = body.services.filter(s => {
          if (seen.has(s.type)) return false;
          seen.add(s.type);
          return true;
        });
        await db('agent_services')
          .insert(uniqueServices.map(s => ({
            device_id: deviceId,
            service_type: s.type,
            port: s.port,
            active: s.active,
            last_seen_at: new Date(),
          })))
          .onConflict(['device_id', 'service_type'])
          .merge();
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to upsert agent_services');
      }
    }

    // ── f. Resolve group ancestry (needed for templates + ban delta) ──────
    let groupIds: number[] = [];
    if (device.groupId) {
      try {
        const groupRows = await db('group_closure')
          .where('descendant_id', device.groupId)
          .select('ancestor_id')
          .orderBy('depth', 'asc') as { ancestor_id: number }[];
        groupIds = groupRows.map(r => r.ancestor_id);
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to resolve group ancestry');
      }
    }

    // ── f2. Resolve templates for event tagging + opt-in gate ─────────────
    // Templates with mode='track' produce events stored for visibility but NOT
    // counted by BanEngine (trackOnlyServices). Services whose resolved template
    // is explicitly disabled (disabledServices) are dropped entirely — this is
    // the server-side half of the opt-in gate, a defense-in-depth for agents
    // that predate the client-side poller gate. We only drop services that have
    // a resolved-but-disabled template (never custom/unknown services), so an
    // intentional bind (enabled_override=true) always lets events through.
    const trackOnlyServices = new Set<string>();
    const disabledServices = new Set<string>();
    if (body.events && body.events.length > 0) {
      try {
        const resolved = await serviceTemplateService.resolveForAgent(deviceId, groupIds);
        for (const cfg of resolved) {
          if (cfg.enabled) {
            if (cfg.mode === 'track') trackOnlyServices.add(cfg.serviceType);
          } else {
            disabledServices.add(cfg.serviceType);
          }
        }
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to resolve service templates for track_only tagging');
      }
    }

    // ── f3. Build peer link lookup maps (LAN + WAN) ───────
    // Used to enrich ip_events with source_agent_id so the NetMap can draw
    // directed edges between agents instead of showing unknown IP nodes.
    //
    // LAN  — all agent_ips entries for this tenant (excluding self)
    // WAN  — all agent_devices with wan_matching_enabled=true + known WAN IP (excluding self)
    //
    // Ambiguity: if two agents share the same IP in the same tenant we store -1
    // (sentinel) and skip the link — this prevents false edges from NAT collisions.
    const lanIpToAgentId = new Map<string, number>(); // ip → agentId, -1 = ambiguous
    const wanIpToAgentId = new Map<string, number>();

    if (body.events && body.events.length > 0) {
      try {
        // LAN: join agent_ips with agent_devices to scope by tenant
        const lanRows = await db('agent_ips as ai')
          .join('agent_devices as ad', 'ad.id', 'ai.agent_id')
          .where({ 'ad.tenant_id': agentTenantId })
          .whereNot({ 'ai.agent_id': deviceId })
          .select('ai.ip_address', 'ai.agent_id') as { ip_address: string; agent_id: number }[];

        for (const row of lanRows) {
          if (lanIpToAgentId.has(row.ip_address)) {
            lanIpToAgentId.set(row.ip_address, -1); // ambiguous
          } else {
            lanIpToAgentId.set(row.ip_address, row.agent_id);
          }
        }

        // WAN: only devices with opt-in flag and a known public IP
        const wanRows = await db('agent_devices')
          .where({ tenant_id: agentTenantId, wan_matching_enabled: true })
          .whereNot({ id: deviceId })
          .whereNotNull('ip')
          .select('id', 'ip') as { id: number; ip: string }[];

        for (const row of wanRows) {
          if (wanIpToAgentId.has(row.ip)) {
            wanIpToAgentId.set(row.ip, -1); // ambiguous
          } else {
            wanIpToAgentId.set(row.ip, row.id);
          }
        }
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to build peer link maps');
      }
    }

    // ── g. Process events ─────────────────────────────────
    // Opt-in gate: drop events whose service has a resolved-but-disabled
    // template before any storage / reputation / live-map emission.
    const incomingEvents: AgentIpEvent[] = withValidEventIps(body.events ?? []).filter(
      (ev: AgentIpEvent) => !disabledServices.has(ev.service),
    );
    if (incomingEvents.length > 0) {
      try {
        const receivedAt = Date.now();
        // Enrich each event with source_agent_id / source_ip_type
        const enrichedEvents: StoredIpEvent[] = incomingEvents.map((ev: AgentIpEvent) => {
          let sourceAgentId: number | null = null;
          let sourceIpType: 'lan' | 'wan' | null = null;

          if (isRfc1918(ev.ip)) {
            const matchId = lanIpToAgentId.get(ev.ip);
            if (matchId !== undefined && matchId !== -1) {
              sourceAgentId = matchId;
              sourceIpType = 'lan';
            }
          } else {
            const matchId = wanIpToAgentId.get(ev.ip);
            if (matchId !== undefined && matchId !== -1) {
              sourceAgentId = matchId;
              sourceIpType = 'wan';
            }
          }

          return {
            device_id: deviceId,
            ip: ev.ip,
            username: ev.username ?? null,
            service: ev.service,
            event_type: ev.eventType,
            timestamp: clampEventTimestamp(ev.timestamp, receivedAt),
            raw_log: ev.rawLog ?? null,
            track_only: trackOnlyServices.has(ev.service),
            tenant_id: agentTenantId,
            source_agent_id: sourceAgentId,
            source_ip_type: sourceIpType,
          };
        });

        const insertedIds = await db('ip_events').insert(enrichedEvents).returning(['id']) as unknown[];

        // Update IP reputation from the new events
        await ipReputationService.upsertFromEvents(
          incomingEvents.map((ev: AgentIpEvent) => ({
            ip: ev.ip,
            service: ev.service,
            username: ev.username ?? null,
            deviceId,
            eventType: ev.eventType,
          })),
        );

        // ── Threat detection ──
        // Any auth failure of this batch puts the device under threat (every
        // failing source is at least 'suspicious'); one notification per
        // cooldown window (atomic last_threat_at claim). Never throws.
        void noteThreat(deviceId, incomingEvents);

        // Live IP activity: batched ip:events + legacy ip:flow (W8-3).
        emitStoredIpEvents(agentTenantId, deviceId, enrichedEvents, insertedIds);
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to insert ip_events');
      }

      // Handle log samples: clear sample_requested flag for each reported log path
      if (body.logSamples && Object.keys(body.logSamples).length > 0) {
        try {
          const logPaths = Object.keys(body.logSamples);
          await db('service_template_assignments')
            .where({ scope: 'agent', scope_id: deviceId })
            .whereIn('log_path_override', logPaths)
            .update({ sample_requested: false });
        } catch (err) {
          logger.warn({ err, deviceId }, 'handlePush: failed to clear sample_requested flags');
        }
      }
    }

    // ── h. Compute ban delta ──────────────────────────────

    let resolvedWhitelist: string[] = [];
    let banDelta: { add: string[]; remove: string[] } = { add: [], remove: [] };
    // undefined (not []) when resolution fails: the field is then omitted and
    // the agent keeps its limits instead of clearing them on a transient error.
    let resolvedRateLimits: RateLimitRule[] | undefined = [];

    try {
      resolvedWhitelist = await whitelistService.resolveWhitelistForAgent(
        deviceId,
        groupIds,
        agentTenantId,
      );
    } catch (err) {
      logger.warn({ err, deviceId }, 'handlePush: whitelistService.resolveWhitelistForAgent failed');
    }

    try {
      const { rateLimitPolicyService } = await import('./rateLimitPolicy.service');
      resolvedRateLimits = await rateLimitPolicyService.resolveForAgent(deviceId, groupIds, agentTenantId);
    } catch (err) {
      resolvedRateLimits = undefined;
      logger.warn({ err, deviceId }, 'handlePush: rateLimitPolicyService.resolveForAgent failed');
    }

    try {
      banDelta = await banService.computeBanDelta(
        deviceId,
        groupIds,
        agentTenantId,
        body.firewallBanned ?? [],
        resolvedWhitelist,
      );
    } catch (err) {
      logger.warn({ err, deviceId }, 'handlePush: banService.computeBanDelta failed');
    }

    // Evaluate-only (dry-run): this agent enforces NO bans. Override the delta to
    // add nothing and remove everything it currently has at the firewall, so the
    // observed traffic has zero network impact while whitelist rules are tuned.
    // (Ban CREATION from this agent's events is separately skipped in BanEngine.)
    if (device.evaluateOnly) {
      banDelta = { add: [], remove: body.firewallBanned ?? [] };
    }

    // ── h. Compute service configs ────────────────────────
    let serviceConfigsMap: Record<string, AgentServiceConfig> = {};
    try {
      const { serviceTemplateService } = await import('./serviceTemplate.service');
      const resolvedConfigs = await serviceTemplateService.resolveForAgent(deviceId, groupIds);
      for (const cfg of resolvedConfigs) {
        const key = cfg.serviceType === 'custom'
          ? `custom:${cfg.logPath ?? cfg.templateId}`
          : cfg.serviceType;
        serviceConfigsMap[key] = {
          enabled: cfg.enabled,
          threshold: cfg.threshold,
          windowSeconds: cfg.windowSeconds,
          customRegex: cfg.customRegex ?? undefined,
          sampleRequested: cfg.sampleRequested,
        };
      }
    } catch {
      // serviceTemplateService may not exist yet; return empty configs
      serviceConfigsMap = {};
    }

    // NOTE: intentionally NO auto-enable fallback here. Services are strictly
    // opt-in: an agent only watches / emits events for services that resolve to
    // an enabled template (global default, or a group/agent enabled_override).
    // The previous "auto-enable all detected services" fallback violated that
    // model (it silently turned on banning for every detected port), so it was
    // removed — no enabled template means the agent stays silent for that service.

    // ── i. Handle pending command ─────────────────────────
    // Agents advertising 'cmdqueue' (W14-1) get their commands as 'command'
    // frames from the hub (queue drained after the config frame). The others
    // keep the legacy path: a queued uninstall is claimed from the queue
    // (history row, pending_command cleared, uninstall_commanded_at set) and
    // rides the config frame; any other pending_command value (e.g. 'update')
    // is delivered as before.
    let pendingCommand: string | undefined;
    const pushCaps = sanitizeAgentCapabilities(body.capabilities) ?? device.capabilities ?? [];
    if (device.pendingCommand === 'uninstall') {
      if (!hasAgentCapability(pushCaps) && (await agentCommandService.claim(deviceId, false)).legacyUninstall) {
        pendingCommand = 'uninstall';
      }
    } else if (device.pendingCommand) {
      pendingCommand = device.pendingCommand;
      await db('agent_devices').where({ id: deviceId })
        .update({ pending_command: null, updated_at: new Date() });
    }

    // ── j. Update device last push time ──────────────────
    const pushTime = new Date();
    await db('agent_devices')
      .where({ id: deviceId })
      .update({ updated_at: pushTime });

    // Notify UI of push activity (owning tenant + Default only):
    // 1. agent:pushHeartbeat — lightweight heartbeat for AgentDetailPage online status
    // 2. AGENT_STATUS_CHANGED 'up' — updates the sidebar status dot, only on a
    //    real offline → online transition (not on every heartbeat)
    // A WS-connected agent goes offline only through the hub (markAgentOffline);
    // its fixed 30 s heartbeat may exceed a short configured push interval.
    const graceMs = obliguardHub.isConnected(deviceUuid)
      ? Number.POSITIVE_INFINITY
      : (device.resolvedSettings.checkIntervalSeconds ?? 60)
        * (device.resolvedSettings.maxMissedPushes ?? 2) * 1000;
    const cameOnline = notePresence(deviceId, graceMs, pushTime.getTime());
    if (_io) {
      emitToTenantAudience(_io, agentTenantId, SOCKET_EVENTS.AGENT_PUSH_HEARTBEAT, {
        deviceId,
        updatedAt: pushTime.toISOString(),
        agentVersion: body.agentVersion ?? device.agentVersion,
      });
      if (cameOnline) {
        emitToTenantAudience(_io, agentTenantId, SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
          deviceId,
          status: 'up',
          wsConnected: true,
          violations: [],
          violationKeys: [],
        });
      }
    }
    // Back after a declared outage (HTTP push, or the first heartbeat after a
    // server restart): resolve the offline incident and notify 'up' (W6-2).
    if (cameOnline) await obliguardHub.recoverOnline(deviceId);

    // ── k. Return ObliguardPushResponse ──────────────────
    // latestVersion only when the update policy allows it (C17-1): 'auto', or a
    // live explicit request; at most one offer per 10 min. Never throws.
    // Windows firewall backend (W13-1 cascade): Windows agents only.
    let firewallBackend: WindowsFirewallBackend | undefined;
    if (device.deviceType !== 'mikrotik' && (body.osInfo?.platform ?? device.osInfo?.platform) === 'windows') {
      try {
        firewallBackend = (await agentConfigService.resolveForDevice({
          id: deviceId, tenantId: device.tenantId, groupId: device.groupId,
        })).windowsFirewallBackend;
      } catch (err) {
        // Omitted: the agent keeps the backend it runs.
        logger.warn({ err, deviceId }, 'handlePush: firewall backend resolution failed');
      }
    }

    let advertised = await resolveAdvertisedVersion(device, body.agentVersion || device.agentVersion || '', _now());
    if (advertised && !opts.deferOfferRecord && !(await recordUpdateOffer(deviceId, advertised))) advertised = undefined;
    return {
      status: 'ok',
      ...(advertised ? { latestVersion: advertised } : {}),
      config: { pushIntervalSeconds: device.resolvedSettings.checkIntervalSeconds },
      banList: { add: banDelta.add, remove: banDelta.remove },
      whitelist: resolvedWhitelist,
      services: serviceConfigsMap,
      ...(resolvedRateLimits ? { rateLimits: resolvedRateLimits } : {}),
      ...(firewallBackend ? { firewallBackend } : {}),
      command: pendingCommand ?? '',
    };
  },

  // ── Events-only flush (WS real-time path) ─────────────────
  //
  // Called by obliguardHub when the agent sends a `{ type:"events" }` frame
  // between heartbeats (500 ms debounce).  Runs the same enrichment + insert
  // pipeline as handlePush but skips the heavy per-push bookkeeping (LAN-IP
  // rebuild, ban-delta, service-config sync) that only needs to run every 30 s.

  async processEventsFlush(
    deviceId: number,
    tenantId: number,
    events: AgentIpEvent[],
  ): Promise<void> {
    if (events.length === 0) return;

    // Single authoritative ingestion gate (A5): the device must exist in this
    // tenant AND be approved. Unknown / other-tenant / pending / refused /
    // suspended devices never ingest events or reputation.
    let dev: { group_id: number | null } | undefined;
    try {
      dev = await db('agent_devices')
        .where({ id: deviceId, tenant_id: tenantId, status: 'approved' })
        .first('group_id') as { group_id: number | null } | undefined;
    } catch (err) {
      logger.warn({ err, deviceId }, 'processEventsFlush: device gate lookup failed');
      return;
    }
    if (!dev) return;
    touchLastSeen(deviceId);

    // Resolve group ancestry (needed for track-only and peer-link lookups)
    let groupIds: number[] = [];
    if (dev.group_id) {
      try {
        const groupRows = await db('group_closure')
          .where('descendant_id', dev.group_id)
          .select('ancestor_id')
          .orderBy('depth', 'asc') as { ancestor_id: number }[];
        groupIds = groupRows.map(r => r.ancestor_id);
      } catch (err) {
        logger.warn({ err, deviceId }, 'processEventsFlush: group ancestry lookup failed');
      }
    }

    // Track-only + disabled service sets (same opt-in gate as handlePush)
    const trackOnlyServices = new Set<string>();
    const disabledServices = new Set<string>();
    try {
      const { serviceTemplateService } = await import('./serviceTemplate.service');
      const resolved = await serviceTemplateService.resolveForAgent(deviceId, groupIds);
      for (const cfg of resolved) {
        if (cfg.enabled) {
          if (cfg.mode === 'track') trackOnlyServices.add(cfg.serviceType);
        } else {
          disabledServices.add(cfg.serviceType);
        }
      }
    } catch { /* not yet configured — all services default to ban mode */ }

    // Opt-in gate: drop events whose service has a resolved-but-disabled template.
    const incomingEvents = withValidEventIps(events).filter((ev) => !disabledServices.has(ev.service));
    if (incomingEvents.length === 0) return;

    // Peer link maps (LAN + WAN) — same logic as handlePush
    const lanIpToAgentId = new Map<string, number>();
    const wanIpToAgentId = new Map<string, number>();
    try {
      const lanRows = await db('agent_ips as ai')
        .join('agent_devices as ad', 'ad.id', 'ai.agent_id')
        .where({ 'ad.tenant_id': tenantId })
        .whereNot({ 'ai.agent_id': deviceId })
        .select('ai.ip_address', 'ai.agent_id') as { ip_address: string; agent_id: number }[];
      for (const row of lanRows) {
        if (lanIpToAgentId.has(row.ip_address)) {
          lanIpToAgentId.set(row.ip_address, -1);
        } else {
          lanIpToAgentId.set(row.ip_address, row.agent_id);
        }
      }

      const wanRows = await db('agent_devices')
        .where({ tenant_id: tenantId, wan_matching_enabled: true })
        .whereNot({ id: deviceId })
        .whereNotNull('ip')
        .select('id', 'ip') as { id: number; ip: string }[];
      for (const row of wanRows) {
        if (wanIpToAgentId.has(row.ip)) {
          wanIpToAgentId.set(row.ip, -1);
        } else {
          wanIpToAgentId.set(row.ip, row.id);
        }
      }
    } catch (err) {
      logger.warn({ err, deviceId }, 'processEventsFlush: peer link lookup failed');
    }

    // Enrich + insert events
    try {
      const receivedAt = Date.now();
      const enrichedEvents: StoredIpEvent[] = incomingEvents.map((ev: AgentIpEvent) => {
        let sourceAgentId: number | null = null;
        let sourceIpType: 'lan' | 'wan' | null = null;

        if (isRfc1918(ev.ip)) {
          const matchId = lanIpToAgentId.get(ev.ip);
          if (matchId !== undefined && matchId !== -1) {
            sourceAgentId = matchId;
            sourceIpType = 'lan';
          }
        } else {
          const matchId = wanIpToAgentId.get(ev.ip);
          if (matchId !== undefined && matchId !== -1) {
            sourceAgentId = matchId;
            sourceIpType = 'wan';
          }
        }

        return {
          device_id: deviceId,
          ip: ev.ip,
          username: ev.username ?? null,
          service: ev.service,
          event_type: ev.eventType,
          timestamp: clampEventTimestamp(ev.timestamp, receivedAt),
          raw_log: ev.rawLog ?? null,
          track_only: trackOnlyServices.has(ev.service),
          tenant_id: tenantId,
          source_agent_id: sourceAgentId,
          source_ip_type: sourceIpType,
        };
      });

      const insertedIds = await db('ip_events').insert(enrichedEvents).returning(['id']) as unknown[];

      await ipReputationService.upsertFromEvents(
        incomingEvents.map((ev: AgentIpEvent) => ({
          ip: ev.ip,
          service: ev.service,
          username: ev.username ?? null,
          deviceId,
          eventType: ev.eventType,
        })),
      );

      // Threat detection — same rule and cooldown as handlePush. Never throws.
      void noteThreat(deviceId, incomingEvents);

      // Live IP activity: batched ip:events + legacy ip:flow (W8-3).
      emitStoredIpEvents(tenantId, deviceId, enrichedEvents, insertedIds);
    } catch (err) {
      logger.warn({ err, deviceId }, 'processEventsFlush: event insert failed');
    }
  },

  // ── Version / download endpoints ─────────────────────────

  /**
   * The served agent version for the logged-in UI (agent/VERSION, dist or src
   * layout). Agents get the update target only through the config frame, gated
   * by the update policy (C17-1).
   */
  getAgentVersion(): { version: string; missingBuilds: string[] } {
    return { version: getServedAgentVersion() ?? '0.0.0', missingBuilds: getMissingAgentBuilds() };
  },

  // ── Agent update requests (C17-1) ────────────────────────

  /**
   * Explicit "Update now" on devices of `tenantId` (strict: other tenants'
   * ids are counted in skipped.notFound, also from Default). The request is
   * pinned to the version served now. Does not touch updated_at ("last seen").
   */
  async requestUpdate(ids: number[], tenantId: number, userId: number | null): Promise<AgentUpdateRequestResult> {
    const uniqueIds = [...new Set(ids)];
    const served = getServedAgentVersion();
    if (served === null) {
      return { requested: 0, targetVersion: null, skipped: { off: 0, current: 0, notUpdatable: uniqueIds.length, notFound: 0 } };
    }
    const devices = await this.getDevicesByIdsInTenant(uniqueIds, tenantId);
    const skipped = { off: 0, current: 0, notUpdatable: 0, notFound: uniqueIds.length - devices.length };
    const eligible: number[] = [];
    for (const d of devices) {
      if (d.deviceType !== 'agent' || d.status !== 'approved' || !d.agentVersion || d.updatePolicySource === 'unresolved') {
        skipped.notUpdatable++;
      } else if (d.resolvedUpdatePolicy === 'off') {
        skipped.off++;
      } else if (!isStrictlyNewerAgentVersion(served, d.agentVersion)) {
        skipped.current++;
      } else {
        eligible.push(d.id);
      }
    }
    if (eligible.length > 0) {
      const now = _now();
      await db('agent_devices')
        .whereIn('id', eligible)
        .andWhere({ tenant_id: tenantId })
        .update({ update_requested_at: new Date(now), update_requested_version: served, update_requested_by: userId });
      // A re-click (or Retry) restores the offer budget of this target and
      // reopens a failed attempt, but keeps last_offered_at: the 10-min
      // spacing survives, so repeated clicks cannot drive a download/restart loop.
      await db('agent_update_attempts')
        .whereIn('device_id', eligible)
        .andWhere({ target_version: served })
        .whereNot({ phase: 'succeeded' })
        .update({ offered_count: 0, phase: 'offered', last_error: null, finished_at: null, updated_at: new Date(now) });
      logger.info({
        event: 'agent_update_requested', userId, tenantId, version: served, count: eligible.length, deviceIds: eligible.slice(0, 50),
      }, 'Agent update requested');
    }
    return { requested: eligible.length, targetVersion: served, skipped };
  },

  /** Cancel a pending request of a device of `tenantId`. */
  async cancelUpdateRequest(id: number, tenantId: number, userId: number | null): Promise<boolean> {
    const n = await db('agent_devices')
      .where({ id, tenant_id: tenantId })
      .whereNotNull('update_requested_at')
      .update(REQUEST_NULLS);
    if (n > 0) await cancelOpenAttempts([id]);
    if (n > 0) logger.info({ event: 'agent_update_request_cancelled', userId, tenantId, deviceId: id }, 'Agent update request cancelled');
    return n > 0;
  },

  /**
   * Cancel the pending requests of these devices of `tenantId` (strict) and
   * close their open attempts ("cancel all pending", W12-4). Emits one patch
   * per cleared device when `emit` (bulk callers cap it). Returns the count.
   */
  async cancelUpdateRequests(ids: number[], tenantId: number, opts: { emit?: boolean } = {}): Promise<number> {
    if (ids.length === 0) return 0;
    const cleared = await db('agent_devices')
      .whereIn('id', ids)
      .andWhere({ tenant_id: tenantId })
      .whereNotNull('update_requested_at')
      .update(REQUEST_NULLS, ['id']) as Array<{ id: number }>;
    const clearedIds = cleared.map((r) => Number(r.id));
    await cancelOpenAttempts(clearedIds);
    if (opts.emit) {
      for (const id of clearedIds) emitDevicePatch(tenantId, id, { updateRequestedAt: null, updateRequestedVersion: null, updatePending: false });
    }
    return clearedIds.length;
  },

  /**
   * "Update outdated agents" of a group of `tenantId` and its sub-groups; null
   * when the group is not in the tenant. `writableIds` (the caller's team
   * scope, permissionService.getWritableAgentIds) limits the agents touched.
   */
  async requestGroupUpdate(
    groupId: number,
    tenantId: number,
    userId: number | null,
    writableIds?: number[] | 'all',
  ): Promise<AgentUpdateRequestResult | null> {
    if (!(await db('monitor_groups').where({ id: groupId, tenant_id: tenantId }).first('id'))) return null;
    const q = db('agent_devices')
      .whereIn('group_id', db('group_closure').where({ ancestor_id: groupId }).select('descendant_id'))
      .andWhere({ tenant_id: tenantId, status: 'approved', device_type: 'agent' });
    if (Array.isArray(writableIds)) q.whereIn('id', writableIds);
    const ids = await q.pluck('id') as number[];
    return this.requestUpdate(ids, tenantId, userId);
  },

  /**
   * Version distribution of approved agents (Default: every tenant — read god
   * view), within `visibleIds` when given (team scope).
   */
  async getVersionDistribution(tenantId: number, visibleIds?: number[] | 'all'): Promise<AgentVersionDistribution> {
    const devices = (await this.listDevices(tenantId, 'approved', { visibleIds })).filter((d) => d.deviceType === 'agent');
    const served = getServedAgentVersion();
    const [global, tenantPolicy] = await Promise.all([
      appConfigService.getAgentGlobal(),
      this.getTenantUpdatePolicy(tenantId),
    ]);
    const policies: Record<AgentUpdatePolicy, number> = { auto: 0, manual: 0, off: 0 };
    let upToDate = 0; let outdated = 0; let unknown = 0; let updatePending = 0; let updateFailed = 0;
    const counts = new Map<string, number>();
    for (const d of devices) {
      const v = d.agentVersion;
      if (!v) unknown++;
      else if (served && isStrictlyNewerAgentVersion(served, v)) outdated++;
      else upToDate++;
      if (d.updatePending) updatePending++;
      // A failed attempt superseded by the running version is not counted
      // (same rule as the client's visibleUpdateAttempt badge).
      if (d.update?.phase === 'failed'
        && !(v && d.update.targetVersion && !isStrictlyNewerAgentVersion(d.update.targetVersion, v))) updateFailed++;
      policies[d.resolvedUpdatePolicy ?? DEFAULT_AGENT_UPDATE_POLICY]++;
      const key = v || 'unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const versions = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([version, count]) => ({
        version,
        count,
        isLatest: version === served,
        outdated: served !== null && version !== 'unknown' && isStrictlyNewerAgentVersion(served, version),
      }));
    return {
      latestVersion: served,
      total: devices.length,
      upToDate,
      outdated,
      unknown,
      updatePending,
      policies,
      globalPolicy: isAgentUpdatePolicy(global.updatePolicy) ? global.updatePolicy : DEFAULT_AGENT_UPDATE_POLICY,
      globalPolicyIsDefault: !isAgentUpdatePolicy(global.updatePolicy),
      tenantPolicy,
      missingBuilds: getMissingAgentBuilds(),
      updateFailed,
      versions,
    };
  },

  // ── Tenant level of the update policy (owner amendment, W2-1) ────────────

  /** The tenant's explicit update policy, or null (inherit the global one). */
  async getTenantUpdatePolicy(tenantId: number): Promise<AgentUpdatePolicy | null> {
    const row = await db('tenants').where({ id: tenantId }).first('agent_update_policy') as
      { agent_update_policy: string | null } | undefined;
    const v = row?.agent_update_policy;
    return isAgentUpdatePolicy(v) ? v : null;
  },

  async getTenantUpdatePolicyInfo(tenantId: number): Promise<AgentTenantUpdatePolicyInfo> {
    const [updatePolicy, global] = await Promise.all([this.getTenantUpdatePolicy(tenantId), appConfigService.getAgentGlobal()]);
    return {
      tenantId,
      updatePolicy,
      globalPolicy: isAgentUpdatePolicy(global.updatePolicy) ? global.updatePolicy : DEFAULT_AGENT_UPDATE_POLICY,
      globalPolicyIsDefault: !isAgentUpdatePolicy(global.updatePolicy),
    };
  },

  /**
   * Set the tenant's policy (null = inherit). 'off' freezes every agent of
   * the tenant: their pending update requests are dropped and their open
   * attempts cancelled, like a device or group 'off'. Returns the previous
   * value, or null when the tenant does not exist.
   */
  async setTenantUpdatePolicy(tenantId: number, policy: AgentUpdatePolicy | null): Promise<{ before: AgentUpdatePolicy | null } | null> {
    const before = await this.getTenantUpdatePolicy(tenantId);
    const n = await db('tenants').where({ id: tenantId }).update({ agent_update_policy: policy });
    if (n === 0) return null;
    invalidateAgentUpdatePolicyCache();
    if (policy === 'off') {
      const cleared = await db('agent_devices')
        .where({ tenant_id: tenantId })
        .whereNotNull('update_requested_at')
        .update(REQUEST_NULLS, ['id']) as Array<{ id: number }>;
      const all = await db('agent_devices').where({ tenant_id: tenantId }).pluck('id') as number[];
      await cancelOpenAttempts(all);
      for (const r of cleared) emitDevicePatch(tenantId, r.id, { updateRequestedAt: null, updateRequestedVersion: null, updatePending: false });
    }
    return { before };
  },

  /**
   * A group (its whole sub-tree) or the global policy was set to 'off': close
   * the open attempts of the frozen devices so the UI stops showing 'offered'.
   * Pending requests are left as they are; the resolver ignores them while off.
   */
  async cancelOpenAttemptsForGroup(groupId: number): Promise<void> {
    const ids = await db('agent_devices')
      .whereIn('group_id', db('group_closure').where({ ancestor_id: groupId }).select('descendant_id'))
      .pluck('id') as number[];
    await cancelOpenAttempts(ids);
  },

  async cancelAllOpenAttempts(): Promise<void> {
    const ids = await db('agent_update_attempts')
      .whereIn('phase', ['offered', ...PROGRESS_UPDATE_PHASES])
      .distinct('device_id')
      .pluck('device_id') as number[];
    await cancelOpenAttempts(ids);
  },

  /**
   * Retry (POST /agent/devices/:id/update/retry): the attempt of the served
   * version restarts with a fresh budget (phase 'offered', 0 offers; the
   * 10-min spacing is kept) and an explicit request is (re)made, so it is
   * honoured under 'manual' too. Same refusals as "Update now".
   */
  async retryUpdate(id: number, tenantId: number, userId: number | null): Promise<AgentUpdateRequestResult> {
    const r = await this.requestUpdate([id], tenantId, userId);
    if (r.requested === 1) {
      logger.info({ event: 'agent_update_retry', userId, tenantId, deviceId: id, version: r.targetVersion }, 'Agent update retried');
      await emitAttemptPatch(id, tenantId);
    }
    return r;
  },

  /**
   * Mark a device as "updating" — called when the agent notifies us it is
   * about to self-update (legacy signal, every deployed build). Sets
   * updating_since (never updated_at: it is not a sign of life), moves the
   * open attempt to 'installing' and emits AGENT_STATUS_CHANGED so the UI
   * shows the "UPDATING" badge immediately.
   */
  async setDeviceUpdating(deviceId: number, tenantId: number): Promise<void> {
    const now = _now();
    await db('agent_devices')
      .where({ id: deviceId })
      .update({ updating_since: new Date(now) });

    const device = await db('agent_devices').where({ id: deviceId }).select('hostname', 'name', 'agent_version').first() as
      { hostname: string; name: string | null; agent_version: string | null } | undefined;
    const label = device?.name ?? device?.hostname ?? `#${deviceId}`;
    logger.info(`Agent ${deviceId} (${label}) is self-updating.`);

    // The open attempt (or, for an update this server did not offer, one for
    // the served version) becomes 'installing'.
    try {
      const open = await db('agent_update_attempts')
        .where({ device_id: deviceId })
        .whereIn('phase', ['offered', 'downloading', 'verifying'])
        .orderBy('updated_at', 'desc')
        .first('id') as { id: number } | undefined;
      if (open) {
        await db('agent_update_attempts').where({ id: open.id })
          .update({ phase: 'installing', last_error: null, finished_at: null, updated_at: new Date(now) });
        await emitAttemptPatch(deviceId, tenantId);
      } else {
        const served = getServedAgentVersion();
        if (served && isStrictlyNewerAgentVersion(served, device?.agent_version ?? '')) {
          await this.applyUpdateStatus(deviceId, tenantId, { targetVersion: served, phase: 'installing', error: null });
        }
      }
    } catch (err) {
      logger.warn({ err, deviceId }, 'agent update: attempt phase update failed');
    }

    // The first heartbeat after the update announces 'up' again (clears the badge).
    _presence.delete(deviceId);
    // Notify the owning tenant (and Default) immediately
    emitToTenantAudience(_io, tenantId, SOCKET_EVENTS.AGENT_STATUS_CHANGED,
      { deviceId, status: 'updating', violations: [], violationKeys: [] });
  },

  /**
   * An update_status frame from an approved agent of `tenantId` (W2-1). The
   * attempt of (device, targetVersion) takes the reported phase; 'failed'
   * records the error, closes the attempt and clears updating_since. A
   * 'succeeded' attempt is never reopened. Returns whether a row changed.
   * Never throws.
   */
  async applyUpdateStatus(deviceId: number, tenantId: number, st: ParsedUpdateStatus): Promise<boolean> {
    try {
      const dev = await db('agent_devices')
        .where({ id: deviceId, tenant_id: tenantId, status: 'approved' })
        .first('id') as { id: number } | undefined;
      if (!dev) return false;
      const now = new Date(_now());
      const failed = st.phase === 'failed';
      const r = await db.raw(
        `INSERT INTO agent_update_attempts AS a
           (device_id, target_version, offered_count, phase, last_error, created_at, updated_at, finished_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id, target_version) DO UPDATE SET
           phase = EXCLUDED.phase,
           last_error = EXCLUDED.last_error,
           finished_at = EXCLUDED.finished_at,
           updated_at = EXCLUDED.updated_at
         WHERE a.phase <> 'succeeded'
         RETURNING a.id`,
        [deviceId, st.targetVersion, st.phase, failed ? (st.error ?? 'failed') : null, now, now, failed ? now : null],
      ) as { rows: Array<{ id: number }> };
      if (r.rows.length === 0) return false;
      if (failed) {
        await db('agent_devices').where({ id: deviceId }).whereNotNull('updating_since').update({ updating_since: null });
        logger.warn({
          event: 'agent_update_failed', deviceId, tenantId, targetVersion: st.targetVersion, reason: st.error ?? 'failed',
        }, 'Agent update failed (reported by the agent)');
        await raiseUpdateFailedIncident(deviceId, st.targetVersion, st.error ?? 'reported by the agent');
      } else {
        logger.info({ event: 'agent_update_status', deviceId, tenantId, targetVersion: st.targetVersion, phase: st.phase }, 'Agent update progress');
      }
      await emitAttemptPatch(deviceId, tenantId);
      return true;
    } catch (err) {
      logger.warn({ err, deviceId }, 'agent update: update_status not recorded');
      return false;
    }
  },

  /**
   * Cleanup job: an attempt stuck in a progress phase ('downloading' to
   * 'restarting') for more than 10 minutes, or whose device is stuck
   * 'updating' (updating_since) as long, is 'failed' ('timeout');
   * updating_since is cleared so the normal offline detection takes over.
   * Never touches updated_at.
   */
  async cleanupStuckUpdating(): Promise<void> {
    const now = _now();
    const cutoff = new Date(now - UPDATE_ATTEMPT_TIMEOUT_MS);
    const rows = await db('agent_devices')
      .whereNotNull('updating_since')
      .where('updating_since', '<', cutoff)
      .select('id', 'hostname', 'name', 'tenant_id') as { id: number; hostname: string; name: string | null; tenant_id: number }[];

    const stuckIds = rows.map((r) => r.id);
    const timedOut = await db('agent_update_attempts')
      .whereIn('phase', [...PROGRESS_UPDATE_PHASES])
      .andWhere((q) => {
        q.where('updated_at', '<', cutoff);
        if (stuckIds.length > 0) q.orWhereIn('device_id', stuckIds);
      })
      .update(
        { phase: 'failed', last_error: 'timeout', finished_at: new Date(now), updated_at: new Date(now) },
        ['device_id', 'target_version'],
      ) as Array<{ device_id: number; target_version: string }>;

    const ids = [...new Set([...stuckIds, ...timedOut.map((r) => Number(r.device_id))])];
    if (ids.length === 0) return;
    await db('agent_devices').whereIn('id', ids).whereNotNull('updating_since').update({ updating_since: null });

    for (const row of rows) {
      const label = row.name ?? row.hostname;
      logger.warn(`Agent ${row.id} (${label}) update timed out — resuming offline detection.`);
    }
    for (const a of timedOut) {
      logger.warn({ event: 'agent_update_failed', deviceId: a.device_id, targetVersion: a.target_version, reason: 'timeout' }, 'Agent update timed out');
      await raiseUpdateFailedIncident(Number(a.device_id), a.target_version, 'timeout');
    }
    for (const id of ids) await emitAttemptPatch(id);
    logger.info(`Agent updating cleanup: ${rows.length} stuck device(s), ${timedOut.length} attempt(s) timed out.`);
  },

  // ── Presence (W2-1) ──────────────────────────────────────────────────────

  /** WS command channel registered: last_online_at of the tenant's row, if any. Never throws. */
  async markChannelOnline(uuid: string, tenantId: number): Promise<void> {
    try {
      await db('agent_devices').where({ uuid, tenant_id: tenantId }).update({ last_online_at: new Date() });
    } catch (err) {
      logger.warn({ err, uuid }, 'agent presence: last_online_at write failed');
    }
  },

  /** The offline grace period expired: last_offline_at, and a patch to the tenant. Never throws. */
  async markChannelOffline(deviceId: number, tenantId: number): Promise<void> {
    try {
      const at = new Date();
      const n = await db('agent_devices').where({ id: deviceId }).update({ last_offline_at: at });
      if (n > 0) emitDevicePatch(tenantId, deviceId, { lastOfflineAt: at.toISOString(), wsConnected: false });
    } catch (err) {
      logger.warn({ err, deviceId }, 'agent presence: last_offline_at write failed');
    }
  },

  /** Obliguard: no hardware metrics (IPS uses events not sensors) */
  getLatestMetrics(_deviceId: number): null { return null; },

  /** Obliguard: no hardware metrics in DB */
  async getMetricsFromDB(_deviceId: number): Promise<null> { return null; },

  getDesktopVersion(): { version: string } {
    // 1. Try obli.tools/VERSION (plain text "X.Y.Z\n")
    try {
      const versionFilePath = path.resolve(__dirname, '../../../../obli.tools/VERSION');
      const v = fs.readFileSync(versionFilePath, 'utf-8').trim();
      if (v) return { version: v };
    } catch { /* not found, try next */ }

    // 2. Dev fallback: parse `const appVersion = "x.y.z"` from obli.tools/main.go
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../obli.tools/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/(?:var|const)\s+appVersion\s*=\s*"([^"]+)"/);
      if (match?.[1]) return { version: match[1] };
    } catch { /* not found */ }

    return { version: '0.0.0' };
  },
};

