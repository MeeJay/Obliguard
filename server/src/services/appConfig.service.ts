import { db } from '../db';
import type { AppConfig, AgentGlobalConfig, NotificationTypeConfig, ObligateConfig, RateLimitEnforcement } from '@obliview/shared';
import { DEFAULT_NOTIFICATION_TYPES } from '@obliview/shared';
import { codedError } from '../utils/errorCodes';

const AGENT_GLOBAL_CONFIG_KEY = 'agent_global_config';
const OBLIGATE_CONFIG_KEY     = 'obligate_config';
const RATE_LIMIT_ENFORCEMENT_KEY = 'rateLimitEnforcement';

export type { RateLimitEnforcement };

// ── Data retention (W12-1 / D15) ─────────────────────────────────────────────

/** Retention windows, in days, applied hourly by services/retention.service.ts. */
export type RetentionKey = 'eventsDays' | 'reputationDays' | 'banHistoryDays' | 'auditDays';
export type RetentionConfig = Record<RetentionKey, number>;

interface RetentionDef {
  /** app_config key holding the explicit value (unset = env fallback, then default). */
  key: string;
  default: number;
  min: number;
  max: number;
  /** Environment variable used when no explicit value is stored. */
  env: string | null;
}

export const RETENTION_DEFS: Readonly<Record<RetentionKey, RetentionDef>> = {
  // ip_events: raw connection/auth firehose. Dashboard history survives the
  // purge through the IPS snapshot tables (ipsSnapshot.service). Min 1: the
  // env variable accepted any positive window before W12-1.
  eventsDays:     { key: 'retention.eventsDays',     default: 90,  min: 1,  max: 3650, env: 'IP_EVENTS_RETENTION_DAYS' },
  // ip_reputation rows inactive for this long (never banned or whitelisted ones).
  reputationDays: { key: 'retention.reputationDays', default: 180, min: 7,  max: 3650, env: null },
  // Inactive (lifted / expired) ban rows, counted from lifted_at / expires_at.
  banHistoryDays: { key: 'retention.banHistoryDays', default: 365, min: 7,  max: 3650, env: null },
  auditDays:      { key: 'retention.auditDays',      default: 365, min: 30, max: 3650, env: 'AUDIT_RETENTION_DAYS' },
};

export const RETENTION_KEYS = Object.keys(RETENTION_DEFS) as RetentionKey[];

/** One retention setting as shown in Settings: stored value, effective value and bounds. */
export interface RetentionSettingView {
  /** Explicit value stored in app_config, null when unset. */
  value: number | null;
  /** Value the retention job applies (stored, else env fallback, else default). */
  effective: number;
  /** Value used when nothing is stored: the env fallback when set, else the built-in default. */
  fallback: number;
  default: number;
  min: number;
  max: number;
  env: string | null;
  /** Clamped env value, null when the variable is unset or invalid. */
  envValue: number | null;
}
export type RetentionView = Record<RetentionKey, RetentionSettingView>;

/** Integer days within the setting's bounds, or null (unset / not a number). */
function parseRetentionDays(raw: string | null | undefined, def: RetentionDef): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(def.max, Math.max(def.min, Math.floor(n)));
}

/**
 * The switch is read on every agent heartbeat: cached briefly, and dropped
 * whenever the key is written through this service.
 */
const RATE_LIMIT_ENFORCEMENT_TTL_MS = 5_000;
let rateLimitEnforcementCache: { value: RateLimitEnforcement; at: number } | null = null;

