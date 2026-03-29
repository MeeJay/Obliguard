import type { Server as SocketIOServer } from 'socket.io';
import { db } from '../db';
import type { IpBan, CreateBanRequest, BanScope } from '@obliview/shared';
import { logger } from '../utils/logger';
import { serviceTemplateService } from './serviceTemplate.service';
import { ipReputationService } from './ipReputation.service';

// ── Socket.io instance (injected from index.ts) ─────────────────────────────
let _io: SocketIOServer | null = null;
export function setBanServiceIO(io: SocketIOServer): void {
  _io = io;
}

// ── Row helpers ──────────────────────────────────────────────────────────────

interface BanRow {
  id: number;
  ip: string;
  cidr_prefix: number | null;
  reason: string | null;
  ban_type: string;
  scope: string;
  scope_id: number | null;
  tenant_id: number | null;
  origin_tenant_id: number | null;
  origin_tenant_name?: string;
  banned_by_user_id: number | null;
  banned_at: Date;
  expires_at: Date | null;
  is_active: boolean;
}

function rowToBan(row: BanRow, isAdmin = false): IpBan {
  return {
    id: row.id,
    ip: row.ip,
    cidrPrefix: row.cidr_prefix,
    reason: row.reason,
    banType: row.ban_type as IpBan['banType'],
    scope: row.scope as BanScope,
    scopeId: row.scope_id,
    tenantId: row.tenant_id,
    // Only expose origin to platform admins
    originTenantId: isAdmin ? row.origin_tenant_id : null,
    originTenantName: isAdmin ? row.origin_tenant_name : undefined,
    bannedByUserId: row.banned_by_user_id,
    bannedAt: row.banned_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    isActive: row.is_active,
  };
}

// ── BanService ───────────────────────────────────────────────────────────────

class BanService {

