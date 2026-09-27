import type { Request } from 'express';

/** A bare URL authority: hostname (underscores tolerated) or bracketed IPv6 literal, optional port. */
export const AUTHORITY_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?)(?::\d{1,5})?$/i;

/** True for a bare http(s) origin (no path, query, fragment or userinfo). */
function isBareOrigin(p: URL): boolean {
  return /^https?:$/.test(p.protocol) && !!p.hostname && !p.username && !p.password
    && (p.pathname === '/' || p.pathname === '') && !p.search && !p.hash;
}

function isLocalHostname(h: string): boolean {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

export interface ConfiguredOrigin {
  /** Lower-cased hostname the request's Host is matched against. */
  hostname: string;
  /** The configured origin, rendered with the request scheme when the entry has none. */
  build: (proto: string) => string;
}

/**
 * Public origins of this instance configured by the operator:
 *   - APP_URL (a scheme-less value is read as https://…);
 *   - CLIENT_ORIGIN, unless it is a localhost default;
 *   - SSO_ALLOWED_HOSTS: comma-separated origins "http(s)://host[:port]", or
 *     bare "host[:port]" read as https:// (the scheme is never taken from the
 *     request, whose X-Forwarded-Proto a client can set).
 * `invalid` lists the entries that could not be parsed: callers must fail
 * closed on them rather than silently ignore a pin the operator meant to set.
 */
export function configuredPublicOrigins(): { entries: ConfiguredOrigin[]; invalid: string[] } {
  const entries: ConfiguredOrigin[] = [];
  const invalid: string[] = [];

  const appUrl = (process.env.APP_URL ?? '').trim();
  if (appUrl) {
    try {
      const p = new URL(appUrl.includes('://') ? appUrl : `https://${appUrl}`);
      const h = p.hostname.toLowerCase();
      if (!h || !/^https?:$/.test(p.protocol) || p.username || p.password) throw new Error('bad');
      entries.push({ hostname: h, build: () => p.origin });
    } catch { invalid.push(`APP_URL=${appUrl}`); }
  }

  const clientOrigin = (process.env.CLIENT_ORIGIN ?? '').trim();
  if (clientOrigin) {
    // CORS-only setting historically: used as an SSO pin only when it is a
    // single bare origin; anything else (lists, paths…) is ignored here.
    try {
      const p = new URL(clientOrigin);
      const h = p.hostname.toLowerCase();
      if (isBareOrigin(p) && AUTHORITY_RE.test(p.host) && !isLocalHostname(h)) {
        entries.push({ hostname: h, build: () => p.origin });
      }
    } catch { /* ignored */ }
  }

  for (const raw of (process.env.SSO_ALLOWED_HOSTS ?? '').split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    try {
      if (entry.includes('://')) {
        const p = new URL(entry);
        if (!isBareOrigin(p)) throw new Error('bad');
        entries.push({ hostname: p.hostname, build: () => p.origin });
      } else if (AUTHORITY_RE.test(entry)) {
        const p = new URL(`https://${entry}`);
        entries.push({ hostname: p.hostname, build: () => p.origin });
      } else {
        throw new Error('bad');
      }
    } catch { invalid.push(`SSO_ALLOWED_HOSTS entry "${raw.trim()}"`); }
  }

  return { entries, invalid };
}

/** Request scheme: X-Forwarded-Proto (http/https only) or the socket's. */
export function requestProto(req: Request): 'http' | 'https' {
  const fwd = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  if (fwd === 'https' || fwd === 'http') return fwd;
  return req.protocol === 'https' ? 'https' : 'http';
}

/** The Host header when it is a bare authority, with its lower-cased hostname; else null. */
export function requestAuthority(req: Request): { authority: string; hostname: string } | null {
  const authority = String(req.headers.host ?? '').trim();
  if (!AUTHORITY_RE.test(authority)) return null;
  try {
    return { authority, hostname: new URL(`http://${authority}`).hostname.toLowerCase() };
  } catch {
    return null;
  }
}
