// =============================================================================
// Obliguard - IPS agent settings: keys, definitions and defaults (W13-1)
// =============================================================================
//
// One tenant-scoped settings model resolved by the server (Obliance
// settingsDefaults / settings.service pattern), over four levels:
//
//   default -> GLOBAL -> TENANT -> GROUP chain (root -> leaf) -> AGENT
//
// Nearest explicit value wins, except:
//   - evaluateOnly ('anyTrue'): dry-run at any group or on the agent is
//     absolute (a sub-group or agent cannot re-arm enforcement); stored in the
//     monitor_groups / agent_devices evaluate_only columns;
//   - notificationTypes ('perField'): each type resolves on its own (a level
//     may set only 'down' and inherit the rest);
//   - updatePolicy ('external'): the dedicated C17 resolver (global -> tenant
//     -> group -> agent, 'off' absolute) keeps its own storage and routes; the
//     settings panels only DISPLAY it (owner directive W13-1).

export const SETTINGS_KEYS = {
  CHECK_INTERVAL:           'checkIntervalSeconds',
  MAX_MISSED_PUSHES:        'maxMissedPushes',
  EVALUATE_ONLY:            'evaluateOnly',
  AUTO_BAN_ENABLED:         'autoBanEnabled',
  WINDOWS_FIREWALL_BACKEND: 'windowsFirewallBackend',
  NOTIFICATION_TYPES:       'notificationTypes',
  UPDATE_POLICY:            'updatePolicy',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

/** The four levels of the cascade, nearest last. */
export const SETTING_LEVELS = ['global', 'tenant', 'group', 'agent'] as const;
export type SettingLevel = (typeof SETTING_LEVELS)[number];

/** Where a resolved value comes from. */
export type SettingSource = 'default' | SettingLevel;

export const WINDOWS_FIREWALL_BACKENDS = ['auto', 'wfp', 'netsh'] as const;
export type WindowsFirewallBackend = (typeof WINDOWS_FIREWALL_BACKENDS)[number];

/** Notification types switched per level (NotificationTypeConfig fields). */
export const NOTIFICATION_TYPE_FIELDS = ['global', 'down', 'up', 'threat', 'attack'] as const;
export type NotificationTypeField = (typeof NOTIFICATION_TYPE_FIELDS)[number];
/** A level's own notification types: null / absent field = inherit. */
export type NotificationTypeFlags = Partial<Record<NotificationTypeField, boolean | null>>;

export type SettingRawValue = number | boolean | string | NotificationTypeFlags;

export interface SettingDefinition {
  key: SettingsKey;
  label: string;
  description: string;
  type: 'number' | 'boolean' | 'enum' | 'flags';
  unit?: string;
  min?: number;
  max?: number;
  /** enum values ('enum' type). */
  options?: readonly string[];
  defaultValue: SettingRawValue;
  /** Levels where an explicit value may be set ([] = display only). */
  scopes: readonly SettingLevel[];
  /** How the levels combine (default 'nearest'). */
  resolution?: 'nearest' | 'anyTrue' | 'perField' | 'external';
  /** Only meaningful for Windows agents. */
  windowsOnly?: boolean;
}

const ALL_LEVELS: readonly SettingLevel[] = SETTING_LEVELS;

export const SETTINGS_DEFINITIONS: SettingDefinition[] = [
  {
    key: SETTINGS_KEYS.CHECK_INTERVAL,
    label: 'Check interval',
    description: 'Expected interval between two agent check-ins (also the HTTP push interval). The offline grace is this interval times the max missed check-ins.',
    type: 'number',
    unit: 'seconds',
    min: 10,
    max: 86400,
    defaultValue: 60,
    scopes: ALL_LEVELS,
  },
  {
    key: SETTINGS_KEYS.MAX_MISSED_PUSHES,
    label: 'Max missed check-ins',
    description: 'Consecutive missed check-ins before the agent is declared offline.',
    type: 'number',
    unit: 'check-ins',
    min: 1,
    max: 20,
    defaultValue: 2,
    scopes: ALL_LEVELS,
  },
  {
    key: SETTINGS_KEYS.AUTO_BAN_ENABLED,
    label: 'Automatic bans',
    description: "The ban engine creates bans from this agent's auth failures. Off = the events are kept and counted, but no automatic ban is created from them (bans from elsewhere are still enforced).",
    type: 'boolean',
    defaultValue: true,
    scopes: ALL_LEVELS,
  },
  {
    key: SETTINGS_KEYS.EVALUATE_ONLY,
    label: 'Evaluate-only (dry-run)',
    description: 'Observe events but never create nor enforce bans. On at any group above applies to every sub-group and agent.',
    type: 'boolean',
    defaultValue: false,
    scopes: ['group', 'agent'],
    resolution: 'anyTrue',
  },
  {
    key: SETTINGS_KEYS.WINDOWS_FIREWALL_BACKEND,
    label: 'Windows firewall backend',
    description: 'How Windows agents enforce bans: auto (current behaviour), WFP filters, or netsh rules. Ignored by other platforms and by agents that predate the switch.',
    type: 'enum',
    options: WINDOWS_FIREWALL_BACKENDS,
    defaultValue: 'auto',
    scopes: ALL_LEVELS,
    windowsOnly: true,
  },
  {
    key: SETTINGS_KEYS.NOTIFICATION_TYPES,
    label: 'Notification types',
    description: 'Which agent events reach the bound notification channels. Each type inherits on its own.',
    type: 'flags',
    defaultValue: { global: true, down: true, up: true, threat: true, attack: true },
    scopes: ALL_LEVELS,
    resolution: 'perField',
  },
  {
    key: SETTINGS_KEYS.UPDATE_POLICY,
    label: 'Agent updates',
    description: "Agent update policy (auto / manual / off, 'off' freezes everything below). Managed by the update policy controls.",
    type: 'enum',
    options: ['auto', 'manual', 'off'],
    defaultValue: 'manual',
    scopes: [],
    resolution: 'external',
  },
];

export const HARDCODED_DEFAULTS: Record<SettingsKey, SettingRawValue> = Object.fromEntries(
  SETTINGS_DEFINITIONS.map((d) => [d.key, d.defaultValue]),
) as Record<SettingsKey, SettingRawValue>;

/** The definition of a key (undefined for an unknown key). */
export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return SETTINGS_DEFINITIONS.find((d) => d.key === key);
}

