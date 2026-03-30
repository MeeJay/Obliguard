import { db } from '../db';
import { appConfigService } from './appConfig.service';
import { logger } from '../utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

interface BlocklistRow {
  id: number;
  name: string;
  source_type: 'oblitools' | 'url';
  url: string;
  api_key: string | null;
  enabled: boolean;
  sync_interval: number;
  last_sync_at: Date | null;
  last_sync_count: number;
  tenant_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface RemoteBlocklist {
  id: number;
  name: string;
  sourceType: 'oblitools' | 'url';
  url: string;
  hasApiKey: boolean;
  enabled: boolean;
  syncInterval: number;
  lastSyncAt: string | null;
  lastSyncCount: number;
  tenantId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface BlockedIpRow {
  id: number;
  blocklist_id: number;
  ip: string;
  reason: string | null;
  first_seen: Date;
  last_seen: Date;
  reports: number;
  sources: string[] | null;
  enabled: boolean;
  created_at: Date;
  // Joined
  blocklist_name?: string;
  source_type?: string;
}

export interface RemoteBlockedIp {
  id: number;
  blocklistId: number;
  blocklistName: string;
  sourceType: string;
  ip: string;
  reason: string | null;
  firstSeen: string;
  lastSeen: string;
  reports: number;
  sources: string[];
  enabled: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToBlocklist(row: BlocklistRow): RemoteBlocklist {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    url: row.url,
    hasApiKey: !!row.api_key,
    enabled: row.enabled,
    syncInterval: row.sync_interval,
    lastSyncAt: row.last_sync_at?.toISOString() ?? null,
    lastSyncCount: row.last_sync_count,
    tenantId: row.tenant_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToBlockedIp(row: BlockedIpRow): RemoteBlockedIp {
  return {
    id: row.id,
    blocklistId: row.blocklist_id,
    blocklistName: row.blocklist_name ?? '',
    sourceType: row.source_type ?? 'url',
    ip: typeof row.ip === 'object' ? String(row.ip) : row.ip,
    reason: row.reason,
    firstSeen: row.first_seen.toISOString(),
    lastSeen: row.last_seen.toISOString(),
    reports: row.reports,
    sources: row.sources ?? [],
    enabled: row.enabled,
  };
}

function isRfc1918(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  return false;
}

// ── Service ──────────────────────────────────────────────────────────────────

export const remoteBlocklistService = {

  // ── CRUD blocklists ──────────────────────────────────────────────────────

  async list(): Promise<RemoteBlocklist[]> {
    const rows = await db<BlocklistRow>('remote_blocklists').orderBy('name');
    return rows.map(rowToBlocklist);
  },

  async create(data: {
    name: string;
    sourceType: 'oblitools' | 'url';
    url: string;
    apiKey?: string | null;
    syncInterval?: number;
    tenantId?: number | null;
  }): Promise<RemoteBlocklist> {
    const [row] = await db<BlocklistRow>('remote_blocklists')
      .insert({
        name: data.name,
        source_type: data.sourceType,
        url: data.url,
        api_key: data.apiKey ?? null,
        sync_interval: data.syncInterval ?? 600,
        tenant_id: data.tenantId ?? null,
      })
      .returning('*');
    return rowToBlocklist(row);
  },

  async update(id: number, data: {
    name?: string;
    url?: string;
    apiKey?: string | null;
    enabled?: boolean;
    syncInterval?: number;
  }): Promise<RemoteBlocklist | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.url !== undefined) updateData.url = data.url;
    if (data.apiKey !== undefined) updateData.api_key = data.apiKey;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.syncInterval !== undefined) updateData.sync_interval = data.syncInterval;

    const [row] = await db<BlocklistRow>('remote_blocklists')
      .where({ id })
      .update(updateData)
      .returning('*');
    return row ? rowToBlocklist(row) : null;
  },

  async delete(id: number): Promise<boolean> {
    const count = await db('remote_blocklists').where({ id }).del();
    return count > 0;
  },

  // ── Remote IPs ───────────────────────────────────────────────────────────

  async listIps(filters: {
    blocklistId?: number;
    search?: string;
    enabled?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ data: RemoteBlockedIp[]; total: number }> {
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    let q = db('remote_blocked_ips as ri')
      .join('remote_blocklists as bl', 'bl.id', 'ri.blocklist_id')
      .select(
        'ri.*',
        'bl.name as blocklist_name',
        'bl.source_type',
      );

    if (filters.blocklistId) q = q.where('ri.blocklist_id', filters.blocklistId);
    if (filters.enabled !== undefined) q = q.where('ri.enabled', filters.enabled);
    if (filters.search) q = q.whereRaw("ri.ip::text ILIKE ?", [`%${filters.search}%`]);

    const countResult = await q.clone().clearSelect().count('ri.id as count').first() as { count: string } | undefined;
    const total = Number(countResult?.count ?? 0);

    const rows = await q.orderBy('ri.last_seen', 'desc').limit(limit).offset(offset) as BlockedIpRow[];
    return { data: rows.map(rowToBlockedIp), total };
  },

  async toggleIp(id: number, enabled: boolean): Promise<boolean> {
    const count = await db('remote_blocked_ips').where({ id }).update({ enabled });
    return count > 0;
  },

  async getStats(): Promise<{ total: number; enabled: number; sources: number; lastSync: string | null }> {
    const total = await db('remote_blocked_ips').count('id as count').first() as { count: string };
    const enabled = await db('remote_blocked_ips').where({ enabled: true }).count('id as count').first() as { count: string };
    const sources = await db('remote_blocklists').where({ enabled: true }).count('id as count').first() as { count: string };
    const lastSync = await db('remote_blocklists').whereNotNull('last_sync_at').orderBy('last_sync_at', 'desc').select('last_sync_at').first() as { last_sync_at: Date } | undefined;
    return {
      total: Number(total?.count ?? 0),
      enabled: Number(enabled?.count ?? 0),
      sources: Number(sources?.count ?? 0),
      lastSync: lastSync?.last_sync_at?.toISOString() ?? null,
    };
  },

  // ── Sync engine ──────────────────────────────────────────────────────────

  async syncAll(): Promise<void> {
    const lists = await db<BlocklistRow>('remote_blocklists').where({ enabled: true });

    for (const list of lists) {
      try {
        if (list.source_type === 'oblitools') {
          await this.syncOblitools(list);
        } else {
          await this.syncUrl(list);
        }
      } catch (err) {
        logger.error(err, `Failed to sync blocklist "${list.name}" (${list.id})`);
      }
    }
  },

  async syncOblitools(list: BlocklistRow): Promise<void> {
    if (!list.api_key) return;

    // Build URL with filters
    const urlObj = new URL(list.url);
    if (list.last_sync_at) {
      urlObj.searchParams.set('since', list.last_sync_at.toISOString());
    }
    // Exclude our own data to avoid re-importing what we pushed
    const instanceName = await appConfigService.get('oblitools_instance_name');
    if (instanceName) {
      urlObj.searchParams.set('exclude_source', instanceName);
    }

    const res = await fetch(urlObj.toString(), {
      headers: { Authorization: `Bearer ${list.api_key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

    const body = await res.json() as {
      ips: Record<string, {
        first_seen?: string;
        last_seen?: string;
        reports?: number;
        sources?: string[];
        reason?: string;
        status?: 'banned' | 'suspicious';
      }>;
    };

    let countBanned = 0;
    let countSuspicious = 0;

    for (const [ip, data] of Object.entries(body.ips ?? {})) {
      const status = data.status ?? 'banned';

      // Store in remote_blocked_ips (tracking/display)
      await db('remote_blocked_ips')
        .insert({
          blocklist_id: list.id,
          ip,
          reason: data.reason ?? null,
          first_seen: data.first_seen ? new Date(data.first_seen) : new Date(),
          last_seen: data.last_seen ? new Date(data.last_seen) : new Date(),
          reports: data.reports ?? 1,
          sources: data.sources ?? null,
        })
        .onConflict(['blocklist_id', 'ip'])
        .merge({
          reason: db.raw('COALESCE(EXCLUDED.reason, remote_blocked_ips.reason)'),
          last_seen: db.raw('GREATEST(EXCLUDED.last_seen, remote_blocked_ips.last_seen)'),
          reports: db.raw('GREATEST(EXCLUDED.reports, remote_blocked_ips.reports)'),
          sources: db.raw('COALESCE(EXCLUDED.sources, remote_blocked_ips.sources)'),
        });

      if (status === 'banned') {
        // Create a global auto-ban if not already banned
        const existingBan = await db('ip_bans').where({ ip, is_active: true }).first();
        if (!existingBan) {
          await db('ip_bans').insert({
            ip,
            scope: 'global',
            ban_type: 'auto',
            reason: `obli.tools: ${data.reason ?? 'shared ban'} (${data.reports ?? 1} reports)`,
            is_active: true,
          }).catch(() => {}); // ignore duplicates
        }
        countBanned++;
      } else {
        // Suspicious: inject auth_failure events to pre-load the ban engine counter.
        // Each "report" from another instance counts as one failure, effectively
        // reducing the remaining attempts before this IP gets auto-banned locally.
        const reports = Math.min(data.reports ?? 1, 10); // Cap at 10 to avoid instant-ban
        for (let i = 0; i < reports; i++) {
          await db('ip_events').insert({
            id: `oblitools-${ip}-${Date.now()}-${i}`,
            ip,
            username: '',
            service: 'oblitools_shared',
            event_type: 'auth_failure',
            raw_log: `obli.tools: suspicious IP (${data.reports ?? 1} reports from ${(data.sources ?? []).length} sources)`,
            tenant_id: list.tenant_id,
            source_ip_type: 'public',
            timestamp: new Date(),
          }).catch(() => {});
        }
        // Mark IP as suspicious in reputation
        const { ipReputationService } = await import('./ipReputation.service');
        await ipReputationService.ensureExists(ip).catch(() => {});
        countSuspicious++;
      }
    }

    await db('remote_blocklists').where({ id: list.id }).update({
      last_sync_at: new Date(),
      last_sync_count: countBanned + countSuspicious,
    });
    if (countBanned > 0 || countSuspicious > 0) {
      logger.info(`Synced from obli.tools "${list.name}": ${countBanned} banned, ${countSuspicious} suspicious`);
    }
  },

  async syncUrl(list: BlocklistRow): Promise<void> {
    const res = await fetch(list.url, {
      headers: list.api_key ? { Authorization: `Bearer ${list.api_key}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    const ips: string[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      // Support CSV: take first column
      const ip = trimmed.split(/[,;\t]/)[0].trim();
      // Basic IPv4 validation
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/.test(ip)) {
        ips.push(ip);
      }
    }

    // Batch upsert
    for (const ip of ips) {
      await db('remote_blocked_ips')
        .insert({
          blocklist_id: list.id,
          ip,
          reason: 'blocklist',
          last_seen: new Date(),
        })
        .onConflict(['blocklist_id', 'ip'])
        .merge({ last_seen: new Date() });
    }

    await db('remote_blocklists').where({ id: list.id }).update({
      last_sync_at: new Date(),
      last_sync_count: ips.length,
    });
    if (ips.length > 0) logger.info(`Synced ${ips.length} IPs from URL blocklist "${list.name}"`);
  },

  // ── Push engine (obli.tools contribution) ────────────────────────────────

  async pushNewBans(): Promise<string> {
    const pushEnabled = await appConfigService.get('oblitools_push_enabled');
    if (pushEnabled !== 'true') return 'Push is disabled. Enable "Share auto-bans" first.';

    const apiKey = await appConfigService.get('oblitools_api_key');
    if (!apiKey) return 'No API key configured.';

    const lastPushStr = await appConfigService.get('oblitools_last_push_at');
    const lastPush = lastPushStr ? new Date(lastPushStr) : new Date(0);
    const stripCidr = (ip: string) => String(ip).replace(/\/\d+$/, '');

    // 1. Collect new banned IPs (auto-bans since last push)
    const newBans = await db('ip_bans')
      .where('ban_type', 'auto')
      .where('banned_at', '>', lastPush)
      .where('is_active', true)
      .select('ip', 'reason') as { ip: string; reason: string | null }[];

    const bannedIps = newBans
      .map(b => ({ ip: stripCidr(String(b.ip)), reason: b.reason ?? 'auto_ban', status: 'banned' as const }))
      .filter(b => !isRfc1918(b.ip));

    // 2. Collect suspicious IPs (not yet banned but flagged)
    const suspiciousRows = await db('ip_reputation')
      .where('status', 'suspicious')
      .where('updated_at', '>', lastPush)
      .select('ip') as { ip: string }[];

    const alreadyBanned = new Set(bannedIps.map(b => b.ip));
    const suspiciousIps = suspiciousRows
      .map(r => ({ ip: stripCidr(String(r.ip)), reason: 'suspicious', status: 'suspicious' as const }))
      .filter(s => !isRfc1918(s.ip) && !alreadyBanned.has(s.ip));

    const allIps = [...bannedIps, ...suspiciousIps];
    if (allIps.length === 0) return `No new IPs to push since last push (${lastPushStr ?? 'never'}).`;

    const instanceName = (await appConfigService.get('oblitools_instance_name')) || 'obliguard';

    const res = await fetch('https://guard.obli.tools/blocklist/api/push', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instance: instanceName,
        ips: allIps.map(b => ({
          ip: b.ip,
          reason: b.reason,
          status: b.status,
        })),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = `Push failed: HTTP ${res.status}${body ? ' — ' + body.slice(0, 200) : ''}`;
      logger.error(msg);
      throw new Error(msg);
    }

    const ack = await res.json() as { accepted?: number; new?: number };
    await appConfigService.set('oblitools_last_push_at', new Date().toISOString());
    const msg = `Pushed ${bannedIps.length} banned + ${suspiciousIps.length} suspicious — accepted: ${ack.accepted ?? '?'}, new: ${ack.new ?? '?'}`;
    logger.info(msg);
    return msg;
  },

  // ── Force sync a single blocklist ────────────────────────────────────────

  async forceSync(id: number): Promise<void> {
    const list = await db<BlocklistRow>('remote_blocklists').where({ id }).first();
    if (!list) throw new Error('Blocklist not found');
    if (list.source_type === 'oblitools') {
      await this.syncOblitools(list);
    } else {
      await this.syncUrl(list);
    }
  },
};
