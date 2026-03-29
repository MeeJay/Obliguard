/**
 * MikroTik Log Poller Service.
 *
 * Periodically polls MikroTik log entries via the RouterOS API and injects
 * auth events (login failures, denied connections, successful logins) into
 * Obliguard's event pipeline.
 *
 * This replaces the need for syslog (UDP or HTTP push) — the server pulls
 * logs directly from the MikroTik using the already-configured API connection.
 *
 * Flow:
 *   1. Every 30s, iterate all approved MikroTik devices
 *   2. Connect via RouterOS API and run /log/print
 *   3. Compare entry IDs with last known state to detect new entries
 *   4. Parse new entries with the syslog parser
 *   5. Inject events into processEventsFlush()
 */

import crypto from 'crypto';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { createRouterOSClient } from './routerosClient';
import { parseMikroTikSyslog } from './syslogParser';
import { decryptSecret } from '../../utils/crypto';
import type { AgentIpEvent } from '@obliview/shared';

const POLL_INTERVAL_MS = 30_000; // 30 seconds

// Cache: deviceId → Set of last known log entry IDs (to detect new entries)
const lastSeenIds = new Map<number, Set<string>>();

let pollTimer: ReturnType<typeof setInterval> | null = null;

interface PollDevice {
  deviceId: number;
  tenantId: number;
  apiHost: string;
  apiPort: number;
  apiUseTls: boolean;
  apiUsername: string;
  apiPasswordEnc: string;
}

async function getDevicesToPoll(): Promise<PollDevice[]> {
  const rows = await db('mikrotik_credentials')
    .join('agent_devices', 'agent_devices.id', 'mikrotik_credentials.device_id')
    .where('agent_devices.status', 'approved')
    .where('agent_devices.device_type', 'mikrotik')
    .select(
      'agent_devices.id as device_id',
      'agent_devices.tenant_id',
      'mikrotik_credentials.api_host',
      'mikrotik_credentials.api_port',
      'mikrotik_credentials.api_use_tls',
      'mikrotik_credentials.api_username',
      'mikrotik_credentials.api_password_enc',
    );

  return rows.map((r) => ({
    deviceId: r.device_id,
    tenantId: r.tenant_id,
    apiHost: r.api_host,
    apiPort: r.api_port,
    apiUseTls: r.api_use_tls,
    apiUsername: r.api_username,
    apiPasswordEnc: r.api_password_enc,
  }));
}

async function pollDevice(device: PollDevice): Promise<void> {
  let password: string;
  try {
    password = decryptSecret(device.apiPasswordEnc);
  } catch {
    logger.warn({ deviceId: device.deviceId }, 'MikroTik log poll: cannot decrypt password');
    return;
  }

  let client;
  try {
    client = await createRouterOSClient({
      host: device.apiHost,
      port: device.apiPort,
      useTls: device.apiUseTls,
      username: device.apiUsername,
      password,
    });
  } catch (err) {
    logger.warn({ err, deviceId: device.deviceId }, 'MikroTik log poll: connection failed');
    await db('mikrotik_credentials').where('device_id', device.deviceId).update({
      last_api_error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return;
  }

  try {
    // Fetch all log entries (RouterOS keeps a circular buffer, typically 1000 entries)
    const entries = await client.getLogEntries();

    // Get or initialize the seen-IDs set for this device
    let seenIds = lastSeenIds.get(device.deviceId);
    if (!seenIds) {
      // First poll: seed with all current IDs, don't process (avoid replaying the entire log)
      seenIds = new Set(entries.map((e) => e.id));
      lastSeenIds.set(device.deviceId, seenIds);
      logger.info(
        { deviceId: device.deviceId, count: seenIds.size },
        'MikroTik log poll: seeded cache (first poll)',
      );

      // Update timestamps to mark as online
      await db('mikrotik_credentials').where('device_id', device.deviceId).update({
        last_api_connected_at: new Date(),
        last_syslog_at: new Date(),
        last_api_error: null,
      });
      const { markMikrotikSeen } = await import('../agent.service');
      markMikrotikSeen(device.deviceId);
      return;
    }

    // Find new entries (entries not in the seen set)
    const newEntries = entries.filter((e) => !seenIds!.has(e.id));

    // Update the seen set with all current IDs
    const currentIds = new Set(entries.map((e) => e.id));
    lastSeenIds.set(device.deviceId, currentIds);

    if (newEntries.length === 0) {
      // Still update timestamps to keep "online" status
      await db('mikrotik_credentials').where('device_id', device.deviceId).update({
        last_api_connected_at: new Date(),
        last_syslog_at: new Date(),
        last_api_error: null,
      });
      const { markMikrotikSeen } = await import('../agent.service');
      markMikrotikSeen(device.deviceId);
      return;
    }

    // Parse new entries
    const events: AgentIpEvent[] = [];
    for (const entry of newEntries) {
      const parsed = parseMikroTikSyslog(entry.message);
      if (!parsed) continue;
      events.push({
        id: `${crypto.randomUUID()}-${Date.now()}`,
        ip: parsed.ip,
        username: parsed.username,
        service: parsed.service,
        eventType: parsed.eventType,
        timestamp: new Date().toISOString(),
        rawLog: `[${entry.time}] ${entry.topics} ${entry.message}`,
      });
    }

    // Inject events into the standard pipeline
    if (events.length > 0) {
      const { agentService } = await import('../agent.service');
      await agentService.processEventsFlush(device.deviceId, device.tenantId, events);
      logger.info(
        { deviceId: device.deviceId, newLogs: newEntries.length, events: events.length },
        'MikroTik log poll: new events detected',
      );
    }

    // Update timestamps
    await db('mikrotik_credentials').where('device_id', device.deviceId).update({
      last_api_connected_at: new Date(),
      last_syslog_at: new Date(),
      last_api_error: null,
    });
    const { markMikrotikSeen } = await import('../agent.service');
    markMikrotikSeen(device.deviceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, deviceId: device.deviceId }, `MikroTik log poll failed: ${msg}`);
    await db('mikrotik_credentials').where('device_id', device.deviceId).update({
      last_api_error: msg,
    }).catch(() => {});
  } finally {
    client.close();
  }
}

async function runPollCycle(): Promise<void> {
  try {
    const devices = await getDevicesToPoll();
    if (devices.length === 0) return;
    for (const device of devices) {
      await pollDevice(device);
    }
  } catch (err) {
    logger.warn({ err }, 'MikroTik log poll: cycle error');
  }
}

export const mikrotikLogPoller = {
  start(): void {
    if (pollTimer) return;
    logger.info(`MikroTik log poller started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
    setTimeout(() => runPollCycle(), 5_000);
    pollTimer = setInterval(() => runPollCycle(), POLL_INTERVAL_MS);
  },

  stop(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },

  /** Clear the cache for a device (e.g., after reconfiguration). */
  clearCache(deviceId?: number): void {
    if (deviceId) {
      lastSeenIds.delete(deviceId);
    } else {
      lastSeenIds.clear();
    }
  },
};
