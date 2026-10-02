import type { Knex } from 'knex';
import { db } from '../db';
import { appConfigService } from './appConfig.service';
import { logger } from '../utils/logger';
import { checkBanTarget } from '../utils/protectedIps';
import { parseIpOrCidr } from '../utils/ipValidation';
import { assertPublicHttpUrl, isPrivateAddress, SsrfRefusedError } from '../utils/ssrfGuard';
import { AppError } from '../middleware/errorHandler';
import { isMasterTenant, MASTER_TENANT_ID } from '@obliview/shared';

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

/** Fields update() accepts (anything else in the request body is ignored). */
export interface RemoteBlocklistPatch {
  name?: unknown;
  url?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
  syncInterval?: unknown;
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

// ── Limits ───────────────────────────────────────────────────────────────────

const SOURCE_TYPES = ['oblitools', 'url'] as const;
const NAME_MAX = 128;
const URL_MAX = 2048;
const API_KEY_MAX = 512;
const SYNC_INTERVAL_MIN = 60;
const SYNC_INTERVAL_MAX = 7 * 86_400;
const FETCH_TIMEOUT_MS = 30_000;
/** Largest body read from a remote list (bytes); a bigger answer fails the sync. */
const MAX_BODY_BYTES = 20 * 1024 * 1024;
/** Entries kept from one URL list; the rest is dropped with a warning. */
const MAX_URL_ENTRIES = 500_000;
const UPSERT_CHUNK = 500;
/** Suspicious IPs contributed per push (the most recently updated first). */
const MAX_PUSH_SUSPICIOUS = 5_000;
const OBLITOOLS_PUSH_URL = 'https://guard.obli.tools/blocklist/api/push';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Origin + path only: a list URL may carry a token in its query string,
 * which tenants without write access must not read.
 */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

function rowToBlocklist(row: BlocklistRow, opts: { redact?: boolean } = {}): RemoteBlocklist {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    url: opts.redact ? redactUrl(row.url) : row.url,
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

/**
 * Remote blocklists are an instance setting (owner decision 6): the Default
 * tenant sees and manages every list; any other tenant gets a read-only view
 * of the instance lists (NULL or Default-owned) plus its own legacy rows.
 * `column` is the qualified remote_blocklists.tenant_id column.
 */
function scopeLists<Q extends Knex.QueryBuilder>(q: Q, tenantId: number | null | undefined, column = 'tenant_id'): Q {
  if (isMasterTenant(tenantId)) return q;
  return q.where((w) => {
    w.whereNull(column).orWhere(column, MASTER_TENANT_ID);
    if (tenantId != null) w.orWhere(column, tenantId);
  }) as Q;
}

function badRequest(message: string): AppError {
  return new AppError(400, message);
}

function parseName(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw badRequest('name must be a non-empty string');
  const s = v.trim();
  if (s.length > NAME_MAX) throw badRequest(`name must be at most ${NAME_MAX} characters`);
  return s;
}

function parseUrlString(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw badRequest('url must be a non-empty string');
  const s = v.trim();
  if (s.length > URL_MAX) throw badRequest(`url must be at most ${URL_MAX} characters`);
  return s;
}

function parseApiKey(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw badRequest('apiKey must be a string');
  const s = v.trim();
  if (s.length > API_KEY_MAX) throw badRequest(`apiKey must be at most ${API_KEY_MAX} characters`);
  return s || null;
}

function parseSyncInterval(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < SYNC_INTERVAL_MIN || v > SYNC_INTERVAL_MAX) {
    throw badRequest(`syncInterval must be an integer between ${SYNC_INTERVAL_MIN} and ${SYNC_INTERVAL_MAX} seconds`);
  }
  return v;
}

/** SSRF screen of a user-supplied list URL: a refusal is a 400. */
async function assertListUrl(url: string): Promise<void> {
  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    if (err instanceof SsrfRefusedError) throw badRequest(err.message);
    throw err;
  }
}

/**
 * Outbound fetch of a remote list: SSRF screen right before the request
 * (DNS may have changed since the URL was saved; an unresolvable host is left
 * to fail in the request itself), no redirect following
 * (a 3xx could bounce onto an internal target), bounded time.
 */
