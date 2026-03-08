import type { MonitorType, MonitorStatus, UserRole } from './monitorTypes';
import type { SettingsKey } from './settingsDefaults';

// ============================================
// User types
// ============================================
export interface UserPreferences {
  toastEnabled: boolean;
  toastPosition: 'top-center' | 'bottom-right';
  multiTenantNotificationsEnabled?: boolean;
}

/** Shape of a live alert as returned by the server (used in socket NOTIFICATION_NEW + REST API). */
export interface LiveAlertData {
  id: number;
  tenantId: number;
  tenantName?: string;
  severity: 'down' | 'up' | 'warning' | 'info';
  title: string;
  message: string;
  navigateTo: string | null;
  stableKey: string | null;
  read: boolean;
  createdAt: string; // ISO 8601
}

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  preferences?: UserPreferences | null;
  email?: string | null;
  preferredLanguage: string;
  enrollmentVersion: number;
  totpEnabled?: boolean;
  emailOtpEnabled?: boolean;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

// ============================================
// Monitor types
// ============================================
export interface Monitor {
  id: number;
  name: string;
  description: string | null;
  type: MonitorType;
  groupId: number | null;
  isActive: boolean;
  status: MonitorStatus;

  // Common config
  intervalSeconds: number | null;
  retryIntervalSeconds: number | null;
  maxRetries: number | null;
  timeoutMs: number | null;
  upsideDown: boolean;

  // HTTP / JSON API
  url: string | null;
  method: string | null;
  headers: Record<string, string> | null;
  body: string | null;
  expectedStatusCodes: number[] | null;
  keyword: string | null;
  keywordIsPresent: boolean | null;
  ignoreSsl: boolean;

  // JSON API
  jsonPath: string | null;
  jsonExpectedValue: string | null;

  // Ping / TCP
  hostname: string | null;
  port: number | null;

  // DNS
  dnsRecordType: string | null;
  dnsResolver: string | null;
  dnsExpectedValue: string | null;

  // SSL
  sslWarnDays: number | null;

  // SMTP
  smtpHost: string | null;
  smtpPort: number | null;

  // Docker
  dockerHost: string | null;
  dockerContainerName: string | null;

  // Game server
  gameType: string | null;
  gameHost: string | null;
  gamePort: number | null;

  // Push
  pushToken: string | null;
  pushMaxIntervalSec: number | null;

  // Script
  scriptCommand: string | null;
  scriptExpectedExit: number | null;

  // Browser (Playwright)
  browserUrl: string | null;
  browserKeyword: string | null;
  browserKeywordIsPresent: boolean | null;
  browserWaitForSelector: string | null;
  browserScreenshotOnFailure: boolean;

  // Value Watcher
  valueWatcherUrl: string | null;
  valueWatcherJsonPath: string | null;
  valueWatcherOperator: string | null;
  valueWatcherThreshold: number | null;
  valueWatcherThresholdMax: number | null;
  valueWatcherPreviousValue: string | null;
  valueWatcherHeaders: Record<string, string> | null;

  // Agent Monitor
  agentDeviceId: number | null;
  agentDeviceName: string | null;  // display name from agent_devices.name (null if not set)
  agentThresholds: AgentThresholds | null;

  // Metadata
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  inMaintenance?: boolean;
}

// ============================================
// Heartbeat types
// ============================================
export interface Heartbeat {
  id: number;
  monitorId: number;
  status: MonitorStatus;
  responseTime: number | null;
  statusCode: number | null;
  message: string | null;
  ping: number | null;
  isRetrying: boolean;
  value: string | null;
  inMaintenance?: boolean;
  createdAt: string;
}

export interface HeartbeatStats {
  monitorId: number;
  period: string;
  uptimePct: number;
  avgResponse: number | null;
  maxResponse: number | null;
  minResponse: number | null;
  totalChecks: number;
  totalUp: number;
  totalDown: number;
}

