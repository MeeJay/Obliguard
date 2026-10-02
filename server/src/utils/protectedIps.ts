/**
 * Protected set: addresses that must never be banned, whatever the path.
 *
 *   - 'interface': every address of the server's own interfaces (checked for
 *     GLOBAL bans only — a tenant member cannot probe the internal Docker/LAN
 *     addresses, and they matter where the blast radius is fleet-wide);
 *   - 'origin':    the hosts of APP_URL / CLIENT_ORIGIN / SSO_ALLOWED_HOSTS
 *     (resolved through DNS, last known addresses kept on failure);
 *   - 'env':       BAN_PROTECTED_IPS (comma-separated IPs / subnets);
 *   - 'infra':     the public addresses of APPROVED agents and of approved
 *     MikroTik routers (API host / syslog source literals), per tenant:
 *     every one for a global ban, the tenant's own for a scoped ban. Loaded
 *     from the database by refreshInfraAddresses() (BanEngine cycle, ban
 *     creation paths); the check itself never queries.
 *
 * On top of it, NON_PUBLIC_RANGES (RFC 1918, CGNAT, loopback, link-local,
 * ULA, multicast...) are never a ban target, whatever the scope: an internal
 * host brute-forcing an agent must not turn into a fleet-wide (or LAN-wide)
 * block. Documentation and benchmark ranges count as public here.
 *
 * checkBanTarget() is the mandatory contract for every path that creates a
 * ban (manual, promote, auto-ban, external, obli.tools, MikroTik import).
 * Never put a protected address in an HTTP response: a refusal uses
 * RESERVED_OR_PROTECTED_MESSAGE, identical to the reserved-range one.
 */
import os from 'node:os';
import dns from 'node:dns';
import { logger } from './logger';
import {
  parseIpOrCidr, parseBanTarget, cidrOverlaps, RESERVED_OR_PROTECTED_MESSAGE,
} from './ipValidation';
import type { ParsedCidr, BanTargetResult } from './ipValidation';
import { configuredPublicOrigins } from './publicOrigin';

type Source = 'interface' | 'origin' | 'env';
interface ProtectedEntry { cidr: ParsedCidr; source: Source }

/** Never a ban target, whatever the scope (see the header). */
export const NON_PUBLIC_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
] as const;

const NON_PUBLIC_PARSED: ParsedCidr[] = NON_PUBLIC_RANGES.map((r) => {
  const p = parseIpOrCidr(r);
  if (!p) throw new Error(`protectedIps: bad non-public range ${r}`);
  return p;
});

/** True when the target overlaps a non-public range (private, CGNAT, ULA...). */
export function isNonPublicTarget(p: ParsedCidr): boolean {
  return NON_PUBLIC_PARSED.some((r) => cidrOverlaps(r, p));
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const DNS_TIMEOUT_MS = 3000;

let cache: { entries: ProtectedEntry[]; at: number } | null = null;
let inflight: Promise<ProtectedEntry[]> | null = null;
/** Last successful resolution per origin host (kept when a later lookup fails). */
const hostCache = new Map<string, ParsedCidr[]>();
const warnedEnv = new Set<string>();

function interfaceEntries(): ProtectedEntry[] {
  const out: ProtectedEntry[] = [];
  let ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
  try { ifaces = os.networkInterfaces(); } catch { /* ignore */ }
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      const p = parseIpOrCidr(i.address);
      if (p) out.push({ cidr: p, source: 'interface' });
    }
  }
  return out;
}

