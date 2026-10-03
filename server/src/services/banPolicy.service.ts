import { db } from '../db';
import { codedError } from '../utils/errorCodes';
import { appConfigService } from './appConfig.service';

// Auto-ban duration policy (W12-3 / ADMIN-FEATURES-17).
//
// How long an auth-failure auto-ban lasts, and how that grows for repeat
// offenders. Auto-bans are global (owner decision), so one platform policy
// applies, edited by the platform admin from the Default tenant. Layers,
// outermost -> innermost (modelled on Obliance threshold.service.ts):
//   1. system default   (DEFAULT_BAN_POLICY: permanent, no ladder = the
//                        historical behaviour)
//   2. platform policy  (app_config 'banPolicy', JSON)
//
// The ladder picks the duration from the number of earlier bans of the
// address (any scope, type or state): the step with the highest `priorBans`
// not above that count wins, below the first step the base duration
// applies. `ttlSeconds: null` is permanent. The duration of a ban is fixed
// when it is created; changing the policy never touches existing bans.
//
// The policy is read once per BanEngine cycle that creates bans: cached in
// memory (60 s), dropped on every write through this service.

const APP_CONFIG_KEY = 'banPolicy';
const CACHE_TTL_MS = 60_000;

/** Shortest timed ban (5 min): anything shorter is undone by the next attack burst. */
export const MIN_BAN_TTL_SECONDS = 300;
/** Longest timed ban (1 year); longer means permanent. */
export const MAX_BAN_TTL_SECONDS = 365 * 24 * 3600;
export const MAX_LADDER_STEPS = 10;
/** Highest prior-ban count a step may key on. */
export const MAX_LADDER_PRIOR_BANS = 1000;

export interface BanPolicyStep {
  /** The step applies from this many earlier bans of the address (>= 1). */
  priorBans: number;
  /** Ban duration in seconds, null = permanent. */
  ttlSeconds: number | null;
}

export interface BanPolicy {
  /** Duration of a first offence (and below the first ladder step); null = permanent. */
  autoBanTtlSeconds: number | null;
  /** Repeat-offender escalation, ascending priorBans. */
  ladder: BanPolicyStep[];
}

export type BanPolicySource = 'default' | 'platform';

export interface EffectiveBanPolicy {
  policy: BanPolicy;
  /** Layer the policy comes from (the system default when nothing is stored). */
  source: BanPolicySource;
}

/** Duration picked for one ban. */
export interface BanTtlChoice {
  ttlSeconds: number | null;
  /** Index of the ladder step that applied, null = the base duration. */
  stepIndex: number | null;
}

export const DEFAULT_BAN_POLICY: Readonly<BanPolicy> = Object.freeze({ autoBanTtlSeconds: null, ladder: [] });

let cache: { value: EffectiveBanPolicy; at: number } | null = null;

/** null = permanent (a stored ttl that would fail validation reads as permanent). */
function readTtl(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= MIN_BAN_TTL_SECONDS && v <= MAX_BAN_TTL_SECONDS ? v : null;
}

/**
 * Tolerant read of the stored JSON: a malformed value falls back to the
 * default, malformed steps are dropped (the write path validates strictly).
 */
function parseStored(raw: string | null): BanPolicy | null {
  if (!raw) return null;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { autoBanTtlSeconds?: unknown; ladder?: unknown };
  const ladder: BanPolicyStep[] = [];
  if (Array.isArray(o.ladder)) {
    for (const s of o.ladder as Array<{ priorBans?: unknown; ttlSeconds?: unknown }>) {
      if (!s || typeof s !== 'object') continue;
      const n = s.priorBans;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) continue;
      ladder.push({ priorBans: n, ttlSeconds: readTtl(s.ttlSeconds) });
    }
  }
  ladder.sort((a, b) => a.priorBans - b.priorBans);
  return { autoBanTtlSeconds: readTtl(o.autoBanTtlSeconds), ladder };
}

function validTtl(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw codedError(400, 'BAN_TTL_NOT_INTEGER', `${field} must be a whole number of seconds, or null (permanent)`, { field });
  }
  if (v < MIN_BAN_TTL_SECONDS || v > MAX_BAN_TTL_SECONDS) {
    throw codedError(400, 'BAN_TTL_OUT_OF_RANGE', `${field} must be between ${MIN_BAN_TTL_SECONDS} and ${MAX_BAN_TTL_SECONDS} seconds, or null (permanent)`, { field, min: MIN_BAN_TTL_SECONDS, max: MAX_BAN_TTL_SECONDS });
  }
  return v;
}

/** Permanent (null) sorts above every timed duration. */
function ttlRank(v: number | null): number {
  return v === null ? Number.POSITIVE_INFINITY : v;
}

