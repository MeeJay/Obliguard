/**
 * MikroTik Address-List Import Service.
 *
 * Periodically polls MikroTik address-lists (e.g. "blacklist", "honeypot") via
 * the RouterOS API and imports new IPs as global 'remote' bans in Obliguard
 * (origin_ref 'mikrotik:<deviceId>': never re-shared to obli.tools).
 *
 * This enables bidirectional sync: MikroTik honeypot/trap rules that add IPs
 * to address-lists on a single router get propagated as bans to ALL agents
 * (including other MikroTik devices, OPNsense, Linux, Windows).
 *
 * Flow:
 *   1. Every 60s, iterate all MikroTik devices with import_address_lists set
 *   2. Connect via RouterOS API and fetch each configured address-list
 *   3. Compare with last known state (in-memory cache)
 *   4. New IPs → global 'remote' bans (batchImportIPs: whitelist, evaluate-only
 *      and operator Lifts respected)
 *   5. Delivered to every agent by the ban delta, to routers by the MikroTik
 *      sync (per-ban push, or the periodic reconciliation for big batches)
 */

import { db } from '../../db';
import { logger } from '../../utils/logger';
import { createRouterOSClient } from './routerosClient';
import { decryptSecret } from '../../utils/crypto';
import { reportMikrotikSyncFailure, resolveMikrotikSyncFailure } from './mikrotikBanSync.service';
import { checkBanTarget } from '../../utils/protectedIps';
import type { BanTarget } from '../../utils/ipValidation';
import { banService } from '../ban.service';

const POLL_INTERVAL_MS = 60_000; // 60 seconds

// Cache: deviceId → Set of known IPs per list (to detect new additions)
const knownIPs = new Map<string, Set<string>>(); // key: "deviceId:listName"

let pollTimer: ReturnType<typeof setInterval> | null = null;

function cacheKey(deviceId: number, listName: string): string {
  return `${deviceId}:${listName}`;
}

export interface ImportDevice {
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
  // Evaluate-only routers observe: no import (and no cache update, so the
  // whole list is imported once the flag is cleared).
  const ctx = await importContext(device.deviceId);
  if (!ctx || ctx.evaluateOnly) return;

  let password: string;
  try {
    password = decryptSecret(device.apiPasswordEnc);
  } catch {
    logger.warn({ deviceId: device.deviceId }, 'MikroTik import: cannot decrypt password');
    await reportMikrotikSyncFailure(device.deviceId, 'import', 'stored API password cannot be decrypted');
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
      deviceId: device.deviceId,
    });
  } catch (err) {
    logger.warn({ err, deviceId: device.deviceId }, 'MikroTik import: connection failed');
    // Shown on the device (a pinned-certificate refusal in particular).
    await db('mikrotik_credentials').where('device_id', device.deviceId).update({
      last_api_error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    await reportMikrotikSyncFailure(device.deviceId, 'import', `connection failed: ${err instanceof Error ? err.message : String(err)}`);
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

      // Batch import as global remote bans
      await batchImportIPs(newIPs, listName, device);
    }

    // Update last connected timestamp
    await db('mikrotik_credentials').where('device_id', device.deviceId).update({
      last_api_connected_at: new Date(),
      last_api_error: null,
    });
    await resolveMikrotikSyncFailure(device.deviceId, 'import');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, deviceId: device.deviceId }, `MikroTik import poll failed: ${msg}`);
    await db('mikrotik_credentials').where('device_id', device.deviceId).update({
      last_api_error: msg,
    }).catch(() => {});
    await reportMikrotikSyncFailure(device.deviceId, 'import', msg);
  } finally {
    client.close();
  }
}

/**
 * The router's group ancestry and evaluate-only state (own flag, or any
 * ancestor group's flag, like the BanEngine). Null when the device is gone.
 */
async function importContext(deviceId: number): Promise<{ groupIds: number[]; evaluateOnly: boolean } | null> {
  const dev = await db('agent_devices').where({ id: deviceId })
    .first('group_id', 'evaluate_only') as { group_id: number | null; evaluate_only: boolean } | undefined;
  if (!dev) return null;
  const groupIds = dev.group_id == null ? [] : await db('group_closure')
    .where('descendant_id', dev.group_id)
    .pluck('ancestor_id') as number[];
  const evalGroup = groupIds.length === 0 ? undefined : await db('monitor_groups')
    .whereIn('id', groupIds).where('evaluate_only', true).first('id');
  return { groupIds, evaluateOnly: !!dev.evaluate_only || !!evalGroup };
}

/**
 * Import address-list entries as global 'remote' bans (origin_ref
 * 'mikrotik:<deviceId>', BROKEN-15). Never as 'auto': an imported address is
 * not a local detection and is never contributed to obli.tools (owner
 * decision 7). Skipped:
 *   - a router in evaluate-only (own flag or an ancestor group's): it
 *     observes, it never creates bans;
 *   - invalid, reserved, too broad and protected entries (checkBanTarget);
 *   - entries contained in a whitelist entry applying to the router (global,
 *     its tenant's, its groups', its own; real containment >>=);
 *   - entries an active global ban already covers, and entries of this
 *     router an operator lifted (an import would undo the Lift).
 * The insert is INSERT ... SELECT ... WHERE NOT EXISTS against the active
 * bans (banService.createRemoteBans); a concurrent ban of the same target is
 * absorbed by the partial unique index of migration 032.
 * Returns the number of bans created.
 */
export async function batchImportIPs(
  rawIps: string[],
  listName: string,
  device: ImportDevice,
): Promise<number> {
  if (rawIps.length === 0) return 0;

  const ctx = await importContext(device.deviceId);
  if (!ctx) return 0;
  if (ctx.evaluateOnly) {
    logger.info({ deviceId: device.deviceId, list: listName, entries: rawIps.length }, 'MikroTik import: router in evaluate-only, nothing imported');
    return 0;
  }

  // Same contract as every ban path (B9-1 must keep it): refuse invalid,
  // reserved, too broad and protected entries. The CANONICAL target is stored
  // like every other ban path: network address in `ip` plus `cidr_prefix` for
  // a subnet (NULL for a host), e.g. '::ffff:1.2.3.4' -> '1.2.3.4'.
  const seen = new Map<string, BanTarget>();
  let refused = 0;
  for (const ip of rawIps) {
    const c = await checkBanTarget(ip, { allowCidr: true });
    if (c.ok) seen.set(c.target.cidr, c.target); else refused++;
  }
  const targets = [...seen.values()];
  if (refused) {
    logger.warn({ deviceId: device.deviceId, list: listName, refused }, 'MikroTik import: refused reserved/protected/too-broad/invalid entries');
  }
  if (targets.length === 0) return 0;

  // Whitelist, active-ban coverage and operator Lifts are applied in SQL by
  // the insert itself (no check-then-insert window).
  const created = await banService.createRemoteBans(targets, {
    originRef: `mikrotik:${device.deviceId}`,
    originTenantId: device.tenantId,
    reason: `MikroTik import: detected in "${listName}" address-list`,
    whitelist: { tenantId: device.tenantId, groupIds: ctx.groupIds, deviceId: device.deviceId },
    respectLifts: true,
  });

  logger.info(
    { deviceId: device.deviceId, list: listName, entries: targets.length, imported: created, skipped: targets.length - created },
    'MikroTik import: batch complete',
  );
  return created;
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
