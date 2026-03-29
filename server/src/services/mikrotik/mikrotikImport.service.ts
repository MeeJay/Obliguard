/**
 * MikroTik Address-List Import Service.
 *
 * Periodically polls MikroTik address-lists (e.g. "blacklist", "honeypot") via
 * the RouterOS API and imports new IPs as global auto-bans in Obliguard.
 *
 * This enables bidirectional sync: MikroTik honeypot/trap rules that add IPs
 * to address-lists on a single router get propagated as bans to ALL agents
 * (including other MikroTik devices, OPNsense, Linux, Windows).
 *
 * Flow:
 *   1. Every 60s, iterate all MikroTik devices with import_address_lists set
 *   2. Connect via RouterOS API and fetch each configured address-list
 *   3. Compare with last known state (in-memory cache)
 *   4. New IPs → create global auto-ban + ip_event (auth_failure)
 *   5. Ban engine propagates to all agents via existing mechanisms
 */

import { db } from '../../db';
import { logger } from '../../utils/logger';
import { createRouterOSClient } from './routerosClient';
import { decryptSecret } from '../../utils/crypto';
import { mikrotikBanSync } from './mikrotikBanSync.service';

const POLL_INTERVAL_MS = 60_000; // 60 seconds

// Cache: deviceId → Set of known IPs per list (to detect new additions)
const knownIPs = new Map<string, Set<string>>(); // key: "deviceId:listName"

let pollTimer: ReturnType<typeof setInterval> | null = null;

function cacheKey(deviceId: number, listName: string): string {
  return `${deviceId}:${listName}`;
}

interface ImportDevice {
  deviceId: number;
  tenantId: number;
  apiHost: string;
  apiPort: number;
  apiUseTls: boolean;
  apiUsername: string;
  apiPasswordEnc: string;
  importLists: string[];
}

async function getImportDevices(): Promise<ImportDevice[]> {
  const rows = await db('mikrotik_credentials')
    .join('agent_devices', 'agent_devices.id', 'mikrotik_credentials.device_id')
    .where('agent_devices.status', 'approved')
    .where('agent_devices.device_type', 'mikrotik')
    .whereNotNull('mikrotik_credentials.import_address_lists')
    .select(
      'agent_devices.id as device_id',
      'agent_devices.tenant_id',
      'mikrotik_credentials.api_host',
      'mikrotik_credentials.api_port',
      'mikrotik_credentials.api_use_tls',
      'mikrotik_credentials.api_username',
      'mikrotik_credentials.api_password_enc',
      'mikrotik_credentials.import_address_lists',
    );

  return rows
    .filter((r) => r.import_address_lists && r.import_address_lists.trim())
    .map((r) => ({
      deviceId: r.device_id,
      tenantId: r.tenant_id,
      apiHost: r.api_host,
      apiPort: r.api_port,
      apiUseTls: r.api_use_tls,
      apiUsername: r.api_username,
      apiPasswordEnc: r.api_password_enc,
      importLists: (r.import_address_lists as string).split(',').map((s: string) => s.trim()).filter(Boolean),
    }));
}

