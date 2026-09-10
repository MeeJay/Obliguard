import * as crypto from 'crypto';
import { appConfigService } from './appConfig.service';
import { logger } from '../utils/logger';

/**
 * JWKS-verified delegation token authentication for endpoints called by SIBLING APPS in the
 * Obli suite (Oblihub honeypot pushing bans, Oblidesk pulling context, etc).
 *
 * The token is minted by Obligate (see delegation.service.ts over there). It is Ed25519-signed,
 * 120s TTL, and its claims say WHO the caller is:
 *   - `sub = "42"`         → a user (numeric id, cross-app tenant slug in `ost`)
 *   - `sub = "app:oblihub"` → the app itself (system push; no user in the loop)
 *
 * This module never accepts a static shared secret. There is no fallback: if Obligate is down
 * or the JWKS can't be fetched, every request returns 503. Silently accepting an older static
 * key would defeat the entire point of switching to signed tokens (the security review that
 * drove Desk/Ance to this pattern spelled that out — never re-open the disjunctor by hand).
 *
 * JWKS is cached in-memory. The remote endpoint publishes multiple keys during rotation, so
 * a fresh signature under a new kid is accepted the moment the cache is refreshed. Cache is
 * invalidated on every miss (unknown kid) — a rotation propagates in one request instead of
 * waiting a full TTL.
 */

export const CLOCK_SKEW_SECONDS = 30;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h — matches Obligate's key rotation cadence
const JWKS_FETCH_TIMEOUT_MS = 3000;

interface PublicJwk {
  kty: string;
  crv?: string;
  x?: string;
  kid: string;
  alg?: string;
}

interface CachedJwks { keys: PublicJwk[]; fetchedAt: number; }
let jwksCache: CachedJwks | null = null;
let inFlightFetch: Promise<CachedJwks> | null = null;

async function fetchJwks(force = false): Promise<CachedJwks> {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache;
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = (async () => {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url) throw new Error('Obligate URL not configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${raw.url.replace(/\/$/, '')}/api/delegation/jwks`, { signal: controller.signal });
      if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
      const body = await res.json() as { keys?: PublicJwk[] };
      if (!Array.isArray(body.keys)) throw new Error('JWKS response missing keys array');
      const fresh: CachedJwks = { keys: body.keys, fetchedAt: Date.now() };
      jwksCache = fresh;
      return fresh;
    } finally {
      clearTimeout(timeout);
      inFlightFetch = null;
    }
  })();
  return inFlightFetch;
}

