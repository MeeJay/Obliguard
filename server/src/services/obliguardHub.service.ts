import type { WebSocket } from 'ws';
import { db } from '../db';
import { logger } from '../utils/logger';
import { agentService, getAgentServiceIO, markAgentOffline, recordUpdateOffer } from './agent.service';
import { parseUpdateStatusFrame } from '../utils/agentUpdate';
import { appConfigService } from './appConfig.service';
import { agentConfigService } from './agentConfig.service';
import { liveAlertService, incidentStableKey } from './liveAlert.service';
import { notificationService } from './notification.service';
import { emitToTenantAudience } from '../utils/socketRooms';
import { agentCommandService, hasAgentCapability } from './agentCommand.service';
import type { AgentCommandRow } from './agentCommand.service';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { AgentIpEvent, ObliguardPushBody } from '@obliview/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ObliguardConn {
  ws: WebSocket;
  deviceUuid: string;
  /** DB row ID — null until the device is known AND approved */
  deviceId: number | null;
  tenantId: number;
  apiKeyId: number;
  /** Cached client IP (from WS upgrade headers) */
  clientIp: string;
  /** Set by disconnectWhere: the conn is being torn down, ignore its frames. */
  closing: boolean;
  /** True once the first heartbeat frame arrived. */
  seenHeartbeat: boolean;
  /** First-heartbeat deadline timer. */
  deadline: ReturnType<typeof setTimeout> | null;
  /** Registered with no agent_devices row yet (counted against the per-key pending cap). */
  rowless: boolean;
  /** Registration time (ms): a heartbeat on a newer channel than an update phase is a reconnection. */
  connectedAt: number;
  /** Last time (ms) a 'dropped' events warning was logged for this channel (throttle). */
  droppedWarnedAt?: number;
  /** Heartbeats and update_status frames of this channel are handled one at a time, in order. */
  queue: Promise<void>;
  /**
   * Rate limits last sent on this channel (W4-5): 'on' while enforcement is
   * on (the resolved list rides every config frame), 'cleared' once [] was
   * sent with enforcement off (then the field is omitted), null before.
   */
  rateLimitsSent?: 'on' | 'cleared' | null;
}

/** Command pushed from server → agent on the WS channel */
export interface OrCommand {
  type: string;
  id: string;
  payload: Record<string, unknown>;
}

interface FirewallWaiter {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  deviceUuid: string;
}

/**
 * Slack added to the offline threshold of the persisted sweep: last_seen_at is
 * written at most once a minute per device (agent.service lastSeenDue).
 */
const OFFLINE_SWEEP_SLACK_MS = 60_000;

/** Cadence of the agent command expiry sweep (W14-1). */
const COMMAND_SWEEP_INTERVAL_MS = 60_000;

/** Offline threshold when a device's settings cannot be resolved (2 min). */
const DEFAULT_OFFLINE_GRACE_MS = 120_000;

/** Stable key of a device's offline incident (one open row while it is down). */
export function agentOfflineKey(deviceId: number): string {
  return incidentStableKey('agent_offline', `device:${deviceId}`);
}

interface OfflineCandidateRow {
  id: number;
  uuid: string;
  tenant_id: number;
  status: string;
  device_type: string | null;
  name: string | null;
  hostname: string;
  last_seen_at: Date | null;
}

