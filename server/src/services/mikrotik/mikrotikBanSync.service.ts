/**
 * MikroTik Ban Sync Service.
 *
 * Pushes ban/unban commands to the approved MikroTik routers of a ban's
 * AUDIENCE when bans are created, lifted or excluded (A3). Called from
 * ban.service.ts hooks:
 *   - global ban      → every tenant's routers, minus tenants holding an
 *                       exclusion on that ban;
 *   - tenant-local    → that tenant's routers only (tenant/group/agent scope);
 *   - exclusion       → unban on the excluding tenant's routers only.
 * An unban never removes an address a router still needs for another active
 * ban (e.g. a global lift while the tenant keeps a local ban).
 *
 * fullSync reconciles one router's address-list with the bans its tenant
 * enforces (same rules as an agent's computeBanDelta), and only ever removes
 * entries Obliguard added itself (comment tag), never operator entries. A
 * periodic reconciler re-runs it for every router.
 */

import type { Knex } from 'knex';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { parseIpOrCidr } from '../../utils/ipValidation';
import { createRouterOSClient } from './routerosClient';
import type { RouterOSClient } from './routerosClient';
import { mikrotikDeviceService } from './mikrotikDevice.service';
import { isUnsafeBanId } from '../banSafetyAudit';

/** Comment prefix of the entries Obliguard adds (RouterOSClient.banIP default 'Obliguard auto-ban'). */
const OBLIGUARD_ENTRY_TAG = 'Obliguard';

/** Periodic reconciliation of every router (fullSync). */
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Which routers a ban change applies to.
 *   - tenantId set: only that tenant's routers (tenant/group/agent ban,
 *     tenant exclusion);
 *   - otherwise a global ban: every router, minus the tenants that excluded
 *     `banId` (or, without banId, the active global bans of the address).
 */
export interface MikrotikBanAudience {
  tenantId?: number | null;
  banId?: number;
}

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

/**
 * Restrict `q` to the ban rows (alias `a`) whose target is `target`, the
 * delivered text: 'address' (/32, /128) or 'network/prefix'. A subnet row
 * holds its network address in ip and the prefix in cidr_prefix (legacy rows:
 * in the inet mask). Unparsable text matches nothing.
 */
function whereBanTarget(q: Knex.QueryBuilder, a: string, target: string): void {
  const p = parseIpOrCidr(target);
  if (!p) {
    q.whereRaw('false');
    return;
  }
  q.whereRaw(`(${a}.ip = ?::inet OR ${a}.ip = ?::inet)`, [p.address, `${p.address}/${p.prefix}`])
    .whereRaw(`COALESCE(${a}.cidr_prefix, masklen(${a}.ip)) = ?`, [p.prefix]);
}

/** Tenants that excluded the global ban `banId` (or the active global bans of `target`). */
async function excludedTenants(target: string, banId?: number): Promise<Set<number>> {
  const q = db('ip_ban_exclusions as ex').distinct('ex.tenant_id');
  if (banId != null) {
    q.where('ex.ban_id', banId);
  } else {
    q.join('ip_bans as b', 'b.id', 'ex.ban_id')
      .where('b.scope', 'global')
      .where('b.is_active', true);
    whereBanTarget(q, 'b', target);
  }
  const rows = await q as Array<{ tenant_id: number }>;
  return new Set(rows.map((r) => Number(r.tenant_id)));
}

/**
 * Of `tenantIds`, the tenants whose routers must still hold `target`: an
 * active, unexpired, safe ban of that target that is global (not excluded by
 * the tenant) or owned by the tenant.
 */
async function tenantsStillWanting(target: string, tenantIds: number[]): Promise<Set<number>> {
  if (tenantIds.length === 0) return new Set();
  const q = db('ip_bans as b')
    .where('b.is_active', true)
    .where((w) => w.whereNull('b.expires_at').orWhere('b.expires_at', '>', db.fn.now()))
    .where((w) => w.where('b.scope', 'global').orWhereIn('b.tenant_id', tenantIds));
  whereBanTarget(q, 'b', target);
  const bans = await q.select('b.id', 'b.scope', 'b.tenant_id') as Array<{ id: number; scope: string; tenant_id: number | null }>;
  const safe = bans.filter((b) => !isUnsafeBanId(b.id));
  if (safe.length === 0) return new Set();

  const globalIds = safe.filter((b) => b.scope === 'global').map((b) => b.id);
  const exclusions = globalIds.length === 0 ? [] : await db('ip_ban_exclusions')
    .whereIn('ban_id', globalIds)
    .whereIn('tenant_id', tenantIds)
    .select('ban_id', 'tenant_id') as Array<{ ban_id: number; tenant_id: number }>;
  const excluded = new Set(exclusions.map((e) => `${e.ban_id}:${e.tenant_id}`));

  const wanting = new Set<number>();
  for (const t of tenantIds) {
    if (safe.some((b) => (b.scope === 'global' ? !excluded.has(`${b.id}:${t}`) : Number(b.tenant_id) === t))) {
      wanting.add(t);
    }
  }
  return wanting;
}