async function lookupWithTimeout(host: string): Promise<ParsedCidr[]> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const res = await Promise.race([
      dns.promises.lookup(host, { all: true, verbatim: true }),
      timeout,
    ]) as Array<{ address: string }>;
    const out: ParsedCidr[] = [];
    for (const r of res) {
      const p = parseIpOrCidr(r.address);
      if (p) out.push(p);
    }
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function originEntries(): Promise<ProtectedEntry[]> {
  const hosts = new Set<string>();
  for (const e of configuredPublicOrigins().entries) {
    const h = e.hostname.replace(/^\[|\]$/g, '').trim();
    if (h) hosts.add(h);
  }
  const out: ProtectedEntry[] = [];
  await Promise.all([...hosts].map(async (host) => {
    const literal = parseIpOrCidr(host);
    if (literal) { out.push({ cidr: literal, source: 'origin' }); return; }
    try {
      const addrs = await lookupWithTimeout(host);
      hostCache.set(host, addrs);
    } catch (err) {
      logger.warn({ host, err: err instanceof Error ? err.message : String(err) }, 'Protected IPs: lookup failed, keeping the last known addresses');
    }
    for (const p of hostCache.get(host) ?? []) out.push({ cidr: p, source: 'origin' });
  }));
  return out;
}

function envEntries(): ProtectedEntry[] {
  const raw = process.env.BAN_PROTECTED_IPS ?? '';
  const out: ProtectedEntry[] = [];
  const bad: string[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const p = parseIpOrCidr(s);
    if (!p || p.prefix < (p.family === 4 ? 8 : 32)) { bad.push(s); continue; }
    out.push({ cidr: p, source: 'env' });
  }
  if (bad.length && !warnedEnv.has(raw)) {
    warnedEnv.add(raw);
    logger.warn({ ignored: bad }, 'BAN_PROTECTED_IPS: invalid or too broad entries ignored');
  }
  return out;
}

