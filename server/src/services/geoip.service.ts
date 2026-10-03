import { logger } from '../utils/logger';
import { parseIpOrCidr, cidrContains } from '../utils/ipValidation';
import type { ParsedCidr } from '../utils/ipValidation';
import { isPrivateAddress } from '../utils/ssrfGuard';

/**
 * GeoIP lookups for attacker IPs (ip_reputation country / city / ASN, NetMap
 * badges). Modelled on Obliance's geolocation.service (cache, rate limit,
 * private-IP skip), with a pluggable provider chosen by environment:
 *
 *   GEOIP_PROVIDER = mmdb    local MaxMind / DB-IP .mmdb file (GEOIP_DB_PATH,
 *                            optional GEOIP_ASN_DB_PATH): nothing leaves the box
 *                  | ip-api  ip-api.com batch endpoint (default when no
 *                            GEOIP_DB_PATH). Free tier is plain HTTP; set
 *                            GEOIP_IPAPI_KEY to use the HTTPS pro endpoint
 *                  | none    disabled
 *   unset: mmdb when GEOIP_DB_PATH is set, ip-api otherwise.
 *
 * Private, reserved and documentation addresses are never looked up, so they
 * never reach a third party. Results (hits AND misses) are kept in an
 * in-memory LRU (10 000 entries, 7 days); transient failures are not cached.
 */

export interface GeoInfo {
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string | null;
  city: string | null;
  /** "AS15169 Google LLC" (ip-api `as` format). */
  asn: string | null;
}

export interface GeoProvider {
  readonly name: string;
  /** Max IPs per lookup() call. */
  readonly maxBatch: number;
  /** False while the provider must not be called (rate limit, backoff, not ready). */
  available(): boolean;
  /** True once the provider can never answer (e.g. unreadable mmdb): GeoIP is then off. */
  disabled?(): boolean;
  /**
   * Resolve `ips` (normalized public addresses). The map holds an entry per
   * IP the provider answered for: GeoInfo for a hit, null for "unknown".
   * Throws on a transient failure (nothing is cached then).
   */
  lookup(ips: string[]): Promise<Map<string, GeoInfo | null>>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_MAX = 10_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
/** ip-api.com documents 15 req/min for /batch on the free tier (45 for /json). */
const IPAPI_DEFAULT_PER_MIN = 15;
const IPAPI_TIMEOUT_MS = 6000;
/** Pause after a provider error or an HTTP 429 without X-Ttl. */
const ERROR_BACKOFF_MS = 60_000;

const COUNTRY_RE = /^[A-Za-z]{2}$/;

// ── Address filter ────────────────────────────────────────────────────────────

/**
 * Ranges never sent to a provider on top of ssrfGuard's private set:
 * benchmark / documentation / IETF-protocol blocks, and every IPv6 address
 * outside global unicast (2000::/3).
 */
const NON_GEO_RANGES = [
  '192.0.0.0/24',     // IETF protocol assignments
  '192.0.2.0/24',     // TEST-NET-1
  '198.18.0.0/15',    // benchmarking
  '198.51.100.0/24',  // TEST-NET-2
  '203.0.113.0/24',   // TEST-NET-3
  '2001:db8::/32',    // IPv6 documentation
] as const;

const NON_GEO_PARSED: ParsedCidr[] = NON_GEO_RANGES.map((r) => {
  const p = parseIpOrCidr(r);
  if (!p) throw new Error(`geoip: bad range ${r}`);
  return p;
});
const V6_GLOBAL_UNICAST = parseIpOrCidr('2000::/3') as ParsedCidr;

/**
 * Normalized address when `ip` is a single public host worth a lookup,
 * null for anything else (CIDR, private, reserved, documentation, garbage).
 */
export function geoLookupCandidate(ip: unknown): string | null {
  const p = parseIpOrCidr(ip);
  if (!p) return null;
  if (p.prefix !== (p.family === 4 ? 32 : 128)) return null;
  if (isPrivateAddress(p.address)) return null;
  if (p.family === 6 && !cidrContains(V6_GLOBAL_UNICAST, p)) return null;
  if (NON_GEO_PARSED.some((r) => cidrContains(r, p))) return null;
  return p.address;
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s.slice(0, max) : null;
}

/** Shape a raw provider answer into column-safe values (null when empty). */
function toGeoInfo(countryCode: unknown, city: unknown, asn: unknown): GeoInfo | null {
  const cc = typeof countryCode === 'string' && COUNTRY_RE.test(countryCode) ? countryCode.toUpperCase() : null;
  const info: GeoInfo = { countryCode: cc, city: clean(city, 100), asn: clean(asn, 200) };
  return info.countryCode || info.city || info.asn ? info : null;
}

// ── ip-api.com provider ───────────────────────────────────────────────────────

interface IpApiRow {
  status?: string;
  query?: string;
  countryCode?: string;
  city?: string;
  as?: string;
}

class IpApiProvider implements GeoProvider {
  readonly name = 'ip-api';
  readonly maxBatch = 100;
  private readonly perMinute: number;
  private readonly url: string;
  private stamps: number[] = [];
  private pausedUntil = 0;