export const appConfigService = {
  async get(key: string): Promise<string | null> {
    const row = await db('app_config').where({ key }).first('value');
    return row?.value ?? null;
  },

  async set(key: string, value: string): Promise<void> {
    await db('app_config')
      .insert({ key, value })
      .onConflict('key')
      .merge({ value });
    if (key === RATE_LIMIT_ENFORCEMENT_KEY) rateLimitEnforcementCache = null;
  },

  async unset(key: string): Promise<void> {
    await db('app_config').where({ key }).delete();
    if (key === RATE_LIMIT_ENFORCEMENT_KEY) rateLimitEnforcementCache = null;
  },

  // ── Data retention (W12-1) ─────────────────────────────────────────────

  /** Stored, env and effective values of every retention window. */
  async getRetentionView(): Promise<RetentionView> {
    const rows = await db('app_config')
      .whereIn('key', RETENTION_KEYS.map((k) => RETENTION_DEFS[k].key))
      .select('key', 'value') as Array<{ key: string; value: string }>;
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const view = {} as RetentionView;
    for (const k of RETENTION_KEYS) {
      const def = RETENTION_DEFS[k];
      const value = parseRetentionDays(stored.get(def.key), def);
      const envValue = def.env ? parseRetentionDays(process.env[def.env], def) : null;
      const fallback = envValue ?? def.default;
      view[k] = {
        value, effective: value ?? fallback, fallback,
        default: def.default, min: def.min, max: def.max, env: def.env, envValue,
      };
    }
    return view;
  },

  /** Effective retention windows (days), always within their bounds. */
  async getRetention(): Promise<RetentionConfig> {
    const view = await this.getRetentionView();
    const cfg = {} as RetentionConfig;
    for (const k of RETENTION_KEYS) cfg[k] = view[k].effective;
    return cfg;
  },

  /**
   * Partial update: an integer within [min, max] stores the value, null
   * clears it (back to the env fallback / default). Anything else is a 400
   * and nothing is written.
   */
  async setRetention(patch: unknown): Promise<RetentionView> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw codedError(400, 'FIELD_OBJECT', 'Retention settings must be an object', { field: 'retention' });
    }
    const entries = Object.entries(patch as Record<string, unknown>);
    if (entries.length === 0) throw codedError(400, 'RETENTION_SETTINGS_EMPTY', 'No retention setting given');
    const writes: Array<{ key: string; value: number | null }> = [];
    for (const [k, v] of entries) {
      // Own keys only: 'toString' / '__proto__' are not settings.
      const def = Object.prototype.hasOwnProperty.call(RETENTION_DEFS, k)
        ? RETENTION_DEFS[k as RetentionKey] : undefined;
      if (!def) throw codedError(400, 'SETTING_UNKNOWN', `Unknown retention setting: ${k}`, { key: k });
      if (v === null) { writes.push({ key: def.key, value: null }); continue; }
      if (typeof v !== 'number' || !Number.isInteger(v) || v < def.min || v > def.max) {
        throw codedError(400, 'FIELD_INTEGER_RANGE', `${k} must be an integer between ${def.min} and ${def.max} days`, { field: k, min: def.min, max: def.max });
      }
      writes.push({ key: def.key, value: v });
    }
    await db.transaction(async (trx) => {
      for (const w of writes) {
        if (w.value === null) await trx('app_config').where({ key: w.key }).delete();
        else await trx('app_config').insert({ key: w.key, value: String(w.value) }).onConflict('key').merge({ value: String(w.value) });
      }
    });
    return this.getRetentionView();
  },

  // ── Rate-limit enforcement switch (W4-5) ───────────────────────────────

  /** 'on' only when explicitly enabled; anything else (unset included) is 'off'. */
  async getRateLimitEnforcement(): Promise<RateLimitEnforcement> {
    const now = Date.now();
    if (rateLimitEnforcementCache && now - rateLimitEnforcementCache.at < RATE_LIMIT_ENFORCEMENT_TTL_MS) {
      return rateLimitEnforcementCache.value;
    }
    const value: RateLimitEnforcement = (await this.get(RATE_LIMIT_ENFORCEMENT_KEY)) === 'on' ? 'on' : 'off';
    rateLimitEnforcementCache = { value, at: now };
    return value;
  },

  async setRateLimitEnforcement(value: RateLimitEnforcement): Promise<RateLimitEnforcement> {
    await this.set(RATE_LIMIT_ENFORCEMENT_KEY, value);
    return value;
  },

  async getAll(): Promise<AppConfig> {
    const rows = await db('app_config').select('key', 'value');
    const map = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));

    /** Extract only the URL from a JSON config blob (never expose apiKey) */
    const parseUrl = (key: string): string | null => {
      if (!map[key]) return null;
      try { return (JSON.parse(map[key]) as { url?: string }).url?.trim() || null; } catch { return null; }
    };

    return {
      allow_2fa: map['allow_2fa'] === 'true',
      force_2fa: map['force_2fa'] === 'true',
      otp_smtp_server_id: map['otp_smtp_server_id'] ? parseInt(map['otp_smtp_server_id'], 10) : null,
      obligate_url:     parseUrl(OBLIGATE_CONFIG_KEY),
      obligate_enabled: map['obligate_enabled'] === 'true',
      oblitools_push_enabled:  map['oblitools_push_enabled'] ?? null,
      oblitools_instance_name: map['oblitools_instance_name'] ?? null,
      oblitools_api_key:       map['oblitools_api_key'] ? '••••••••' : null, // never expose raw key
      oblitools_last_push_at:  map['oblitools_last_push_at'] ?? null,
    };
  },

  // ── Obligate SSO gateway ───────────────────────────────────────────────

  async getObligateConfig(): Promise<ObligateConfig> {
    const raw = await this.get(OBLIGATE_CONFIG_KEY);
    const enabled = await this.get('obligate_enabled');
    if (!raw) return { url: null, apiKeySet: false, enabled: enabled === 'true' };
    try {
      const cfg = JSON.parse(raw) as { url?: string; apiKey?: string };
      return { url: cfg.url?.trim() || null, apiKeySet: !!cfg.apiKey?.trim(), enabled: enabled === 'true' };
    } catch { return { url: null, apiKeySet: false, enabled: enabled === 'true' }; }
  },

  async getObligateRaw(): Promise<{ url: string | null; apiKey: string | null }> {
    const raw = await this.get(OBLIGATE_CONFIG_KEY);
    if (!raw) return { url: null, apiKey: null };
    try {
      const cfg = JSON.parse(raw) as { url?: string; apiKey?: string };
      // Trimmed on read too, for rows saved before values were normalised: a
      // stray whitespace would make the hashed public client id mismatch.
      return { url: cfg.url?.trim() || null, apiKey: cfg.apiKey?.trim() || null };
    } catch { return { url: null, apiKey: null }; }
  },

  async patchObligateConfig(patch: { url?: string | null; apiKey?: string | null; enabled?: boolean }): Promise<ObligateConfig> {
    const existing = await this.getObligateRaw();
    const newKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : patch.apiKey;
    const merged = {
      url: 'url' in patch ? (patch.url?.trim() || null) : existing.url,
      apiKey: ('apiKey' in patch && newKey) ? newKey : existing.apiKey,
    };
    await this.set(OBLIGATE_CONFIG_KEY, JSON.stringify(merged));
    if ('enabled' in patch) {
      await this.set('obligate_enabled', patch.enabled ? 'true' : 'false');
    }
    const enabled = await this.get('obligate_enabled');
    return { url: merged.url, apiKeySet: !!merged.apiKey, enabled: enabled === 'true' };
  },

  /** Get global agent defaults from app_config */
  async getAgentGlobal(): Promise<AgentGlobalConfig> {
    const raw = await this.get(AGENT_GLOBAL_CONFIG_KEY);
    if (!raw) {
      return { checkIntervalSeconds: null, maxMissedPushes: null, notificationTypes: null };
    }
    try {
      return JSON.parse(raw) as AgentGlobalConfig;
    } catch {
      return { checkIntervalSeconds: null, maxMissedPushes: null, notificationTypes: null };
    }
  },

  /** Merge-patch global agent defaults */
  async setAgentGlobal(patch: Partial<AgentGlobalConfig>): Promise<AgentGlobalConfig> {
    const current = await this.getAgentGlobal();
    const updated: AgentGlobalConfig = { ...current, ...patch };
    await this.set(AGENT_GLOBAL_CONFIG_KEY, JSON.stringify(updated));
    return updated;
  },

  /**
   * Read the global notification types (fully resolved — each field falls back to
   * DEFAULT_NOTIFICATION_TYPES when null).
   */
  async getResolvedAgentNotificationTypes(): Promise<{
    global: boolean; down: boolean; up: boolean; threat: boolean; attack: boolean;
  }> {
    const cfg = await this.getAgentGlobal();
    const nt: NotificationTypeConfig | null = cfg.notificationTypes ?? null;
    return {
      global: nt?.global ?? DEFAULT_NOTIFICATION_TYPES.global,
      down:   nt?.down   ?? DEFAULT_NOTIFICATION_TYPES.down,
      up:     nt?.up     ?? DEFAULT_NOTIFICATION_TYPES.up,
      threat: nt?.threat ?? DEFAULT_NOTIFICATION_TYPES.threat,
      attack: nt?.attack ?? DEFAULT_NOTIFICATION_TYPES.attack,
    };
  },
};
