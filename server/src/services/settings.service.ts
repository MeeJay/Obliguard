import { db } from '../db';
import type {
  AgentGlobalConfig, SettingLevel, SettingsKey, SettingRawValue, SettingDefinition, NotificationTypeFlags, NotificationTypeConfig,
} from '@obliview/shared';
import { getSettingDefinition, NOTIFICATION_TYPE_FIELDS, MASTER_TENANT_ID } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { codedError, type ErrorCode, type ErrorParams } from '../utils/errorCodes';
import { appConfigService } from './appConfig.service';

/**
 * IPS settings rows (W13-1): tenant-scoped storage of the cascade keys
 * (shared/src/settingsDefaults.ts), modelled on Obliance settings.service +
 * settingsWrite.service. Resolution lives in agentConfig.service.
 *
 *   level   scope_id    tenant_id
 *   global  NULL        1 (Default: platform-wide)
 *   tenant  tenant id   that tenant
 *   group   group id    the group's tenant
 *   agent   device id   the device's tenant
 *
 * evaluateOnly is column-backed (monitor_groups / agent_devices
 * evaluate_only, read by the ban engine); updatePolicy is never written here
 * (C17 resolver, owner directive).
 *
 * Legacy storage (agent_global_config, agent_group_config, agent_devices
 * override columns) is mirrored on every write until its readers have moved
 * to the resolver (notification.service), then dropped next release.
 */

interface SettingsRow {
  key: string;
  value: unknown;
}

export interface SettingTarget {
  level: SettingLevel;
  /** null for global. */
  scopeId: number | null;
  /** Owning tenant (Default for global). */
  tenantId: number;
}

/** Keys mirrored into the legacy storage of a level. */
const LEGACY_KEYS: ReadonlySet<string> = new Set(['checkIntervalSeconds', 'maxMissedPushes', 'notificationTypes']);

function invalid(code: ErrorCode, message: string, params?: ErrorParams): AppError {
  return codedError(400, code, message, params);
}

/** Placeholders of FIELD_INTEGER_RANGE (an open bound is left out: the server text is shown). */
function rangeParams(field: string, min: number | undefined, max: number | undefined): ErrorParams {
  return { field, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

/** Full legacy NotificationTypeConfig (null = inherit) of a flags value. */
export function flagsToLegacyTypes(flags: NotificationTypeFlags | null): NotificationTypeConfig | null {
  if (!flags) return null;
  const out = {} as NotificationTypeConfig;
  for (const f of NOTIFICATION_TYPE_FIELDS) out[f] = typeof flags[f] === 'boolean' ? flags[f] as boolean : null;
  return out;
}

/** Flags of a legacy NotificationTypeConfig (boolean fields only), null when none is set. */
export function legacyTypesToFlags(raw: unknown): NotificationTypeFlags | null {
  const obj = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })() : raw;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: NotificationTypeFlags = {};
  for (const f of NOTIFICATION_TYPE_FIELDS) {
    const v = (obj as Record<string, unknown>)[f];
    if (typeof v === 'boolean') out[f] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Validate a value for `key` (AppError 400). Returns the value to store, or
 * null when it means "no explicit value" (notification types all inherited).
 */
export function normalizeSettingValue(def: SettingDefinition, value: unknown): SettingRawValue | null {
  switch (def.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid('FIELD_INTEGER', `${def.key} must be an integer`, { field: def.key });
      if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) {
        throw invalid('FIELD_INTEGER_RANGE', `Value for ${def.key} must be between ${def.min} and ${def.max}`, rangeParams(def.key, def.min, def.max));
      }
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid('FIELD_BOOLEAN', `${def.key} must be true or false`, { field: def.key });
      return value;
    case 'enum':
      if (typeof value !== 'string' || !(def.options ?? []).includes(value)) {
        throw invalid('FIELD_ONE_OF', `${def.key} must be one of: ${(def.options ?? []).join(', ')}`, { field: def.key, options: (def.options ?? []).join(', ') });
      }
      return value;
    case 'flags': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('FIELD_OBJECT', `${def.key} must be an object`, { field: def.key });
      const src = value as Record<string, unknown>;
      const out: NotificationTypeFlags = {};
      for (const [k, v] of Object.entries(src)) {
        if (!(NOTIFICATION_TYPE_FIELDS as readonly string[]).includes(k)) throw invalid('FIELD_UNKNOWN', `Unknown ${def.key} field: ${k}`, { field: `${def.key}.${k}` });
        if (v === null || v === undefined) continue;
        if (typeof v !== 'boolean') throw invalid('FIELD_BOOLEAN_OR_NULL', `${def.key}.${k} must be true, false or null`, { field: `${def.key}.${k}` });
        out[k as keyof NotificationTypeFlags] = v;
      }
      return Object.keys(out).length > 0 ? out : null;
    }
  }
}

