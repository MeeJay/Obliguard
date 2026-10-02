import { promises as dnsPromises } from 'dns';
import { isIP } from 'net';
import { parseIpOrCidr, cidrContains } from './ipValidation';
import type { ParsedCidr } from './ipValidation';

// Reject any HTTP target that resolves to a private / loopback /
// link-local / metadata range. Ported from Obliance (utils/ssrfGuard.ts),
// used by the remote blocklist fetcher so an admin (or a compromised
// session) can't aim our outbound fetcher at internal services
// (PostgreSQL, the Docker network, cloud metadata 169.254.169.254, …).
//
// We resolve the hostname BEFORE the request fires and re-check every
// answer — `https://example.com` could otherwise resolve onto an internal
// address. This is best-effort against an attacker who races DNS
// responses; callers must also fetch with redirect: 'manual' so a 3xx
// cannot bounce the request onto an internal target.

const PRIVATE_RANGES = [
  // IPv4
  '0.0.0.0/8',          // "this" network
  '10.0.0.0/8',         // RFC1918
  '100.64.0.0/10',      // CGNAT
  '127.0.0.0/8',        // loopback
  '169.254.0.0/16',     // link-local + cloud metadata
  '172.16.0.0/12',      // RFC1918
  '192.168.0.0/16',     // RFC1918
  '224.0.0.0/4',        // multicast
  '240.0.0.0/4',        // reserved + broadcast
  // IPv6 (IPv4-mapped ::ffff:a.b.c.d is folded into IPv4 by parseIpOrCidr)
  '::/96',              // unspecified, ::1 loopback, IPv4-compatible
  '64:ff9b::/96',       // NAT64 (embeds an IPv4 target)
  '64:ff9b:1::/48',     // local-use NAT64
  '2001::/32',          // Teredo (embeds an IPv4 target)
  '2002::/16',          // 6to4 (embeds an IPv4 target)
  'fc00::/7',           // ULA
  'fe80::/10',          // link-local
  'ff00::/8',           // multicast
] as const;

const PRIVATE_PARSED: ParsedCidr[] = PRIVATE_RANGES.map((r) => {
  const p = parseIpOrCidr(r);
  if (!p) throw new Error(`ssrfGuard: bad private range ${r}`);
  return p;
});

/**
 * True when `ip` is a literal address in a private / loopback / link-local /
 * multicast / reserved range. An unparsable value counts as private
 * (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  const p = parseIpOrCidr(ip);
  if (!p) return true;
  return PRIVATE_PARSED.some((r) => cidrContains(r, p));
}

export function isPrivateIPv4(ip: string): boolean {
  return isIP(ip) === 4 && isPrivateAddress(ip);
}

export function isPrivateIPv6(ip: string): boolean {
  return isIP(ip) === 6 && isPrivateAddress(ip);
}

/** Error raised by assertPublicHttpUrl (callers map it to a 400). */
export class SsrfRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfRefusedError';
  }
}

/**
 * Parse `rawUrl` and refuse anything but a public http(s) target.
 *
 * `allowUnresolved`: a hostname that does not resolve is let through (the
 * request itself will then fail to resolve). Used right before a fetch, where
 * it adds no exposure over the resolve-then-fetch race this guard already
 * accepts; saving a URL keeps the strict default.
 */
export async function assertPublicHttpUrl(rawUrl: string, opts: { allowUnresolved?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfRefusedError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfRefusedError(`Refused non-HTTP scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SsrfRefusedError('Refused URL with embedded credentials');
  }
  // WHATWG URL keeps the brackets of an IPv6 literal in `hostname`.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw new SsrfRefusedError('Invalid URL');
  // Localhost + literal IPs handled directly.
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'localhost.localdomain') {
    throw new SsrfRefusedError('Refused private destination (localhost)');
  }
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) throw new SsrfRefusedError(`Refused private destination (${hostname})`);
    return url;
  }
  // DNS hostname — resolve and screen ALL answers.
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await dnsPromises.lookup(hostname, { all: true });
  } catch (err) {
    if (opts.allowUnresolved) return url;
    throw new SsrfRefusedError(`Could not resolve ${hostname}: ${(err as Error).message}`);
  }
  if (answers.length === 0) {
    if (opts.allowUnresolved) return url;
    throw new SsrfRefusedError(`Could not resolve ${hostname}`);
  }
  for (const a of answers) {
    if (isPrivateAddress(a.address)) {
      throw new SsrfRefusedError(`Refused private destination (${hostname} → ${a.address})`);
    }
  }
  return url;
}