// ============================================
// Group types
// ============================================
export interface MonitorGroup {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
  sortOrder: number;
  isGeneral: boolean;
  groupNotifications: boolean;
  kind: 'monitor' | 'agent';
  agentThresholds?: AgentThresholds | null;
  agentGroupConfig?: AgentGroupConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupTreeNode extends MonitorGroup {
  children: GroupTreeNode[];
  monitors: Monitor[];
}

// ============================================
// Notification types
// ============================================
export interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
  createdBy: number | null;
  /** Owner tenant of this channel */
  tenantId?: number;
  /** True when this channel belongs to another tenant and is shared to the current one */
  isShared?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OverrideMode = 'merge' | 'replace' | 'exclude';

// ============================================
// Settings types
// ============================================
export type SettingsScope = 'global' | 'group' | 'monitor';

export interface SettingValue {
  value: number;
  source: SettingsScope | 'default';
  sourceId: number | null;
  sourceName: string;
}

export type ResolvedSettings = Record<SettingsKey, SettingValue>;

// ============================================
// Incident types
// ============================================
export interface Incident {
  id: number;
  monitorId: number;
  startedAt: string;
  resolvedAt: string | null;
  durationSec: number | null;
  previousStatus: MonitorStatus;
  newStatus: MonitorStatus;
  message: string | null;
}

// ============================================
// Maintenance Window types
// ============================================
export type MaintenanceScopeType = 'global' | 'group' | 'monitor' | 'agent';
export type MaintenanceScheduleType = 'one_time' | 'recurring';
export type MaintenanceRecurrenceType = 'daily' | 'weekly';

export interface MaintenanceWindow {
  id: number;
  name: string;
  scopeType: MaintenanceScopeType;
  scopeId: number | null;       // null for 'global' scope
  isOverride: boolean;          // DEPRECATED — kept for DB compat, ignored in logic
  scheduleType: MaintenanceScheduleType;
  // one_time
  startAt: string | null;
  endAt: string | null;
  // recurring
  startTime: string | null;   // 'HH:MM'
  endTime: string | null;     // 'HH:MM'
  recurrenceType: MaintenanceRecurrenceType | null;
  daysOfWeek: number[] | null; // 0=Mon … 6=Sun
  timezone: string;
  notifyChannelIds: number[];
  lastNotifiedStartAt: string | null;
  lastNotifiedEndAt: string | null;
  active: boolean;
  createdAt: string;
  // Computed by server (always present on API responses)
  isActiveNow?: boolean;
  scopeName?: string;
  // Computed for effective-windows view (present when fetched via /effective endpoint)
  source?: 'local' | 'group' | 'global';
  sourceId?: number | null;     // id of the owning group/monitor/agent (null for global)
  sourceName?: string;          // display name of the owning scope
  isDisabledHere?: boolean;     // true if this scope has disabled this inherited window
  canEdit?: boolean;            // true if the current scope owns this window
  canDelete?: boolean;          // true if the current scope owns this window
  canDisable?: boolean;         // true if inherited AND not yet disabled at this scope
  canEnable?: boolean;          // true if inherited AND currently disabled at this scope
}

export interface MaintenanceWindowDisable {
  id: number;
  windowId: number;
  scopeType: 'group' | 'monitor' | 'agent';
  scopeId: number;
  createdAt: string;
}

export interface CreateMaintenanceWindowRequest {
  name: string;
  scopeType: MaintenanceScopeType;
  scopeId?: number | null;      // omit / null for 'global'
  isOverride?: boolean;         // DEPRECATED, accepted for backward compat
  scheduleType: MaintenanceScheduleType;
  startAt?: string | null;
  endAt?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  recurrenceType?: MaintenanceRecurrenceType | null;
  daysOfWeek?: number[] | null;
  timezone?: string;
  notifyChannelIds?: number[];
  active?: boolean;
}

export type UpdateMaintenanceWindowRequest = Partial<CreateMaintenanceWindowRequest>;

// ============================================
// API types
// ============================================
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
}

export interface BulkEditRequest {
  monitorIds: number[];
  changes: Partial<Monitor>;
}

export interface CreateGroupRequest {
  name: string;
  description?: string | null;
  parentId?: number | null;
  sortOrder?: number;
  isGeneral?: boolean;
  groupNotifications?: boolean;
  kind?: 'monitor' | 'agent';
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string | null;
  parentId?: number | null;
  sortOrder?: number;
  isGeneral?: boolean;
  groupNotifications?: boolean;
}

export interface MoveGroupRequest {
  newParentId: number | null;
}

// ============================================
// Notification API types
// ============================================
export interface CreateNotificationChannelRequest {
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled?: boolean;
}

export interface UpdateNotificationChannelRequest {
  name?: string;
  config?: Record<string, unknown>;
  isEnabled?: boolean;
}

export interface NotificationBinding {
  id: number;
  channelId: number;
  scope: 'global' | 'group' | 'monitor';
  scopeId: number | null;
  overrideMode: OverrideMode;
}

export interface NotificationPluginMeta {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];
}

