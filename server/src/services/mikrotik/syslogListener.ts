/**
 * MikroTik Syslog UDP Listener.
 *
 * Listens on a configurable UDP port (default 5514) for syslog messages from
 * MikroTik routers. Incoming packets are routed to the correct MikroTik device
 * record via the source IP (syslog_identifier in mikrotik_credentials).
 *
 * Parsed auth events are injected into the standard ip_events pipeline via
 * agentService.processEventsFlush(), so they flow through the same ban engine,
 * IP reputation, and notification system as regular agent events.
 */

import dgram from 'dgram';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { parseMikroTikSyslog } from './syslogParser';
import type { AgentIpEvent } from '@obliview/shared';

interface DeviceMapping {
  deviceId: number;
  tenantId: number;
  cachedAt: number;
}

// Cache syslog_identifier → device mapping (60s TTL to avoid per-packet DB queries)
const deviceCache = new Map<string, DeviceMapping | null>();
const CACHE_TTL_MS = 60_000;

// Rate limiting: max events per source IP per second
const RATE_LIMIT_PER_SEC = 100;
const rateCounts = new Map<string, { count: number; resetAt: number }>();

let server: dgram.Socket | null = null;

async function lookupDevice(sourceIp: string): Promise<DeviceMapping | null> {
  const now = Date.now();
  const cached = deviceCache.get(sourceIp);
  if (cached !== undefined && (cached === null || now - cached.cachedAt < CACHE_TTL_MS)) {
    return cached;
  }

  const row = await db('mikrotik_credentials')
    .join('agent_devices', 'agent_devices.id', 'mikrotik_credentials.device_id')
    .where('mikrotik_credentials.syslog_identifier', sourceIp)
    .where('agent_devices.status', 'approved')
    .select('agent_devices.id as device_id', 'agent_devices.tenant_id')
    .first() as { device_id: number; tenant_id: number } | undefined;

  if (!row) {
    deviceCache.set(sourceIp, null);
    return null;
  }

  const mapping: DeviceMapping = {
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    cachedAt: now,
  };
  deviceCache.set(sourceIp, mapping);
  return mapping;
}

function isRateLimited(sourceIp: string): boolean {
  const now = Date.now();
  let entry = rateCounts.get(sourceIp);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 1000 };
    rateCounts.set(sourceIp, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT_PER_SEC;
}

function updateLastSyslog(deviceId: number): void {
  db('mikrotik_credentials')
    .where('device_id', deviceId)
    .update({ last_syslog_at: db.fn.now() })
    .catch((err) => logger.warn({ err, deviceId }, 'syslog: failed to update last_syslog_at'));
}

export const syslogListener = {
  start(): void {
    const port = config.syslogPort;
    if (port <= 0) {
      logger.info('MikroTik syslog listener disabled (SYSLOG_PORT=0)');
      return;
    }

    server = dgram.createSocket('udp4');

    server.on('message', async (msg, rinfo) => {
      const sourceIp = rinfo.address;

      if (isRateLimited(sourceIp)) return;

      const raw = msg.toString('utf-8').trim();
      if (!raw) return;

      const parsed = parseMikroTikSyslog(raw);
      if (!parsed) return; // Not an auth-related message

      try {
        const device = await lookupDevice(sourceIp);
        if (!device) return; // Unknown source — no registered MikroTik at this IP

        // Update syslog timestamp (for online/offline detection)
        updateLastSyslog(device.deviceId);
        const { markMikrotikSeen } = await import('../agent.service');
        markMikrotikSeen(device.deviceId);

        // Build AgentIpEvent
        const event: AgentIpEvent = {
          id: `${uuidv4()}-${Date.now()}`,
          ip: parsed.ip,
          username: parsed.username,
          service: parsed.service,
          eventType: parsed.eventType,
          timestamp: new Date().toISOString(),
          rawLog: parsed.rawLog,
        };

        // Inject into the standard event pipeline
        const { agentService } = await import('../agent.service');
        await agentService.processEventsFlush(device.deviceId, device.tenantId, [event]);
      } catch (err) {
        logger.warn({ err, sourceIp }, 'syslog: error processing MikroTik message');
      }
    });

    server.on('error', (err) => {
      logger.error({ err }, `MikroTik syslog listener error on port ${port}`);
      server?.close();
    });

    server.bind(port, () => {
      logger.info(`MikroTik syslog listener started on UDP port ${port}`);
    });
  },

  stop(): void {
    server?.close();
    server = null;
  },

  /** Invalidate the device cache (e.g. after adding/removing a MikroTik device). */
  invalidateCache(): void {
    deviceCache.clear();
  },
};