async function guardedFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const url = await assertPublicHttpUrl(rawUrl, { allowUnresolved: true });
  const res = await fetch(url.toString(), {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new Error(`Refused redirect (HTTP ${res.status})`);
  }
  return res;
}

/** Response body as text, failing once it exceeds `max` bytes. */
async function readCapped(res: Response, max = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    throw new Error(`Response too large (${declared} bytes, max ${max})`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response too large (more than ${max} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A single public host address worth contributing to obli.tools, or null. */
function shareableHost(raw: string): string | null {
  const p = parseIpOrCidr(String(raw).replace(/\/\d+$/, ''));
  if (!p) return null;
  if (p.prefix !== (p.family === 4 ? 32 : 128)) return null;
  if (isPrivateAddress(p.address)) return null;
  return p.address;
}

// ── Service ──────────────────────────────────────────────────────────────────

export const remoteBlocklistService = {

  // ── CRUD blocklists ──────────────────────────────────────────────────────

  async list(tenantId: number | null | undefined): Promise<RemoteBlocklist[]> {
    const rows = await scopeLists(db<BlocklistRow>('remote_blocklists'), tenantId).orderBy('name') as BlocklistRow[];
    const redact = !isMasterTenant(tenantId);
    return rows.map((r) => rowToBlocklist(r, { redact }));
  },

  async getRow(id: number, tenantId: number | null | undefined): Promise<BlocklistRow | null> {
    const row = await scopeLists(db<BlocklistRow>('remote_blocklists').where({ id }), tenantId).first() as BlocklistRow | undefined;
    return row ?? null;
  },

  async create(data: {
    name: unknown;
    sourceType: unknown;
    url: unknown;
    apiKey?: unknown;
    syncInterval?: unknown;
    tenantId?: number | null;
  }): Promise<RemoteBlocklist> {
    const name = parseName(data.name);
    if (!SOURCE_TYPES.includes(data.sourceType as typeof SOURCE_TYPES[number])) {
      throw badRequest(`sourceType must be one of: ${SOURCE_TYPES.join(', ')}`);
    }
    const sourceType = data.sourceType as typeof SOURCE_TYPES[number];
    const url = parseUrlString(data.url);
    const apiKey = parseApiKey(data.apiKey);
    const syncInterval = data.syncInterval === undefined || data.syncInterval === null
      ? 600
      : parseSyncInterval(data.syncInterval);
    await assertListUrl(url);

    const [row] = await db<BlocklistRow>('remote_blocklists')
      .insert({
        name,
        source_type: sourceType,
        url,
        api_key: apiKey,
        sync_interval: syncInterval,
        tenant_id: data.tenantId ?? null,
      })
      .returning('*');
    return rowToBlocklist(row);
  },

  /**
   * Whitelisted fields only. Changing the URL without supplying a new key
   * drops the stored key: it must never be sent to a host it was not
   * entered for.
   */
  async update(id: number, tenantId: number | null | undefined, patch: RemoteBlocklistPatch): Promise<RemoteBlocklist | null> {
    const current = await this.getRow(id, tenantId);
    if (!current) return null;

    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (patch.name !== undefined) updateData.name = parseName(patch.name);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw badRequest('enabled must be a boolean');
      updateData.enabled = patch.enabled;
    }
    if (patch.syncInterval !== undefined) updateData.sync_interval = parseSyncInterval(patch.syncInterval);
    if (patch.apiKey !== undefined) updateData.api_key = parseApiKey(patch.apiKey);
    if (patch.url !== undefined) {
      const url = parseUrlString(patch.url);
      if (url !== current.url) {
        await assertListUrl(url);
        updateData.url = url;
        if (patch.apiKey === undefined) updateData.api_key = null;
      }
    }

    const [row] = await db<BlocklistRow>('remote_blocklists')
      .where({ id: current.id })
      .update(updateData)
      .returning('*');
    return row ? rowToBlocklist(row) : null;
  },

  async delete(id: number, tenantId: number | null | undefined): Promise<boolean> {
    const current = await this.getRow(id, tenantId);
    if (!current) return false;
    const count = await db('remote_blocklists').where({ id: current.id }).del();
    return count > 0;
  },

  // ── Remote IPs ───────────────────────────────────────────────────────────

  async listIps(filters: {
    tenantId: number | null | undefined;
    blocklistId?: number;
    search?: string;
    enabled?: boolean;
    limit: number;
    offset: number;
  }): Promise<{ data: RemoteBlockedIp[]; total: number }> {
    let q = scopeLists(
      db('remote_blocked_ips as ri')
        .join('remote_blocklists as bl', 'bl.id', 'ri.blocklist_id')
        .select(
          'ri.*',
          'bl.name as blocklist_name',
          'bl.source_type',
        ),
      filters.tenantId,
      'bl.tenant_id',
    );

    if (filters.blocklistId) q = q.where('ri.blocklist_id', filters.blocklistId);
    if (filters.enabled !== undefined) q = q.where('ri.enabled', filters.enabled);
    if (filters.search) q = q.whereRaw('ri.ip::text ILIKE ?', [`%${filters.search}%`]);

    const countResult = await q.clone().clearSelect().count('ri.id as count').first() as { count: string } | undefined;
    const total = Number(countResult?.count ?? 0);

    const rows = await q.orderBy('ri.last_seen', 'desc').limit(filters.limit).offset(filters.offset) as BlockedIpRow[];
    return { data: rows.map(rowToBlockedIp), total };
  },

  async toggleIp(id: number, enabled: boolean, tenantId: number | null | undefined): Promise<boolean> {
    const visible = scopeLists(
      db('remote_blocklists as bl').select('bl.id'),
      tenantId,
      'bl.tenant_id',
    );
    const count = await db('remote_blocked_ips')
      .where({ id })
      .whereIn('blocklist_id', visible)
      .update({ enabled });
    return count > 0;
  },

  async getStats(tenantId: number | null | undefined): Promise<{ total: number; enabled: number; sources: number; lastSync: string | null }> {
    const visible = () => scopeLists(db('remote_blocklists as bl').select('bl.id'), tenantId, 'bl.tenant_id');
    const total = await db('remote_blocked_ips').whereIn('blocklist_id', visible()).count('id as count').first() as { count: string };
    const enabled = await db('remote_blocked_ips').whereIn('blocklist_id', visible()).where({ enabled: true }).count('id as count').first() as { count: string };
    const sources = await scopeLists(db('remote_blocklists').where({ enabled: true }), tenantId).count('id as count').first() as { count: string };
    const lastSync = await scopeLists(db('remote_blocklists').whereNotNull('last_sync_at'), tenantId)
      .orderBy('last_sync_at', 'desc').select('last_sync_at').first() as { last_sync_at: Date } | undefined;
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
        await this.syncOne(list);
      } catch (err) {
        logger.error(err, `Failed to sync blocklist "${list.name}" (${list.id})`);
      }
    }
  },

  async syncOne(list: BlocklistRow): Promise<void> {
    if (list.source_type === 'oblitools') {
      await this.syncOblitools(list);
    } else {
      await this.syncUrl(list);
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

    const res = await guardedFetch(urlObj.toString(), {
      headers: { Authorization: `Bearer ${list.api_key}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await readCapped(res, 4096).catch(() => '')).slice(0, 200)}`);

    const body = JSON.parse(await readCapped(res)) as {
      ips?: Record<string, {
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
    let countRefused = 0;

    for (const [rawIp, data] of Object.entries(body.ips ?? {})) {
      const status = data.status ?? 'banned';

      // Same contract as every ban path: invalid, too broad, reserved and
      // protected entries are counted and skipped, never stored nor banned.
      const chk = await checkBanTarget(rawIp, { allowCidr: true });
      if (!chk.ok || (status === 'banned' && chk.target.isNetwork)) {
        countRefused++;
        continue;
      }
      const ip = chk.target.cidr;

      // Store in remote_blocked_ips (tracking/display)
      await db('remote_blocked_ips')
        .insert({
          blocklist_id: list.id,
          ip,
          reason: typeof data.reason === 'string' ? data.reason.slice(0, 256) : null,
          first_seen: data.first_seen ? new Date(data.first_seen) : new Date(),
          last_seen: data.last_seen ? new Date(data.last_seen) : new Date(),
          reports: typeof data.reports === 'number' && Number.isInteger(data.reports) ? data.reports : 1,
          sources: Array.isArray(data.sources) ? data.sources.map(String) : null,
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
        const existingBan = await db('ip_bans').whereRaw('ip = ?::inet', [chk.target.address]).where('is_active', true).first();
        if (!existingBan) {
          await db('ip_bans').insert({
            ip: chk.target.address,
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

    if (countRefused > 0) {
      logger.warn({ listId: list.id, refused: countRefused }, 'obli.tools sync: refused reserved/protected/invalid entries');
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
    const res = await guardedFetch(list.url, {
      headers: list.api_key ? { Authorization: `Bearer ${list.api_key}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await readCapped(res);
    const ips = new Set<string>();
    let refused = 0;
    let truncated = false;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      // Support CSV: take first column
      const raw = trimmed.split(/[,;\t ]/)[0].trim();
      // Same contract as every ban path (syntax, /16 v4 and /48 v6 floor,
      // reserved and protected): invalid entries are counted and skipped.
      const chk = await checkBanTarget(raw, { allowCidr: true });
      if (!chk.ok) { refused++; continue; }
      if (ips.size >= MAX_URL_ENTRIES) { truncated = true; break; }
      ips.add(chk.target.cidr);
    }
    if (refused > 0) {
      logger.warn({ listId: list.id, refused }, 'URL blocklist sync: refused invalid/reserved/protected/too broad entries');
    }
    if (truncated) {
      logger.warn({ listId: list.id, kept: MAX_URL_ENTRIES }, 'URL blocklist sync: list truncated');
    }

    // Batch upsert (entries are de-duplicated: one statement may not touch a row twice)
    const now = new Date();
    const all = [...ips];
    for (let i = 0; i < all.length; i += UPSERT_CHUNK) {
      const chunk = all.slice(i, i + UPSERT_CHUNK);
      await db('remote_blocked_ips')
        .insert(chunk.map((ip) => ({
          blocklist_id: list.id,
          ip,
          reason: 'blocklist',
          last_seen: now,
        })))
        .onConflict(['blocklist_id', 'ip'])
        .merge({ last_seen: now });
    }

    await db('remote_blocklists').where({ id: list.id }).update({
      last_sync_at: now,
      last_sync_count: all.length,
    });
    if (all.length > 0) logger.info(`Synced ${all.length} IPs from URL blocklist "${list.name}"`);
  },

  // ── Push engine (obli.tools contribution) ────────────────────────────────

  /**
   * Contributes this instance's own detections to obli.tools: active
   * engine auto-bans and suspicious IPs (failures, not banned, not
   * whitelisted) updated since the last successful push. Never re-shares
   * what came from elsewhere (remote lists, external apps, MikroTik
   * imports). Throws on failure; oblitools_last_push_at only advances on
   * success.
   */
  async pushNewBans(): Promise<string> {
    const pushEnabled = await appConfigService.get('oblitools_push_enabled');
    if (pushEnabled !== 'true') return 'Push is disabled. Enable "Share auto-bans" first.';

    const apiKey = await appConfigService.get('oblitools_api_key');
    if (!apiKey) return 'No API key configured.';

    const lastPushStr = await appConfigService.get('oblitools_last_push_at');
    const parsedLast = lastPushStr ? new Date(lastPushStr) : null;
    const lastPush = parsedLast && !Number.isNaN(parsedLast.getTime()) ? parsedLast : new Date(0);
    // The next window starts where this one was cut, so a ban created
    // while the push is in flight is not skipped.
    const pushStartedAt = new Date();

    const notFromRemote = (ipCol: string) =>
      db('remote_blocked_ips as rbi').select(db.raw('1')).whereRaw(`rbi.ip = ${ipCol}`);

    // 1. Engine auto-bans since the last push (local detections only)
    const newBans = await db('ip_bans as b')
      .where('b.ban_type', 'auto')
      .where('b.is_active', true)
      .where('b.banned_at', '>', lastPush)
      .where('b.banned_at', '<=', pushStartedAt)
      .whereNull('b.origin_app')
      .whereNull('b.cidr_prefix')
      .where((w) => {
        w.whereNull('b.reason').orWhere((r) => {
          r.whereNot('b.reason', 'like', 'obli.tools:%').whereNot('b.reason', 'like', 'MikroTik import:%');
        });
      })
      .whereNotExists(notFromRemote('b.ip'))
      .select(db.raw('host(b.ip) as ip'), 'b.reason') as { ip: string; reason: string | null }[];

    const bannedIps: { ip: string; reason: string; status: 'banned' }[] = [];
    const seen = new Set<string>();
    for (const b of newBans) {
      const ip = shareableHost(b.ip);
      if (!ip || seen.has(ip)) continue;
      seen.add(ip);
      bannedIps.push({ ip, reason: b.reason ?? 'auto_ban', status: 'banned' });
    }

    // 2. Suspicious IPs, computed like ipReputation.service (instance view:
    //    failures above 0, no active ban, not whitelisted), with at least one
    //    failure observed locally (not injected by an obli.tools pull or a
    //    MikroTik import).
    const suspiciousRows = await db('ip_reputation as r')
      .where('r.total_failures', '>', 0)
      .where('r.updated_at', '>', lastPush)
      .where('r.updated_at', '<=', pushStartedAt)
      .whereNotExists(
        db('ip_bans as b').select(db.raw('1'))
          .where('b.is_active', true)
          .whereRaw('set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip))) >>= r.ip'),
      )
      .whereNotExists(db('ip_whitelist as w').select(db.raw('1')).whereRaw('w.ip >>= r.ip'))
      .whereNotExists(notFromRemote('r.ip'))
      .whereExists(
        db('ip_events as e').select(db.raw('1'))
          .whereRaw('e.ip = r.ip')
          .where('e.event_type', 'auth_failure')
          .whereNot('e.service', 'oblitools_shared')
          .whereNot('e.service', 'like', 'mikrotik_import:%'),
      )
      .orderBy('r.updated_at', 'desc')
      .limit(MAX_PUSH_SUSPICIOUS)
      .select(db.raw('host(r.ip) as ip')) as { ip: string }[];

    const suspiciousIps: { ip: string; reason: string; status: 'suspicious' }[] = [];
    for (const r of suspiciousRows) {
      const ip = shareableHost(r.ip);
      if (!ip || seen.has(ip)) continue;
      seen.add(ip);
      suspiciousIps.push({ ip, reason: 'suspicious', status: 'suspicious' });
    }

    const allIps = [...bannedIps, ...suspiciousIps];
    if (allIps.length === 0) {
      await appConfigService.set('oblitools_last_push_at', pushStartedAt.toISOString());
      return `No new IPs to push since last push (${lastPushStr ?? 'never'}).`;
    }

    const instanceName = (await appConfigService.get('oblitools_instance_name')) || 'obliguard';

    let res: Response;
    try {
      res = await fetch(OBLITOOLS_PUSH_URL, {
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
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = `Push failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      throw new Error(msg);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = `Push failed: HTTP ${res.status}${body ? ' — ' + body.slice(0, 200) : ''}`;
      logger.error(msg);
      throw new Error(msg);
    }

    const ack = await res.json().catch(() => ({})) as { accepted?: number; new?: number };
    await appConfigService.set('oblitools_last_push_at', pushStartedAt.toISOString());
    const msg = `Pushed ${bannedIps.length} banned + ${suspiciousIps.length} suspicious — accepted: ${ack.accepted ?? '?'}, new: ${ack.new ?? '?'}`;
    logger.info(msg);
    return msg;
  },

  // ── Force sync a single blocklist ────────────────────────────────────────

  /** false when the list does not exist (or is not visible to `tenantId`). */
  async forceSync(id: number, tenantId: number | null | undefined): Promise<boolean> {
    const list = await this.getRow(id, tenantId);
    if (!list) return false;
    await this.syncOne(list);
    return true;
  },
};