  constructor(env: NodeJS.ProcessEnv) {
    const n = Number(env.GEOIP_RATE_LIMIT_PER_MIN);
    this.perMinute = Number.isInteger(n) && n > 0 ? n : IPAPI_DEFAULT_PER_MIN;
    const key = (env.GEOIP_IPAPI_KEY ?? '').trim();
    const fields = 'fields=status,query,countryCode,city,as';
    this.url = key
      ? `https://pro.ip-api.com/batch?${fields}&key=${encodeURIComponent(key)}`
      : `http://ip-api.com/batch?${fields}`;
  }

  available(): boolean {
    const now = Date.now();
    if (now < this.pausedUntil) return false;
    this.stamps = this.stamps.filter((t) => now - t < RATE_WINDOW_MS);
    return this.stamps.length < this.perMinute;
  }

  private pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  async lookup(ips: string[]): Promise<Map<string, GeoInfo | null>> {
    this.stamps.push(Date.now());
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ips),
        redirect: 'manual',
        signal: AbortSignal.timeout(IPAPI_TIMEOUT_MS),
      });
    } catch (err) {
      this.pause(ERROR_BACKOFF_MS);
      throw err;
    }

    // X-Rl = requests left in the window, X-Ttl = seconds until it resets.
    const ttl = Number(res.headers.get('x-ttl'));
    const left = res.headers.get('x-rl');
    if (left !== null && Number(left) <= 0 && Number.isFinite(ttl)) this.pause((ttl + 1) * 1000);
    if (res.status === 429) {
      this.pause(Number.isFinite(ttl) && ttl > 0 ? (ttl + 1) * 1000 : ERROR_BACKOFF_MS);
      throw new Error('ip-api rate limited (429)');
    }
    if (!res.ok) {
      this.pause(ERROR_BACKOFF_MS);
      throw new Error(`ip-api HTTP ${res.status}`);
    }

    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) throw new Error('ip-api: unexpected batch response');
    const out = new Map<string, GeoInfo | null>();
    raw.forEach((row: IpApiRow, i) => {
      const asked = ips[i];
      if (!asked || !row || typeof row !== 'object') return;
      out.set(asked, row.status === 'success' ? toGeoInfo(row.countryCode, row.city, row.as) : null);
    });
    return out;
  }
}

// ── Local mmdb provider ───────────────────────────────────────────────────────

interface MmdbRecord {
  country?: { iso_code?: string };
  registered_country?: { iso_code?: string };
  city?: { names?: { en?: string } };
  traits?: { autonomous_system_number?: number; autonomous_system_organization?: string };
  autonomous_system_number?: number;
  autonomous_system_organization?: string;
}

interface MmdbReader { get(ip: string): MmdbRecord | null }

function asnLabel(num: unknown, org: unknown): string | null {
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  return typeof org === 'string' && org.trim() ? `AS${num} ${org.trim()}` : `AS${num}`;
}

class MmdbProvider implements GeoProvider {
  readonly name = 'mmdb';
  readonly maxBatch = 1000;
  private main: MmdbReader | null = null;
  private asnDb: MmdbReader | null = null;
  private failed = false;
  readonly ready: Promise<void>;

  constructor(private readonly dbPath: string, private readonly asnPath: string | null) {
    this.ready = this.open();
  }

  private async open(): Promise<void> {
    try {
      const { open } = await import('maxmind');
      const opts = { watchForUpdates: true, watchForUpdatesNonPersistent: true };
      this.main = await open<any>(this.dbPath, opts) as MmdbReader;
      logger.info({ db: this.dbPath }, 'GeoIP: local mmdb loaded');
      if (!this.asnPath) return;
      try {
        this.asnDb = await open<any>(this.asnPath, opts) as MmdbReader;
        logger.info({ asnDb: this.asnPath }, 'GeoIP: local ASN mmdb loaded');
      } catch (err) {
        // The ASN database is optional: country / city keep working without it.
        logger.warn({ err, asnDb: this.asnPath }, 'GeoIP: ASN mmdb unavailable, ASN left empty');
      }
    } catch (err) {
      this.failed = true;
      logger.error({ err, db: this.dbPath }, 'GeoIP: mmdb unavailable, lookups disabled');
    }
  }

  available(): boolean {
    return this.main !== null && !this.failed;
  }

  disabled(): boolean {
    return this.failed;
  }

  async lookup(ips: string[]): Promise<Map<string, GeoInfo | null>> {
    await this.ready;
    const out = new Map<string, GeoInfo | null>();
    if (!this.main) return out;
    for (const ip of ips) {
      const rec = this.main.get(ip);
      const asnRec = this.asnDb?.get(ip) ?? null;
      const asn = asnLabel(asnRec?.autonomous_system_number, asnRec?.autonomous_system_organization)
        ?? asnLabel(rec?.traits?.autonomous_system_number, rec?.traits?.autonomous_system_organization)
        ?? asnLabel(rec?.autonomous_system_number, rec?.autonomous_system_organization);
      out.set(ip, toGeoInfo(
        rec?.country?.iso_code ?? rec?.registered_country?.iso_code,
        rec?.city?.names?.en,
        asn,
      ));
    }
    return out;
  }
}