async function pollDevice(device: ImportDevice): Promise<void> {
  let password: string;
  try {
    password = decryptSecret(device.apiPasswordEnc);
  } catch {
    logger.warn({ deviceId: device.deviceId }, 'MikroTik import: cannot decrypt password');
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
    logger.warn({ err, deviceId: device.deviceId }, 'MikroTik import: connection failed');
    return;
  }

  try {
    for (const listName of device.importLists) {
      const key = cacheKey(device.deviceId, listName);
      const currentIPs = await client.getBannedIPs(listName);
      const currentSet = new Set(currentIPs);

      const previousSet = knownIPs.get(key);
      if (!previousSet) {
        // First poll — seed the cache, don't import existing entries
        // (avoid importing the entire existing blacklist on first startup)
        knownIPs.set(key, currentSet);
        logger.info(
          { deviceId: device.deviceId, list: listName, count: currentSet.size },
          'MikroTik import: seeded cache (first poll, no import)',
        );
        continue;
      }

      // Find newly added IPs
      const newIPs: string[] = [];
      for (const ip of currentSet) {
        if (!previousSet.has(ip)) {
          newIPs.push(ip);
        }
      }

      // Update cache
      knownIPs.set(key, currentSet);

      if (newIPs.length === 0) continue;

      logger.info(
        { deviceId: device.deviceId, list: listName, newIPs: newIPs.length },
        'MikroTik import: new IPs detected in address-list',
      );

      // Import each new IP as a global auto-ban
      for (const ip of newIPs) {
        await importIPAsBan(ip, listName, device);
      }
    }

    // Update last connected timestamp
    await db('mikrotik_credentials').where('device_id', device.deviceId).update({
      last_api_connected_at: new Date(),
      last_api_error: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, deviceId: device.deviceId }, `MikroTik import poll failed: ${msg}`);
    await db('mikrotik_credentials').where('device_id', device.deviceId).update({
      last_api_error: msg,
    }).catch(() => {});
  } finally {
    client.close();
  }
}

async function importIPAsBan(
  ip: string,
  listName: string,
  device: ImportDevice,
): Promise<void> {
  // Skip if already actively banned
  const existingBan = await db('ip_bans')
    .where({ ip, is_active: true })
    .first();
  if (existingBan) return;

  // Skip if whitelisted (use deviceId=0 and empty groupIds since this is a global import)
  const { whitelistService } = await import('../whitelist.service');
  const isWhitelisted = await whitelistService.isWhitelisted(ip, device.deviceId, [], device.tenantId);
  if (isWhitelisted) return;

  // Create a global auto-ban
  const reason = `MikroTik import: detected in "${listName}" address-list`;
  await db('ip_bans').insert({
    ip,
    scope: 'global',
    ban_type: 'auto',
    origin_tenant_id: device.tenantId,
    reason,
    is_active: true,
  });

  // Also insert an ip_event so it shows up in the event log
  const crypto = await import('crypto');
  await db('ip_events').insert({
    id: `${crypto.randomUUID()}-${Date.now()}`,
    ip,
    username: '',
    service: `mikrotik_import:${listName}`,
    event_type: 'auth_failure',
    raw_log: reason,
    device_id: device.deviceId,
    tenant_id: device.tenantId,
    source_ip_type: 'public',
    timestamp: new Date(),
  });

  // Ensure IP reputation entry exists
  try {
    const { ipReputationService } = await import('../ipReputation.service');
    await ipReputationService.ensureExists(ip);
  } catch { /* non-fatal */ }

  logger.info({ ip, list: listName, deviceId: device.deviceId }, 'MikroTik import: created auto-ban');

  // Propagate ban to all MikroTik devices (so the IP is blocked everywhere)
  await mikrotikBanSync.pushBanToAll(ip, 'ban').catch(() => {});
}

async function runPollCycle(): Promise<void> {
  try {
    const devices = await getImportDevices();
    if (devices.length === 0) return;

    // Poll devices sequentially to avoid overwhelming the network
    for (const device of devices) {
      await pollDevice(device);
    }
  } catch (err) {
    logger.warn({ err }, 'MikroTik import: poll cycle error');
  }
}

export const mikrotikImport = {
  start(): void {
    if (pollTimer) return;
    logger.info(`MikroTik address-list import started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
    // Initial poll after 10s (let the server finish startup)
    setTimeout(() => runPollCycle(), 10_000);
    pollTimer = setInterval(() => runPollCycle(), POLL_INTERVAL_MS);
  },

  stop(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },

  /** Force an immediate poll cycle (e.g., after adding a new device). */
  async pollNow(): Promise<void> {
    await runPollCycle();
  },

  /** Clear the known-IPs cache for a device (e.g., after reconfiguration). */
  clearCache(deviceId?: number): void {
    if (deviceId) {
      for (const key of knownIPs.keys()) {
        if (key.startsWith(`${deviceId}:`)) knownIPs.delete(key);
      }
    } else {
      knownIPs.clear();
    }
  },
};
