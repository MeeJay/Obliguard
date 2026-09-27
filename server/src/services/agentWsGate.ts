/**
 * Pre-upgrade gate of the agent WebSocket command channel (A5).
 *
 * The agent's wsConnect fails on any non-101 status and backs off ×1.5 up to
 * 60 s (agent/websocket.go), whereas a close frame after the upgrade makes it
 * reconnect every 2 s (agent/cmd_ws.go). So every refusal is decided BEFORE
 * agentWss.handleUpgrade and answered with a plain HTTP status
 * (400/401/403/429/503). Mirrors Obliance's pre-upgrade verdict + rejectUpgrade.
 *
 * Later lots edit this file rather than index.ts: B3-4 (clientIp) edits
 * checkAgentUpgrade, D6 (maxPayload) the WebSocketServer construction below.
 */
import type http from 'http';
import { STATUS_CODES } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { db } from '../db';
import { logger } from '../utils/logger';
import { isAgentApiKeyFormat, isDeviceUuidFormat } from '../utils/agentIdentity';
import { agentService, warnBindingRefused, AGENT_MAX_PENDING_PER_KEY } from './agent.service';
import { obliguardHub } from './obliguardHub.service';

export type AgentUpgradeVerdict =
  | { ok: true; apiKeyId: number; tenantId: number; deviceUuid: string; clientIp: string; rowless: boolean }
  | { ok: false; status: 400 | 401 | 403 | 429 | 503; reason: string };

const OBLIGUARD_AGENT_WS_RE = /^\/api\/agent\/ws$/;

export async function checkAgentUpgrade(request: IncomingMessage): Promise<AgentUpgradeVerdict> {
  const apiKey = request.headers['x-api-key'];
  if (apiKey === undefined || apiKey === '') return { ok: false, status: 401, reason: 'Missing X-Api-Key' };
  if (!isAgentApiKeyFormat(apiKey)) return { ok: false, status: 400, reason: 'Invalid X-Api-Key' };

  const devUuid = new URL(request.url ?? '/', 'http://localhost').searchParams.get('uuid');
  if (!isDeviceUuidFormat(devUuid)) return { ok: false, status: 400, reason: 'Invalid uuid query param' };

  const keyRow = await db('agent_api_keys').where({ key: apiKey }).first('id', 'tenant_id') as
    { id: number; tenant_id: number } | undefined;
  if (!keyRow) return { ok: false, status: 401, reason: 'Invalid API key' };

  // Any use of a valid key is recorded (throttled): 'Last used' becomes a real signal.
  agentService.touchApiKeyUsage(keyRow.id);

  if (obliguardHub.hasLiveConflict(devUuid, keyRow.tenant_id, keyRow.id)) {
    warnBindingRefused({
      deviceUuid: devUuid, deviceId: null, apiKeyId: keyRow.id, keyTenantId: keyRow.tenant_id,
      deviceTenantId: null, boundKeyId: null, deviceType: null, via: 'ws-live',
    });
    return { ok: false, status: 403, reason: 'Device already connected with another API key' };
  }

  // checkAgentBinding never claims/re-binds a suspended or refused row (pure verdict).
  const v = await agentService.checkAgentBinding({ id: keyRow.id, tenant_id: keyRow.tenant_id }, devUuid);
  if (!v.ok) {
    warnBindingRefused({
      deviceUuid: devUuid, deviceId: v.device.id, apiKeyId: keyRow.id, keyTenantId: keyRow.tenant_id,
      deviceTenantId: v.device.tenant_id, boundKeyId: v.device.api_key_id, deviceType: v.device.device_type, via: 'ws',
    });
    return { ok: false, status: 403, reason: 'Device/API-key mismatch' };
  }

  // Pending devices are accepted: they heartbeat, but get no config, events or commands.
  if (v.device && (v.device.status === 'suspended' || v.device.status === 'refused')) {
    return { ok: false, status: 403, reason: `Device ${v.device.status}` };
  }

  // Row-less connections are bounded by the same per-key pending cap: pending
  // rows + live sockets still waiting for their first heartbeat.
  if (!v.device && AGENT_MAX_PENDING_PER_KEY > 0
    && (await agentService.countPendingForKey(keyRow.id)) + obliguardHub.countRowlessForKey(keyRow.id)
      >= AGENT_MAX_PENDING_PER_KEY) {
    return { ok: false, status: 429, reason: 'Enrolment deferred: pending device cap reached' };
  }

  // B3-4 replaces this with utils/clientIp
  const clientIp =
    (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ??
    request.socket.remoteAddress ??
    '';

  return { ok: true, apiKeyId: keyRow.id, tenantId: keyRow.tenant_id, deviceUuid: devUuid, clientIp, rowless: !v.device };
}

/** Answer a plain HTTP status on a not-yet-upgraded socket, then close it. */
export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  const body = reason || STATUS_CODES[status] || 'Error';
  // Keep a listener: a peer reset while we write must not crash the process.
  socket.on('error', () => socket.destroy());
  socket.once('finish', () => socket.destroy());
  try {
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + '\r\n'
      + body,
    );
  } catch {
    socket.destroy();
  }
}

export function handleAgentUpgrade(agentWss: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const onEarlyError = () => { try { socket.destroy(); } catch { /* ignore */ } };
  // Node removed the http server's socketOnError before emitting 'upgrade':
  // without this, an ECONNRESET during the DB awaits is an unhandled 'error'
  // → uncaughtException → process.exit(1) (index.ts safety net).
  socket.on('error', onEarlyError);
  void (async () => {
    let v: AgentUpgradeVerdict;
    try {
      v = await checkAgentUpgrade(request);
    } catch (err) {
      logger.error({ err }, 'Obliguard agent WS gate error');
      v = { ok: false, status: 503, reason: 'Internal error' };
    }
    if (socket.destroyed) return;
    if (!v.ok) { rejectUpgrade(socket, v.status, v.reason); return; }
    const ok = v;
    socket.removeListener('error', onEarlyError); // ws.handleUpgrade attaches its own socketOnError first thing
    agentWss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      obliguardHub.register(ok.deviceUuid, ok.tenantId, ok.apiKeyId, ok.clientIp, ws, { rowless: ok.rowless }).catch((err) => {
        logger.error({ err }, 'Obliguard agent WS register error');
        try { ws.close(1011, 'Internal error'); } catch { /* ignore */ }
      });
    });
  })();
}

/**
 * Take over the server's 'upgrade' routing: /api/agent/ws goes through the
 * agent gate, everything else to the upgrade listeners already attached
 * (Socket.io). Call AFTER createSocketServer(server). Returns the agent
 * WebSocketServer (closed by index.ts on shutdown).
 */
export function attachAgentWebSocket(server: http.Server): WebSocketServer {
  const agentWss = new WebSocketServer({ noServer: true });

  const sioUpgradeListeners = server.rawListeners('upgrade').slice();
  server.removeAllListeners('upgrade');

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '/';
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; } catch { /* malformed: not ours */ }

    if (OBLIGUARD_AGENT_WS_RE.test(pathname)) {
      handleAgentUpgrade(agentWss, request, socket, head);
      return; // handled — do NOT forward to socket.io
    }

    // Forward everything else to socket.io's original upgrade listeners
    for (const listener of sioUpgradeListeners) {
      (listener as (...args: unknown[]) => void).call(server, request, socket, head);
    }
  });

  return agentWss;
}