async function refresh(): Promise<ProtectedEntry[]> {
  const merged = [...interfaceEntries(), ...envEntries(), ...(await originEntries())];
  const seen = new Set<string>();
  const entries: ProtectedEntry[] = [];
  for (const e of merged) {
    const key = `${e.source}|${e.cidr.address}/${e.cidr.prefix}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(e);
  }
  cache = { entries, at: Date.now() };
  return entries;
}

// ── Infra addresses (approved agents and routers) ───────────────────────────

interface InfraEntry { cidr: ParsedCidr; tenantId: number }

const INFRA_TTL_MS = 60 * 1000;
let infra: { entries: InfraEntry[]; at: number } | null = null;
let infraInflight: Promise<InfraEntry[]> | null = null;

/**
 * Reload the public addresses of approved agents (the address their pushes
 * come from) and of approved MikroTik routers (literal API host / syslog
 * source). Pending devices never count: an unapproved key holder must not be
 * able to make its own address unbannable. Returns the entry count.
 */
export async function refreshInfraAddresses(): Promise<number> {
  if (!infraInflight) {
    infraInflight = (async () => {
      // Lazy: the pure checks (and their tests) never load the database.
      const { db } = await import('../db');
      const devices = await db('agent_devices')
        .where('status', 'approved')
        .whereNotNull('ip')
        .select('ip', 'tenant_id') as Array<{ ip: string; tenant_id: number }>;
      const routers = await db('mikrotik_credentials as m')
        .join('agent_devices as d', 'd.id', 'm.device_id')
        .where('d.status', 'approved')
        .select('m.api_host', 'm.syslog_identifier', 'd.tenant_id') as
        Array<{ api_host: string | null; syslog_identifier: string | null; tenant_id: number }>;
      const seen = new Set<string>();
      const entries: InfraEntry[] = [];
      const add = (raw: string | null, tenantId: number) => {
        const p = parseIpOrCidr(String(raw ?? '').trim().replace(/^\[|\]$/g, ''));
        // Full-length public addresses only (a private one is non-public anyway).
        if (!p || p.prefix !== (p.family === 4 ? 32 : 128) || isNonPublicTarget(p)) return;
        const key = `${tenantId}|${p.address}`;
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ cidr: p, tenantId: Number(tenantId) });
      };
      for (const d of devices) add(d.ip, d.tenant_id);
      for (const r of routers) {
        add(r.api_host, r.tenant_id);
        add(r.syslog_identifier, r.tenant_id);
      }
      infra = { entries, at: Date.now() };
      return entries;
    })().finally(() => { infraInflight = null; });
  }
  return (await infraInflight).length;
}

/** Refresh the infra addresses when stale. Never throws: the last list is kept. */
export async function ensureInfraFresh(): Promise<void> {
  if (infra && Date.now() - infra.at < INFRA_TTL_MS) return;
  try {
    await refreshInfraAddresses();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Protected IPs: infra address refresh failed, keeping the last list');
  }
}

async function getEntries(): Promise<ProtectedEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;
  if (!inflight) {
    inflight = refresh().finally(() => { inflight = null; });
  }
  return inflight;
}

/** The whole protected set (never to be sent in an HTTP response). */
export async function getProtectedAddresses(): Promise<ParsedCidr[]> {
  return (await getEntries()).map((e) => e.cidr);
}

/**
 * First protected entry overlapping `t`, or null. `includeInterfaces: false`
 * (tenant, group and agent bans) skips the server's interface addresses and
 * the infra addresses of any tenant but `tenantId`.
 * `silent: true` skips the per-hit warning (periodic audit).
 */
export async function findProtectedConflict(
  t: ParsedCidr,
  opts: { includeInterfaces?: boolean; silent?: boolean; tenantId?: number | null } = {},
): Promise<ParsedCidr | null> {
  const includeInterfaces = opts.includeInterfaces ?? true;
  for (const e of await getEntries()) {
    if (!includeInterfaces && e.source === 'interface') continue;
    if (cidrOverlaps(e.cidr, t)) {
      // silent: the periodic banSafetyAudit logs its own (change-only) summary.
      if (!opts.silent) logger.warn({ target: t, protected: e.cidr }, 'Refused ban on a protected address');
      return e.cidr;
    }
  }
  for (const e of infra?.entries ?? []) {
    if (!includeInterfaces && (opts.tenantId == null || e.tenantId !== Number(opts.tenantId))) continue;
    if (cidrOverlaps(e.cidr, t)) {
      if (!opts.silent) logger.warn({ target: t, protected: e.cidr, source: 'infra' }, 'Refused ban on a protected address');
      return e.cidr;
    }
  }
  return null;
}

/**
 * Non-public range, then protected set, for an already parsed target.
 * `global` selects the fleet-wide checks (interfaces, every tenant's infra);
 * a scoped ban passes its owning `tenantId`. Every refusal is logged
 * (BanSafety) unless `silent`.
 */
export async function findBanSafetyConflict(
  t: ParsedCidr,
  opts: { global: boolean; tenantId?: number | null; silent?: boolean },
): Promise<'reserved' | 'protected' | null> {
  if (isNonPublicTarget(t)) {
    if (!opts.silent) logger.warn({ target: t, global: opts.global }, 'BanSafety: refused ban on a non-public address');
    return 'reserved';
  }
  if (await findProtectedConflict(t, { includeInterfaces: opts.global, tenantId: opts.tenantId, silent: opts.silent })) {
    return 'protected';
  }
  return null;
}

/**
 * The contract of every path that creates a ban: parseBanTarget (syntax,
 * floor, reserved ranges), the non-public ranges, then the protected set.
 * `includeInterfaces` (default true) means a global ban; a scoped one passes
 * false and its owning `tenantId`. `silent`: the caller logs (throttled).
 */
export async function checkBanTarget(
  raw: unknown,
  opts: { allowCidr?: boolean; includeInterfaces?: boolean; tenantId?: number | null; silent?: boolean } = {},
): Promise<BanTargetResult> {
  const r = parseBanTarget(raw, { allowCidr: opts.allowCidr });
  if (!r.ok) return r;
  const conflict = await findBanSafetyConflict(r.target, {
    global: opts.includeInterfaces ?? true, tenantId: opts.tenantId, silent: opts.silent,
  });
  if (conflict) return { ok: false, code: conflict, message: RESERVED_OR_PROTECTED_MESSAGE };
  return r;
}

/** Tests only: drop the merged cache (and, with `dns: true`, the per-host resolutions). */
export function __resetProtectedCacheForTests(opts: { dns?: boolean } = {}): void {
  cache = null;
  inflight = null;
  infra = null;
  warnedEnv.clear();
  if (opts.dns) hostCache.clear();
}