async function connect(deviceId: number): Promise<{ client: RouterOSClient; listName: string } | null> {
  const cfg = await mikrotikDeviceService.getRouterOSConfig(deviceId);
  if (!cfg) return null;
  const client = await createRouterOSClient({
    host: cfg.host,
    port: cfg.port,
    useTls: cfg.useTls,
    username: cfg.username,
    password: cfg.password,
  });
  return { client, listName: cfg.addressListName };
}

async function markConnected(deviceId: number): Promise<void> {
  await db('mikrotik_credentials').where('device_id', deviceId).update({
    last_api_connected_at: new Date(),
    last_api_error: null,
  });
}

async function markError(deviceId: number, msg: string): Promise<void> {
  await db('mikrotik_credentials').where('device_id', deviceId).update({
    last_api_error: msg,
  }).catch(() => {});
}

async function pushToDevice(
  deviceId: number,
  action: 'ban' | 'unban',
  ip: string,
): Promise<void> {
  try {
    const conn = await connect(deviceId);
    if (!conn) return;
    const { client, listName } = conn;
    try {
      if (action === 'ban') {
        await client.banIP(ip, listName);
      } else {
        await client.unbanIP(ip, listName);
      }
    } finally {
      client.close();
    }
    await markConnected(deviceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, deviceId, action, ip }, `MikroTik ban sync failed: ${msg}`);
    await markError(deviceId, msg);
  }
}

interface AddressListEntry { id: string; address: string; comment: string }

