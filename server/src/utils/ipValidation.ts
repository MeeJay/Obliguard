/**
 * Strict IP / CIDR validation for ban targets. Pure: no DB, no DNS.
 *
 *   - parseIpOrCidr(): strict syntax only (canonical, host bits masked);
 *   - parseBanTarget(): syntax + policy (subnet allowed?, prefix floor,
 *     reserved ranges);
 *   - protectedIps.checkBanTarget() adds the protected set on top: it is the
 *     contract every path that creates a ban must use.
 *
 * agent/bansafety.go (D9.3) must mirror RESERVED_BAN_RANGES and the floors.
 */
import net from 'node:net';
import { logger } from './logger';

export type IpFamily = 4 | 6;

export interface ParsedCidr {
  /** Canonical address, host bits masked, never contains '/'. */
  address: string;
  family: IpFamily;
  prefix: number;
}

export interface BanTarget extends ParsedCidr {
  isNetwork: boolean;
  /** `${address}/${prefix}` for a network, the bare address for a host. */
  cidr: string;
}

export type BanTargetErrorCode = 'invalid' | 'cidr_not_allowed' | 'too_broad' | 'reserved' | 'protected';

export type BanTargetResult =
  | { ok: true; target: BanTarget }
  | { ok: false; code: BanTargetErrorCode; message: string };

export const DEFAULT_BAN_MIN_PREFIX_V4 = 16;
export const DEFAULT_BAN_MIN_PREFIX_V6 = 48;

/**
 * One message for reserved ranges AND protected addresses: a refusal never
 * tells which one it was (no oracle on the server's own addresses).
 */
export const RESERVED_OR_PROTECTED_MESSAGE = 'Reserved or protected address: it cannot be banned';

export const RESERVED_BAN_RANGES = [
  '0.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fe80::/10',
  'ff00::/8',
] as const;

// ── BigInt helpers ───────────────────────────────────────────────────────────

const V4_OCTET_RE = /^(0|[1-9][0-9]{0,2})$/;
const PREFIX_RE = /^(0|[1-9][0-9]{0,2})$/;

function bits(family: IpFamily): number {
  return family === 4 ? 32 : 128;
}