export const banPolicyService = {
  /**
   * Strict validation of a policy sent by the admin: timed durations
   * between MIN and MAX_BAN_TTL_SECONDS (null = permanent), at most
   * MAX_LADDER_STEPS steps with strictly ascending priorBans (>= 1), and an
   * escalation that never shortens a ban (each step at least as long as the
   * one before it, the base duration first).
   */
  validate(input: unknown): BanPolicy {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw codedError(400, 'BAN_POLICY_INVALID', 'Invalid ban policy');
    const o = input as { autoBanTtlSeconds?: unknown; ladder?: unknown };
    if (!('autoBanTtlSeconds' in o)) throw codedError(400, 'BAN_POLICY_TTL_REQUIRED', 'autoBanTtlSeconds is required (null = permanent)');
    const autoBanTtlSeconds = validTtl(o.autoBanTtlSeconds, 'autoBanTtlSeconds');
    const rawLadder = o.ladder ?? [];
    if (!Array.isArray(rawLadder)) throw codedError(400, 'BAN_LADDER_NOT_ARRAY', 'ladder must be an array');
    if (rawLadder.length > MAX_LADDER_STEPS) throw codedError(400, 'BAN_LADDER_TOO_LONG', `ladder has at most ${MAX_LADDER_STEPS} steps`, { max: MAX_LADDER_STEPS });

    const ladder: BanPolicyStep[] = [];
    let prevPrior = 0;
    let prevTtl = autoBanTtlSeconds;
    rawLadder.forEach((raw: unknown, i: number) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw codedError(400, 'BAN_LADDER_STEP_INVALID', `ladder[${i}] is invalid`, { step: i + 1 });
      const s = raw as { priorBans?: unknown; ttlSeconds?: unknown };
      const n = s.priorBans;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > MAX_LADDER_PRIOR_BANS) {
        throw codedError(400, 'BAN_LADDER_PRIOR_BANS_INVALID', `ladder[${i}].priorBans must be a whole number between 1 and ${MAX_LADDER_PRIOR_BANS}`, { step: i + 1, max: MAX_LADDER_PRIOR_BANS });
      }
      if (n <= prevPrior) throw codedError(400, 'BAN_LADDER_ORDER', 'ladder steps must be in strictly ascending priorBans order');
      if (!('ttlSeconds' in s)) throw codedError(400, 'BAN_LADDER_TTL_REQUIRED', `ladder[${i}].ttlSeconds is required (null = permanent)`, { step: i + 1 });
      const ttlSeconds = validTtl(s.ttlSeconds, `ladder[${i}].ttlSeconds`);
      if (ttlRank(ttlSeconds) < ttlRank(prevTtl)) {
        throw codedError(400, 'BAN_LADDER_TTL_DECREASING', `ladder[${i}] is shorter than the duration before it: a repeat offence never gets a shorter ban`, { step: i + 1 });
      }
      ladder.push({ priorBans: n, ttlSeconds });
      prevPrior = n;
      prevTtl = ttlSeconds;
    });
    return { autoBanTtlSeconds, ladder };
  },

  /** The policy in force and the layer it comes from (cached 60 s). */
  async getEffective(): Promise<EffectiveBanPolicy> {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
    const stored = parseStored(await appConfigService.get(APP_CONFIG_KEY));
    const value: EffectiveBanPolicy = stored
      ? { policy: stored, source: 'platform' }
      : { policy: { autoBanTtlSeconds: DEFAULT_BAN_POLICY.autoBanTtlSeconds, ladder: [] }, source: 'default' };
    cache = { value, at: now };
    return value;
  },

  /** Store a policy (validated first); null clears it (back to the system default). */
  async set(input: unknown): Promise<EffectiveBanPolicy> {
    if (input === null) {
      await db('app_config').where({ key: APP_CONFIG_KEY }).delete();
    } else {
      const policy = this.validate(input);
      await appConfigService.set(APP_CONFIG_KEY, JSON.stringify(policy));
    }
    cache = null;
    return this.getEffective();
  },

  /** Drop the cache (tests, or a write that bypassed this service). */
  invalidate(): void {
    cache = null;
  },

  /** True when the duration depends on the address's history (the engine then counts its earlier bans). */
  needsPriorCounts(policy: BanPolicy): boolean {
    return policy.ladder.length > 0;
  },

  /** Duration of a ban for an address with `priorBans` earlier bans. */
  ttlFor(policy: BanPolicy, priorBans: number): BanTtlChoice {
    let choice: BanTtlChoice = { ttlSeconds: policy.autoBanTtlSeconds, stepIndex: null };
    policy.ladder.forEach((s, i) => {
      if (priorBans >= s.priorBans) choice = { ttlSeconds: s.ttlSeconds, stepIndex: i };
    });
    return choice;
  },

  /** expires_at of a ban created at `at` (null = permanent). */
  expiresAt(policy: BanPolicy, priorBans: number, at = Date.now()): Date | null {
    const { ttlSeconds } = this.ttlFor(policy, priorBans);
    return ttlSeconds === null ? null : new Date(at + ttlSeconds * 1000);
  },
};
