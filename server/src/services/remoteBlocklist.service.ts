import type { Knex } from 'knex';
import { db } from '../db';
import { appConfigService } from './appConfig.service';
import { logger } from '../utils/logger';
import { checkBanTarget } from '../utils/protectedIps';
import { parseIpOrCidr } from '../utils/ipValidation';
import type { BanTarget } from '../utils/ipValidation';
import { assertPublicHttpUrl, isPrivateAddress, SsrfRefusedError } from '../utils/ssrfGuard';
import { AppError } from '../middleware/errorHandler';
import { codedError, type ErrorCode, type ErrorParams } from '../utils/errorCodes';
import { liveAlertService, incidentStableKey } from './liveAlert.service';
import { isMasterTenant, MASTER_TENANT_ID } from '@obliview/shared';
import { banService } from './ban.service';

// ── Types ────────────────────────────────────────────────────────────────────

interface BlocklistRow {
  id: number;
  name: string;
  source_type: 'oblitools' | 'url';
  url: string;
  api_key: string | null;
  enabled: boolean;
  /** Create 'remote' bans from the list (migration 037). */
  enforce: boolean;
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
  /** The list creates global 'remote' bans (else its entries are only listed). */
  enforce: boolean;
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
  enforce?: unknown;
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
  /** 'banned' | 'suspicious' as reported by the source (migration 037). */
  status: string;
  created_at: Date;
  // Joined
  blocklist_name?: string;
  source_type?: string;
  list_enforce?: boolean;
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
  /** 'banned' | 'suspicious' as reported by the source. */
  status: string;
  /** The entry's list enforces (creates bans). */
  listEnforce: boolean;
  /** A ban is wanted for this entry: list enforcing, entry enabled and 'banned'. */
  enforced: boolean;
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
    enforce: row.enforce,
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
    status: row.status ?? 'banned',
    listEnforce: !!row.list_enforce,
    enforced: !!row.list_enforce && row.enabled && (row.status ?? 'banned') === 'banned',
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

function badRequest(code: ErrorCode, message: string, params?: ErrorParams): AppError {
  return codedError(400, code, message, params);
}

function parseName(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw badRequest('FIELD_REQUIRED', 'name must be a non-empty string', { field: 'name' });
  const s = v.trim();
  if (s.length > NAME_MAX) throw badRequest('FIELD_TOO_LONG', `name must be at most ${NAME_MAX} characters`, { field: 'name', max: NAME_MAX });
  return s;
}

function parseUrlString(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw badRequest('FIELD_REQUIRED', 'url must be a non-empty string', { field: 'url' });
  const s = v.trim();
  if (s.length > URL_MAX) throw badRequest('FIELD_TOO_LONG', `url must be at most ${URL_MAX} characters`, { field: 'url', max: URL_MAX });
  return s;
}

function parseApiKey(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw badRequest('FIELD_STRING', 'apiKey must be a string', { field: 'apiKey' });
  const s = v.trim();
  if (s.length > API_KEY_MAX) throw badRequest('FIELD_TOO_LONG', `apiKey must be at most ${API_KEY_MAX} characters`, { field: 'apiKey', max: API_KEY_MAX });
  return s || null;
}

function parseSyncInterval(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < SYNC_INTERVAL_MIN || v > SYNC_INTERVAL_MAX) {
    throw badRequest('FIELD_INTEGER_RANGE', `syncInterval must be an integer between ${SYNC_INTERVAL_MIN} and ${SYNC_INTERVAL_MAX} seconds`, { field: 'syncInterval', min: SYNC_INTERVAL_MIN, max: SYNC_INTERVAL_MAX });
  }
  return v;
}

