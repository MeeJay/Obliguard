import type { WebSocket } from 'ws';
import { db } from '../db';
import { logger } from '../utils/logger';
import { agentService, getAgentServiceIO } from './agent.service';
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

// ── Service ───────────────────────────────────────────────────────────────────

export class ObliguardHubService {
  /** deviceUuid → active connection */
  private byDevice = new Map<string, ObliguardConn>();
  /** deviceUuid → pending offline timer (cleared if agent reconnects before expiry) */
  private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** A socket that sends no heartbeat within this delay is closed (4008). Tests may lower it. */
  firstHeartbeatDeadlineMs = 60_000;

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
   * Drains a queued 'uninstall' on connect (approved devices only).
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
    };
    this.byDevice.set(deviceUuid, conn);

    ws.on('close', () => this._unregister(deviceUuid, ws));
    ws.on('error', () => this._unregister(deviceUuid, ws));
    ws.on('message', async (data: Buffer) => {
      if (conn.closing || ws.readyState !== 1) return;
      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          case 'heartbeat': await this._handleHeartbeat(conn, msg); break;
          case 'events':    await this._handleEventsFlush(conn, msg); break;
          case 'firewall_response': this._resolveFirewallResponse(conn, msg); break;
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

    // Drain a queued 'uninstall' on connect (other commands wait for the heartbeat)
    await this._drainPendingCommand(conn);

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
      if (deviceId) {
        this._startOfflineTimer(deviceUuid, deviceId);
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

  /** Close the live channel of a device (suspend / refuse / delete). */
  disconnectDevice(uuid: string, reason: string): number {
    return this.disconnectWhere((c) => c.deviceUuid === uuid, 4003, reason);
  }

  /**
   * Start a delayed offline notification. The delay = checkIntervalSeconds × maxMissedPushes
   * resolved from the device's settings (group → global → defaults).
   * This absorbs brief WS reconnections without flashing the UI red.
   */
  private async _startOfflineTimer(deviceUuid: string, deviceId: number): Promise<void> {
    // Resolve the device's effective settings for the grace period
    let delaySec = 60 * 2; // fallback: 2 minutes
    try {
      const device = await agentService.getDeviceById(deviceId);
      if (device) {
        const cis = device.resolvedSettings?.checkIntervalSeconds ?? 60;
        const mmp = device.resolvedSettings?.maxMissedPushes ?? 2;
        delaySec = cis * mmp;
      }
    } catch { /* use fallback */ }

    const timer = setTimeout(() => {
      this.offlineTimers.delete(deviceUuid);
      // Only emit if the agent hasn't reconnected
      if (!this.isConnected(deviceUuid)) {
        const io = getAgentServiceIO();
        if (io) {
          logger.info({ deviceUuid, deviceId }, 'Obliguard agent offline grace period expired');
          io.to('role:admin').emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
            deviceId,
            status: 'down',
            wsConnected: false,
          });
        }
      }
    }, delaySec * 1000);

    this.offlineTimers.set(deviceUuid, timer);
  }

  /**
   * On connect: cache the device id of an APPROVED device and deliver a queued
   * 'uninstall'. Other commands (e.g. 'update') are delivered by the next
   * heartbeat's handlePush, with latestVersion. The conditional UPDATE prevents
   * a double delivery racing handlePush; uninstall_commanded_at lets
   * cleanupUninstalledDevices remove the device.
   */
  private async _drainPendingCommand(conn: ObliguardConn): Promise<void> {
    try {
      const row = await db('agent_devices')
        .where({ uuid: conn.deviceUuid, tenant_id: conn.tenantId })
        .first('id', 'status', 'pending_command') as
        { id: number; status: string; pending_command: string | null } | undefined;

      if (!row || row.status !== 'approved') return;

      // Cache the device ID for later use
      conn.deviceId = row.id;

      if (row.pending_command !== 'uninstall') return;

      const n = await db('agent_devices')
        .where({ id: row.id, pending_command: 'uninstall' })
        .update({ pending_command: null, uninstall_commanded_at: new Date(), updated_at: new Date() });

      if (n === 1 && conn.ws.readyState === 1 && !conn.closing) {
        conn.ws.send(JSON.stringify({ type: 'config', command: 'uninstall' }));
      }
    } catch (e) {
      logger.error(e, 'obliguardHub: failed to drain pending command');
    }
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
      };

      const response = await agentService.handlePush(
        conn.apiKeyId,
        conn.tenantId,
        conn.deviceUuid,
        conn.clientIp,
        body,
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

      if (conn.ws.readyState === 1 && !conn.closing) {
        conn.ws.send(JSON.stringify(configMsg));
      }
    } catch (e) {
      logger.error(e, 'obliguardHub: heartbeat handling failed');
    }
  }

  /**
   * Handle an events-flush frame: `{ type: "events", events: [...] }`.
   * Processes only the events pipeline (enrichment, insert, reputation,
   * threat detection, Starmap emit) — no ban/config overhead.
   * processEventsFlush re-validates approval + tenant on every flush.
   */
  private async _handleEventsFlush(conn: ObliguardConn, msg: any): Promise<void> {
    const events: AgentIpEvent[] = Array.isArray(msg.events) ? msg.events : [];
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