/** The definition of a key writable at `level` (AppError 400 otherwise). */
export function writableDefinition(key: unknown, level: SettingLevel): SettingDefinition {
  const def = typeof key === 'string' ? getSettingDefinition(key) : undefined;
  if (!def) throw invalid('SETTING_UNKNOWN', `Unknown setting key: ${String(key)}`, { key: String(key) });
  if (def.resolution === 'external') throw invalid('SETTING_EXTERNAL', `${def.key} is managed by its own controls`, { key: def.key });
  if (!def.scopes.includes(level)) throw invalid('SETTING_LEVEL_INVALID', `${def.key} cannot be set at the ${level} level`, { key: def.key, level });
  return def;
}

function scopeWhere(level: SettingLevel, scopeId: number | null): Record<string, unknown> {
  return { scope: level, scope_id: scopeId };
}

async function upsertRow(target: SettingTarget, key: string, value: SettingRawValue): Promise<void> {
  const serialized = JSON.stringify(value);
  const tenantId = target.level === 'global' ? MASTER_TENANT_ID : target.tenantId;
  if (target.scopeId === null) {
    // Global: scope_id IS NULL never fires the (scope, scope_id, key) index,
    // hence the partial one (migration 041) repeated in ON CONFLICT.
    await db.raw(
      `INSERT INTO settings (scope, scope_id, key, value, tenant_id, created_at, updated_at)
       VALUES (?, NULL, ?, ?::jsonb, ?, NOW(), NOW())
       ON CONFLICT (scope, key) WHERE scope_id IS NULL
       DO UPDATE SET value = EXCLUDED.value, tenant_id = EXCLUDED.tenant_id, updated_at = NOW()`,
      [target.level, key, serialized, tenantId],
    );
    return;
  }
  await db.raw(
    `INSERT INTO settings (scope, scope_id, key, value, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?::jsonb, ?, NOW(), NOW())
     ON CONFLICT (scope, scope_id, key)
     DO UPDATE SET value = EXCLUDED.value, tenant_id = EXCLUDED.tenant_id, updated_at = NOW()`,
    [target.level, target.scopeId, key, serialized, tenantId],
  );
}

/** Merge a patch into monitor_groups.agent_group_config (legacy mirror; other keys kept). */
async function mergeGroupConfigColumn(groupId: number, patch: Record<string, unknown>): Promise<void> {
  const row = await db('monitor_groups').where({ id: groupId }).first('agent_group_config') as { agent_group_config: unknown } | undefined;
  if (!row) return;
  const raw = row.agent_group_config;
  const current = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    pushIntervalSeconds: null, maxMissedPushes: null, notificationTypes: null,
    ...current, ...patch,
  };
  delete merged.heartbeatMonitoring;
  await db('monitor_groups').where({ id: groupId })
    .update({ agent_group_config: JSON.stringify(merged), updated_at: new Date() });
}

/** Write the legacy storage of one level for a cascade key (value null = inherit). */
async function mirrorLegacy(target: SettingTarget, key: string, value: SettingRawValue | null): Promise<void> {
  if (!LEGACY_KEYS.has(key) || target.level === 'tenant') return;
  const legacyValue = key === 'notificationTypes' ? flagsToLegacyTypes(value as NotificationTypeFlags | null) : value;
  if (target.level === 'global') {
    await appConfigService.setAgentGlobal({ [key]: legacyValue } as Partial<AgentGlobalConfig>);
    return;
  }
  if (target.level === 'group' && target.scopeId !== null) {
    await mergeGroupConfigColumn(target.scopeId, { [key === 'checkIntervalSeconds' ? 'pushIntervalSeconds' : key]: legacyValue });
    return;
  }
  if (target.level === 'agent' && target.scopeId !== null) {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (key === 'checkIntervalSeconds') {
      update.override_group_settings = value !== null;
      if (value !== null) update.check_interval_seconds = value;
    } else if (key === 'maxMissedPushes') {
      update.agent_max_missed_pushes = value;
    } else {
      update.notification_types = legacyValue ? JSON.stringify(legacyValue) : null;
    }
    await db('agent_devices').where({ id: target.scopeId }).update(update);
  }
}

