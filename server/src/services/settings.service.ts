import { db } from '../db';
import type { SettingsScope, ResolvedSettings, SettingValue } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';
import { SETTINGS_KEYS, HARDCODED_DEFAULTS, SETTINGS_DEFINITIONS } from '@obliview/shared';

interface SettingsRow {
  id: number;
  scope: string;
  scope_id: number | null;
  key: string;
  value: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface SettingOverride {
  key: SettingsKey;
  value: number;
}

export const settingsService = {
  // ── Raw CRUD ──

  async getByScope(scope: SettingsScope, scopeId: number | null): Promise<Record<string, number>> {
    const rows = await db<SettingsRow>('settings')
      .where({ scope, scope_id: scopeId })
      .select('key', 'value');

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.key] = row.value as number;
    }
    return result;
  },

  async set(scope: SettingsScope, scopeId: number | null, key: SettingsKey, value: number): Promise<void> {
    // Validate key
    const def = SETTINGS_DEFINITIONS.find((d) => d.key === key);
    if (!def) throw new Error(`Unknown setting key: ${key}`);
    if (value < def.min || value > def.max) {
      throw new Error(`Value for ${key} must be between ${def.min} and ${def.max}`);
    }

    // Admin policy: enforce MIN_CHECK_INTERVAL / MIN_RETRY_INTERVAL env vars
    const minCheckInterval = Math.max(1, parseInt(process.env.MIN_CHECK_INTERVAL ?? '10', 10));
    if (key === SETTINGS_KEYS.CHECK_INTERVAL && value < minCheckInterval) {
      throw new Error(`Check interval must be at least ${minCheckInterval}s (admin policy)`);
    }
    const minRetryInterval = Math.max(1, parseInt(process.env.MIN_RETRY_INTERVAL ?? '5', 10));
    if (key === SETTINGS_KEYS.RETRY_INTERVAL && value < minRetryInterval) {
      throw new Error(`Retry interval must be at least ${minRetryInterval}s (admin policy)`);
    }

    await db('settings')
      .insert({
        scope,
        scope_id: scopeId,
        key,
        value: JSON.stringify(value),
        updated_at: new Date(),
      })
      .onConflict(['scope', 'scope_id', 'key'])
      .merge({ value: JSON.stringify(value), updated_at: new Date() });
  },

  async remove(scope: SettingsScope, scopeId: number | null, key: SettingsKey): Promise<boolean> {
    const count = await db('settings')
      .where({ scope, scope_id: scopeId, key })
      .del();
    return count > 0;
  },

  async setBulk(scope: SettingsScope, scopeId: number | null, overrides: SettingOverride[]): Promise<void> {
    for (const { key, value } of overrides) {
      await this.set(scope, scopeId, key, value);
    }
  },

  // ── Inheritance Resolution ──

  /**
   * Resolve all settings for a given scope, walking up the hierarchy:
   *   Hardcoded defaults → Global → Group ancestors (root→leaf) → Monitor
   *
   * Each resolved value tracks its source for UI display.
   */
  async resolveForMonitor(monitorId: number, groupId: number | null): Promise<ResolvedSettings> {
    // 1. Start with hardcoded defaults
    const resolved: ResolvedSettings = {} as ResolvedSettings;
    const allKeys = Object.values(SETTINGS_KEYS);

    for (const key of allKeys) {
      resolved[key] = {
        value: HARDCODED_DEFAULTS[key],
        source: 'default',
        sourceId: null,
        sourceName: 'Default',
      };
    }

    // 2. Apply global overrides
    const globalOverrides = await this.getByScope('global', null);
    for (const key of allKeys) {
      if (globalOverrides[key] !== undefined) {
        resolved[key] = {
          value: globalOverrides[key],
          source: 'global',
          sourceId: null,
          sourceName: 'Global',
        };
      }
    }

    // 3. Apply group chain (root → leaf) if monitor is in a group
    if (groupId !== null) {
      // Get ancestors ordered by depth DESC (root first → direct parent last)
      const ancestorRows = await db('group_closure')
        .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
        .where('group_closure.descendant_id', groupId)
        .orderBy('group_closure.depth', 'desc')
        .select('monitor_groups.id', 'monitor_groups.name', 'group_closure.depth');

      for (const ancestor of ancestorRows) {
        const groupOverrides = await this.getByScope('group', ancestor.id);
        for (const key of allKeys) {
          if (groupOverrides[key] !== undefined) {
            resolved[key] = {
              value: groupOverrides[key],
              source: 'group',
              sourceId: ancestor.id,
              sourceName: ancestor.name,
            };
          }
        }
      }
    }

    // 4. Apply monitor-level overrides
    const monitorOverrides = await this.getByScope('monitor' as unknown as SettingsScope, monitorId);
    for (const key of allKeys) {
      if (monitorOverrides[key] !== undefined) {
        resolved[key] = {
          value: monitorOverrides[key],
          source: 'monitor' as unknown as SettingsScope,
          sourceId: monitorId,
          sourceName: 'This monitor',
        };
      }
    }

    return resolved;
  },

  /**
   * Resolve settings for a group level (for display in group settings UI).
   * Chain: Hardcoded → Global → Ancestor groups (root→parent)
   * Does NOT include the group's own overrides as resolved — returns them separately.
   */
  async resolveForGroup(groupId: number): Promise<{ resolved: ResolvedSettings; overrides: Record<string, number> }> {
    const allKeys = Object.values(SETTINGS_KEYS);

    // 1. Start with hardcoded defaults
    const resolved: ResolvedSettings = {} as ResolvedSettings;
    for (const key of allKeys) {
      resolved[key] = {
        value: HARDCODED_DEFAULTS[key],
        source: 'default',
        sourceId: null,
        sourceName: 'Default',
      };
    }

    // 2. Global
    const globalOverrides = await this.getByScope('global', null);
    for (const key of allKeys) {
      if (globalOverrides[key] !== undefined) {
        resolved[key] = {
          value: globalOverrides[key],
          source: 'global',
          sourceId: null,
          sourceName: 'Global',
        };
      }
    }

    // 3. Ancestors (root→parent, excluding self)
    const ancestorRows = await db('group_closure')
      .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
      .where('group_closure.descendant_id', groupId)
      .where('group_closure.depth', '>', 0) // exclude self
      .orderBy('group_closure.depth', 'desc')
      .select('monitor_groups.id', 'monitor_groups.name', 'group_closure.depth');

    for (const ancestor of ancestorRows) {
      const groupOvr = await this.getByScope('group', ancestor.id);
      for (const key of allKeys) {
        if (groupOvr[key] !== undefined) {
          resolved[key] = {
            value: groupOvr[key],
            source: 'group',
            sourceId: ancestor.id,
            sourceName: ancestor.name,
          };
        }
      }
    }

    // 4. Get this group's own overrides (separate, not merged into resolved)
    const overrides = await this.getByScope('group', groupId);

    return { resolved, overrides };
  },

  /**
   * Resolve for global scope (just hardcoded defaults + global overrides)
   */
  async resolveGlobal(): Promise<{ resolved: ResolvedSettings; overrides: Record<string, number> }> {
    const allKeys = Object.values(SETTINGS_KEYS);
    const resolved: ResolvedSettings = {} as ResolvedSettings;

    for (const key of allKeys) {
      resolved[key] = {
        value: HARDCODED_DEFAULTS[key],
        source: 'default',
        sourceId: null,
        sourceName: 'Default',
      };
    }

    const overrides = await this.getByScope('global', null);

    return { resolved, overrides };
  },
};