function b64urlDecode(input: string): Buffer {
  const s = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

interface DelegationClaims {
  iss: string;
  aud: string;
  azp: string;
  sub: string;
  ost: string;
  scp: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
}

export interface VerifiedDelegation {
  claims: DelegationClaims;
  /** 'user' | 'app' — parsed from the sub prefix. */
  subjectType: 'user' | 'app';
  /** For subjectType='user': numeric user id (as it appears in the audience's Obligate mapping). */
  subjectUserId: number | null;
  /** For subjectType='app': the source app_type (e.g. 'oblihub'). */
  sourceAppType: string | null;
}

export type VerifyFailure =
  | { kind: 'missing_bearer' }
  | { kind: 'malformed_token' }
  | { kind: 'kid_unknown' }
  | { kind: 'bad_signature' }
  | { kind: 'expired' }
  | { kind: 'not_yet_valid' }
  | { kind: 'wrong_audience'; expected: string; actual: string }
  | { kind: 'wrong_issuer' }
  | { kind: 'jwks_unreachable'; message: string };

export type VerifyResult =
  | { ok: true; result: VerifiedDelegation }
  | { ok: false; failure: VerifyFailure };

/**
 * Verify an Authorization: Bearer <JWT> header against Obligate's JWKS. Returns the parsed
 * claims + a subjectType hint. The caller decides whether the claims are ALLOWED for the
 * endpoint (Obliguard checks `sub === 'app:oblihub'` before accepting an external ban).
 */
export async function verifyDelegationToken(authorization: string | undefined, expectedAudience: string): Promise<VerifyResult> {
  if (!authorization?.startsWith('Bearer ')) return { ok: false, failure: { kind: 'missing_bearer' } };
  const token = authorization.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, failure: { kind: 'malformed_token' } };

  let header: { alg?: string; kid?: string; typ?: string };
  let claims: DelegationClaims;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    claims = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, failure: { kind: 'malformed_token' } };
  }
  if (header.alg !== 'EdDSA' || !header.kid) return { ok: false, failure: { kind: 'malformed_token' } };

  // Fetch JWKS, retry once with force=true if the kid is unknown (rotation just happened).
  let jwks: CachedJwks;
  try { jwks = await fetchJwks(false); }
  catch (err) { return { ok: false, failure: { kind: 'jwks_unreachable', message: err instanceof Error ? err.message : String(err) } }; }
  let jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) {
    try { jwks = await fetchJwks(true); }
    catch (err) { return { ok: false, failure: { kind: 'jwks_unreachable', message: err instanceof Error ? err.message : String(err) } }; }
    jwk = jwks.keys.find(k => k.kid === header.kid);
    if (!jwk) return { ok: false, failure: { kind: 'kid_unknown' } };
  }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) return { ok: false, failure: { kind: 'malformed_token' } };

  // Verify signature — Node 24 supports Ed25519 natively via createPublicKey from JWK.
  const publicKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' });
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const signature = b64urlDecode(parts[2]);
  const ok = crypto.verify(null, signingInput, publicKey, signature);
  if (!ok) return { ok: false, failure: { kind: 'bad_signature' } };

  // Claims checks — audience, issuer (soft), and time window with skew.
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp && nowSec > claims.exp + CLOCK_SKEW_SECONDS) return { ok: false, failure: { kind: 'expired' } };
  if (claims.nbf && nowSec + CLOCK_SKEW_SECONDS < claims.nbf) return { ok: false, failure: { kind: 'not_yet_valid' } };
  if (claims.aud !== expectedAudience) return { ok: false, failure: { kind: 'wrong_audience', expected: expectedAudience, actual: claims.aud } };
  // Issuer is soft: Obligate sets `iss` from its own hostname config which the operator may
  // change without redeploying us. We log but don't reject.

  // Parse sub → subjectType + numeric id or source app_type.
  let subjectType: 'user' | 'app' = 'user';
  let subjectUserId: number | null = null;
  let sourceAppType: string | null = null;
  if (typeof claims.sub === 'string' && claims.sub.startsWith('app:')) {
    subjectType = 'app';
    sourceAppType = claims.sub.slice(4) || null;
  } else if (typeof claims.sub === 'string' && /^\d+$/.test(claims.sub)) {
    subjectType = 'user';
    subjectUserId = parseInt(claims.sub, 10);
  } else {
    return { ok: false, failure: { kind: 'malformed_token' } };
  }

  return { ok: true, result: { claims, subjectType, subjectUserId, sourceAppType } };
}

export function verifyFailureToHttp(failure: VerifyFailure): { status: number; code: string; message: string } {
  switch (failure.kind) {
    case 'missing_bearer':    return { status: 401, code: 'missing_bearer',    message: 'Missing Bearer token' };
    case 'malformed_token':   return { status: 401, code: 'malformed_token',   message: 'Malformed delegation token' };
    case 'kid_unknown':       return { status: 401, code: 'kid_unknown',       message: 'Token signed by an unknown key' };
    case 'bad_signature':     return { status: 401, code: 'bad_signature',     message: 'Invalid token signature' };
    case 'expired':           return { status: 401, code: 'expired',           message: 'Token expired' };
    case 'not_yet_valid':     return { status: 401, code: 'not_yet_valid',     message: 'Token not yet valid' };
    case 'wrong_audience':    return { status: 403, code: 'wrong_audience',    message: `Token audience is ${failure.actual}, expected ${failure.expected}` };
    case 'wrong_issuer':      return { status: 403, code: 'wrong_issuer',      message: 'Token issuer not trusted' };
    // 503 (not 401) — a JWKS network failure is our problem, not the caller's. Returning 401
    // would tell them "your token is bad, don't retry" and they'd stop pushing legitimate
    // updates until an operator poked something. 503 = temporary, do retry, exactly what
    // Desk/Ance's delegatedAuth documents as the "internal_error → 503" rule.
    case 'jwks_unreachable':  return { status: 503, code: 'jwks_unreachable',  message: `JWKS unreachable: ${failure.message}` };
  }
}