/** Whether `key` may carry an explicit value at `level`. */
export function isSettingWritableAt(key: string, level: SettingLevel): boolean {
  return !!getSettingDefinition(key)?.scopes.includes(level);
}

/** A resolved value and where it comes from (shown by the inheritance badge). */
export interface ResolvedSettingValue {
  value: SettingRawValue;
  source: SettingSource;
  /** tenant / group / agent id of the source (null for default / global). */
  sourceId: number | null;
  sourceName: string;
  /** perField keys: the source of each field. */
  fields?: Partial<Record<string, { value: boolean; source: SettingSource; sourceId: number | null; sourceName: string }>>;
}

export type ResolvedSettingsMap = Partial<Record<SettingsKey, ResolvedSettingValue>>;

/**
 * GET /api/settings/<level>/.../resolved:
 *   - resolved: what this level inherits from the levels above (own value excluded);
 *   - overrides: this level's own explicit values;
 *   - effective: what applies at this level (own value included).
 */
export interface ScopeSettingsView {
  level: SettingLevel;
  scopeId: number | null;
  /** Owning tenant of the scope (null for global). */
  tenantId: number | null;
  resolved: ResolvedSettingsMap;
  overrides: Partial<Record<SettingsKey, SettingRawValue>>;
  effective: ResolvedSettingsMap;
}
