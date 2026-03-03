import type { MonitorType, MonitorStatus, UserRole } from './monitorTypes';
import type { SettingsKey } from './settingsDefaults';

// ============================================
// User types
// ============================================
export interface UserPreferences {
  toastEnabled: boolean;
  toastPosition: 'top-center' | 'bottom-right';
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
  agentThresholds: AgentThresholds | null;

  // Metadata
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
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

/** Default group-level config for agent groups */
export interface AgentGroupConfig {
  /** Default push interval for agents in this group (null = device keeps its own) */
  pushIntervalSeconds: number | null;
  /** Default heartbeat monitoring toggle (null = device keeps its own) */
  heartbeatMonitoring: boolean | null;
  /** Consecutive missed pushes before declaring agent offline (null = system default of 2) */
  maxMissedPushes: number | null;
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
  /** Parent group's agent_thresholds — used as the "inherited" baseline in the threshold editor */
  groupThresholds?: AgentThresholds | null;
  /** Per-device UI display preferences (hidden cores, renamed drives, combined charts, etc.) */
  displayConfig: AgentDisplayConfig | null;
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