function v4ToBigInt(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!V4_OCTET_RE.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function v6ToBigInt(raw: string): bigint | null {
  let s = raw.toLowerCase();
  // A trailing dotted IPv4 fills the last two hextets.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = v4ToBigInt(tail);
    if (v4 == null) return null;
    const hi = Number((v4 >> 16n) & 0xffffn).toString(16);
    const lo = Number(v4 & 0xffffn).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  let groups: string[];
  const dbl = s.indexOf('::');
  if (dbl >= 0) {
    const leftS = s.slice(0, dbl);
    const rightS = s.slice(dbl + 2);
    const left = leftS ? leftS.split(':') : [];
    const right = rightS ? rightS.split(':') : [];
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    groups = [...left, ...Array<string>(fill).fill('0'), ...right];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

function maskOf(family: IpFamily, prefix: number): bigint {
  const total = BigInt(bits(family));
  if (prefix <= 0) return 0n;
  const all = (1n << total) - 1n;
  return (all >> (total - BigInt(prefix))) << (total - BigInt(prefix));
}

function renderV4(v: bigint): string {
  return [24n, 16n, 8n, 0n].map((sh) => String(Number((v >> sh) & 0xffn))).join('.');
}

/** RFC 5952: lowercase, no leading zeros, longest run (>= 2) of zero hextets as '::', leftmost on ties. */
function renderV6(v: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((v >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

function valueOf(p: ParsedCidr): bigint {
  const v = p.family === 4 ? v4ToBigInt(p.address) : v6ToBigInt(p.address);
  return v ?? 0n;
}

// ── Environment floors ───────────────────────────────────────────────────────

const warnedEnv = new Set<string>();
function warnOnce(key: string, msg: string, extra: Record<string, unknown>): void {
  if (warnedEnv.has(key)) return;
  warnedEnv.add(key);
  logger.warn(extra, msg);
}

function readFloor(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return def;
  const s = raw.trim();
  if (!/^[0-9]{1,3}$/.test(s)) {
    warnOnce(`${name}=${raw}`, `${name} is not a number: using the default`, { [name]: raw, default: def });
    return def;
  }
  const n = Number(s);
  if (n < min || n > max) {
    const clamped = Math.min(max, Math.max(min, n));
    warnOnce(`${name}=${raw}`, `${name} is out of range: clamped`, { [name]: raw, clamped });
    return clamped;
  }
  return n;
}

/** Widest bannable prefix per family (BAN_MIN_PREFIX_V4 / _V6, read on every call). */
export function banPrefixFloor(env: NodeJS.ProcessEnv = process.env): { v4: number; v6: number } {
  return {
    v4: readFloor(env, 'BAN_MIN_PREFIX_V4', DEFAULT_BAN_MIN_PREFIX_V4, 8, 32),
    v6: readFloor(env, 'BAN_MIN_PREFIX_V6', DEFAULT_BAN_MIN_PREFIX_V6, 16, 128),
  };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Strict IP or CIDR syntax (no policy). Canonical form, host bits masked; null when invalid. */
export function parseIpOrCidr(raw: unknown): ParsedCidr | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 64 || /\s/.test(s) || s.includes('%')) return null;
  const parts = s.split('/');
  if (parts.length > 2) return null;
  const addr = parts[0];
  const fam = net.isIP(addr);
  if (fam === 0) return null;
  let family: IpFamily = fam === 4 ? 4 : 6;
  let prefix = bits(family);
  if (parts.length === 2) {
    if (!PREFIX_RE.test(parts[1])) return null;
    prefix = Number(parts[1]);
    if (prefix > bits(family)) return null;
  }
  let value = family === 4 ? v4ToBigInt(addr) : v6ToBigInt(addr);
  if (value == null) return null;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → plain IPv4.
  if (family === 6 && (value >> 32n) === 0xffffn) {
    if (prefix < 96) return null;
    family = 4;
    prefix -= 96;
    value &= 0xffffffffn;
  }

  value &= maskOf(family, prefix);
  return { address: family === 4 ? renderV4(value) : renderV6(value), family, prefix };
}

function toParsed(x: ParsedCidr | string): ParsedCidr | null {
  return typeof x === 'string' ? parseIpOrCidr(x) : x;
}

/** True when both networks share at least one address (same family). */
export function cidrOverlaps(a: ParsedCidr | string, b: ParsedCidr | string): boolean {
  const pa = toParsed(a);
  const pb = toParsed(b);
  if (!pa || !pb || pa.family !== pb.family) return false;
  const m = maskOf(pa.family, Math.min(pa.prefix, pb.prefix));
  return (valueOf(pa) & m) === (valueOf(pb) & m);
}

/** True when `outer` contains the whole of `inner`. */
export function cidrContains(outer: ParsedCidr | string, inner: ParsedCidr | string): boolean {
  const po = toParsed(outer);
  const pi = toParsed(inner);
  if (!po || !pi) return false;
  return po.prefix <= pi.prefix && cidrOverlaps(po, pi);
}

const RESERVED_PARSED: ParsedCidr[] = RESERVED_BAN_RANGES.map((r) => {
  const p = parseIpOrCidr(r);
  if (!p) throw new Error(`ipValidation: bad reserved range ${r}`);
  return p;
});

/** True when the target overlaps a reserved range (loopback, link-local, multicast...). */
export function isReservedBanTarget(p: ParsedCidr): boolean {
  return RESERVED_PARSED.some((r) => cidrOverlaps(r, p));
}

/**
 * Syntax + policy for a ban target, in this order: invalid, subnet not
 * allowed, too broad (floor), reserved. The protected set is checked by
 * protectedIps.checkBanTarget().
 */
export function parseBanTarget(
  raw: unknown,
  opts: { allowCidr?: boolean; env?: NodeJS.ProcessEnv } = {},
): BanTargetResult {
  const p = parseIpOrCidr(raw);
  if (!p) return { ok: false, code: 'invalid', message: 'Invalid IP address or subnet' };
  const isNetwork = p.prefix < bits(p.family);
  if (isNetwork && !opts.allowCidr) {
    return { ok: false, code: 'cidr_not_allowed', message: 'Subnets are not accepted here: give a single IP address' };
  }
  const floors = banPrefixFloor(opts.env ?? process.env);
  const floor = p.family === 4 ? floors.v4 : floors.v6;
  if (p.prefix < floor) {
    return { ok: false, code: 'too_broad', message: `Subnet too broad: the widest bannable network is /${floor} for IPv${p.family}` };
  }
  if (isReservedBanTarget(p)) {
    return { ok: false, code: 'reserved', message: RESERVED_OR_PROTECTED_MESSAGE };
  }
  return {
    ok: true,
    target: { ...p, isNetwork, cidr: isNetwork ? `${p.address}/${p.prefix}` : p.address },
  };
}

/** The raw target of a stored ban row (ip may already carry a mask, else cidr_prefix). */
export function banTargetRawFromRow(ip: string, cidrPrefix: number | null): string {
  return ip.includes('/') ? ip : (cidrPrefix != null ? `${ip}/${cidrPrefix}` : ip);
}
