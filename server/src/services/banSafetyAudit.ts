/**
 * Safety net for EXISTING ban rows (minted before the A2 validation, e.g. by
 * the old bulk-ban): reserved addresses, subnets wider than the floor, and
 * protected addresses.
 *
 * refreshUnsafeBanRegistry() runs at BanEngine start and every 10 minutes.
 * Unsafe rows are NOT deactivated: they are logged, and each unsafe
 * row is skipped by computeBanDelta and MikroTik fullSync, so agents and
 * routers remove them. Manual global rows without an origin tenant (old
 * bulk-ban) are only logged for review.
 *
 * The registry is keyed by ban ROW id, not by ip text: a tenant-local ban on a
 * server interface address is legitimate (interfaces are protected for global
 * bans only) and must still be delivered when an unsafe global row carries
 * the same text.
 *
 * Imports no other service (ban.service and mikrotikBanSync import it).
 */
import { db } from '../db';
import { logger } from '../utils/logger';
import { parseBanTarget } from '../utils/ipValidation';
import { findProtectedConflict } from '../utils/protectedIps';

const AUDIT_INTERVAL_MS = 10 * 60 * 1000;

let unsafeIds = new Set<number>();
let lastSignature = '';
let timer: NodeJS.Timeout | null = null;

interface AuditRow {
  id: number;
  ip: string;
  cidr_prefix: number | null;
  scope: string;
  ban_type: string;
  origin_tenant_id: number | null;
}

export async function refreshUnsafeBanRegistry(): Promise<{ unsafe: number; legacyBulk: number }> {
  const rows = await db('ip_bans')
    .where('is_active', true)
    .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', db.fn.now()))
    .select('id', 'ip', 'cidr_prefix', 'scope', 'ban_type', 'origin_tenant_id') as AuditRow[];

  const next = new Set<number>();
  const unsafe: Array<{ id: number; ip: string; scope: string; ban_type: string; why: string }> = [];
  const legacy: number[] = [];

  for (const row of rows) {
    // The DELIVERED value: agents and routers only ever receive the ip text.
    const ip = String(row.ip);
    const r = parseBanTarget(ip, { allowCidr: true });
    let why: string | null = null;
    if (!r.ok) why = r.code;
    else if (await findProtectedConflict(r.target, { includeInterfaces: row.scope === 'global', silent: true })) why = 'protected';
    if (why) {
      next.add(Number(row.id));
      unsafe.push({ id: row.id, ip, scope: row.scope, ban_type: row.ban_type, why });
    }
    if (row.ban_type === 'manual' && row.scope === 'global' && row.origin_tenant_id == null) legacy.push(row.id);
  }

  const signature = `${unsafe.map((u) => u.id).sort((a, b) => a - b).join(',')}|${[...legacy].sort((a, b) => a - b).join(',')}`;
  if (signature !== lastSignature) {
    lastSignature = signature;
    if (unsafe.length > 0 || legacy.length > 0) {
      logger.warn(
        { unsafe: unsafe.slice(0, 50), unsafeCount: unsafe.length, legacyBulk: legacy.slice(0, 50), legacyBulkCount: legacy.length },
        'BanSafety audit: active bans that are not delivered (unsafe) or need review (legacy bulk-ban)',
      );
    }
  }

  unsafeIds = next;
  return { unsafe: unsafe.length, legacyBulk: legacy.length };
}

/** True when this active ban row is unsafe (skipped at delivery). */
export function isUnsafeBanId(id: number): boolean {
  return unsafeIds.has(Number(id));
}

export function startBanSafetyAudit(): void {
  if (timer) return;
  const run = () => {
    void refreshUnsafeBanRegistry().catch((err) => logger.warn({ err }, 'BanSafety audit failed'));
  };
  run();
  timer = setInterval(run, AUDIT_INTERVAL_MS);
  timer.unref();
}

export function stopBanSafetyAudit(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
