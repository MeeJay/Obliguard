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
 * Mirrors Obliance's delegationVerify.service.ts:
 *   - alg pinned to EdDSA, typ must be 'JWT', base64url-only segments, bounded token size;
 *   - iat / nbf / exp are REQUIRED integers, lifetime (exp - iat) capped at MAX_LIFETIME_SEC;
 *   - `iss` must equal the configured Obligate origin (OBLIGATE_ISSUER overrides it for
 *     split-URL installs) and `aud` must be a plain string equal to the expected audience;
 *   - `jti` must be a UUID and `azp` an app-type slug;
 *   - an unknown kid triggers at most one forced JWKS refetch per JWKS_MIN_REFETCH_MS (plus
 *     in-flight dedupe), so random kids cannot turn this endpoint into a request amplifier
 *     pointed at Obligate.
 * One deliberate difference: every accepted jti is remembered until its exp and a second
 * presentation is refused ('replayed'). Obliance tolerates reuse because a context rail reads
 * several sections with one token; the external-bans endpoints change global enforcement
 * state, so a captured token must not be replayable at all.
 */

export const CLOCK_SKEW_SECONDS = 30;
/** Upper bound on exp - iat. Obligate mints iat + 120; anything longer looks like a standing credential. */
export const MAX_LIFETIME_SEC = 300;
/** A compact JWS carrying these claims is well under 1 KB. */
const MAX_TOKEN_BYTES = 4096;
const ALLOWED_ALG = 'EdDSA';
const JWKS_PATH = '/api/delegation/jwks';
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h — matches Obligate's key rotation cadence
/** An unknown kid may trigger at most one JWKS fetch per this interval. */
export const JWKS_MIN_REFETCH_MS = 30_000;
const JWKS_FETCH_TIMEOUT_MS = 3000;
const JWKS_MAX_KEYS = 20;
const JWKS_MAX_BYTES = 64 * 1024;
/** Obligate URL / enabled flag cache — app_config has no cache of its own. */
const CONFIG_TTL_MS = 60_000;
/** Bound on the replay memo. Oldest entries are evicted first when full. */
const REPLAY_MAX_ENTRIES = 50_000;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const APP_TYPE_RE = /^[a-z][a-z0-9-]{1,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  | { kind: 'typ_invalid' }
  | { kind: 'kid_unknown' }
  | { kind: 'bad_signature' }
  | { kind: 'payload_invalid' }
  | { kind: 'expired' }
  | { kind: 'not_yet_valid' }
  | { kind: 'lifetime_excessive' }
  | { kind: 'wrong_audience'; expected: string; actual: string }
  | { kind: 'wrong_issuer' }
  | { kind: 'azp_invalid' }
  | { kind: 'jti_invalid' }
  | { kind: 'replayed' }
  | { kind: 'not_configured' }
  | { kind: 'jwks_unreachable'; message: string };

export type VerifyResult =
  | { ok: true; result: VerifiedDelegation }
  /** `kid` is surfaced for logging only; it is the (unverified) header value. */
  | { ok: false; failure: VerifyFailure; kid: string | null };

// ── Obligate origin (cached) ─────────────────────────────────────────────────

interface ObligateOrigin {
  /** Origin we fetch the JWKS from, no trailing slash. */
  base: string;
  /** The exact `iss` value we require. */
  issuer: string;
}

let originCache: { base: string | null; at: number } | null = null;

/** Normalise a configured URL and refuse anything that is not http(s). */
function safeBase(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

async function getObligateOrigin(): Promise<ObligateOrigin | null> {
  const now = Date.now();
  if (!originCache || now - originCache.at >= CONFIG_TTL_MS) {
    let base: string | null = null;
    try {
      const raw = await appConfigService.getObligateRaw();
      const enabled = await appConfigService.get('obligate_enabled');
      // Delegation only means anything while the Obligate integration is on: an operator who
      // switched Obligate off expects cross-app pushes to stop too.
      if (enabled === 'true') base = safeBase(raw.url);
    } catch (err) {
      logger.warn({ err }, '[delegation] could not read Obligate config');
      base = null;
    }
    originCache = { base, at: now };
  }
  if (!originCache.base) return null;
  // `iss` normally IS the configured base URL (Obligate stamps OBLIGATE_PUBLIC_URL). The
  // override exists only for split-URL installs where Obliguard reaches Obligate on an internal
  // address while Obligate stamps its public one. Read on every call (cheap, no caching games).
  const override = process.env.OBLIGATE_ISSUER?.trim().replace(/\/+$/, '');
  return { base: originCache.base, issuer: override || originCache.base };
}

// ── JWKS cache ───────────────────────────────────────────────────────────────

type PublicKey = ReturnType<typeof crypto.createPublicKey>;

let keyCache = new Map<string, PublicKey>();
let keysFetchedAt = 0;
let lastFetchAttemptAt = 0;
let inFlight: Promise<void> | null = null;

async function fetchJwks(base: string): Promise<void> {
  lastFetchAttemptAt = Date.now();
  const res = await fetch(`${base}${JWKS_PATH}`, {
    method: 'GET',
    // Never follow a redirect for a trust anchor: that is how a hijacked or misconfigured
    // Obligate would hand us someone else's public key.
    redirect: 'manual',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > JWKS_MAX_BYTES) throw new Error('JWKS response too large');

  const body = await res.json() as { keys?: unknown };
  if (!Array.isArray(body?.keys)) throw new Error('JWKS response missing keys array');

  const next = new Map<string, PublicKey>();
  for (const entry of body.keys.slice(0, JWKS_MAX_KEYS)) {
    const jwk = entry as Record<string, unknown>;
    if (typeof jwk?.kid !== 'string' || jwk.kid.length === 0) continue;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') continue;
    if ('d' in jwk) {
      logger.error({ kid: jwk.kid }, '[delegation] JWKS entry carries private key material — ignored');
      continue;
    }
    if (jwk.alg !== undefined && jwk.alg !== ALLOWED_ALG) continue;
    try {
      next.set(jwk.kid, crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' }));
    } catch (err) {
      logger.warn({ err, kid: jwk.kid }, '[delegation] unusable JWKS entry');
    }
  }
  if (next.size === 0) throw new Error('JWKS has no usable Ed25519 key');
  keyCache = next;
  keysFetchedAt = Date.now();
}

/** Single-flight wrapper — a burst of requests produces one fetch, not one per request. */
function refreshJwks(base: string): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetchJwks(base).finally(() => { inFlight = null; });
  return inFlight;
}

async function resolveKey(base: string, kid: string): Promise<{ key: PublicKey } | { key: null; failure: VerifyFailure }> {
  const now = Date.now();
  const cached = keyCache.get(kid);
  if (cached) {
    // A key we already hold stays usable past the TTL: freshness is about LEARNING new keys,
    // so a due background refresh never turns an Obligate hiccup into an outage.
    if (now - keysFetchedAt >= JWKS_TTL_MS && now - lastFetchAttemptAt >= JWKS_MIN_REFETCH_MS) {
      refreshJwks(base).catch((err) => logger.warn({ err }, '[delegation] background JWKS refresh failed'));
    }
    return { key: cached };
  }

  if (now - lastFetchAttemptAt < JWKS_MIN_REFETCH_MS) {
    // Rate-limited. Join a fetch already in flight (cold start burst), otherwise refuse.
    if (inFlight) {
      try { await inFlight; } catch { /* reported below */ }
      const joined = keyCache.get(kid);
      if (joined) return { key: joined };
    }
    return keyCache.size > 0
      ? { key: null, failure: { kind: 'kid_unknown' } }
      : { key: null, failure: { kind: 'jwks_unreachable', message: 'JWKS refetch rate-limited' } };
  }

  try {
    await refreshJwks(base);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, base }, '[delegation] JWKS fetch failed');
    return { key: null, failure: { kind: 'jwks_unreachable', message } };
  }
  const fresh = keyCache.get(kid);
  return fresh ? { key: fresh } : { key: null, failure: { kind: 'kid_unknown' } };
}

// ── Replay memo ──────────────────────────────────────────────────────────────

/** jti → exp (epoch seconds). Map iteration order is insertion order, so the first key is the oldest. */
const seenJti = new Map<string, number>();

/** Operator escape hatch for a caller that still reuses tokens. Default: strict one-shot. */
function replayCheckEnabled(): boolean {
  return process.env.DELEGATION_ALLOW_JTI_REUSE !== 'true';
}

/** Returns false when the jti was already presented and is still within its validity window. */
function rememberJti(jti: string, exp: number, nowSec: number): boolean {
  const seen = seenJti.get(jti);
  if (seen !== undefined && seen + CLOCK_SKEW_SECONDS >= nowSec) return false;
  if (seenJti.size >= REPLAY_MAX_ENTRIES) {
    for (const [k, e] of seenJti) {
      if (e + CLOCK_SKEW_SECONDS < nowSec) seenJti.delete(k);
    }
    // Still full of live entries: evict the oldest (bounded LRU). Such a volume of live tokens
    // means far more traffic than any sibling app produces.
    while (seenJti.size >= REPLAY_MAX_ENTRIES) {
      const oldest = seenJti.keys().next().value;
      if (oldest === undefined) break;
      seenJti.delete(oldest);
    }
  }
  seenJti.delete(jti);
  seenJti.set(jti, exp);
  return true;
}

// ── Compact JWS ──────────────────────────────────────────────────────────────

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * Verify an Authorization: Bearer <JWT> header against Obligate's JWKS. Returns the parsed
 * claims + a subjectType hint. The caller decides whether the claims are ALLOWED for the
 * endpoint (Obliguard checks the source app allowlist before accepting an external ban).
 * Never throws: an unexpected error is a refusal.
 */
export async function verifyDelegationToken(authorization: string | undefined, expectedAudience: string): Promise<VerifyResult> {
  try {
    return await verifyInner(authorization, expectedAudience);
  } catch (err) {
    logger.error({ err }, '[delegation] verification threw — refusing');
    return { ok: false, failure: { kind: 'jwks_unreachable', message: 'internal error' }, kid: null };
  }
}

async function verifyInner(authorization: string | undefined, expectedAudience: string): Promise<VerifyResult> {
  const refuse = (failure: VerifyFailure, kid: string | null = null): VerifyResult => ({ ok: false, failure, kid });

  if (!authorization?.startsWith('Bearer ')) return refuse({ kind: 'missing_bearer' });
  const token = authorization.slice(7).trim();
  if (token.length === 0 || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return refuse({ kind: 'malformed_token' });
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL_RE.test(p))) return refuse({ kind: 'malformed_token' });
  const [seg0, seg1, seg2] = parts;

  // Header: alg is PINNED, never used to choose a verifier (alg-confusion).
  const header = decodeJson(seg0);
  if (!header) return refuse({ kind: 'malformed_token' });
  const rawKid = typeof header.kid === 'string' && header.kid.length > 0 && header.kid.length <= 200 ? header.kid : null;
  if (header.alg !== ALLOWED_ALG || !rawKid) return refuse({ kind: 'malformed_token' }, rawKid);
  // Obligate always stamps typ 'JWT'; a missing or different typ is not a token it minted.
  if (header.typ !== 'JWT') return refuse({ kind: 'typ_invalid' }, rawKid);

  const origin = await getObligateOrigin();
  if (!origin) return refuse({ kind: 'not_configured' }, rawKid);

  const resolved = await resolveKey(origin.base, rawKid);
  if (!resolved.key) return refuse(resolved.failure, rawKid);

  // Signature over the ASCII bytes of the SEGMENTS, not the decoded JSON.
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(null, Buffer.from(`${seg0}.${seg1}`, 'utf8'), resolved.key, Buffer.from(seg2, 'base64url'));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return refuse({ kind: 'bad_signature' }, rawKid);

  // Only now is the payload trustworthy enough to read.
  const p = decodeJson(seg1);
  if (!p) return refuse({ kind: 'payload_invalid' }, rawKid);
  if (!isInt(p.iat) || !isInt(p.nbf) || !isInt(p.exp)) return refuse({ kind: 'payload_invalid' }, rawKid);
  // aud must be a plain string: a token addressed to several apps has a blast radius of several apps.
  if (typeof p.aud !== 'string' || p.aud !== expectedAudience) {
    return refuse({ kind: 'wrong_audience', expected: expectedAudience, actual: typeof p.aud === 'string' ? p.aud.slice(0, 64) : 'non-string' }, rawKid);
  }
  if (typeof p.iss !== 'string' || p.iss.replace(/\/+$/, '') !== origin.issuer) return refuse({ kind: 'wrong_issuer' }, rawKid);
  if (typeof p.azp !== 'string' || !APP_TYPE_RE.test(p.azp)) return refuse({ kind: 'azp_invalid' }, rawKid);
  if (typeof p.jti !== 'string' || !UUID_RE.test(p.jti)) return refuse({ kind: 'jti_invalid' }, rawKid);

  const nowSec = Math.floor(Date.now() / 1000);
  if (p.nbf > nowSec + CLOCK_SKEW_SECONDS) return refuse({ kind: 'not_yet_valid' }, rawKid);
  if (p.exp <= nowSec - CLOCK_SKEW_SECONDS) return refuse({ kind: 'expired' }, rawKid);
  if (p.exp - p.iat > MAX_LIFETIME_SEC) return refuse({ kind: 'lifetime_excessive' }, rawKid);

  // Parse sub → subjectType + numeric id or source app_type.
  let subjectType: 'user' | 'app';
  let subjectUserId: number | null = null;
  let sourceAppType: string | null = null;
  if (typeof p.sub === 'string' && p.sub.startsWith('app:') && APP_TYPE_RE.test(p.sub.slice(4))) {
    subjectType = 'app';
    sourceAppType = p.sub.slice(4);
  } else if (typeof p.sub === 'string' && /^[0-9]{1,15}$/.test(p.sub) && Number(p.sub) > 0) {
    subjectType = 'user';
    subjectUserId = parseInt(p.sub, 10);
  } else {
    return refuse({ kind: 'malformed_token' }, rawKid);
  }

  // Replay protection: burned only once every other check passed, so a refused token never
  // poisons the memo.
  if (replayCheckEnabled() && !rememberJti(p.jti, p.exp, nowSec)) return refuse({ kind: 'replayed' }, rawKid);

  const claims: DelegationClaims = {
    iss: p.iss,
    aud: p.aud,
    azp: p.azp,
    sub: p.sub,
    ost: typeof p.ost === 'string' ? p.ost : '',
    scp: typeof p.scp === 'string' ? p.scp : '',
    jti: p.jti,
    iat: p.iat,
    nbf: p.nbf,
    exp: p.exp,
  };
  return { ok: true, result: { claims, subjectType, subjectUserId, sourceAppType } };
}

