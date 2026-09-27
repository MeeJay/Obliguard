/**
 * Protected set: addresses that must never be banned, whatever the path.
 *
 *   - 'interface': every address of the server's own interfaces (checked for
 *     GLOBAL bans only — a tenant member cannot probe the internal Docker/LAN
 *     addresses, and they matter where the blast radius is fleet-wide);
 *   - 'origin':    the hosts of APP_URL / CLIENT_ORIGIN / SSO_ALLOWED_HOSTS
 *     (resolved through DNS, last known addresses kept on failure);
 *   - 'env':       BAN_PROTECTED_IPS (comma-separated IPs / subnets).
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
 * (tenant, group and agent bans) skips the server's interface addresses.
 * `silent: true` skips the per-hit warning (periodic audit).
 */
export async function findProtectedConflict(
  t: ParsedCidr,
  opts: { includeInterfaces?: boolean; silent?: boolean } = {},
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
  return null;
}

/**
 * The contract of every path that creates a ban: parseBanTarget (syntax,
 * floor, reserved ranges), then the protected set.
 */
export async function checkBanTarget(
  raw: unknown,
  opts: { allowCidr?: boolean; includeInterfaces?: boolean } = {},
): Promise<BanTargetResult> {
  const r = parseBanTarget(raw, { allowCidr: opts.allowCidr });
  if (!r.ok) return r;
  if (await findProtectedConflict(r.target, { includeInterfaces: opts.includeInterfaces ?? true })) {
    return { ok: false, code: 'protected', message: RESERVED_OR_PROTECTED_MESSAGE };
  }
  return r;
}

/** Tests only: drop the merged cache (and, with `dns: true`, the per-host resolutions). */
export function __resetProtectedCacheForTests(opts: { dns?: boolean } = {}): void {
  cache = null;
  inflight = null;
  warnedEnv.clear();
  if (opts.dns) hostCache.clear();
}