/** SSRF screen of a user-supplied list URL: a refusal is a 400. */
async function assertListUrl(url: string): Promise<void> {
  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    if (err instanceof SsrfRefusedError) throw badRequest('BLOCKLIST_URL_REFUSED', err.message);
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

// ── Ban provenance (W9-1) ────────────────────────────────────────────────────

/** origin_ref of the 'remote' bans created from a list. */
export function blocklistOriginRef(listId: number): string {
  return `blocklist:${listId}`;
}

/** SQL: ban row `b` as a network, comparable with remote_blocked_ips.ip. */
const BAN_NETWORK_SQL = 'set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip)))';

/**
 * Bring a list's 'remote' bans in line with its entries (owner decision 6):
 *   - a list that does not enforce has no active ban (all lifted as
 *     'remote_sync', which sets no BanEngine watermark);
 *   - an enforcing list has one global ban per enabled 'banned' entry:
 *     bans whose entry is gone, disabled or now 'suspicious' are lifted,
 *     missing ones are created (banService.createRemoteBans: whitelisted
 *     entries and entries already covered by an active global ban skipped).
 * A disabled list (no sync) keeps its bans until it stops enforcing or is
 * deleted. Entries are re-checked like every ban target (the protected set
 * may have grown since they were stored). The stored enforce flag decides,
 * not the caller's copy: a sync started before an admin turned enforcement
 * off must not bring the list's bans back (a deleted list counts as off).
 */
async function reconcileListBans(list: Pick<BlocklistRow, 'id' | 'name' | 'tenant_id' | 'source_type'>): Promise<{ created: number; lifted: number }> {
  const ref = blocklistOriginRef(list.id);
  const stored = await db('remote_blocklists').where({ id: list.id }).first('enforce') as { enforce: boolean } | undefined;
  if (!stored?.enforce) return { created: 0, lifted: await banService.deactivateRemoteBans(ref) };

  const staleIds = await db('ip_bans as b')
    .where({ 'b.origin_ref': ref, 'b.ban_type': 'remote', 'b.is_active': true })
    .whereNotExists(
      db('remote_blocked_ips as ri').select(db.raw('1'))
        .where('ri.blocklist_id', list.id)
        .where('ri.enabled', true)
        .where('ri.status', 'banned')
        .whereRaw(`ri.ip = ${BAN_NETWORK_SQL}`),
    )
    .pluck('b.id') as number[];
  const lifted = (await banService.deactivateBans(staleIds, 'remote_sync')).length;

  const candidates = await db('remote_blocked_ips as ri')
    .where('ri.blocklist_id', list.id)
    .where('ri.enabled', true)
    .where('ri.status', 'banned')
    .whereNotExists(
      db('ip_bans as b').select(db.raw('1'))
        .where('b.is_active', true)
        .where('b.scope', 'global')
        .whereRaw(`${BAN_NETWORK_SQL} >>= ri.ip`),
    )
    .select(db.raw('ri.ip::text AS target'), 'ri.reason', 'ri.reports') as Array<{ target: string; reason: string | null; reports: number }>;

  const targets: Array<BanTarget & { reason: string }> = [];
  for (const c of candidates) {
    const chk = await checkBanTarget(c.target, { allowCidr: true, silent: true });
    if (!chk.ok) continue;
    const reason = list.source_type === 'oblitools'
      ? `obli.tools: ${c.reason ?? 'shared ban'} (${c.reports} reports)`
      : `Remote blocklist "${list.name}"`;
    targets.push({ ...chk.target, reason });
  }
  const created = await banService.createRemoteBans(targets, {
    originRef: ref,
    // Instance lists belong to the Default tenant.
    originTenantId: list.tenant_id ?? MASTER_TENANT_ID,
    reason: `Remote blocklist "${list.name}"`,
  });
  if (created > 0 || lifted > 0) {
    logger.info({ listId: list.id, created, lifted }, 'Remote blocklist: bans reconciled');
  }
  return { created, lifted };
}

/** reconcileListBans that logs instead of throwing (CRUD side effects). */
async function reconcileQuietly(list: Pick<BlocklistRow, 'id' | 'name' | 'tenant_id' | 'source_type'>): Promise<void> {
  try {
    await reconcileListBans(list);
  } catch (err) {
    logger.error({ err, listId: list.id }, 'Remote blocklist: ban reconciliation failed');
  }
}

// ── Sync failure alerts (W6-2) ───────────────────────────────────────────────

function syncFailureKey(listId: number): string {
  return incidentStableKey('blocklist_sync_failed', `list:${listId}`);
}

/**
 * Lists known to have no open sync alert (in memory): a healthy list costs
 * no live_alerts query per sync. Cleared for a list on failure; after a
 * restart the first successful sync checks once.
 */
const syncHealthy = new Set<number>();

/** Raise (or bump) the list's sync-failure incident. Never throws. */
async function reportSyncFailure(list: BlocklistRow, err: unknown): Promise<void> {
  syncHealthy.delete(list.id);
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  try {
    await liveAlertService.raiseIncident({
      // A platform list (tenant_id NULL) belongs to the Default tenant.
      tenantId: list.tenant_id ?? MASTER_TENANT_ID,
      kind: 'blocklist_sync_failed',
      stableKey: syncFailureKey(list.id),
      severity: 'warning',
      title: `Blocklist sync failed: ${list.name}`,
      message: `Remote blocklist "${list.name}" could not be synchronised: ${reason}`,
      link: '/settings',
    });
  } catch (e) {
    logger.warn({ err: e, listId: list.id }, 'Remote blocklist: sync failure alert failed');
  }
}

/** Resolve the list's sync-failure incident, if any. Never throws. */
async function resolveSyncFailure(listId: number): Promise<void> {
  if (syncHealthy.has(listId)) return;
  try {
    await liveAlertService.resolveIncidents({ stableKey: syncFailureKey(listId) });
    syncHealthy.add(listId);
  } catch (e) {
    logger.warn({ err: e, listId }, 'Remote blocklist: sync alert resolve failed');
  }
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
    enforce?: unknown;
    tenantId?: number | null;
  }): Promise<RemoteBlocklist> {
    const name = parseName(data.name);
    if (!SOURCE_TYPES.includes(data.sourceType as typeof SOURCE_TYPES[number])) {
      throw badRequest('FIELD_ONE_OF', `sourceType must be one of: ${SOURCE_TYPES.join(', ')}`, { field: 'sourceType', options: SOURCE_TYPES.join(', ') });
    }
    const sourceType = data.sourceType as typeof SOURCE_TYPES[number];
    const url = parseUrlString(data.url);
    const apiKey = parseApiKey(data.apiKey);
    const syncInterval = data.syncInterval === undefined || data.syncInterval === null
      ? 600
      : parseSyncInterval(data.syncInterval);
    // A new list only lists its entries until an admin turns enforcement on
    // (owner decision 6; the column default true only covers legacy rows).
    let enforce = false;
    if (data.enforce !== undefined && data.enforce !== null) {
      if (typeof data.enforce !== 'boolean') throw badRequest('FIELD_BOOLEAN', 'enforce must be a boolean', { field: 'enforce' });
      enforce = data.enforce;
    }
    await assertListUrl(url);

    const [row] = await db<BlocklistRow>('remote_blocklists')
      .insert({
        name,
        source_type: sourceType,
        url,
        api_key: apiKey,
        sync_interval: syncInterval,
        enforce,
        tenant_id: data.tenantId ?? null,
      })
      .returning('*');
    return rowToBlocklist(row);
  },

  /**
   * Whitelisted fields only. Changing the URL without supplying a new key
   * drops the stored key: it must never be sent to a host it was not
   * entered for. Turning `enforce` off lifts the list's bans at once;
   * turning it on creates them from the entries already synced.
   */
  async update(id: number, tenantId: number | null | undefined, patch: RemoteBlocklistPatch): Promise<RemoteBlocklist | null> {
    const current = await this.getRow(id, tenantId);
    if (!current) return null;

    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (patch.name !== undefined) updateData.name = parseName(patch.name);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw badRequest('FIELD_BOOLEAN', 'enabled must be a boolean', { field: 'enabled' });
      updateData.enabled = patch.enabled;
    }
    if (patch.enforce !== undefined) {
      if (typeof patch.enforce !== 'boolean') throw badRequest('FIELD_BOOLEAN', 'enforce must be a boolean', { field: 'enforce' });
      updateData.enforce = patch.enforce;
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
    if (!row) return null;
    if (row.enforce !== current.enforce) await reconcileQuietly(row);
    return rowToBlocklist(row);
  },

  async delete(id: number, tenantId: number | null | undefined): Promise<boolean> {
    const current = await this.getRow(id, tenantId);
    if (!current) return false;
    // Its bans go with it (entries cascade).
    await banService.deactivateRemoteBans(blocklistOriginRef(current.id));
    const count = await db('remote_blocklists').where({ id: current.id }).del();
    // A deleted list no longer fails: close its sync alert.
    if (count > 0) await resolveSyncFailure(current.id);
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
          'bl.enforce as list_enforce',
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
    const [entry] = await db('remote_blocked_ips')
      .where({ id })
      .whereIn('blocklist_id', visible)
      .update({ enabled })
      .returning('blocklist_id') as Array<{ blocklist_id: number }>;
    if (!entry) return false;
    // Applied at once on an enforcing list (ban created / lifted).
    const list = await db<BlocklistRow>('remote_blocklists').where({ id: entry.blocklist_id }).first();
    if (list?.enforce) await reconcileQuietly(list);
    return true;
  },

  async getStats(tenantId: number | null | undefined): Promise<{ total: number; enabled: number; enforced: number; sources: number; lastSync: string | null }> {
    const visible = () => scopeLists(db('remote_blocklists as bl').select('bl.id'), tenantId, 'bl.tenant_id');
    const total = await db('remote_blocked_ips').whereIn('blocklist_id', visible()).count('id as count').first() as { count: string };
    const enabled = await db('remote_blocked_ips').whereIn('blocklist_id', visible()).where({ enabled: true }).count('id as count').first() as { count: string };
    // Entries a ban is wanted for (enforcing list, enabled, 'banned').
    const enforced = await db('remote_blocked_ips')
      .whereIn('blocklist_id', visible().where('bl.enforce', true))
      .where({ enabled: true, status: 'banned' })
      .count('id as count').first() as { count: string };
    const sources = await scopeLists(db('remote_blocklists').where({ enabled: true }), tenantId).count('id as count').first() as { count: string };
    const lastSync = await scopeLists(db('remote_blocklists').whereNotNull('last_sync_at'), tenantId)
      .orderBy('last_sync_at', 'desc').select('last_sync_at').first() as { last_sync_at: Date } | undefined;
    return {
      total: Number(total?.count ?? 0),
      enabled: Number(enabled?.count ?? 0),
      enforced: Number(enforced?.count ?? 0),
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

  /**
   * Sync one list. A failure raises a 'blocklist_sync_failed' live alert of
   * the list's tenant (platform lists: Default), one per list; the next
   * successful sync resolves it. The error is rethrown.
   */
  async syncOne(list: BlocklistRow): Promise<void> {
    try {
      if (list.source_type === 'oblitools') {
        await this.syncOblitools(list);
      } else {
        await this.syncUrl(list);
      }
    } catch (err) {
      await reportSyncFailure(list, err);
      throw err;
    }
    await resolveSyncFailure(list.id);
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

      // Stored with the source's verdict: an enforcing list bans the
      // 'banned' entries only (reconcileListBans below).
      await db('remote_blocked_ips')
        .insert({
          blocklist_id: list.id,
          ip,
          status,
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
          status: db.raw('EXCLUDED.status'),
        });

      if (status === 'banned') {
        countBanned++;
      } else {
        // Suspicious: listed and shown in IP Reputation, never pre-loaded into
        // the BanEngine counters (an imported report is not a local failure;
        // the former ip_events injection never worked: string id into a
        // bigIncrements column).
        const { ipReputationService } = await import('./ipReputation.service');
        await ipReputationService.ensureExists(ip).catch(() => {});
        countSuspicious++;
      }
    }

    // Global 'remote' bans of the 'banned' entries, only when the list
    // enforces (owner decision 6).
    await reconcileListBans(list);

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
    if (ips.size === 0) {
      // An empty answer is more likely a transient upstream problem than an
      // emptied list: the entries (and their bans) are kept.
      logger.warn({ listId: list.id }, 'URL blocklist sync: empty list, entries kept');
    }
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

    // The list mirrors the source: entries it no longer serves are dropped
    // (their bans are lifted by the reconciliation).
    if (all.length > 0) {
      await db('remote_blocked_ips').where({ blocklist_id: list.id }).where('last_seen', '<', now).del();
    }
    await reconcileListBans(list);

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
      .whereNull('b.origin_ref')
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