// ── Provider selection ────────────────────────────────────────────────────────

/** Build the provider named by the environment; null = GeoIP disabled. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): GeoProvider | null {
  let mode = (env.GEOIP_PROVIDER ?? '').trim().toLowerCase();
  const dbPath = (env.GEOIP_DB_PATH ?? '').trim();
  const asnPath = (env.GEOIP_ASN_DB_PATH ?? '').trim() || null;
  if (mode && !['mmdb', 'ip-api', 'ipapi', 'none', 'off', 'disabled'].includes(mode)) {
    logger.warn({ provider: mode }, 'GeoIP: unknown GEOIP_PROVIDER, using the default');
    mode = '';
  }
  if (mode === 'none' || mode === 'off' || mode === 'disabled') return null;
  if (mode === 'mmdb' || (!mode && dbPath)) {
    if (!dbPath) {
      // An explicit mmdb choice never falls back to a third party.
      logger.error('GeoIP: GEOIP_PROVIDER=mmdb without GEOIP_DB_PATH, mmdb unavailable, lookups disabled');
      return null;
    }
    return new MmdbProvider(dbPath, asnPath);
  }
  return new IpApiProvider(env);
}

// ── Service ───────────────────────────────────────────────────────────────────

interface CacheEntry { info: GeoInfo | null; at: number }

class GeoipService {
  private provider: GeoProvider | null | undefined;
  private cache = new Map<string, CacheEntry>();

  private current(): GeoProvider | null {
    if (this.provider === undefined) this.provider = providerFromEnv();
    return this.provider;
  }

  /** Active provider name ('none' when disabled). */
  get providerName(): string {
    return this.current()?.name ?? 'none';
  }

  /** False when no provider is configured or it can never answer (broken mmdb). */
  isEnabled(): boolean {
    const p = this.current();
    return p !== null && !p.disabled?.();
  }

  /**
   * Replace the provider (tests inject a fake). `undefined` re-reads the
   * environment on next use. Always empties the cache.
   */
  setProvider(provider: GeoProvider | null | undefined): void {
    this.provider = provider;
    this.cache.clear();
  }

  clearCache(): void {
    this.cache.clear();
  }

  // LRU: a Map keeps insertion order; a hit is re-inserted at the tail.
  private cached(ip: string): CacheEntry | undefined {
    const e = this.cache.get(ip);
    if (!e) return undefined;
    this.cache.delete(ip);
    if (Date.now() - e.at > CACHE_TTL_MS) return undefined;
    this.cache.set(ip, e);
    return e;
  }

  private remember(ip: string, info: GeoInfo | null): void {
    this.cache.delete(ip);
    while (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(ip, { info, at: Date.now() });
  }

  /** True when `ip` (normalized) is cached as unknown to the provider. */
  isKnownMiss(ip: string): boolean {
    const e = this.cached(ip);
    return e !== undefined && e.info === null;
  }

  /**
   * Resolve up to any number of IPs: non-candidates are dropped, the cache
   * answers first, the rest goes to the provider in batches while it is
   * available. Keys are the normalized addresses; a value is GeoInfo (hit) or
   * null (provider does not know it). An IP left out of the map is unresolved
   * for now (disabled, rate limited or transient failure): retry later.
   */
  async lookupMany(ips: Iterable<string>): Promise<Map<string, GeoInfo | null>> {
    const out = new Map<string, GeoInfo | null>();
    const provider = this.current();
    const todo: string[] = [];
    const seen = new Set<string>();
    for (const raw of ips) {
      const ip = geoLookupCandidate(raw);
      if (!ip || seen.has(ip)) continue;
      seen.add(ip);
      const hit = this.cached(ip);
      if (hit) out.set(ip, hit.info);
      else todo.push(ip);
    }
    if (!provider || todo.length === 0) return out;

    if (provider instanceof MmdbProvider) await provider.ready;
    if (provider.disabled?.()) return out;
    for (let i = 0; i < todo.length; i += provider.maxBatch) {
      if (!provider.available()) {
        logger.debug({ provider: provider.name, left: todo.length - i }, 'GeoIP: provider unavailable, lookups deferred');
        break;
      }
      const chunk = todo.slice(i, i + provider.maxBatch);
      try {
        const got = await provider.lookup(chunk);
        for (const ip of chunk) {
          if (!got.has(ip)) continue;
          const info = got.get(ip) ?? null;
          this.remember(ip, info);
          out.set(ip, info);
        }
      } catch (err) {
        logger.warn({ err, provider: provider.name, count: chunk.length }, 'GeoIP lookup failed');
        break;
      }
    }
    return out;
  }
}

export const geoipService = new GeoipService();