  /** List active bans visible to the caller */
  async list(opts: {
    tenantId: number;
    isAdmin: boolean;
    onlyActive?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: IpBan[]; total: number }> {
    const { tenantId, isAdmin, onlyActive = true, search, limit = 50, offset = 0 } = opts;

    // Join with exclusions for the calling tenant so we can expose isExcludedByTenant
    let q = db('ip_bans')
      .leftJoin('tenants as origin_tenant', 'ip_bans.origin_tenant_id', 'origin_tenant.id')
      .leftJoin('ip_ban_exclusions as ex', function () {
        this.on('ex.ban_id', '=', 'ip_bans.id')
          .andOnVal('ex.tenant_id', '=', tenantId);
      })
      .select(
        'ip_bans.*',
        'origin_tenant.name as origin_tenant_name',
        db.raw('ex.id IS NOT NULL AS is_excluded_by_tenant'),
      );

    if (isAdmin) {
      // Admin sees all bans (global + all tenants)
    } else {
      // Tenant admin sees: global bans + their own tenant bans
      q = q.where((b) => {
        b.where('ip_bans.scope', 'global').orWhere('ip_bans.tenant_id', tenantId);
      });
    }

    if (onlyActive) q = q.where('ip_bans.is_active', true);
    if (search) q = q.whereRaw("ip_bans.ip::text ILIKE ?", [`%${search}%`]);

    const countQ = q.clone().clearSelect().count('ip_bans.id as count');
    const [{ count }] = await countQ as unknown as [{ count: string }];

    const rows = await q.orderBy('ip_bans.banned_at', 'desc').limit(limit).offset(offset) as (BanRow & { is_excluded_by_tenant: boolean })[];
    return {
      data: rows.map((r) => ({ ...rowToBan(r, isAdmin), isExcludedByTenant: r.is_excluded_by_tenant ?? false })),
      total: Number(count),
    };
  }

  /** Create a manual ban */
  async create(
    data: CreateBanRequest,
    userId: number,
    tenantId: number,
    isAdmin: boolean,
  ): Promise<IpBan> {
    const scope: BanScope = data.scope ?? (isAdmin ? 'global' : 'tenant');

    // Non-admins can only create tenant-scoped bans
    if (!isAdmin && scope !== 'tenant') {
      throw new Error('Only platform admins can create non-tenant-scoped bans');
    }

    // Reject if this IP already has an active ban
    const existing = await db('ip_bans')
      .where({ ip: data.ip, is_active: true })
      .where(function () {
        this.whereNull('expires_at').orWhere('expires_at', '>', new Date());
      })
      .first();
    if (existing) {
      throw new Error('This IP is already banned');
    }

    const [row] = await db('ip_bans')
      .insert({
        ip: data.ip,
        cidr_prefix: data.cidrPrefix ?? null,
        reason: data.reason ?? null,
        ban_type: 'manual',
        scope,
        scope_id: data.scopeId ?? null,
        tenant_id: scope === 'global' ? null : tenantId,
        origin_tenant_id: null,
        banned_by_user_id: userId,
        expires_at: data.expiresAt ?? null,
        is_active: true,
      })
      .returning('*') as BanRow[];

    _io?.emit('ban:created', rowToBan(row, isAdmin));

    // Push ban to MikroTik devices (fire-and-forget)
    import('./mikrotik/mikrotikBanSync.service')
      .then(({ mikrotikBanSync }) => mikrotikBanSync.pushBanToAll(data.ip, 'ban'))
      .catch(() => {});

    return rowToBan(row, isAdmin);
  }

  /** Promote a tenant ban to global (admin only) */
  async promoteToGlobal(banId: number): Promise<IpBan> {
    const [row] = await db('ip_bans')
      .where('id', banId)
      .update({ scope: 'global', scope_id: null, tenant_id: null })
      .returning('*') as BanRow[];

    if (!row) throw new Error('Ban not found');
    _io?.emit('ban:updated', rowToBan(row, true));
    return rowToBan(row, true);
  }

  /** Lift (deactivate) a ban — platform admins only for global-scope bans */
  async lift(banId: number, tenantId: number, isAdmin: boolean): Promise<void> {
    const ban = await db('ip_bans').where('id', banId).first() as BanRow | undefined;
    if (!ban) throw new Error('Ban not found');

    // Tenant admins can only lift their own tenant-scoped bans.
    // To opt out of a global ban without revoking it for everyone, use excludeForTenant().
    if (!isAdmin && (ban.scope !== 'tenant' || ban.tenant_id !== tenantId)) {
      throw new Error('Insufficient permissions to lift this ban');
    }

    await db('ip_bans').where('id', banId).update({ is_active: false });
    _io?.emit('ban:lifted', { id: banId });

    // Push unban to MikroTik devices (fire-and-forget)
    import('./mikrotik/mikrotikBanSync.service')
      .then(({ mikrotikBanSync }) => mikrotikBanSync.pushBanToAll(ban.ip, 'unban'))
      .catch(() => {});
  }

  /**
   * Create a per-tenant exclusion for a global ban.
   * The ban stays active globally; agents of this tenant will not enforce it.
   */
  async excludeForTenant(banId: number, tenantId: number, userId: number): Promise<void> {
    const ban = await db('ip_bans').where('id', banId).first() as BanRow | undefined;
    if (!ban) throw new Error('Ban not found');
    if (ban.scope !== 'global') throw new Error('Only global bans can be excluded per-tenant');
    if (!ban.is_active) throw new Error('Ban is no longer active');

    // Insert — ignore duplicate (already excluded)
    await db('ip_ban_exclusions')
      .insert({ ban_id: banId, tenant_id: tenantId, created_by: userId })
      .onConflict(['ban_id', 'tenant_id'])
      .ignore();

    _io?.emit('ban:excluded', { banId, tenantId });
  }

  /**
   * Remove a per-tenant exclusion (re-enable enforcement for this tenant).
   */
  async removeExclusion(banId: number, tenantId: number): Promise<void> {
    const deleted = await db('ip_ban_exclusions')
      .where({ ban_id: banId, tenant_id: tenantId })
      .delete();
    if (!deleted) throw new Error('No exclusion found for this ban and tenant');
    _io?.emit('ban:exclusionRemoved', { banId, tenantId });
  }

  /**
   * Compute the ban list delta for an agent:
   * IPs that should be banned but aren't in agentCurrentBans,
   * and IPs in agentCurrentBans that are no longer banned.
   */
  async computeBanDelta(
    deviceId: number,
    groupIds: number[],
    tenantId: number,
    agentCurrentBans: string[],
    resolvedWhitelist: string[],
  ): Promise<{ add: string[]; remove: string[] }> {
    // Fetch all active bans applicable to this agent
    const bans = await db('ip_bans')
      .where('is_active', true)
      .where((b) => {
        b.where('scope', 'global')
          .orWhere('tenant_id', tenantId)
          .orWhere((c) => c.where('scope', 'group').whereIn('scope_id', groupIds))
          .orWhere((c) => c.where('scope', 'agent').where('scope_id', deviceId));
      })
      .select('ip_bans.id', 'ip_bans.ip') as Array<{ id: number; ip: string }>;

    // Fetch IPs of global bans that this tenant has excluded
    const excludedBanIds = new Set<number>(
      (await db('ip_ban_exclusions')
        .where({ tenant_id: tenantId })
        .pluck('ban_id') as number[]),
    );

    // Filter out whitelisted and tenant-excluded IPs
    const shouldBeBanned = new Set<string>();
    for (const ban of bans) {
      if (excludedBanIds.has(ban.id)) continue; // tenant opted out of this global ban

      const banIp = ban.ip;
      const isWhitelisted = resolvedWhitelist.some((cidr) => {
        // Simple check — the full CIDR containment is done in whitelistService.isWhitelisted
        // Here we do exact match for performance; the agent will apply its own whitelist anyway
        return banIp === cidr || banIp.startsWith(cidr.split('/')[0]);
      });
      if (!isWhitelisted) shouldBeBanned.add(banIp);
    }

    const currentSet = new Set(agentCurrentBans);
    const add = [...shouldBeBanned].filter((ip) => !currentSet.has(ip));
    const remove = [...currentSet].filter((ip) => !shouldBeBanned.has(ip));

    return { add, remove };
  }
}

export const banService = new BanService();

// ── BanEngine ────────────────────────────────────────────────────────────────
// Runs every 30s, evaluates ip_events against per-service thresholds,
// and auto-creates global bans for IPs that exceed them.

const BAN_ENGINE_INTERVAL_MS = 30_000;

class BanEngine {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), BAN_ENGINE_INTERVAL_MS);
    logger.info('BanEngine started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async run(): Promise<void> {
    try {
      await this.evaluateThresholds();
    } catch (err) {
      logger.error(err, 'BanEngine run failed');
    }
  }

  /**
   * For each approved agent, resolve its active service templates (opt-in model),
   * then count auth_failure events in each configured window.
   * If count >= threshold AND ip is not whitelisted, create a global ban.
   *
   * Templates are opt-in: they must be explicitly enabled at group or agent level
   * (enabled_override = true) to count toward auto-bans.
   */
  private async evaluateThresholds(): Promise<void> {
    // Fetch all approved agents
    const devices = await db('agent_devices')
      .where({ status: 'approved' })
      .select('id', 'group_id', 'tenant_id') as Array<{ id: number; group_id: number | null; tenant_id: number }>;

    if (devices.length === 0) return;

    // Pre-fetch group ancestries for all devices in one query
    const devicesWithGroups = await Promise.all(
      devices.map(async (dev) => {
        if (!dev.group_id) return { dev, groupIds: [] as number[] };
        const rows = await db('group_closure')
          .where('descendant_id', dev.group_id)
          .select('ancestor_id')
          .orderBy('depth', 'asc') as { ancestor_id: number }[];
        return { dev, groupIds: rows.map(r => r.ancestor_id) };
      }),
    );

    // Evaluate per-device
    for (const { dev, groupIds } of devicesWithGroups) {
      let resolved;
      try {
        resolved = await serviceTemplateService.resolveForAgent(dev.id, groupIds);
      } catch (err) {
        logger.warn({ err, deviceId: dev.id }, 'BanEngine: failed to resolve templates for device');
        continue;
      }

      // Only process enabled ban-mode templates
      const activeTemplates = resolved.filter(cfg => cfg.enabled && cfg.mode === 'ban');
      if (activeTemplates.length === 0) continue;

      for (const cfg of activeTemplates) {
        const windowStart = new Date(Date.now() - cfg.windowSeconds * 1000);

        const results = await db('ip_events')
          .select('ip', 'tenant_id')
          .count('id as failure_count')
          .where('device_id', dev.id)
          .where('service', cfg.serviceType)
          .where('event_type', 'auth_failure')
          .where('track_only', false)
          .where('timestamp', '>=', windowStart)
          .groupBy('ip', 'tenant_id')
          .havingRaw('count(id) >= ?', [cfg.threshold]) as Array<{
            ip: string;
            tenant_id: number;
            failure_count: string;
          }>;

        for (const r of results) {
          await this.createAutoBan(r.ip, r.tenant_id, cfg.serviceType, Number(r.failure_count));
        }
      }
    }
  }

  private async createAutoBan(
    ip: string,
    originTenantId: number,
    service: string,
    failureCount: number,
  ): Promise<void> {
    // Check if already actively banned
    const existing = await db('ip_bans')
      .where('ip', ip)
      .where('scope', 'global')
      .where('is_active', true)
      .first();

    if (existing) return; // Already banned globally

    // Check whitelist (global-scope only for now; per-tenant override handled at push time)
    const whitelisted = await db('ip_whitelist')
      .where('scope', 'global')
      .whereRaw('?::inet << ip', [ip])
      .first();

    if (whitelisted) return;

    await db('ip_bans').insert({
      ip,
      scope: 'global',
      ban_type: 'auto',
      origin_tenant_id: originTenantId,
      reason: `Auto-ban: ${failureCount} ${service} auth failures`,
      is_active: true,
    });

    // Ensure the IP has a reputation row so it appears in the IP Reputation module
    // even if ip_events were processed before the reputation upsert fix.
    await ipReputationService.ensureExists(ip).catch(() => { /* non-fatal */ });

    logger.info({ ip, service, failureCount }, 'BanEngine: auto-banned IP');
    _io?.emit('ban:auto', { ip, service, failureCount, originTenantId });

    // Push auto-ban to MikroTik devices (fire-and-forget)
    import('./mikrotik/mikrotikBanSync.service')
      .then(({ mikrotikBanSync }) => mikrotikBanSync.pushBanToAll(ip, 'ban'))
      .catch(() => {});

    // ── Mark origin agents as "under attack" ──────────────────────────────────
    // Find agent devices that had recent auth_failure events from this IP (last 10 min)
    try {
      const cutoff = new Date(Date.now() - 10 * 60 * 1000);
      const affectedDevices = await db('ip_events')
        .where({ ip, event_type: 'auth_failure', tenant_id: originTenantId })
        .where('timestamp', '>=', cutoff)
        .whereNotNull('device_id')
        .distinct('device_id')
        .pluck('device_id') as number[];

      if (affectedDevices.length > 0) {
        await db('agent_devices')
          .whereIn('id', affectedDevices)
          .update({ last_attack_at: new Date() });

        // Fire "attack" notifications for each affected device
        const { notificationService } = await import('./notification.service');
        for (const devId of affectedDevices) {
          const devRow = await db('agent_devices').where({ id: devId }).select('name', 'hostname').first() as { name: string | null; hostname: string } | undefined;
          const label = devRow?.name ?? devRow?.hostname ?? String(devId);
          notificationService.sendForAgent(devId, label, 'attack', 'ok', [`${ip} banned (${failureCount} ${service} failures)`], 'attack').catch(
            (err) => logger.warn({ err, devId, ip }, 'Failed to send attack notification'),
          );
        }
      }
    } catch (err) {
      logger.warn({ err, ip }, 'BanEngine: failed to update last_attack_at for affected devices');
    }
  }
}

export const banEngine = new BanEngine();