/** Column-backed evaluateOnly write (true = dry-run at this level, null / false = off). */
async function writeEvaluateOnly(target: SettingTarget, value: boolean): Promise<void> {
  const table = target.level === 'group' ? 'monitor_groups' : 'agent_devices';
  await db(table).where({ id: target.scopeId }).update({ evaluate_only: value, updated_at: new Date() });
  const { invalidateEvaluateOnlyCache } = await import('./agent.service');
  invalidateEvaluateOnlyCache();
}

async function invalidateResolver(): Promise<void> {
  const { agentConfigService } = await import('./agentConfig.service');
  agentConfigService.invalidate();
}

export const settingsService = {
  /** This level's own explicit values (evaluateOnly from its column, when on). */
  async getOwn(level: SettingLevel, scopeId: number | null): Promise<Partial<Record<SettingsKey, SettingRawValue>>> {
    const rows = await db<SettingsRow>('settings').where(scopeWhere(level, scopeId)).select('key', 'value');
    const out: Partial<Record<SettingsKey, SettingRawValue>> = {};
    for (const r of rows) {
      const def = getSettingDefinition(r.key);
      if (!def || def.resolution === 'external' || def.resolution === 'anyTrue' || !def.scopes.includes(level)) continue;
      out[def.key] = r.value as SettingRawValue; // jsonb: parsed by the driver
    }
    if ((level === 'group' || level === 'agent') && scopeId !== null) {
      const table = level === 'group' ? 'monitor_groups' : 'agent_devices';
      const row = await db(table).where({ id: scopeId }).first('evaluate_only') as { evaluate_only: boolean | null } | undefined;
      if (row?.evaluate_only) out.evaluateOnly = true;
    }
    return out;
  },

  /**
   * Set (value) or reset (null) one key at a level. Validated first (AppError
   * 400); `mirror: false` when the caller writes the legacy storage itself
   * (compat endpoints). Drops the resolver cache.
   */
  async write(target: SettingTarget, key: string, value: unknown, opts: { mirror?: boolean } = {}): Promise<SettingRawValue | null> {
    const def = writableDefinition(key, target.level);
    if (target.level !== 'global' && target.scopeId === null) throw invalid('SCOPE_ID_REQUIRED', 'Missing scope id');
    const stored = value === null ? null : normalizeSettingValue(def, value);

    if (def.resolution === 'anyTrue') {
      await writeEvaluateOnly(target, stored === true);
    } else if (stored === null) {
      await db('settings').where({ ...scopeWhere(target.level, target.scopeId), key: def.key }).del();
    } else {
      await upsertRow(target, def.key, stored);
    }
    if (opts.mirror !== false) await mirrorLegacy(target, def.key, stored);
    await invalidateResolver();
    return stored;
  },

  /** Several keys at one level, all validated before the first write. */
  async writeMany(target: SettingTarget, entries: Array<{ key: string; value: unknown }>, opts: { mirror?: boolean } = {}): Promise<void> {
    for (const e of entries) {
      const def = writableDefinition(e.key, target.level);
      if (e.value !== null) normalizeSettingValue(def, e.value);
    }
    for (const e of entries) await this.write(target, e.key, e.value, opts);
  },

  /** Drop the rows of deleted groups / agents (no FK on scope_id). */
  async removeScopes(level: 'group' | 'agent', scopeIds: number[]): Promise<void> {
    if (scopeIds.length === 0) return;
    await db('settings').where({ scope: level }).whereIn('scope_id', scopeIds).del();
    await invalidateResolver();
  },
};
