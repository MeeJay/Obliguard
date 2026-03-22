import { db } from '../db';
import type { AppConfig, AgentGlobalConfig, NotificationTypeConfig, ObligateConfig } from '@obliview/shared';
import { DEFAULT_NOTIFICATION_TYPES } from '@obliview/shared';

const AGENT_GLOBAL_CONFIG_KEY = 'agent_global_config';
const OBLIGATE_CONFIG_KEY     = 'obligate_config';

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

    /** Extract only the URL from a JSON config blob (never expose apiKey) */
    const parseUrl = (key: string): string | null => {
      if (!map[key]) return null;
      try { return (JSON.parse(map[key]) as { url?: string }).url || null; } catch { return null; }
    };

    return {
      allow_2fa: map['allow_2fa'] === 'true',
      force_2fa: map['force_2fa'] === 'true',
      otp_smtp_server_id: map['otp_smtp_server_id'] ? parseInt(map['otp_smtp_server_id'], 10) : null,
      obligate_url:     parseUrl(OBLIGATE_CONFIG_KEY),
      obligate_enabled: map['obligate_enabled'] === 'true',
    };
  },

  // ── Obligate SSO gateway ───────────────────────────────────────────────

  async getObligateConfig(): Promise<ObligateConfig> {
    const raw = await this.get(OBLIGATE_CONFIG_KEY);
    const enabled = await this.get('obligate_enabled');
    if (!raw) return { url: null, apiKeySet: false, enabled: enabled === 'true' };
    try {
      const cfg = JSON.parse(raw) as { url?: string; apiKey?: string };
      return { url: cfg.url ?? null, apiKeySet: !!cfg.apiKey, enabled: enabled === 'true' };
    } catch { return { url: null, apiKeySet: false, enabled: enabled === 'true' }; }
  },

  async getObligateRaw(): Promise<{ url: string | null; apiKey: string | null }> {
    const raw = await this.get(OBLIGATE_CONFIG_KEY);
    if (!raw) return { url: null, apiKey: null };
    try {
      const cfg = JSON.parse(raw) as { url?: string; apiKey?: string };
      return { url: cfg.url ?? null, apiKey: cfg.apiKey ?? null };
    } catch { return { url: null, apiKey: null }; }
  },

  async patchObligateConfig(patch: { url?: string | null; apiKey?: string | null; enabled?: boolean }): Promise<ObligateConfig> {
    const existing = await this.getObligateRaw();
    const merged = {
      url: 'url' in patch ? (patch.url ?? null) : existing.url,
      apiKey: ('apiKey' in patch && patch.apiKey) ? patch.apiKey : existing.apiKey,
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
