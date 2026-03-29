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
      // Find IPs not yet seen (on first poll, imports ALL existing entries)
      const newIPs: string[] = [];
      for (const ip of currentSet) {
        if (!previousSet || !previousSet.has(ip)) {
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

      // Batch import as global auto-bans
      await batchImportIPs(newIPs, listName, device);
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

/**
 * Batch import IPs as global auto-bans.
 * Optimized for large imports (30K+ IPs): filters already-banned in bulk,
 * batch-inserts bans and events in chunks of 500.
 */
async function batchImportIPs(
  ips: string[],
  listName: string,
  device: ImportDevice,
): Promise<void> {
  if (ips.length === 0) return;

  const reason = `MikroTik import: detected in "${listName}" address-list`;
  const CHUNK_SIZE = 500;

  // 1. Filter out IPs that are already actively banned (bulk query)
  const alreadyBanned = new Set<string>();
  for (let i = 0; i < ips.length; i += CHUNK_SIZE) {
    const chunk = ips.slice(i, i + CHUNK_SIZE);
    const rows = await db('ip_bans')
      .whereIn('ip', chunk)
      .where('is_active', true)
      .select('ip');
    for (const r of rows) alreadyBanned.add(r.ip);
  }

  const toImport = ips.filter((ip) => !alreadyBanned.has(ip));
  if (toImport.length === 0) {
    logger.info(
      { deviceId: device.deviceId, list: listName, total: ips.length, skipped: ips.length },
      'MikroTik import: all IPs already banned',
    );
    return;
  }

  // 2. Batch insert bans
  const now = new Date();
  for (let i = 0; i < toImport.length; i += CHUNK_SIZE) {
    const chunk = toImport.slice(i, i + CHUNK_SIZE);

    const banRows = chunk.map((ip) => ({
      ip,
      scope: 'global',
      ban_type: 'auto',
      origin_tenant_id: device.tenantId,
      reason,
      is_active: true,
      banned_at: now,
    }));

    // Use onConflict to skip IPs that got banned between our check and insert
    await db('ip_bans').insert(banRows).onConflict(['ip', 'is_active']).ignore().catch(() => {
      // Fallback: insert one by one if bulk fails (e.g., no unique constraint)
      return Promise.allSettled(banRows.map((r) => db('ip_bans').insert(r).catch(() => {})));
    });

    // 3. Batch insert events
    const crypto = await import('crypto');
    const eventRows = chunk.map((ip) => ({
      id: `${crypto.randomUUID()}-${Date.now()}`,
      ip,
      username: '',
      service: `mikrotik_import:${listName}`,
      event_type: 'auth_failure',
      raw_log: reason,
      device_id: device.deviceId,
      tenant_id: device.tenantId,
      source_ip_type: 'public',
      timestamp: now,
    }));
    await db('ip_events').insert(eventRows).catch(() => {});

    if (i % 5000 === 0 && i > 0) {
      logger.info(
        { deviceId: device.deviceId, list: listName, progress: `${i}/${toImport.length}` },
        'MikroTik import: batch progress',
      );
    }
  }

  logger.info(
    { deviceId: device.deviceId, list: listName, imported: toImport.length, skipped: alreadyBanned.size },
    'MikroTik import: batch complete',
  );

  // 4. Propagate to all MikroTik devices (fire-and-forget, done by ban engine on next cycle)
  // Don't push 30K individual bans — the ban engine's delta sync handles this.
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
