import { db } from '../db';
import type { AppConfig, AgentGlobalConfig, NotificationTypeConfig, ObliviewConfig, OblimapConfig, OblianceConfig } from '@obliview/shared';
import { DEFAULT_NOTIFICATION_TYPES } from '@obliview/shared';

const AGENT_GLOBAL_CONFIG_KEY = 'agent_global_config';
const OBLIVIEW_CONFIG_KEY     = 'obliview_config';
const OBLIMAP_CONFIG_KEY      = 'oblimap_config';
const OBLIANCE_CONFIG_KEY     = 'obliance_config';

/** Internal shape stored in DB (apiKey included). */
interface IntegrationConfigRaw {
  url?: string;
  apiKey?: string;
}

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
  },

  async getAll(): Promise<AppConfig> {
    const rows = await db('app_config').select('key', 'value');
    const map = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));

    /** Extract only the URL from a JSON config blob (never expose apiKey). */
    const parseUrl = (cfgKey: string): string | null => {
      if (!map[cfgKey]) return null;
      try { return (JSON.parse(map[cfgKey]) as IntegrationConfigRaw).url ?? null; } catch { return null; }
    };

    return {
      allow_2fa: map['allow_2fa'] === 'true',
      force_2fa: map['force_2fa'] === 'true',
      otp_smtp_server_id: map['otp_smtp_server_id'] ? parseInt(map['otp_smtp_server_id'], 10) : null,
      // Use the synced flat keys for URLs (set by setXxxConfig helpers below)
      obliview_url: map['obliview_url'] ?? parseUrl(OBLIVIEW_CONFIG_KEY),
      oblimap_url:  parseUrl(OBLIMAP_CONFIG_KEY),
      obliance_url: parseUrl(OBLIANCE_CONFIG_KEY),
      enable_foreign_sso:  map['enable_foreign_sso']  === 'true',
      enable_oblimap_sso:  map['enable_oblimap_sso']  === 'true',
      enable_obliance_sso: map['enable_obliance_sso'] === 'true',
    };
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

  // ── Obliview integration ─────────────────────────────────────────────────

  /** Get Obliview URL + whether an API key has been set (key itself never exposed). */
  async getObliviewConfig(): Promise<ObliviewConfig> {
    const raw = await this.get(OBLIVIEW_CONFIG_KEY);
    if (!raw) return { url: null, apiKeySet: false };
    try {
      const cfg = JSON.parse(raw) as IntegrationConfigRaw;
      return { url: cfg.url ?? null, apiKeySet: !!cfg.apiKey };
    } catch {
      return { url: null, apiKeySet: false };
    }
  },

  /** Merge-patch Obliview config. Pass apiKey=null to clear it. */
  async setObliviewConfig(patch: { url?: string | null; apiKey?: string | null }): Promise<ObliviewConfig> {
    const raw = await this.get(OBLIVIEW_CONFIG_KEY);
    const current: IntegrationConfigRaw = raw ? (JSON.parse(raw) as IntegrationConfigRaw) : {};
    if ('url' in patch) {
      if (patch.url) current.url = patch.url;
      else delete current.url;
    }
    if ('apiKey' in patch) {
      if (patch.apiKey) current.apiKey = patch.apiKey;
      else delete current.apiKey;
    }
    await this.set(OBLIVIEW_CONFIG_KEY, JSON.stringify(current));
    await this.set('obliview_url', current.url ?? '');
    return { url: current.url ?? null, apiKeySet: !!current.apiKey };
  },

  /** Server-side only: returns the raw Obliview API key for proxy requests. */
  async getObliviewRaw(): Promise<{ url: string | null; apiKey: string | null }> {
    const raw = await this.get(OBLIVIEW_CONFIG_KEY);
    if (!raw) return { url: null, apiKey: null };
    try {
      const cfg = JSON.parse(raw) as IntegrationConfigRaw;
      return { url: cfg.url ?? null, apiKey: cfg.apiKey ?? null };
    } catch {
      return { url: null, apiKey: null };
    }
  },

  // ── Oblimap integration ──────────────────────────────────────────────────

  async getOblimapConfig(): Promise<OblimapConfig> {
    const raw = await this.get(OBLIMAP_CONFIG_KEY);
    if (!raw) return { url: null, apiKeySet: false };
    try {
      const cfg = JSON.parse(raw) as IntegrationConfigRaw;
      return { url: cfg.url ?? null, apiKeySet: !!cfg.apiKey };
    } catch {
      return { url: null, apiKeySet: false };
    }
  },

  async setOblimapConfig(patch: { url?: string | null; apiKey?: string | null }): Promise<OblimapConfig> {
    const raw = await this.get(OBLIMAP_CONFIG_KEY);
    const current: IntegrationConfigRaw = raw ? (JSON.parse(raw) as IntegrationConfigRaw) : {};
    if ('url' in patch) { if (patch.url) current.url = patch.url; else delete current.url; }
    if ('apiKey' in patch) { if (patch.apiKey) current.apiKey = patch.apiKey; else delete current.apiKey; }
    await this.set(OBLIMAP_CONFIG_KEY, JSON.stringify(current));
    return { url: current.url ?? null, apiKeySet: !!current.apiKey };
  },

  async getOblimapRaw(): Promise<{ url: string | null; apiKey: string | null }> {
    const raw = await this.get(OBLIMAP_CONFIG_KEY);
    if (!raw) return { url: null, apiKey: null };
    try {
      const cfg = JSON.parse(raw) as IntegrationConfigRaw;
      return { url: cfg.url ?? null, apiKey: cfg.apiKey ?? null };
    } catch {
      return { url: null, apiKey: null };
    }
  },

  // ── Obliance integration ─────────────────────────────────────────────────

  async getOblianceConfig(): Promise<OblianceConfig> {
    const raw = await this.get(OBLIANCE_CONFIG_KEY);
    if (!raw) return { url: null, apiKeySet: false };
    try {
      const cfg = JSON.parse(raw) as IntegrationConfigRaw;
      return { url: cfg.url ?? null, apiKeySet: !!cfg.apiKey };
    } catch {
      return { url: null, apiKeySet: false };
    }
  },

  async setOblianceConfig(patch: { url?: string | null; apiKey?: string | null }): Promise<OblianceConfig> {
    const raw = await this.get(OBLIANCE_CONFIG_KEY);
    const current: IntegrationConfigRaw = raw ? (JSON.parse(raw) as IntegrationConfigRaw) : {};
    if ('url' in patch) { if (patch.url) current.url = patch.url; else delete current.url; }
    if ('apiKey' in patch) { if (patch.apiKey) current.apiKey = patch.apiKey; else delete current.apiKey; }
    await this.set(OBLIANCE_CONFIG_KEY, JSON.stringify(current));
    return { url: current.url ?? null, apiKeySet: !!current.apiKey };
  },

  async getOblianceRaw(): Promise<{ url: string | null; apiKey: string | null }> {
    const raw = await this.get(OBLIANCE_CONFIG_KEY);
    if (!raw) return { url: null, apiKey: null };
    try {
      const cfg = JSON.parse(raw) as IntegrationConfigRaw;
      return { url: cfg.url ?? null, apiKey: cfg.apiKey ?? null };
    } catch {
      return { url: null, apiKey: null };
    }
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
