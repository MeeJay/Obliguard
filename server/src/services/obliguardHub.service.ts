import type { WebSocket } from 'ws';
import { db } from '../db';
import { logger } from '../utils/logger';
import { agentService, getAgentServiceIO } from './agent.service';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { AgentIpEvent, ObliguardPushBody } from '@obliview/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ObliguardConn {
  ws: WebSocket;
  deviceUuid: string;
  /** DB row ID — null until first heartbeat resolves the device */
  deviceId: number | null;
  tenantId: number;
  apiKeyId: number;
  /** Cached client IP (from WS upgrade headers) */
  clientIp: string;
}

/** Command pushed from server → agent on the WS channel */
export interface OrCommand {
  type: string;
  id: string;
  payload: Record<string, unknown>;
}

// ── Service ───────────────────────────────────────────────────────────────────

class ObliguardHubService {
  /** deviceUuid → active connection */
  private byDevice = new Map<string, ObliguardConn>();
  /** deviceUuid → pending offline timer (cleared if agent reconnects before expiry) */
  private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    // Ping every 15 s to keep the connection alive through reverse proxies.
    setInterval(() => {
      for (const [uuid, conn] of this.byDevice) {
        if (conn.ws.readyState === 1 /* OPEN */) {
          try { (conn.ws as any).ping(); } catch { this._unregister(uuid, conn.ws); }
        }
      }
    }, 15_000);
  }

  /**
   * Register an Obliguard agent command-channel WebSocket.
   * Replaces any existing connection for the same device UUID.
   * Drains any pending_command queued in the DB immediately on connect.
   */
  async register(
    deviceUuid: string,
    tenantId: number,
    apiKeyId: number,
    clientIp: string,
    ws: WebSocket,
  ): Promise<void> {
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
    };
    this.byDevice.set(deviceUuid, conn);

    ws.on('close', () => this._unregister(deviceUuid, ws));
    ws.on('error', () => this._unregister(deviceUuid, ws));
    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          case 'heartbeat': await this._handleHeartbeat(conn, msg); break;
          case 'events':    await this._handleEventsFlush(conn, msg); break;
          default:          break; // unknown message type — ignore
        }
      } catch { /* malformed JSON */ }
    });

    // Drain pending DB command on connect (delivers commands queued while offline)
    await this._drainPendingCommand(conn);

    logger.info({ deviceUuid, tenantId }, 'Obliguard agent command channel connected');
  }

  private _unregister(deviceUuid: string, ws: WebSocket): void {
    const existing = this.byDevice.get(deviceUuid);
    if (existing?.ws === ws) {
      const deviceId = existing.deviceId;
      this.byDevice.delete(deviceUuid);
      logger.info({ deviceUuid }, 'Obliguard agent command channel disconnected');

      // Start an offline grace timer based on the device's resolved settings.
      // If the agent reconnects before the timer fires, register() cancels it.
      if (deviceId) {
        this._startOfflineTimer(deviceUuid, deviceId);
      }
    }
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
   * Drain any command queued in agent_devices.pending_command while the agent
   * was offline. Clears the DB record before sending to prevent re-delivery.
   */
  private async _drainPendingCommand(conn: ObliguardConn): Promise<void> {
    try {
      const row = await db('agent_devices')
        .where({ uuid: conn.deviceUuid, tenant_id: conn.tenantId })
        .select('id', 'pending_command')
        .first() as { id: number; pending_command: string | null } | undefined;

      if (!row) return;

      // Cache the device ID for later use
      conn.deviceId = row.id;

      if (!row.pending_command) return;

      // Clear before delivering
      await db('agent_devices').where({ id: row.id }).update({ pending_command: null });

      if (conn.ws.readyState === 1) {
        conn.ws.send(JSON.stringify({ type: 'config', command: row.pending_command }));
      }
    } catch (e) {
      logger.error(e, 'obliguardHub: failed to drain pending command');
    }
  }

  /**
   * Handle a heartbeat message from an Obliguard agent.
   * Calls the full handlePush pipeline (updates metadata, resolves ban delta,
   * service configs, etc.) and sends a `{ type: "config", ... }` response.
   */
  private async _handleHeartbeat(conn: ObliguardConn, msg: any): Promise<void> {
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

      // Cache resolved device ID so events-flush path can use it without a DB lookup
      if (!conn.deviceId) {
        const row = await db('agent_devices')
          .where({ uuid: conn.deviceUuid, tenant_id: conn.tenantId })
          .select('id')
          .first() as { id: number } | undefined;
        if (row) conn.deviceId = row.id;
      }

      if (response.status === 'pending' || response.status === 'refused') {
        // Don't send config to non-approved agents
        return;
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

      if (conn.ws.readyState === 1) {
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
   * Latency: typically <500 ms from event occurrence to Starmap update.
   */
  private async _handleEventsFlush(conn: ObliguardConn, msg: any): Promise<void> {
    const events: AgentIpEvent[] = msg.events ?? [];
    if (events.length === 0) return;

    // Resolve device ID if not yet cached (first flush before any heartbeat)
    if (!conn.deviceId) {
      try {
        const row = await db('agent_devices')
          .where({ uuid: conn.deviceUuid, tenant_id: conn.tenantId })
          .select('id', 'status')
          .first() as { id: number; status: string } | undefined;
        if (!row || row.status === 'pending' || row.status === 'refused') return;
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
    if (!conn || conn.ws.readyState !== 1) return false;
    try {
      conn.ws.send(JSON.stringify(cmd));
      return true;
    } catch {
      this._unregister(deviceUuid, conn.ws);
      return false;
    }
  }

  isConnected(deviceUuid: string): boolean {
    const conn = this.byDevice.get(deviceUuid);
    if (conn && conn.ws.readyState === 1) return true;
    // During grace period, report as still connected to avoid UI flicker
    return this.offlineTimers.has(deviceUuid);
  }
}

export const obliguardHub = new ObliguardHubService();
