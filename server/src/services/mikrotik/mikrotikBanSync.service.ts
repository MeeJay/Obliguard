/**
 * MikroTik Ban Sync Service.
 *
 * Pushes ban/unban commands to all approved MikroTik devices when bans are
 * created or lifted. Called from ban.service.ts hooks.
 *
 * Also provides a full sync method to reconcile the MikroTik address-list
 * with Obliguard's active bans (used on device creation or reconnection).
 */

import { db } from '../../db';
import { logger } from '../../utils/logger';
import { createRouterOSClient } from './routerosClient';
import { mikrotikDeviceService } from './mikrotikDevice.service';
import { isUnsafeBanId } from '../banSafetyAudit';

interface MikroTikDeviceInfo {
  deviceId: number;
  tenantId: number;
}

async function getApprovedMikroTikDevices(tenantId?: number | null): Promise<MikroTikDeviceInfo[]> {
  const q = db('agent_devices')
    .where('device_type', 'mikrotik')
    .where('status', 'approved')
    .select('id as deviceId', 'tenant_id as tenantId');
  if (tenantId != null) q.where('tenant_id', tenantId);
  return q;
}

async function pushToDevice(
  deviceId: number,
  action: 'ban' | 'unban',
  ip: string,
): Promise<void> {
  const cfg = await mikrotikDeviceService.getRouterOSConfig(deviceId);
  if (!cfg) return;

  try {
    const client = await createRouterOSClient({
      host: cfg.host,
      port: cfg.port,
      useTls: cfg.useTls,
      username: cfg.username,
      password: cfg.password,
    });

    if (action === 'ban') {
      await client.banIP(ip, cfg.addressListName);
    } else {
      await client.unbanIP(ip, cfg.addressListName);
    }

    client.close();

    await db('mikrotik_credentials').where('device_id', deviceId).update({
      last_api_connected_at: new Date(),
      last_api_error: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, deviceId, action, ip }, `MikroTik ban sync failed: ${msg}`);
    await db('mikrotik_credentials').where('device_id', deviceId).update({
      last_api_error: msg,
    }).catch(() => {});
  }
}

export const mikrotikBanSync = {
  /**
   * Push a ban or unban to ALL approved MikroTik devices.
   * Called after auto-ban, manual ban, or ban lift.
   * Fire-and-forget — errors are logged but don't block the caller.
   *
   * opts.tenantId restricts the push to that tenant's routers (tenant-local
   * bans). Stop-gap until A3 replaces this with pushBan(ban, action).
   */
  async pushBanToAll(ip: string, action: 'ban' | 'unban', opts?: { tenantId?: number | null }): Promise<void> {
    const devices = await getApprovedMikroTikDevices(opts?.tenantId);
    if (devices.length === 0) return;

    // Run in parallel, don't await individual failures
    await Promise.allSettled(
      devices.map((d) => pushToDevice(d.deviceId, action, ip)),
    );
  },

  /**
   * Full ban sync for a single MikroTik device.
   * Fetches all active bans from Obliguard, compares with the device's current
   * address-list, and adds/removes entries to reconcile.
   */
  async fullSync(deviceId: number): Promise<{ added: number; removed: number; error?: string }> {
    const cfg = await mikrotikDeviceService.getRouterOSConfig(deviceId);
    if (!cfg) return { added: 0, removed: 0, error: 'Credentials not found' };

    try {
      // Get all active global bans
      const bans = await db('ip_bans')
        .where('is_active', true)
        .select('id', 'ip') as Array<{ id: number; ip: string }>;
      // Unsafe legacy rows (banSafetyAudit) are never delivered: an existing
      // entry is removed by the toRemove loop below. A3 replaces this with a
      // fullSync based on computeBanDelta and must keep the unsafe filter.
      const wantedIPs = new Set(bans.filter((b) => !isUnsafeBanId(b.id)).map((b) => String(b.ip)));

      // Get current address-list from MikroTik
      const client = await createRouterOSClient({
        host: cfg.host,
        port: cfg.port,
        useTls: cfg.useTls,
        username: cfg.username,
        password: cfg.password,
      });

      const currentIPs = new Set(await client.getBannedIPs(cfg.addressListName));

      // Compute delta
      const toAdd = [...wantedIPs].filter((ip) => !currentIPs.has(ip));
      const toRemove = [...currentIPs].filter((ip) => !wantedIPs.has(ip));

      for (const ip of toAdd) {
        await client.banIP(ip, cfg.addressListName);
      }
      for (const ip of toRemove) {
        await client.unbanIP(ip, cfg.addressListName);
      }

      client.close();

      await db('mikrotik_credentials').where('device_id', deviceId).update({
        last_api_connected_at: new Date(),
        last_api_error: null,
      });

      logger.info({ deviceId, added: toAdd.length, removed: toRemove.length }, 'MikroTik full ban sync complete');
      return { added: toAdd.length, removed: toRemove.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, deviceId }, `MikroTik full sync failed: ${msg}`);
      await db('mikrotik_credentials').where('device_id', deviceId).update({
        last_api_error: msg,
      }).catch(() => {});
      return { added: 0, removed: 0, error: msg };
    }
  },
};