/** Every entry of `listName`, with its RouterOS id and comment (null when the print fails). */
async function listEntries(client: RouterOSClient, listName: string): Promise<AddressListEntry[] | null> {
  let result: string[][];
  try {
    result = await client.sendCommand(['/ip/firewall/address-list/print', `?list=${listName}`]);
  } catch {
    return null;
  }
  const entries: AddressListEntry[] = [];
  for (const sentence of result) {
    if (sentence[0] !== '!re') continue;
    const entry: AddressListEntry = { id: '', address: '', comment: '' };
    for (const word of sentence) {
      if (word.startsWith('=.id=')) entry.id = word.slice(5);
      else if (word.startsWith('=address=')) entry.address = word.slice(9);
      else if (word.startsWith('=comment=')) entry.comment = word.slice(9);
    }
    if (entry.id && entry.address) entries.push(entry);
  }
  return entries;
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconciling = false;

export const mikrotikBanSync = {
  /**
   * Push a ban or unban to the approved MikroTik routers of `audience`
   * (see MikrotikBanAudience; omitted = global, legacy callers). `ip` is the
   * delivered target: an address, or 'network/prefix' for a subnet ban
   * (RouterOS address-lists take CIDR entries).
   * Fire-and-forget — errors are logged but don't block the caller.
   */
  async pushBanToAll(ip: string, action: 'ban' | 'unban', audience: MikrotikBanAudience = {}): Promise<void> {
    let devices = await getApprovedMikroTikDevices(audience.tenantId);
    if (devices.length === 0) return;

    if (action === 'ban' && audience.tenantId == null) {
      // Global ban: tenants that opted out keep their routers clean.
      const excluded = await excludedTenants(ip, audience.banId);
      devices = devices.filter((d) => !excluded.has(Number(d.tenantId)));
    } else if (action === 'unban') {
      // Never drop an address a router still enforces for another ban.
      const tenants = [...new Set(devices.map((d) => Number(d.tenantId)))];
      const wanting = await tenantsStillWanting(ip, tenants);
      devices = devices.filter((d) => !wanting.has(Number(d.tenantId)));
    }
    if (devices.length === 0) return;

    // Run in parallel, don't await individual failures
    await Promise.allSettled(
      devices.map((d) => pushToDevice(d.deviceId, action, ip)),
    );
  },

  /**
   * Full ban sync for a single MikroTik router: the wanted set is what an
   * agent of the router's tenant / group would enforce (computeBanDelta:
   * global bans not excluded by the tenant, the tenant's own bans, unsafe
   * and whitelisted rows skipped; subnets as 'network/prefix', which RouterOS
   * enforces natively). Missing addresses are added; an unwanted entry is removed
   * only when Obliguard added it — its comment carries the Obliguard tag, or
   * (comments unavailable) its address is one Obliguard banned. Operator
   * entries stay.
   */
  async fullSync(deviceId: number): Promise<{ added: number; removed: number; error?: string }> {
    const dev = await db('agent_devices')
      .where({ id: deviceId, device_type: 'mikrotik' })
      .first('tenant_id', 'group_id') as { tenant_id: number; group_id: number | null } | undefined;
    if (!dev) return { added: 0, removed: 0, error: 'Device not found' };

    try {
      const conn = await connect(deviceId);
      if (!conn) return { added: 0, removed: 0, error: 'Credentials not found' };
      const { client, listName } = conn;
      let added = 0;
      let removed = 0;
      try {
        const current = [...new Set(await client.getBannedIPs(listName))];
        const entries = await listEntries(client, listName);
        const groupIds = dev.group_id == null ? [] : await db('group_closure')
          .where('descendant_id', dev.group_id)
          .pluck('ancestor_id') as number[];
        const { banService } = await import('../ban.service');
        const delta = await banService.computeBanDelta(
          deviceId,
          groupIds,
          Number(dev.tenant_id),
          current,
          [],
          { cidr: true },
        );

        for (const ip of delta.add) {
          await client.banIP(ip, listName);
          added++;
        }
        if (entries) {
          // Tagged entries only, removed by id (an operator duplicate stays).
          const unwanted = new Set(delta.remove);
          for (const e of entries) {
            if (!unwanted.has(e.address) || !e.comment.startsWith(OBLIGUARD_ENTRY_TAG)) continue;
            await client.sendCommand(['/ip/firewall/address-list/remove', `=.id=${e.id}`]);
            removed++;
          }
        } else if (delta.remove.length > 0) {
          // No comments: only targets Obliguard itself banned at some point
          // (compared as address + prefix: a subnet row stores its prefix apart).
          const keyOf = (address: string, prefix: number) => `${address}/${prefix}`;
          const parsed = new Map<string, string>();
          for (const ip of delta.remove) {
            const p = parseIpOrCidr(ip);
            if (p) parsed.set(ip, keyOf(p.address, p.prefix));
          }
          const addresses = [...new Set([...parsed.values()].map((k) => k.slice(0, k.lastIndexOf('/'))))];
          const known = new Set<string>();
          if (addresses.length > 0) {
            const rows = await db('ip_bans')
              .whereRaw('host(ip)::inet = ANY(?::inet[])', [addresses])
              .distinct(db.raw('host(ip) AS host'), db.raw('COALESCE(cidr_prefix, masklen(ip)) AS prefix')) as
              Array<{ host: string; prefix: number }>;
            for (const r of rows) {
              const p = parseIpOrCidr(`${r.host}/${r.prefix}`);
              if (p) known.add(keyOf(p.address, p.prefix));
            }
          }
          for (const ip of delta.remove) {
            const key = parsed.get(ip);
            if (!key || !known.has(key)) continue;
            await client.unbanIP(ip, listName);
            removed++;
          }
        }
      } finally {
        client.close();
      }

      await markConnected(deviceId);
      logger.info({ deviceId, added, removed }, 'MikroTik full ban sync complete');
      return { added, removed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, deviceId }, `MikroTik full sync failed: ${msg}`);
      await markError(deviceId, msg);
      return { added: 0, removed: 0, error: msg };
    }
  },

  /**
   * fullSync every approved router (of `tenantId` when given), one at a time.
   * Re-entrancy guarded: a run still in progress makes this call a no-op.
   */
  async reconcileAll(tenantId?: number | null): Promise<{ devices: number; failed: number } | null> {
    if (reconciling) {
      logger.warn('MikroTik reconciler: previous run still in progress — skipping');
      return null;
    }
    reconciling = true;
    try {
      const devices = await getApprovedMikroTikDevices(tenantId);
      let failed = 0;
      for (const d of devices) {
        const r = await mikrotikBanSync.fullSync(d.deviceId);
        if (r.error) failed++;
      }
      return { devices: devices.length, failed };
    } finally {
      reconciling = false;
    }
  },

  /** Start the periodic reconciler (every 60 min). */
  startReconciler(): void {
    if (reconcileTimer) return;
    reconcileTimer = setInterval(() => {
      mikrotikBanSync.reconcileAll().catch((err) => logger.error(err, 'MikroTik reconciler failed'));
    }, RECONCILE_INTERVAL_MS);
    reconcileTimer.unref?.();
    logger.info('MikroTik ban reconciler started');
  },

  stopReconciler(): void {
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
  },
};