function deviceLabel(row: { id: number; name: string | null; hostname: string | null }): string {
  return row.name || row.hostname || `#${row.id}`;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class ObliguardHubService {
  /** deviceUuid → active connection */
  private byDevice = new Map<string, ObliguardConn>();
  /** deviceUuid → pending offline timer (cleared if agent reconnects before expiry) */
  private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * API keys disabled or deleted since start (W10-2). register() refuses them:
   * an upgrade that passed the gate just before the key was disabled must not
   * slip in after closeByApiKey. Cleared by allowApiKey on re-enable.
   */
  private revokedKeys = new Set<number>();
  /**
   * Tenants deleted since start (C13). register() refuses them and their
   * closing channels start no offline timer. Tenant ids are never reused
   * (serial), so the set only grows with deletions.
   */
  private revokedTenants = new Set<number>();

  /** A socket that sends no heartbeat within this delay is closed (4008). Tests may lower it. */
  firstHeartbeatDeadlineMs = 60_000;

  /**
   * Offline grace override in ms (null = checkIntervalSeconds x
   * maxMissedPushes of the device). Tests may set it.
   */
  offlineGraceMsOverride: number | null = null;

  /**
   * Start of the persisted sweep's observation (server start): an agent
   * seen before it is measured from it, so after a restart the fleet gets a
   * full grace window to reconnect (reconnect backoff up to 60 s) before
   * any 'down' is sent. Tests may lower it.
   */
  sweepSince = Date.now();

  /** Command expiry sweep timer, started with the first channel (W14-1). */
  private commandSweep: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Ping every 15 s to keep the connection alive through reverse proxies.
    const pinger = setInterval(() => {
      for (const [uuid, conn] of this.byDevice) {
        if (conn.ws.readyState === 1 /* OPEN */) {
          try { (conn.ws as any).ping(); } catch { this._unregister(uuid, conn.ws); }
        }
      }
    }, 15_000);
    pinger.unref?.();
  }

  /**
   * True when a live, non-closing connection holds `uuid` for another tenant or
   * another API key. Such a connection is never displaced.
   */
  hasLiveConflict(uuid: string, tenantId: number, apiKeyId: number): boolean {
    const e = this.byDevice.get(uuid);
    return !!e && !e.closing && e.ws.readyState === 1 && (e.tenantId !== tenantId || e.apiKeyId !== apiKeyId);
  }

  /**
   * Register an Obliguard agent command-channel WebSocket.
   * Replaces an existing connection of the SAME key for the device UUID; a live
   * connection held by another key is never displaced (the new one is closed
   * 4003 — the pre-upgrade gate normally rejects it with HTTP 403 first).
   * Drains the command queue on connect (approved devices only; agents
   * without 'cmdqueue' only get a queued uninstall, as a config frame).
   * Returns false when the socket was refused.
   */
  async register(
    deviceUuid: string,
    tenantId: number,
    apiKeyId: number,
    clientIp: string,
    ws: WebSocket,
    opts: { rowless?: boolean } = {},
  ): Promise<boolean> {
    if (ws.readyState !== 1) return false;

    if (this.revokedTenants.has(tenantId)) {
      logger.warn({ deviceUuid, tenantId, apiKeyId }, 'Obliguard agent WS refused: tenant deleted');
      try { ws.close(4003, 'Tenant deleted'); } catch { /* ignore */ }
      return false;
    }

    if (this.revokedKeys.has(apiKeyId)) {
      logger.warn({ deviceUuid, tenantId, apiKeyId }, 'Obliguard agent WS refused: API key disabled');
      try { ws.close(4003, 'API key revoked'); } catch { /* ignore */ }
      return false;
    }

    if (this.hasLiveConflict(deviceUuid, tenantId, apiKeyId)) {
      const live = this.byDevice.get(deviceUuid)!;
      logger.warn(
        { deviceUuid, tenantId, apiKeyId, liveTenantId: live.tenantId, liveApiKeyId: live.apiKeyId },
        'Obliguard agent WS refused: device already connected with another API key',
      );
      try { ws.close(4003, 'Device/API-key mismatch'); } catch { /* ignore */ }
      return false;
    }

    // Cancel any pending offline timer — agent reconnected in time
    const pendingTimer = this.offlineTimers.get(deviceUuid);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.offlineTimers.delete(deviceUuid);
      logger.info({ deviceUuid }, 'Obliguard agent reconnected — offline timer cancelled');
    }

    const existing = this.byDevice.get(deviceUuid);
    if (existing && existing.ws.readyState === 1) {
      try { existing.ws.close(1000, 'replaced'); } catch {}
    }

    const conn: ObliguardConn = {
      ws, deviceUuid, deviceId: null, tenantId, apiKeyId, clientIp,
      closing: false, seenHeartbeat: false, deadline: null, rowless: opts.rowless === true,
      connectedAt: Date.now(), queue: Promise.resolve(), rateLimitsSent: null,
    };
    this.byDevice.set(deviceUuid, conn);

    ws.on('close', () => this._unregister(deviceUuid, ws));
    ws.on('error', () => this._unregister(deviceUuid, ws));
    ws.on('message', async (data: Buffer) => {
      if (conn.closing || ws.readyState !== 1) return;
      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          // Serialised per channel: an offer is counted (after its frame was
          // written) before the next heartbeat of the same agent is evaluated.
          case 'heartbeat':     await this._enqueue(conn, () => this._handleHeartbeat(conn, msg)); break;
          case 'update_status': await this._enqueue(conn, () => this._handleUpdateStatus(conn, msg)); break;
          case 'events':    await this._handleEventsFlush(conn, msg); break;
          case 'firewall_response': this._resolveFirewallResponse(conn, msg); break;
          case 'command_ack': await this._handleCommandAck(conn, msg); break;
          default:          break; // unknown message type — ignore
        }
      } catch { /* malformed JSON */ }
    });

    // Row-less / silent sockets are bounded: no heartbeat within the deadline → closed.
    conn.deadline = setTimeout(() => {
      if (!conn.seenHeartbeat) this.disconnectWhere((c) => c === conn, 4008, 'No heartbeat');
    }, this.firstHeartbeatDeadlineMs);
    conn.deadline.unref?.();
    ws.once('close', () => { if (conn.deadline) clearTimeout(conn.deadline); });

    this._startCommandSweep();
    // Drain the command queue on connect (from the capabilities stored by the
    // previous session; the heartbeat drains again with the fresh list).
    await this._drainPendingCommand(conn);
    // Presence: last_online_at (W2-1).
    await agentService.markChannelOnline(deviceUuid, tenantId);
    // Back from a declared outage: resolve the offline incident, notify 'up'.
    if (conn.deviceId) await this.recoverOnline(conn.deviceId);

    logger.info({ deviceUuid, tenantId }, 'Obliguard agent command channel connected');
    return true;
  }

  private _unregister(deviceUuid: string, ws: WebSocket): void {
    const existing = this.byDevice.get(deviceUuid);
    if (existing?.ws === ws) {
      const deviceId = existing.deviceId;
      if (existing.deadline) { clearTimeout(existing.deadline); existing.deadline = null; }
      this.byDevice.delete(deviceUuid);
      logger.info({ deviceUuid }, 'Obliguard agent command channel disconnected');

      // Pending firewall commands of this device can no longer be answered.
      for (const [id, w] of this.firewallWaiters) {
        if (w.deviceUuid === deviceUuid) {
          clearTimeout(w.timer);
          this.firewallWaiters.delete(id);
          w.reject(new Error('Agent is not connected'));
        }
      }

      // Start an offline grace timer based on the device's resolved settings.
      // If the agent reconnects before the timer fires, register() cancels it.
      if (deviceId && !this.revokedTenants.has(existing.tenantId)) {
        this._startOfflineTimer(deviceUuid, deviceId, existing.tenantId);
      }
    }
  }

  // ── Teardown API ─────────────────────────────────────────────────────────────

  /**
   * Close every connection matching `pred`. Entries stay in byDevice until
   * their 'close' event (_unregister keeps the offline-timer semantics); a
   * socket that does not close within 5 s is terminated.
   * Also the hook for tenant deletion (C13).
   */
  disconnectWhere(pred: (c: ObliguardConn) => boolean, code: number, reason: string): number {
    let count = 0;
    for (const conn of [...this.byDevice.values()]) {
      if (!pred(conn)) continue;
      conn.closing = true;
      try {
        conn.ws.close(code, reason);
      } catch {
        try { conn.ws.terminate(); } catch { /* ignore */ }
      }
      const t = setTimeout(() => {
        try { if (conn.ws.readyState !== 3) conn.ws.terminate(); } catch { /* ignore */ }
      }, 5000);
      t.unref?.();
      count++;
    }
    return count;
  }

  /**
   * Live sockets of `apiKeyId` registered before their device row exists (the
   * first heartbeat inserts it). The gate adds them to countPendingForKey so a
   * key holder cannot open unbounded fresh-uuid sockets inside the
   * first-heartbeat window.
   */
  countRowlessForKey(apiKeyId: number): number {
    let n = 0;
    for (const c of this.byDevice.values()) {
      if (c.rowless && !c.closing && c.apiKeyId === apiKeyId) n++;
    }
    return n;
  }

  /** Close every live channel authenticated with `apiKeyId` (key deletion). */
  disconnectByApiKey(apiKeyId: number): number {
    return this.disconnectWhere((c) => c.apiKeyId === apiKeyId, 4003, 'API key revoked');
  }

  /**
   * Key disabled or deleted (W10-2): close its live channels and refuse its
   * in-flight upgrades until allowApiKey. Same close as a deletion (4003): the
   * agent reconnects, the gate answers 401 and the agent backs off.
   */
  closeByApiKey(apiKeyId: number): number {
    this.revokedKeys.add(apiKeyId);
    return this.disconnectByApiKey(apiKeyId);
  }

  /** Key re-enabled: its agents may register again. */
  allowApiKey(apiKeyId: number): void {
    this.revokedKeys.delete(apiKeyId);
  }

  /**
   * Tenant deleted (C13): close every live channel of `tenantId` (4003, the
   * agent reconnects and the gate answers 401: its key is gone) and refuse
   * the tenant's in-flight upgrades for good. No offline incident is raised
   * for these agents. Returns the number of channels closed.
   */
  closeByTenant(tenantId: number): number {
    this.revokedTenants.add(tenantId);
    return this.disconnectWhere((c) => c.tenantId === tenantId, 4003, 'Tenant deleted');
  }

  /**
   * Deliver a queued 'uninstall' right away to every live channel of
   * `tenantId` (the "Uninstall all agents" action of a tenant deletion):
   * the same conditional drain as on connect, so a heartbeat racing it never
   * delivers twice. Offline agents get it when they reconnect. Returns the
   * number of agents the command was sent to.
   */
  async deliverUninstallToTenant(tenantId: number): Promise<number> {
    let sent = 0;
    for (const conn of [...this.byDevice.values()]) {
      if (conn.tenantId !== tenantId || conn.closing || conn.ws.readyState !== 1) continue;
      if (await this._drainPendingCommand(conn)) sent++;
    }
    return sent;
  }

  /**
   * Deliver right away the queued commands of `deviceIds` that hold a live
   * channel (a request from the UI, W14-1); offline agents get them on their
   * next contact. Serialized with the channel's heartbeats. Returns the
   * number of agents something was sent to.
   */
  async deliverQueuedCommands(deviceIds: number[]): Promise<number> {
    const wanted = new Set(deviceIds);
    let sent = 0;
    for (const conn of [...this.byDevice.values()]) {
      if (!conn.deviceId || !wanted.has(conn.deviceId) || conn.closing || conn.ws.readyState !== 1) continue;
      let delivered = false;
      await this._enqueue(conn, async () => { delivered = await this._drainPendingCommand(conn); });
      if (delivered) sent++;
    }
    return sent;
  }

  /** Close the live channel of a device (suspend / refuse / delete). */
  disconnectDevice(uuid: string, reason: string): number {
    return this.disconnectWhere((c) => c.deviceUuid === uuid, 4003, reason);
  }

  /**
   * Start a delayed offline notification. The delay = checkIntervalSeconds × maxMissedPushes
   * resolved from the device's settings (group → global → defaults).
   * This absorbs brief WS reconnections without flashing the UI red.
   */
  private async _startOfflineTimer(deviceUuid: string, deviceId: number, tenantId: number): Promise<void> {
    const delayMs = this.offlineGraceMsOverride ?? await this._offlineGraceMs(deviceId);
    // The agent reconnected while the settings were resolved: no timer.
    if (this.byDevice.get(deviceUuid)?.ws.readyState === 1) return;

    // A newer disconnect restarts the grace window (never two timers per device).
    const previous = this.offlineTimers.get(deviceUuid);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      if (this.offlineTimers.get(deviceUuid) !== timer) return;
      this.offlineTimers.delete(deviceUuid);
      // The tenant was deleted meanwhile: its agents are gone, not offline.
      if (this.revokedTenants.has(tenantId)) return;
      // Only emit if the agent hasn't reconnected
      if (!this.isConnected(deviceUuid)) {
        // The next heartbeat is an offline → online transition again.
        markAgentOffline(deviceId);
        void agentService.markChannelOffline(deviceId, tenantId);
        logger.info({ deviceUuid, deviceId }, 'Obliguard agent offline grace period expired');
        // The owning tenant's members and the Default god view.
        emitToTenantAudience(getAgentServiceIO(), tenantId, SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
          deviceId,
          status: 'down',
          wsConnected: false,
        });
        // Live alert + 'down' to the channels (approved agents only).
        this.declareOffline(deviceId).catch((err) => {
          logger.warn({ err, deviceId }, 'obliguardHub: offline incident failed');
        });
      }
    }, delayMs);
    timer.unref?.();

    this.offlineTimers.set(deviceUuid, timer);
  }

  /**
   * checkIntervalSeconds × maxMissedPushes of the device, in ms, read through
   * the IPS settings cascade (global → tenant → group chain → agent, W13-1).
   */
  private async _offlineGraceMs(deviceId: number): Promise<number> {
    try {
      const settings = await agentConfigService.resolveForDeviceId(deviceId);
      if (settings) return settings.checkIntervalSeconds * settings.maxMissedPushes * 1000;
    } catch (err) {
      logger.warn({ err, deviceId }, 'obliguardHub: offline grace resolution failed, default used');
    }
    return DEFAULT_OFFLINE_GRACE_MS;
  }

  // ── Offline incidents (W6-2) ─────────────────────────────────────────────────
  // Mirrors Obliance device.service checkOfflineDevices / handlePush: an
  // approved agent that stays away past its grace window raises ONE open
  // 'agent_offline' incident (stable key per device) and sends 'down' to its
  // notification channels; its return resolves the incident and sends 'up'.
  // The open incident row is the declared-offline memory, so it survives a
  // server restart; the persisted sweep (sweepOffline) declares the agents
  // that never came back.

  /**
   * Declare an approved agent offline: raise its offline incident and, when
   * the incident is new, notify 'down'. Pending, refused and suspended
   * devices, routers and connected agents are skipped. True when a new
   * incident was opened. Internal timers only.
   */
  async declareOffline(deviceId: number): Promise<boolean> {
    const row = await db('agent_devices')
      .where({ id: deviceId })
      .first('id', 'uuid', 'tenant_id', 'status', 'device_type', 'name', 'hostname', 'last_seen_at') as
      OfflineCandidateRow | undefined;
    if (!row || row.status !== 'approved' || (row.device_type ?? 'agent') !== 'agent') return false;
    if (this.isConnected(row.uuid)) return false;

    const label = deviceLabel(row);
    const lastSeen = row.last_seen_at ? new Date(row.last_seen_at) : null;
    const { created } = await liveAlertService.raiseIncident({
      tenantId: row.tenant_id,
      kind: 'agent_offline',
      stableKey: agentOfflineKey(row.id),
      deviceId: row.id,
      severity: 'down',
      title: `Agent offline: ${label}`,
      message: lastSeen
        ? `${label} has not reported since ${lastSeen.toISOString()}. New bans are not enforced on it.`
        : `${label} stopped reporting. New bans are not enforced on it.`,
      link: `/agents/${row.id}`,
    });

    // Reconnected while the incident was being raised: recover right away.
    // A row this call just opened was never announced as 'down': close it
    // without an 'up' (an older open row did send 'down': recover normally).
    if (this.isConnected(row.uuid)) {
      if (created) {
        await liveAlertService.resolveIncidents({ deviceId: row.id, kind: 'agent_offline' }).catch((err) => {
          logger.warn({ err, deviceId: row.id }, 'obliguardHub: offline incident close failed');
        });
      } else {
        await this.recoverOnline(row.id);
      }
      return false;
    }
    if (created) {
      logger.warn({ deviceId: row.id, tenantId: row.tenant_id }, 'Agent declared offline');
      notificationService.sendForAgent(row.id, label, 'down', 'up', [], 'down').catch((err) => {
        logger.warn({ err, deviceId: row.id }, 'obliguardHub: offline notification failed');
      });
    }
    return created;
  }

  /**
   * The agent is back (channel registered, or a push after an outage):
   * resolve its open offline incident and notify 'up'. Nothing is sent when
   * no outage was declared; resolveIncidents is atomic, so concurrent callers
   * (register + heartbeat) notify once. Never throws.
   */
  async recoverOnline(deviceId: number): Promise<boolean> {
    try {
      const ids = await liveAlertService.resolveIncidents({ deviceId, kind: 'agent_offline' });
      if (ids.length === 0) return false;
      const row = await db('agent_devices').where({ id: deviceId })
        .first('id', 'name', 'hostname') as { id: number; name: string | null; hostname: string } | undefined;
      const label = row ? deviceLabel(row) : `#${deviceId}`;
      logger.info({ deviceId }, 'Agent back online after a declared outage');
      notificationService.sendForAgent(deviceId, label, 'up', 'down', [], 'up').catch((err) => {
        logger.warn({ err, deviceId }, 'obliguardHub: online notification failed');
      });
      return true;
    } catch (err) {
      logger.warn({ err, deviceId }, 'obliguardHub: offline incident recovery failed');
      return false;
    }
  }

  /**
   * Persisted offline sweep (index.ts, every 60 s): approved agents whose
   * last_seen_at is older than their grace window (plus the last_seen_at
   * write throttle), with no channel, no running grace timer and no open
   * offline incident, are declared offline. Covers agents that never came
   * back after a server restart and HTTP-push agents (no disconnect event).
   * Returns the number of new incidents.
   */
  async sweepOffline(now = Date.now()): Promise<number> {
    const rows = await db('agent_devices as d')
      .where('d.status', 'approved')
      .where('d.device_type', 'agent')
      .whereNotNull('d.last_seen_at')
      .where('d.last_seen_at', '<', new Date(now - (this.offlineGraceMsOverride ?? OFFLINE_SWEEP_SLACK_MS)))
      .whereNotExists(
        db('live_alerts as la')
          .whereRaw('la.device_id = d.id')
          .where('la.incident_kind', 'agent_offline')
          .whereNull('la.resolved_at')
          .select(db.raw('1')),
      )
      .select('d.id', 'd.uuid', 'd.tenant_id', 'd.last_seen_at') as
      Array<{ id: number; uuid: string; tenant_id: number; last_seen_at: Date }>;

    let declared = 0;
    for (const r of rows) {
      if (this.isConnected(r.uuid)) continue;
      const graceMs = this.offlineGraceMsOverride ?? (await this._offlineGraceMs(r.id)) + OFFLINE_SWEEP_SLACK_MS;
      const seenAt = Math.max(new Date(r.last_seen_at).getTime(), this.sweepSince);
      if (now - seenAt < graceMs) continue;
      try {
        if (!(await this.declareOffline(r.id))) continue;
        declared++;
        // Same presence side effects as the grace timer.
        markAgentOffline(r.id);
        await agentService.markChannelOffline(r.id, r.tenant_id);
        emitToTenantAudience(getAgentServiceIO(), r.tenant_id, SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
          deviceId: r.id,
          status: 'down',
          wsConnected: false,
        });
      } catch (err) {
        logger.warn({ err, deviceId: r.id }, 'obliguardHub: offline sweep failed for a device');
      }
    }
    return declared;
  }

  /**
   * On connect: cache the device id of an APPROVED device and deliver its
   * queued commands (W14-1): 'command' frames to an agent advertising
   * 'cmdqueue' (capabilities stored by its previous heartbeat), otherwise only
   * a queued 'uninstall', as the legacy config frame. Other legacy commands
   * (pending_command 'update') are delivered by the next heartbeat's
   * handlePush. The claim is locked per device, so a racing heartbeat never
   * delivers twice; uninstall_commanded_at lets cleanupUninstalledDevices
   * remove the device. True when something was sent.
   */
  private async _drainPendingCommand(conn: ObliguardConn): Promise<boolean> {
    try {
      const row = await db('agent_devices')
        .where({ uuid: conn.deviceUuid, tenant_id: conn.tenantId })
        .first('id', 'status', 'capabilities') as
        { id: number; status: string; capabilities: unknown } | undefined;

      if (!row || row.status !== 'approved') return false;

      // Cache the device ID for later use
      conn.deviceId = row.id;

      return await this._deliverCommands(conn, hasAgentCapability(row.capabilities));
    } catch (e) {
      logger.error(e, 'obliguardHub: failed to drain pending command');
      return false;
    }
  }

  /**
   * Claim and send the device's queued commands (conn.deviceId set). Frames
   * that could not be written go back to the queue. True when one was sent.
   */
  private async _deliverCommands(conn: ObliguardConn, cmdqueue: boolean): Promise<boolean> {
    const deviceId = conn.deviceId;
    if (!deviceId || conn.closing || conn.ws.readyState !== 1) return false;
    const claim = await agentCommandService.claim(deviceId, cmdqueue);

    if (claim.legacyUninstall) {
      if (this._send(conn, { type: 'config', command: 'uninstall' })) return true;
      await agentCommandService.requeue(claim.legacyRows);
      return false;
    }

    let sent = false;
    const unsent: AgentCommandRow[] = [];
    for (const row of claim.commands) {
      const payload = await this._commandPayload(deviceId, row);
      if (payload === null) continue; // failed while preparing (recorded)
      const frame = { type: 'command', id: String(row.id), command: row.type, payload };
      if (this._send(conn, frame)) {
        sent = true;
        logger.info({ deviceId, commandId: row.id, command: row.type }, 'Agent command sent');
      } else {
        unsent.push(row);
      }
    }
    if (unsent.length > 0) await agentCommandService.requeue(unsent);
    return sent;
  }

  /**
   * Payload of a command frame. firewall_resync carries the full ban list the
   * agent must enforce, resolved now (evaluate-only agents get []). Null when
   * it cannot be built: the command is marked failed.
   */
  private async _commandPayload(deviceId: number, row: AgentCommandRow): Promise<Record<string, unknown> | null> {
    const base = (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload))
      ? row.payload as Record<string, unknown> : {};
    if (row.type !== 'firewall_resync') return base;
    try {
      const bans = await agentService.resolveFullBanList(deviceId);
      if (bans === null) throw new Error('device not found');
      return { ...base, bans };
    } catch (err) {
      logger.warn({ err, deviceId, commandId: row.id }, 'obliguardHub: firewall resync ban list failed');
      await agentCommandService.fail(row.id, deviceId, 'The ban list could not be resolved').catch(() => {});
      return null;
    }
  }

  /**
   * `{ type: "command_ack", id, status, result }` (W14-1): acknowledgement
   * then final result of a queued command. Only rows of this channel's
   * approved device are updated.
   */
  private async _handleCommandAck(conn: ObliguardConn, msg: { id?: unknown; status?: unknown; result?: unknown }): Promise<void> {
    if (!conn.deviceId) return;
    try {
      await agentCommandService.ack(conn.deviceId, msg.id, msg.status, msg.result);
    } catch (e) {
      logger.error(e, 'obliguardHub: command ack failed');
    }
  }

  /** Expiry / result-timeout sweep of the command queue, every minute. */
  private _startCommandSweep(): void {
    if (this.commandSweep) return;
    this.commandSweep = setInterval(() => {
      agentCommandService.sweep().catch((err) => {
        logger.debug({ err }, 'obliguardHub: command sweep failed');
      });
    }, COMMAND_SWEEP_INTERVAL_MS);
    this.commandSweep.unref?.();
  }

  /**
   * Handle a heartbeat message from an Obliguard agent.
   * Calls the full handlePush pipeline (binding, metadata, ban delta, service
   * configs, etc.) and sends a `{ type: "config", ... }` response.
   */
  private async _handleHeartbeat(conn: ObliguardConn, msg: any): Promise<void> {
    conn.seenHeartbeat = true;
    try {
      const body: ObliguardPushBody = {
        hostname:       msg.hostname       ?? '',
        agentVersion:   msg.agentVersion   ?? '',
        osInfo:         msg.osInfo,
        services:       msg.services       ?? [],
        events:         [],   // events arrive separately via flush frames
        firewallBanned: msg.firewallBanned ?? [],
        firewallName:   msg.firewallName   ?? '',
        logSamples:     msg.logSamples     ?? {},
        lanIPs:         msg.lanIPs         ?? [],
        // W2-1: optional; sanitised by handlePush (absent = stored list kept).
        capabilities:   msg.capabilities,
      };

      const pushStartedAt = new Date();
      const response = await agentService.handlePush(
        conn.apiKeyId,
        conn.tenantId,
        conn.deviceUuid,
        conn.clientIp,
        body,
        { deferOfferRecord: true, connectedAt: conn.connectedAt },
      );
      // The row exists now (or enrolment was deferred and the socket closes below).
      conn.rowless = false;

      if (response.status === 'refused') {
        // Also covers suspended and binding mismatch. deviceId is KEPT so
        // _unregister starts the offline grace timer (UI gets 'down').
        this.disconnectWhere((c) => c === conn, 4003, 'Device refused');
        return;
      }

      if (response.status === 'pending') {
        // Don't send config to non-approved agents
        conn.deviceId = null;
        if (response.enrolmentDeferred) this.disconnectWhere((c) => c === conn, 1013, 'Enrolment deferred');
        return;
      }

      agentService.touchApiKeyUsage(conn.apiKeyId);

      // Cache resolved device ID so events-flush path can use it without a DB lookup
      if (!conn.deviceId) {
        const row = await db('agent_devices')
          .where({ uuid: conn.deviceUuid, tenant_id: conn.tenantId, status: 'approved' })
          .first('id') as { id: number } | undefined;
        if (row) conn.deviceId = row.id;
      }

      // Build and send config reply
      const configMsg: Record<string, unknown> = { type: 'config' };
      if (response.config?.pushIntervalSeconds) {
        configMsg.pushIntervalSeconds = response.config.pushIntervalSeconds;
      }
      if (response.latestVersion) {
        configMsg.latestVersion = response.latestVersion;
      }
      // Windows agents (W13-1 cascade): 'auto' | 'wfp' | 'netsh', on every frame
      // so a switch back applies; older agents ignore the field.
      if (response.firewallBackend) {
        configMsg.firewallBackend = response.firewallBackend;
      }
      if (response.banList && (response.banList.add.length > 0 || response.banList.remove.length > 0)) {
        configMsg.banList = response.banList;
      }
      if (response.whitelist && response.whitelist.length > 0) {
        configMsg.whitelist = response.whitelist;
      }
      if (response.services && Object.keys(response.services).length > 0) {
        configMsg.services = response.services;
      }
      if (response.command) {
        configMsg.command = response.command;
      }

      // Rate limits (W4-5). An agent applies the field only when present
      // (absent = unchanged, [] = clear). Enforcement on: the resolved list
      // (enabled policies) rides every frame, the agent skips an unchanged
      // set. Enforcement off: [] once per channel clears whatever an earlier
      // session applied, then the field is omitted.
      const rateLimitsOn = (await appConfigService.getRateLimitEnforcement()) === 'on';
      let rateLimitsState = conn.rateLimitsSent ?? null;
      if (rateLimitsOn) {
        // No list (resolution failed upstream): omit, the agent keeps its limits.
        if (Array.isArray(response.rateLimits)) {
          configMsg.rateLimits = response.rateLimits;
          rateLimitsState = 'on';
        }
      } else if (rateLimitsState !== 'cleared') {
        configMsg.rateLimits = [];
        rateLimitsState = 'cleared';
      }

      // The offer is counted only once its frame was actually written (W2-1).
      const sent = this._send(conn, configMsg);
      if (sent) conn.rateLimitsSent = rateLimitsState;
      if (sent && response.latestVersion && conn.deviceId) {
        await recordUpdateOffer(conn.deviceId, response.latestVersion);
      }
      // Legacy uninstall claimed by handlePush but never written: back to the
      // queue (pending_command restored, uninstall_commanded_at cleared).
      if (!sent && response.command === 'uninstall' && conn.deviceId) {
        await agentCommandService.requeueLegacyUninstall(conn.deviceId, pushStartedAt);
      }

      // Command queue (W14-1): agents advertising 'cmdqueue' get their queued
      // commands after the config frame; the others got a queued uninstall in
      // it (handlePush, legacy path).
      if (sent && conn.deviceId && hasAgentCapability(msg.capabilities)) {
        await this._deliverCommands(conn, true);
      }
    } catch (e) {
      logger.error(e, 'obliguardHub: heartbeat handling failed');
    }
  }

  /** Run `fn` after the previous queued frame of this channel (errors are contained). */
  private _enqueue(conn: ObliguardConn, fn: () => Promise<void>): Promise<void> {
    const next = conn.queue.then(fn, fn).catch((e) => { logger.error(e, 'obliguardHub: frame handling failed'); });
    conn.queue = next;
    return next;
  }

  /** Write a frame on a live, non-closing channel. False when nothing was written. */
  private _send(conn: ObliguardConn, frame: unknown): boolean {
    if (conn.closing || conn.ws.readyState !== 1) return false;
    try {
      conn.ws.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      logger.warn({ err: e, deviceUuid: conn.deviceUuid }, 'obliguardHub: frame write failed');
      return false;
    }
  }

  /**
   * Handle `{ type: "update_status", targetVersion, phase, error? }` (W2-1):
   * progress of a self-update, same envelope as the events frame. Approved
   * devices only (conn.deviceId is set for them); unknown phases and
   * malformed frames are ignored.
   */
  private async _handleUpdateStatus(conn: ObliguardConn, msg: unknown): Promise<void> {
    const st = parseUpdateStatusFrame(msg);
    if (!st) return;
    // A restarted agent may report (e.g. a failed install) before its first
    // heartbeat on this channel: resolve the approved row already bound to this
    // channel's key (any re-binding is left to the heartbeat's A5 check).
    if (!conn.deviceId && !conn.rowless) {
      const row = await db('agent_devices')
        .where({ uuid: conn.deviceUuid, tenant_id: conn.tenantId, api_key_id: conn.apiKeyId, status: 'approved' })
        .first('id') as { id: number } | undefined;
      if (row) conn.deviceId = row.id;
    }
    if (!conn.deviceId) return;
    await agentService.applyUpdateStatus(conn.deviceId, conn.tenantId, st);
  }

  /**
   * Handle an events-flush frame: `{ type: "events", events: [...] }`.
   * Processes only the events pipeline (enrichment, insert, reputation,
   * threat detection, Starmap emit) — no ban/config overhead.
   * processEventsFlush re-validates approval + tenant on every flush.
   */
  private async _handleEventsFlush(conn: ObliguardConn, msg: any): Promise<void> {
    const events: AgentIpEvent[] = Array.isArray(msg.events) ? msg.events : [];
    // Agents >= W5-5 report how many events their bounded queue dropped
    // (oldest first) since the last flush. Logged at most once a minute per channel.
    const dropped = Number(msg.dropped);
    if (Number.isFinite(dropped) && dropped > 0) {
      const now = Date.now();
      if (!conn.droppedWarnedAt || now - conn.droppedWarnedAt >= 60_000) {
        conn.droppedWarnedAt = now;
        logger.warn({ deviceUuid: conn.deviceUuid, dropped }, 'Agent event queue overflowed: events dropped');
      }
    }
    if (events.length === 0) return;

    // Resolve device ID if not yet cached (first flush before any heartbeat)
    if (!conn.deviceId) {
      try {
        const row = await db('agent_devices')
          .where({ uuid: conn.deviceUuid, tenant_id: conn.tenantId })
          .select('id', 'status')
          .first() as { id: number; status: string } | undefined;
        if (!(row && row.status === 'approved')) return;
        conn.deviceId = row.id;
      } catch {
        return;
      }
    }

    await agentService.processEventsFlush(conn.deviceId, conn.tenantId, events);
  }

  /**
   * Push a command to a connected agent instantly over the WS channel.
   * Returns true if delivered, false if the agent is currently offline
   * (caller should fall back to agent_devices.pending_command in the DB).
   */
  push(deviceUuid: string, cmd: OrCommand): boolean {
    const conn = this.byDevice.get(deviceUuid);
    if (!conn || conn.closing || conn.ws.readyState !== 1) return false;
    try {
      conn.ws.send(JSON.stringify(cmd));
      return true;
    } catch {
      this._unregister(deviceUuid, conn.ws);
      return false;
    }
  }

  // ── Firewall command: push and wait for response ─────────────────────────

  private firewallWaiters = new Map<string, FirewallWaiter>();

  async pushAndWait(deviceUuid: string, cmd: OrCommand, timeoutMs = 30000): Promise<unknown> {
    // The waiter (bound to the target device) is registered BEFORE the push, so
    // an immediate answer is never lost and only that device can resolve it.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.firewallWaiters.delete(cmd.id);
        logger.warn({ deviceUuid, cmdId: cmd.id }, 'pushAndWait: TIMEOUT after ' + (timeoutMs / 1000) + 's');
        reject(new Error('Agent did not respond within ' + (timeoutMs / 1000) + 's'));
      }, timeoutMs);
      this.firewallWaiters.set(cmd.id, { resolve, reject, timer, deviceUuid });

      if (!this.push(deviceUuid, cmd)) {
        clearTimeout(timer);
        this.firewallWaiters.delete(cmd.id);
        reject(new Error('Agent is not connected'));
        return;
      }
      logger.info({ deviceUuid, cmdType: cmd.type, cmdId: cmd.id }, 'pushAndWait: command sent, awaiting response');
    });
  }

  private _resolveFirewallResponse(conn: ObliguardConn, msg: { id?: unknown; [k: string]: unknown }): void {
    if (typeof msg.id !== 'string' || msg.id.length > 64) {
      logger.warn('Firewall response without a valid id — ignoring');
      return;
    }
    const waiter = this.firewallWaiters.get(msg.id);
    if (!waiter) {
      logger.warn({ msgId: msg.id }, 'Firewall response for unknown/expired waiter');
      return;
    }
    if (waiter.deviceUuid !== conn.deviceUuid) {
      logger.warn(
        { msgId: msg.id, expectedUuid: waiter.deviceUuid, fromUuid: conn.deviceUuid },
        'Firewall response from another device — ignored',
      );
      return;
    }
    logger.info({ msgId: msg.id, success: msg.success }, 'pushAndWait: response received');
    clearTimeout(waiter.timer);
    this.firewallWaiters.delete(msg.id);
    waiter.resolve(msg);
  }

  isConnected(deviceUuid: string): boolean {
    const conn = this.byDevice.get(deviceUuid);
    if (conn && conn.ws.readyState === 1) return true;
    // During grace period, report as still connected to avoid UI flicker
    return this.offlineTimers.has(deviceUuid);
  }
}

export const obliguardHub = new ObliguardHubService();
