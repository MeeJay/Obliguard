import type { UserRole } from './monitorTypes';
import type { SettingsKey } from './settingsDefaults';

// ============================================
// User types
// ============================================
export interface UserPreferences {
  toastEnabled: boolean;
  toastPosition: 'top-center' | 'bottom-right';
  multiTenantNotificationsEnabled?: boolean;
}

/** Shape of a live alert as returned by the server. */
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
  createdAt: string;
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
  kind: 'agent';
  agentThresholds?: AgentThresholds | null;
  agentGroupConfig?: AgentGroupConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupTreeNode extends MonitorGroup {
  children: GroupTreeNode[];
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
  tenantId?: number;
  isShared?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OverrideMode = 'merge' | 'replace' | 'exclude';

export interface NotificationBinding {
  id: number;
  channelId: number;
  scope: 'global' | 'group' | 'agent';
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
// Settings types
// ============================================
export type SettingsScope = 'global' | 'group';

export interface SettingValue {
  value: number;
  source: SettingsScope | 'default';
  sourceId: number | null;
  sourceName: string;
}

export type ResolvedSettings = Record<SettingsKey, SettingValue>;

// ============================================
// Maintenance Window types
// ============================================
export type MaintenanceScopeType = 'global' | 'group' | 'agent';
export type MaintenanceScheduleType = 'one_time' | 'recurring';
export type MaintenanceRecurrenceType = 'daily' | 'weekly';

export interface MaintenanceWindow {
  id: number;
  name: string;
  scopeType: MaintenanceScopeType;
  scopeId: number | null;
  isOverride: boolean;
  scheduleType: MaintenanceScheduleType;
  startAt: string | null;
  endAt: string | null;
  startTime: string | null;
  endTime: string | null;
  recurrenceType: MaintenanceRecurrenceType | null;
  daysOfWeek: number[] | null;
  timezone: string;
  notifyChannelIds: number[];
  lastNotifiedStartAt: string | null;
  lastNotifiedEndAt: string | null;
  active: boolean;
  createdAt: string;
  isActiveNow?: boolean;
  scopeName?: string;
  source?: 'local' | 'group' | 'global';
  sourceId?: number | null;
  sourceName?: string;
  isDisabledHere?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canDisable?: boolean;
  canEnable?: boolean;
}

export interface MaintenanceWindowDisable {
  id: number;
  windowId: number;
  scopeType: 'group' | 'agent';
  scopeId: number;
  createdAt: string;
}

export interface CreateMaintenanceWindowRequest {
  name: string;
  scopeType: MaintenanceScopeType;
  scopeId?: number | null;
  isOverride?: boolean;
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

export interface CreateGroupRequest {
  name: string;
  description?: string | null;
  parentId?: number | null;
  sortOrder?: number;
  isGeneral?: boolean;
  groupNotifications?: boolean;
  kind?: 'agent';
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
  /** URL of the companion Obliview instance. When set, a "Switch to Obliview" button appears in the header. */
  obliview_url: string | null;
}

/**
 * Global agent defaults stored in app_config as JSON under key "agent_global_config".
 */
export interface AgentGlobalConfig {
  checkIntervalSeconds: number | null;
  maxMissedPushes: number | null;
  notificationTypes: NotificationTypeConfig | null;
}

export const DEFAULT_AGENT_GLOBAL_CONFIG: Required<{
  checkIntervalSeconds: number;
  maxMissedPushes: number;
}> = {
  checkIntervalSeconds: 60,
  maxMissedPushes: 2,
};

// ============================================
// Team & Permission types
// ============================================
export type PermissionLevel = 'ro' | 'rw';
export type PermissionScope = 'group' | 'agent';

export interface UserTeam {
  id: number;
  name: string;
  description: string | null;
  canCreate: boolean;
  tenantId: number;
  tenantName?: string;
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

export interface AgentTempSensorOverride {
  enabled: boolean;
  op: '>' | '<' | '>=' | '<=';
  threshold: number;
}

export interface AgentTempThreshold {
  globalEnabled: boolean;
  op: '>' | '<' | '>=' | '<=';
  threshold: number;
  overrides: Record<string, AgentTempSensorOverride>;
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
  netIn:  { enabled: false, threshold: 12_500_000, op: '>' },
  netOut: { enabled: false, threshold: 12_500_000, op: '>' },
  temp:   { globalEnabled: false, op: '>', threshold: 85, overrides: {} },
};

export interface NotificationTypeConfig {
  global: boolean | null;
  down:   boolean | null;
  up:     boolean | null;
  /** Notify when an IP from this agent becomes suspicious (yellow). */
  threat: boolean | null;
  /** Notify when an IP is banned due to activity from this agent. */
  attack: boolean | null;
}

export const DEFAULT_NOTIFICATION_TYPES: Required<{ [K in keyof NotificationTypeConfig]: boolean }> = {
  global: true,
  down:   true,
  up:     true,
  threat: true,
  attack: true,
};

export interface AgentGroupConfig {
  pushIntervalSeconds: number | null;
  maxMissedPushes: number | null;
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

export interface AgentDisplayConfig {
  cpu: {
    groupCoreThreads: boolean;
    hiddenCores: number[];
    tempSensor: string | null;
    hiddenCharts: string[];
  };
  ram: {
    hideUsed: boolean;
    hideFree: boolean;
    hideSwap: boolean;
    hiddenCharts: string[];
  };
  gpu: {
    hiddenRows: string[];
    hiddenCharts: string[];
  };
  drives: {
    hiddenMounts: string[];
    renames: Record<string, string>;
    combineReadWrite: boolean;
  };
  network: {
    hiddenInterfaces: string[];
    renames: Record<string, string>;
    combineInOut: boolean;
  };
  temps: {
    hiddenLabels: string[];
  };
}

export interface AgentDevice {
  id: number;
  uuid: string;
  hostname: string;
  tenantId: number;
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
  heartbeatMonitoring: boolean;
  checkIntervalSeconds: number;
  approvedBy: number | null;
  approvedAt: string | null;
  groupId: number | null;
  createdAt: string;
  updatedAt: string;
  sensorDisplayNames: Record<string, string> | null;
  overrideGroupSettings: boolean;
  resolvedSettings: {
    checkIntervalSeconds: number;
    heartbeatMonitoring: boolean;
    maxMissedPushes: number;
  };
  groupSettings: AgentGroupConfig | null;
  groupThresholds?: AgentThresholds | null;
  displayConfig: AgentDisplayConfig | null;
  pendingCommand?: string | null;
  uninstallCommandedAt?: string | null;
  updatingSince?: string | null;
  inMaintenance?: boolean;
  notificationTypes?: NotificationTypeConfig | null;
  resolvedNotificationTypes?: {
    global: boolean;
    down: boolean;
    up: boolean;
    threat: boolean;
    attack: boolean;
  };
  /** Set when an IP from this agent turns suspicious. Clears after 3 min without new failures. */
  lastThreatAt?: string | null;
  /** Set when an IP is banned from this agent's events. Clears after 10 min without new bans. */
  lastAttackAt?: string | null;
}

// ============================================
// Remediation types
// ============================================
export type RemediationActionType = 'webhook' | 'n8n' | 'script' | 'docker_restart' | 'ssh';
export type RemediationTrigger   = 'down' | 'up' | 'both';
export type RemediationRunStatus = 'success' | 'failed' | 'timeout' | 'cooldown_skip';
export type OverrideModeR        = 'merge' | 'replace' | 'exclude';

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
  scope: 'global' | 'group' | 'agent';
  scopeId: number | null;
  overrideMode: OverrideModeR;
  triggerOn: RemediationTrigger;
  cooldownSeconds: number;
}

export interface ResolvedRemediationBinding extends RemediationBinding {
  action: RemediationAction;
  inheritedFrom?: 'global' | 'group';
}

export interface RemediationRun {
  id: number;
  actionId: number;
  agentDeviceId: number;
  triggeredBy: 'down' | 'up';
  status: RemediationRunStatus;
  output: string | null;
  error: string | null;
  durationMs: number | null;
  triggeredAt: string;
  actionName?: string;
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
  scope: 'global' | 'group' | 'agent';
  scopeId?: number | null;
  overrideMode?: OverrideModeR;
  triggerOn?: RemediationTrigger;
  cooldownSeconds?: number;
}

// ============================================
// Tenant types
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

export interface UserTenantAssignment {
  tenantId: number;
  tenantName: string;
  tenantSlug: string;
  isMember: boolean;
  role: 'admin' | 'member';
}

// ============================================
// Obliguard — Service template types
// ============================================
export type BuiltinServiceType = 'ssh' | 'rdp' | 'nginx' | 'apache' | 'iis' | 'ftp' | 'mail' | 'mysql';
export type ServiceType = BuiltinServiceType | 'custom';

export type ServiceTemplateMode = 'ban' | 'track';

export interface ServiceTemplate {
  id: number;
  name: string;
  serviceType: ServiceType;
  isBuiltin: boolean;
  defaultLogPath: string | null;
  /** Named-group regex: (?P<ip>...) (?P<username>...). NULL for built-in templates. */
  customRegex: string | null;
  threshold: number;
  windowSeconds: number;
  enabled: boolean;
  /**
   * 'ban'   = events from this template trigger BanEngine (default)
   * 'track' = events stored for visibility but NOT counted toward auto-bans
   */
  mode: ServiceTemplateMode;
  /** NULL = platform-wide; non-null = tenant-scoped custom template */
  tenantId: number | null;
  /**
   * When set, this is a "local" template visible only on one agent or group.
   * ownerScope = 'agent' | 'group', ownerScopeId = device or group id.
   * Local templates are not shown in the global templates list.
   */
  ownerScope: 'agent' | 'group' | null;
  ownerScopeId: number | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  /** Assignments for this template (populated when fetching detail) */
  assignments?: ServiceTemplateAssignment[];
}

export interface ServiceTemplateAssignment {
  id: number;
  templateId: number;
  scope: 'group' | 'agent';
  scopeId: number;
  /** NULL = inherit from template */
  logPathOverride: string | null;
  thresholdOverride: number | null;
  windowSecondsOverride: number | null;
  enabledOverride: boolean | null;
  /** When true, agent will include log sample lines in next push */
  sampleRequested: boolean;
  createdAt: string;
}

/** Fully-resolved service config for a given agent (after inheritance) */
export interface ResolvedServiceConfig {
  templateId: number;
  name: string;
  serviceType: ServiceType;
  isBuiltin: boolean;
  logPath: string | null;
  customRegex: string | null;
  threshold: number;
  windowSeconds: number;
  enabled: boolean;
  mode: ServiceTemplateMode;
  sampleRequested: boolean;
  /**
   * Where the `enabled` value was overridden.
   * 'agent'  = an agent-level assignment set enabled_override
   * 'group'  = a group-level assignment set enabled_override (closest ancestor wins)
   * null     = no override — using template default
   */
  enabledOverrideScope: 'agent' | 'group' | null;
  /**
   * null    = global template (no owner — applies system-wide)
   * 'group' = owned by a specific group; auto-applies to agents in that group
   */
  templateOwnerScope: 'group' | null;
}

export interface CreateServiceTemplateRequest {
  name: string;
  serviceType: ServiceType;
  defaultLogPath?: string | null;
  customRegex?: string | null;
  threshold?: number;
  windowSeconds?: number;
  enabled?: boolean;
  mode?: ServiceTemplateMode;
  /** When provided, creates a local template tied to this agent or group. */
  ownerScope?: 'agent' | 'group' | null;
  ownerScopeId?: number | null;
}

export interface UpdateServiceTemplateRequest {
  name?: string;
  defaultLogPath?: string | null;
  customRegex?: string | null;
  threshold?: number;
  windowSeconds?: number;
  enabled?: boolean;
  mode?: ServiceTemplateMode;
}

export interface UpsertServiceAssignmentRequest {
  logPathOverride?: string | null;
  thresholdOverride?: number | null;
  windowSecondsOverride?: number | null;
  enabledOverride?: boolean | null;
  sampleRequested?: boolean;
}

// ============================================
// Obliguard — IP event types
// ============================================
export type IpEventType = 'auth_failure' | 'auth_success' | 'port_scan';

export interface IpEvent {
  id: number;
  deviceId: number | null;
  /** Device hostname (joined) */
  deviceHostname?: string;
  ip: string;
  username: string | null;
  service: string;
  eventType: IpEventType;
  timestamp: string;
  rawLog: string | null;
  /** When true, event was matched by a 'track' mode template and is excluded from ban counting */
  trackOnly: boolean;
  tenantId: number | null;
  createdAt: string;
}

// ============================================
// Obliguard — IP reputation types
// ============================================
export interface IpReputation {
  ip: string;
  totalFailures: number;
  totalSuccesses: number;
  affectedAgentsCount: number;
  affectedServices: string[];
  attemptedUsernames: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  lastEventDeviceId: number | null;
  geoCountryCode: string | null;
  geoCity: string | null;
  asn: string | null;
  updatedAt: string;
  /** Computed: 'banned' | 'whitelisted' | 'suspicious' | 'clean' */
  status?: IpStatus;
}

export type IpStatus = 'banned' | 'whitelisted' | 'suspicious' | 'clean';

// ============================================
// Obliguard — Ban types
// ============================================
export type BanScope = 'global' | 'tenant' | 'group' | 'agent';
export type BanType = 'auto' | 'manual';

export interface IpBan {
  id: number;
  ip: string;
  cidrPrefix: number | null;
  reason: string | null;
  banType: BanType;
  scope: BanScope;
  scopeId: number | null;
  tenantId: number | null;
  /**
   * Which tenant's agent triggered this auto-ban.
   * Only visible to platform admins (role='admin').
   * Tenants see this as null (hidden by API).
   */
  originTenantId: number | null;
  /** origin_tenant_id resolved to a name (admin only) */
  originTenantName?: string;
  bannedByUserId: number | null;
  bannedAt: string;
  expiresAt: string | null;
  isActive: boolean;
}

export interface CreateBanRequest {
  ip: string;
  cidrPrefix?: number | null;
  reason?: string | null;
  scope?: BanScope;
  scopeId?: number | null;
  expiresAt?: string | null;
}

export interface UpdateBanRequest {
  reason?: string | null;
  expiresAt?: string | null;
  isActive?: boolean;
}

// ============================================
// Obliguard — Whitelist types
// ============================================
export type WhitelistScope = 'global' | 'tenant' | 'group' | 'agent';

export interface IpWhitelist {
  id: number;
  /** CIDR notation (e.g. "192.168.0.0/24" or "1.2.3.4/32") */
  ip: string;
  label: string | null;
  scope: WhitelistScope;
  scopeId: number | null;
  tenantId: number | null;
  createdBy: number | null;
  createdAt: string;
}

export interface CreateWhitelistRequest {
  ip: string;
  label?: string | null;
  scope?: WhitelistScope;
  scopeId?: number | null;
}

// ============================================
// Obliguard — Agent push payload types
// ============================================

/** Service detected on the agent machine */
export interface AgentDetectedService {
  type: ServiceType;
  port: number | null;
  active: boolean;
}

/** Single auth event reported by the agent */
export interface AgentIpEvent {
  /** Local UUID to avoid duplicate processing */
  id: string;
  ip: string;
  username: string | null;
  service: string;
  eventType: IpEventType;
  timestamp: string;
  rawLog: string | null;
}

/** New Obliguard push request body (agent → server) */
export interface ObliguardPushBody {
  hostname: string;
  agentVersion: string;
  osInfo: {
    platform: string;
    distro: string | null;
    release: string | null;
    arch: string;
  };
  /** Detected services on this machine */
  services?: AgentDetectedService[];
  /** Auth events since last push */
  events?: AgentIpEvent[];
  /** IPs currently banned in the local firewall */
  firewallBanned?: string[];
  /** Firewall implementation in use (ufw, firewalld, iptables, nftables, windows, macos_pf) */
  firewallName?: string;
  /**
   * Log samples requested by the server.
   * Key = log file path, value = last N lines.
   */
  logSamples?: Record<string, string[]>;
}

/** Per-service config sent back to the agent */
export interface AgentServiceConfig {
  enabled: boolean;
  threshold: number;
  windowSeconds: number;
  /** Only for custom services: named-group regex */
  customRegex?: string | null;
  /** Request the agent to include last 50 lines in next push */
  sampleRequested?: boolean;
}

/** Obliguard push response (server → agent) */
export interface ObliguardPushResponse {
  status: 'ok' | 'pending' | 'refused';
  latestVersion?: string;
  config?: {
    pushIntervalSeconds: number;
  };
  banList?: {
    /** IPs to add to the local firewall */
    add: string[];
    /** IPs to remove from the local firewall */
    remove: string[];
  };
  /** Resolved whitelist CIDRs — agent skips banning these */
  whitelist?: string[];
  /**
   * Per-service config keyed by serviceType ('ssh', 'nginx', etc.)
   * or by log path for custom services ('custom:/var/log/tomcat/catalina.out')
   */
  services?: Record<string, AgentServiceConfig>;
  command?: string;
}