export interface NotificationConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'url' | 'textarea' | 'boolean' | 'smtp_server_select';
  placeholder?: string;
  required?: boolean;
}

// ============================================
// SMTP Server types
// ============================================
export interface SmtpServer {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// App Config types
// ============================================
export interface AppConfig {
  allow_2fa: boolean;
  force_2fa: boolean;
  otp_smtp_server_id: number | null;
}

// ============================================
// Team & Permission types
// ============================================
export type PermissionLevel = 'ro' | 'rw';
export type PermissionScope = 'group' | 'monitor';

export interface UserTeam {
  id: number;
  name: string;
  description: string | null;
  canCreate: boolean;
  tenantId: number;
  tenantName?: string; // populated by JOIN in getAll()
  createdAt: string;
  updatedAt: string;
}

export interface TeamPermission {
  id: number;
  teamId: number;
  scope: PermissionScope;
  scopeId: number;
  level: PermissionLevel;
}

export interface UserPermissions {
  canCreate: boolean;
  teams: number[];
  /** map of "group:<id>" or "monitor:<id>" → permission level */
  permissions: Record<string, PermissionLevel>;
}

// ============================================
// Team API types
// ============================================
export interface CreateTeamRequest {
  name: string;
  description?: string | null;
  canCreate?: boolean;
}

export interface UpdateTeamRequest {
  name?: string;
  description?: string | null;
  canCreate?: boolean;
}

export interface SetTeamMembersRequest {
  userIds: number[];
}

export interface SetTeamPermissionsRequest {
  permissions: Array<{
    scope: PermissionScope;
    scopeId: number;
    level: PermissionLevel;
  }>;
}

// ============================================
// User API types
// ============================================
export interface CreateUserRequest {
  username: string;
  password: string;
  displayName?: string | null;
  role?: UserRole;
}

export interface UpdateUserRequest {
  username?: string;
  displayName?: string | null;
  role?: UserRole;
  isActive?: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: User;
}

// ============================================
// Agent threshold types
// ============================================
export interface AgentMetricThreshold {
  enabled: boolean;
  threshold: number;
  op: '>' | '<' | '>=' | '<=';
}

/** Per-sensor temperature override (key = sensor label) */
export interface AgentTempSensorOverride {
  enabled: boolean;   // true = this sensor has its own settings (overrides global)
  op: '>' | '<' | '>=' | '<=';
  threshold: number;  // °C
}

/** Global temperature threshold + optional per-sensor overrides */
export interface AgentTempThreshold {
  globalEnabled: boolean;              // master on/off for all temp monitoring
  op: '>' | '<' | '>=' | '<=';        // global operator
  threshold: number;                   // global threshold in °C
  overrides: Record<string, AgentTempSensorOverride>;  // key = sensor label
}

export interface AgentThresholds {
  cpu: AgentMetricThreshold;
  memory: AgentMetricThreshold;
  disk: AgentMetricThreshold;
  netIn: AgentMetricThreshold;
  netOut: AgentMetricThreshold;
  temp?: AgentTempThreshold;
}

export const DEFAULT_AGENT_THRESHOLDS: AgentThresholds = {
  cpu:    { enabled: true,  threshold: 90,         op: '>' },
  memory: { enabled: true,  threshold: 90,         op: '>' },
  disk:   { enabled: true,  threshold: 90,         op: '>' },
  // Network thresholds stored in bytes/sec; 100 Mbps = 100 × 125 000 bytes/sec
  netIn:  { enabled: false, threshold: 12_500_000, op: '>' },
  netOut: { enabled: false, threshold: 12_500_000, op: '>' },
  temp:   { globalEnabled: false, op: '>', threshold: 85, overrides: {} },
};

/**
 * Per-type notification toggles.
 * Each field is `boolean | null` where null means "inherit from parent group / system default".
 * System defaults: global=true, down=true, up=true, alert=true, update=false.
 */
export interface NotificationTypeConfig {
  /** Master switch — if false no notifications are sent (channels remain bound but muted) */
  global: boolean | null;
  /** Notify when agent/monitor goes DOWN / offline */
  down: boolean | null;
  /** Notify when agent/monitor recovers (back UP) */
  up: boolean | null;
  /** Notify when agent threshold is breached (alert status) */
  alert: boolean | null;
  /** Notify when agent starts a self-update (default off) */
  update: boolean | null;
}

/** System defaults for notification types (used when no group/device override is set) */
export const DEFAULT_NOTIFICATION_TYPES: Required<{ [K in keyof NotificationTypeConfig]: boolean }> = {
  global: true,
  down:   true,
  up:     true,
  alert:  true,
  update: false,
};

/** Default group-level config for agent groups */
export interface AgentGroupConfig {
  /** Default push interval for agents in this group (null = device keeps its own) */
  pushIntervalSeconds: number | null;
  /** Default heartbeat monitoring toggle (null = device keeps its own) */
  heartbeatMonitoring: boolean | null;
  /** Consecutive missed pushes before declaring agent offline (null = system default of 2) */
  maxMissedPushes: number | null;
  /** Notification type toggles (null = inherit from parent group / system defaults) */
  notificationTypes: NotificationTypeConfig | null;
}

// ============================================
// Agent types
// ============================================
export interface AgentApiKey {
  id: number;
  name: string;
  key: string;
  createdBy: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  deviceCount?: number;
}

/**
 * Per-device UI display preferences stored in agent_devices.display_config (JSONB).
 * All fields are optional; missing fields fall back to defaults (everything visible).
 */
export interface AgentDisplayConfig {
  cpu: {
    /** Show 2 stacked mini-bars per physical core instead of 2-column thread grid */
    groupCoreThreads: boolean;
    /** Physical core indices (0-based) to hide from the overview card */
    hiddenCores: number[];
    /** Temperature sensor label to use for the CPU temp chart (null = average all) */
    tempSensor: string | null;
    /** Detail-page chart IDs to hide: 'load-avg' | 'temp' | 'freq' */
    hiddenCharts: string[];
  };
  ram: {
    hideUsed: boolean;
    hideFree: boolean;
    hideSwap: boolean;
    /** Detail-page chart IDs to hide: 'pct' | 'used-mb' | 'swap' */
    hiddenCharts: string[];
  };
  gpu: {
    /** Row labels to hide from the overview card (e.g. 'Copy', 'Encode', 'VRAM') */
    hiddenRows: string[];
    /** Detail-page chart IDs to hide: 'util' | 'vram' | 'temp' */
    hiddenCharts: string[];
  };
  drives: {
    /** Mount paths to hide from the overview card */
    hiddenMounts: string[];
    /** mount → custom display name */
    renames: Record<string, string>;
    /** Detail page: combine Read+Write into one dual-series chart */
    combineReadWrite: boolean;
  };
  network: {
    /** Interface names to hide from the overview card */
    hiddenInterfaces: string[];
    /** interface name → custom display name */
    renames: Record<string, string>;
    /** Detail page: combine IN+OUT into one dual-series chart */
    combineInOut: boolean;
  };
  temps: {
    /** Sensor labels to hide from the overview card */
    hiddenLabels: string[];
  };
}

export interface AgentDevice {
  id: number;
  uuid: string;
  hostname: string;
  tenantId: number;
  /** Custom display name — shown instead of hostname when set */
  name: string | null;
  ip: string | null;
  osInfo: {
    platform: string;
    distro: string | null;
    release: string | null;
    arch: string;
  } | null;
  agentVersion: string | null;
  apiKeyId: number | null;
  status: 'pending' | 'approved' | 'refused' | 'suspended';
  /** When false: agent going offline → 'inactive' (grey), no notification */
  heartbeatMonitoring: boolean;
  checkIntervalSeconds: number;
  approvedBy: number | null;
  approvedAt: string | null;
  groupId: number | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Map of sensorKey → human-readable display name.
   * Key format: "temp:<raw_label>" — matches threshold override keys.
   * Example: { "temp:acpitz-acpi-0": "Motherboard", "temp:CPU Package": "CPU" }
   */
  sensorDisplayNames: Record<string, string> | null;
  /**
   * When false the device inherits checkIntervalSeconds, heartbeatMonitoring and
   * maxMissedPushes from the parent group's agent_group_config.
   * The existing checkIntervalSeconds field holds the device-level value and is
   * used when overrideGroupSettings = true.
   */
  overrideGroupSettings: boolean;
  /** Resolved effective settings (accounts for group inheritance when override=false) */
  resolvedSettings: {
    checkIntervalSeconds: number;
    heartbeatMonitoring: boolean;
    maxMissedPushes: number;
  };
  /**
   * Raw agent_group_config from the parent group (null if device has no group or
   * the group has no config set).  Unlike resolvedSettings this is never affected
   * by overrideGroupSettings — it always reflects what the group itself defines.
   * The UI uses this to display "inherited from group" values and to write the
   * correct value to the device column when a per-field override is disabled.
   */
  groupSettings: AgentGroupConfig | null;
  /** Parent group's agent_thresholds — used as the "inherited" baseline in the threshold editor */
  groupThresholds?: AgentThresholds | null;
  /** Per-device UI display preferences (hidden cores, renamed drives, combined charts, etc.) */
  displayConfig: AgentDisplayConfig | null;
  /**
   * Command queued by an admin, delivered to the agent on its next push.
   * Cleared once the command has been sent to the agent.
   * Example values: 'uninstall'
   */
  pendingCommand?: string | null;
  /**
   * Timestamp at which the 'uninstall' command was delivered to the agent.
   * Used by the cleanup job to auto-delete the device ~10 minutes after delivery.
   */
  uninstallCommandedAt?: string | null;
  /**
   * Set when the agent notifies the server it is about to self-update.
   * While set (and within 10 minutes), the device shows "UPDATING" status and
   * is excluded from downtime / uptime calculations.
   * Cleared on the next successful push, or by the cleanup job after 10 minutes.
   */
  updatingSince?: string | null;
  inMaintenance?: boolean;
  /**
   * Device-level notification type override.
   * null = inherit from parent group chain (see resolvedNotificationTypes for effective values).
   * When set, overrides the group's notification type settings.
   */
  notificationTypes?: NotificationTypeConfig | null;
  /** Resolved effective notification types (device → group hierarchy → defaults) */
  resolvedNotificationTypes?: {
    global: boolean;
    down: boolean;
    up: boolean;
    alert: boolean;
    update: boolean;
  };
}

// ============================================
// Remediation types
// ============================================
export type RemediationActionType = 'webhook' | 'n8n' | 'script' | 'docker_restart' | 'ssh';
export type RemediationTrigger   = 'down' | 'up' | 'both';
export type RemediationRunStatus = 'success' | 'failed' | 'timeout' | 'cooldown_skip';
export type OverrideModeR        = 'merge' | 'replace' | 'exclude';

/** Config shapes stored in remediation_actions.config (JSONB) */
export interface WebhookRemediationConfig {
  platform?: 'n8n' | 'make' | 'zapier' | null;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  bodyExtra?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ScriptRemediationConfig {
  script: string;
  shell?: string;
  timeoutMs?: number;
}

export interface DockerRestartRemediationConfig {
  containerName: string;
  socketPath?: string;
}

export interface SshRemediationConfig {
  host: string;
  port?: number;
  username: string;
  authType: 'password' | 'key';
  /** AES-256-GCM encrypted credential — never returned in plaintext */
  credentialEnc?: string;
  command: string;
  timeoutMs?: number;
}

export interface RemediationAction {
  id: number;
  name: string;
  type: RemediationActionType;
  config: WebhookRemediationConfig | ScriptRemediationConfig | DockerRestartRemediationConfig | SshRemediationConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RemediationBinding {
  id: number;
  actionId: number;
  scope: 'global' | 'group' | 'monitor';
  scopeId: number | null;
  overrideMode: OverrideModeR;
  triggerOn: RemediationTrigger;
  cooldownSeconds: number;
}

export interface ResolvedRemediationBinding extends RemediationBinding {
  action: RemediationAction;
  inheritedFrom?: 'global' | 'group';  // present when not directly bound at this scope
}

export interface RemediationRun {
  id: number;
  actionId: number;
  monitorId: number;
  triggeredBy: 'down' | 'up';
  status: RemediationRunStatus;
  output: string | null;
  error: string | null;
  durationMs: number | null;
  triggeredAt: string;
  actionName?: string;  // joined
}

export interface CreateRemediationActionRequest {
  name: string;
  type: RemediationActionType;
  config: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateRemediationActionRequest {
  name?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface AddRemediationBindingRequest {
  actionId: number;
  scope: 'global' | 'group' | 'monitor';
  scopeId?: number | null;
  overrideMode?: OverrideModeR;
  triggerOn?: RemediationTrigger;
  cooldownSeconds?: number;
}

// ============================================
// Tenant types (multi-tenancy)
// ============================================
export interface Tenant {
  id: number;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantMembership {
  tenantId: number;
  userId: number;
  role: 'admin' | 'member';
}

export interface TenantWithRole extends Tenant {
  role: 'admin' | 'member';
}

/** Returned by GET /api/users/:id/tenants — all tenants with this user's membership info */
export interface UserTenantAssignment {
  tenantId: number;
  tenantName: string;
  tenantSlug: string;
  isMember: boolean;
  role: 'admin' | 'member';
}