export function verifyFailureToHttp(failure: VerifyFailure): { status: number; code: string; message: string } {
  switch (failure.kind) {
    case 'missing_bearer':     return { status: 401, code: 'missing_bearer',     message: 'Missing Bearer token' };
    case 'malformed_token':    return { status: 401, code: 'malformed_token',    message: 'Malformed delegation token' };
    case 'typ_invalid':        return { status: 401, code: 'typ_invalid',        message: 'Token type must be JWT' };
    case 'kid_unknown':        return { status: 401, code: 'kid_unknown',        message: 'Token signed by an unknown key' };
    case 'bad_signature':      return { status: 401, code: 'bad_signature',      message: 'Invalid token signature' };
    case 'payload_invalid':    return { status: 401, code: 'payload_invalid',    message: 'Token claims are missing or malformed' };
    case 'expired':            return { status: 401, code: 'expired',            message: 'Token expired' };
    case 'not_yet_valid':      return { status: 401, code: 'not_yet_valid',      message: 'Token not yet valid' };
    case 'lifetime_excessive': return { status: 401, code: 'lifetime_excessive', message: `Token lifetime exceeds ${MAX_LIFETIME_SEC}s` };
    case 'wrong_audience':     return { status: 403, code: 'wrong_audience',     message: `Token audience is ${failure.actual}, expected ${failure.expected}` };
    case 'wrong_issuer':       return { status: 401, code: 'wrong_issuer',       message: 'Token issuer not trusted' };
    case 'azp_invalid':        return { status: 401, code: 'azp_invalid',        message: 'Token requester (azp) is invalid' };
    case 'jti_invalid':        return { status: 401, code: 'jti_invalid',        message: 'Token id (jti) is invalid' };
    case 'replayed':           return { status: 401, code: 'replayed',           message: 'Token already used' };
    // 503 (not 401) — configuration / JWKS failures are our problem, not the caller's. A 401
    // would tell them "your token is bad, don't retry" and they'd stop pushing legitimate
    // updates until an operator poked something. 503 = temporary, do retry.
    case 'not_configured':     return { status: 503, code: 'not_configured',     message: 'Obligate integration is not configured' };
    case 'jwks_unreachable':   return { status: 503, code: 'jwks_unreachable',   message: `JWKS unreachable: ${failure.message}` };
  }
}

/** Test hook: drop cached keys, config, rate-limit clock and replay memo. */
export function __resetDelegationStateForTest(): void {
  keyCache = new Map();
  keysFetchedAt = 0;
  lastFetchAttemptAt = 0;
  inFlight = null;
  originCache = null;
  seenJti.clear();
}
