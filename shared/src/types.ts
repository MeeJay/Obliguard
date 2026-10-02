import type { SettingsKey } from './settingsDefaults';

export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

// ============================================
// User types
// ============================================
export type AppTheme = 'obli-operator' | 'obli-daylight' | 'obli-dim' | 'modern' | 'neon';

export interface UserPreferences {
  toastEnabled: boolean;
  toastPosition: 'top-center' | 'bottom-right';
  multiTenantNotificationsEnabled?: boolean;
  preferredTheme?: AppTheme;
  anonymousMode?: boolean;
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
  foreignSource?: string | null;
  /** Profile picture as base64 data URI or remote URL — synced from Obligate when SSO is used. */
  avatar?: string | null;
  /**
   * Favourite workspace (opened at sign-in when still usable), or null. Set by
   * the session payloads (/auth/me, login); absent on admin user listings.
   */
  preferredTenantId?: number | null;
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
  /** @deprecated Obliview leftover, ignored by the server (group notifications removed). */
  groupNotifications?: boolean;
  /**
   * Evaluate-only (dry-run) mode. When true, this group and all its descendant
   * groups + agents observe events but never create or enforce auto-bans.
   */
  evaluateOnly?: boolean;
  kind: 'agent';
  /** Owning tenant (Default god view keeps write pickers and drag-and-drop tenant-local). */
  tenantId?: number;
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
  /**
   * True when the caller does not own the channel (shared to its tenant):
   * secrets in `config` are masked with NOTIFICATION_REDACTED and the
   * channel cannot be edited, deleted, re-shared or bound globally.
   */
  readOnly?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Placeholder sent instead of a secret config value of a read-only channel. */
export const NOTIFICATION_REDACTED = '__REDACTED__';

/** IPS event a notification describes. */
export type NotificationKind = 'threat' | 'attack' | 'ban' | 'down' | 'up' | 'test';

/**
 * IPS fields carried by a notification payload, next to the legacy
 * monitorName/oldStatus/newStatus fields. Plugins render `title` and
 * `message` when present; the other fields are structured data (webhook
 * consumers get them as-is). ip/service/username come from agent logs and
 * are attacker-controlled: plugins must escape them for their markup.
 */
export interface NotificationEventFields {
  kind?: NotificationKind;
  title?: string;
  ip?: string;
  service?: string;
  failureCount?: number;
  username?: string;
  agentName?: string;
  tenantName?: string;
  url?: string;
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
  /** @deprecated Ignored by the server (group notifications removed). */
  groupNotifications?: boolean;
  kind?: 'agent';
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string | null;
  parentId?: number | null;
  sortOrder?: number;
  isGeneral?: boolean;
  /** @deprecated Ignored by the server (group notifications removed). */
  groupNotifications?: boolean;
  evaluateOnly?: boolean;
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
  obligate_url: string | null;
  obligate_enabled: boolean;
  oblitools_push_enabled: string | null;
  oblitools_instance_name: string | null;
  oblitools_api_key: string | null;
  oblitools_last_push_at: string | null;
}

/**
 * Obligate SSO gateway settings stored under `obligate_config` in app_config.
 * The raw apiKey is never exposed to clients — only `apiKeySet` (boolean) is returned.
 */
export interface ObligateConfig {
  url: string | null;
  apiKeySet: boolean;
  enabled: boolean;
}

/**
 * Global agent defaults stored in app_config as JSON under key "agent_global_config".
 */
// ── Agent update policy (C17-1) ──────────────────────────────────────────────
/**
 * Who decides when an agent self-updates. 'auto': every served release is
 * advertised; 'manual': only after an explicit "Update now"; 'off': never.
 * 'off' at any level (global / group / agent) is absolute; otherwise the
 * nearest explicit value wins.
 */
export type AgentUpdatePolicy = 'auto' | 'manual' | 'off';
export const AGENT_UPDATE_POLICIES: readonly AgentUpdatePolicy[] = ['auto', 'manual', 'off'];
/** Built-in default when no level sets a policy. */
export const DEFAULT_AGENT_UPDATE_POLICY: AgentUpdatePolicy = 'manual';
/** Where the resolved policy comes from ('unresolved' = group or tenant lookup failed, fails closed to 'off'). */
export type AgentUpdatePolicySource = 'agent' | 'group' | 'tenant' | 'global' | 'default' | 'unresolved';

/**
 * Phase of an agent update attempt (agent_update_attempts.phase, W2-1).
 * 'offered': latestVersion was written in a config frame; the next phases are
 * reported by the agent (update_status frame) or inferred by the server.
 */
export type AgentUpdatePhase =
  | 'offered' | 'downloading' | 'verifying' | 'installing' | 'restarting'
  | 'succeeded' | 'failed' | 'cancelled';
export const AGENT_UPDATE_PHASES: readonly AgentUpdatePhase[] = [
  'offered', 'downloading', 'verifying', 'installing', 'restarting', 'succeeded', 'failed', 'cancelled',
];
/** Phases an agent may report in an update_status frame (anything else is ignored). */
export const AGENT_REPORTED_UPDATE_PHASES: readonly AgentUpdatePhase[] = [
  'downloading', 'verifying', 'installing', 'restarting', 'failed',
];

/** The latest update attempt of a device (AgentDevice.update). */
export interface AgentUpdateAttemptInfo {
  targetVersion: string;
  phase: AgentUpdatePhase;
  /** Config frames that carried latestVersion for this target (capped at 3). */
  attempts: number;
  /** 'no_progress' | 'timeout' | 'reverted_or_failed' | an agent-reported error. */
  lastError: string | null;
  updatedAt: string;
}

/** Agent → server WS frame reporting the progress of a self-update. */
export interface AgentUpdateStatusFrame {
  type: 'update_status';
  targetVersion: string;
  phase: 'downloading' | 'verifying' | 'installing' | 'restarting' | 'failed';
  error?: string;
}

/** Tenant level of the update policy (GET/PATCH /agent/update-policy/tenant). */
export interface AgentTenantUpdatePolicyInfo {
  tenantId: number;
  /** The tenant's explicit policy; null = inherit the global one. */
  updatePolicy: AgentUpdatePolicy | null;
  /** Effective global policy (built-in 'manual' when unset). */
  globalPolicy: AgentUpdatePolicy;
  globalPolicyIsDefault: boolean;
}

export interface AgentUpdateRequestResult {
  requested: number;
  targetVersion: string | null;
  skipped: { off: number; current: number; notUpdatable: number; notFound: number };
}

export interface AgentVersionDistribution {
  latestVersion: string | null;
  total: number;
  upToDate: number;
  outdated: number;
  unknown: number;
  updatePending: number;
  policies: Record<AgentUpdatePolicy, number>;
  globalPolicy: AgentUpdatePolicy;
  globalPolicyIsDefault: boolean;
  /** Explicit policy of the operating tenant; null = inherits the global one. */
  tenantPolicy: AgentUpdatePolicy | null;
  /** os-arch artifacts whose build does not match the served version (nothing is advertised to them). */
  missingBuilds: string[];
  /** Approved agents whose latest update attempt failed. */
  updateFailed: number;
  versions: Array<{ version: string; count: number; isLatest: boolean; outdated: boolean }>;
}

export interface AgentGlobalConfig {
  checkIntervalSeconds: number | null;
  maxMissedPushes: number | null;
  notificationTypes: NotificationTypeConfig | null;
  /** Global agent update policy. null / absent = DEFAULT_AGENT_UPDATE_POLICY ('manual'). */
  updatePolicy?: AgentUpdatePolicy | null;
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

/**
 * Feature-level capabilities. These are the keys Obliguard registers with
 * Obligate (obligate.service.syncCapabilitySchemas) and that flow back into
 * team_permissions.capabilities on SSO login. They gate WHAT a non-admin may do
 * (viewing is granted to any tenant member; these govern mutations).
 * Admins implicitly hold all of them.
 */
export const CAPABILITIES = {
  /** Manage agent devices (edit/delete/command, firewall rules). */
  MONITOR_RW: 'monitor_rw',
  /** Create / edit / delete / move groups. */
  GROUP_RW: 'group_rw',
  /** Manage whitelist entries. */
  WHITELIST: 'whitelist',
  /** Create / lift / promote bans. */
  BANS: 'bans',
} as const;

export type Capability = typeof CAPABILITIES[keyof typeof CAPABILITIES];

export const ALL_CAPABILITIES: Capability[] = [
  CAPABILITIES.MONITOR_RW,
  CAPABILITIES.GROUP_RW,
  CAPABILITIES.WHITELIST,
  CAPABILITIES.BANS,
];

export interface UserPermissions {
  canCreate: boolean;
  teams: number[];
  permissions: Record<string, PermissionLevel>;
  /** Feature capabilities the user holds (admin ⇒ all). */
  capabilities: Capability[];
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
  /** Group agent update policy (applies to sub-groups). null / absent = inherit. */
  updatePolicy?: AgentUpdatePolicy | null;
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

/**
 * Live agent status carried by AGENT_STATUS_CHANGED (sidebar / list dots):
 * 'up' and 'down' follow the WS channel, 'updating' a self-update in progress.
 * 'alert' and 'inactive' are kept for older emitters.
 */
export type AgentLiveStatus = 'up' | 'down' | 'alert' | 'inactive' | 'updating';

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
  /**
   * @deprecated Obliview leftover: no longer returned nor accepted by the
   * server (offline alerts follow the 'down' notification type).
   */
  heartbeatMonitoring?: boolean;
  checkIntervalSeconds: number;
  /** Raw device-level value. null = not set at device level = inherit from group/global. */
  maxMissedPushes: number | null;
  approvedBy: number | null;
  approvedAt: string | null;
  groupId: number | null;
  createdAt: string;
  updatedAt: string;
  sensorDisplayNames: Record<string, string> | null;
  overrideGroupSettings: boolean;
  resolvedSettings: {
    checkIntervalSeconds: number;
    /** @deprecated No longer returned by the server. */
    heartbeatMonitoring?: boolean;
    maxMissedPushes: number;
  };
  groupSettings: AgentGroupConfig | null;
  groupThresholds?: AgentThresholds | null;
  displayConfig: AgentDisplayConfig | null;
  pendingCommand?: string | null;
  uninstallCommandedAt?: string | null;
  updatingSince?: string | null;
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
  /**
   * When true, this agent's WAN IP (agent_devices.ip) is used for peer link matching.
   * Only enable when the WAN IP is dedicated/static (e.g. VPS with fixed public IP).
   * Defaults to false — without it, WAN matching is ambiguous (many machines behind same NAT).
   */
  wanMatchingEnabled: boolean;
  /** True when the agent has an active WebSocket command channel to the server. */
  wsConnected: boolean;
  /**
   * Effective evaluate-only (dry-run) state: true if this device's own flag is set
   * OR it inherits the flag from an ancestor group. In this mode the agent observes
   * events but creates/enforces NO bans.
   */
  evaluateOnly?: boolean;
  /** Where the effective evaluate-only state comes from ('agent' = own flag, 'group' = inherited). */
  evaluateOnlySource?: 'agent' | 'group' | null;
  /**
   * Device type:
   *   - 'agent':    Go agent binary installed on a host
   *   - 'mikrotik': remote MikroTik device, polled over the RouterOS API
   *   - 'm365':     Microsoft 365 tenant, polled over Graph and the Management Activity API
   */
  deviceType: 'agent' | 'mikrotik' | 'm365';
  /**
   * MikroTik connectivity status (only set when deviceType='mikrotik'):
   *   - 'online':        syslog received recently OR API test succeeded recently
   *   - 'offline':       was online before but syslog/API went silent
   *   - 'misconfigured': never received any syslog AND never had a successful API connection
   */
  mikrotikStatus?: 'online' | 'offline' | 'misconfigured';
  // ── Update policy (C17-1) ──
  /** Raw device-level update policy. null = inherit from group / global. */
  updatePolicy?: AgentUpdatePolicy | null;
  /** Effective update policy ('off' at any level above wins). */
  resolvedUpdatePolicy?: AgentUpdatePolicy;
  /** Level the effective policy comes from. */
  updatePolicySource?: AgentUpdatePolicySource;
  /** Group that sets the effective policy, when updatePolicySource = 'group'. */
  updatePolicySourceGroupId?: number | null;
  /** Agent version served by this server (agent/VERSION); null when unavailable. */
  latestAgentVersion?: string | null;
  /** True when the served version is strictly newer than the reported one (approved agents only). */
  updateAvailable?: boolean;
  /** Timestamp of a pending explicit "Update now" request. */
  updateRequestedAt?: string | null;
  /** Version served when the request was made (void once another version is served). */
  updateRequestedVersion?: string | null;
  /** True while a live request will be offered at the next heartbeat. */
  updatePending?: boolean;
  // ── Presence and update lifecycle (W2-1) ──
  /** Last heartbeat / events frame / push (60 s resolution). Never moved by admin edits. */
  lastSeenAt?: string | null;
  /** Last WS command-channel registration. */
  lastOnlineAt?: string | null;
  /** Last time the offline grace period expired. */
  lastOfflineAt?: string | null;
  /** Capabilities reported in the heartbeat (e.g. 'tls_unverified'). */
  capabilities?: string[];
  /** Latest update attempt, or null when none was ever recorded. */
  update?: AgentUpdateAttemptInfo | null;
}

/** Socket payload of AGENT_DEVICE_UPDATED: only the changed fields. */
export interface AgentDeviceUpdatedEvent {
  deviceId: number;
  patch: Partial<AgentDevice>;
}

/** Socket payload of 'agent:deviceCreated' (a new pending enrolment, tenant admins only). */
export interface AgentDeviceCreatedEvent {
  deviceId: number;
  device: AgentDevice;
}

// ============================================
// MikroTik remote device types
// ============================================

export interface MikroTikCredentials {
  id: number;
  deviceId: number;
  apiHost: string;
  apiPort: number;
  apiUseTls: boolean;
  apiUsername: string;
  /** Source IP that syslog arrives from — used to route packets to this device. */
  syslogIdentifier: string;
  /** Address-list name to PUSH bans to (export). */
  addressListName: string;
  /** Comma-separated address-list names to IMPORT from (e.g. "blacklist,honeypot"). Null = disabled. */
  importAddressLists: string | null;
  /** Unique token for HTTP syslog ingestion (used when UDP syslog is not available). */
  ingestToken: string | null;
  lastApiConnectedAt: string | null;
  lastApiError: string | null;
  lastSyslogAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMikroTikDeviceRequest {
  name: string;
  hostname: string;
  groupId?: number | null;
  apiHost: string;
  apiPort?: number;
  apiUseTls?: boolean;
  apiUsername: string;
  apiPassword: string;
  syslogIdentifier: string;
  addressListName?: string;
  /** Comma-separated address-list names to import from (e.g. "blacklist,honeypot"). */
  importAddressLists?: string;
}

export interface UpdateMikroTikCredentialsRequest {
  apiHost?: string;
  apiPort?: number;
  apiUseTls?: boolean;
  apiUsername?: string;
  apiPassword?: string;
  syslogIdentifier?: string;
  addressListName?: string;
  importAddressLists?: string | null;
}

// ============================================
// M365 Guard types
// ============================================

/**
 * Licence tier detected on the customer tenant. It gates which controls can run:
 * sign-in logs and userRegistrationDetails need P1, risky users need P2. On the
 * free tier, connections are only visible through the unified audit log.
 */
export type M365LicenceProfile = 'free' | 'p1' | 'p2';

/** Per-source freshness, as shown by the UI banner and asserted by F-DATA-01. */
export interface M365SourceFreshness {
  /** Last successful posture scan. */
  lastPostureAt: string | null;
  /** Last sign-in read through Graph. Always null on the free tier. */
  lastSignInAt: string | null;
  /** Timestamp of the most recent unified audit log event ingested. */
  lastUalEventAt: string | null;
  /** Hours since the most recent audit event, or null when nothing was ever ingested. */
  ualLagHours: number | null;
}

export interface M365Tenant {
  id: number;
  deviceId: number;
  entraTenantId: string | null;
  primaryDomain: string | null;
  clientId: string | null;
  /** null until the enrolment script has uploaded the certificate. */
  certThumbprint: string | null;
  certNotAfter: string | null;
  licenceProfile: M365LicenceProfile | null;
  /** True once the optional second consent, covering the response actions, is granted. */
  hasWriteConsent: boolean;
  exoWorkerEnabled: boolean;
  /**
   * True when the service principal actually holds the Exchange role.
   * Exchange.ManageAsApp alone grants nothing: without the role every Exchange
   * command is denied, reads included. When false, the P-EXO controls are
   * reported as uncovered instead of silently passing.
   */
  exoRoleAssigned: boolean;
  freshness: M365SourceFreshness;
  lastError: string | null;
  lastErrorAt: string | null;
  settings: M365TenantSettings;
  /** True once the tenant has credentials and a token could be acquired. */
  enrolled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-tenant tuning. Every field has a safe default, so a freshly enrolled
 * tenant is already usable: the point of these is to remove the false positives
 * that only the operator knows about, such as the office egress IP.
 */
export interface M365TenantSettings {
  /** ISO 3166-1 alpha-2 codes a sign-in may legitimately come from. */
  allowedCountries?: string[];
  /** Neighbouring countries tolerated by the impossible-travel rule. */
  neighborCountriesTolerance?: string[];
  /** IPs and CIDRs that are never suspicious, typically the customer's offices. */
  trustedIps?: string[];
  /** Words that identify the operator in a mailbox rule name, to cap its severity. */
  mspKeywords?: string[];
  /** Applications consented to on purpose, which posture must stop reporting. */
  allowedOauthApps?: string[];
  /** Mailbox forwards validated by the business, as "mailbox -> destination". */
  allowedForwarding?: Array<{ mailbox: string; to: string }>;
  /** ASNs of VPNs the customer's staff legitimately use. */
  allowedVpnAsns?: string[];
  /** External recipients per hour and per sender above which D-MAIL-01 fires. */
  outboundBurstThreshold?: number;
}

/**
 * Creating an m365 device does not contact Microsoft: it registers the tenant,
 * generates the key pair and hands back the enrolment command to run.
 */
export interface CreateM365TenantRequest {
  name: string;
  /** Primary domain of the customer tenant, used as the device hostname. */
  primaryDomain: string;
  groupId?: number | null;
}

export interface UpdateM365TenantRequest {
  primaryDomain?: string;
  exoWorkerEnabled?: boolean;
  settings?: M365TenantSettings;
}

/**
 * What the UI shows after registering a tenant. The certificate is public
 * material; the private key stays on the server and is never part of a response.
 */
export interface M365EnrolmentInstructions {
  deviceId: number;
  /** Single-use token, returned once and only once. */
  token: string;
  expiresAt: string;
  /** Self-signed certificate, PEM, to upload into the customer tenant. */
  certificatePem: string;
  certThumbprint: string;
  /** Ready-to-run command, for the operator to paste into a PowerShell prompt. */
  command: string;
}

/** Posted back by the enrolment script, authenticated by the single-use token. */
export interface M365EnrolmentCallbackRequest {
  token: string;
  entraTenantId: string;
  clientId: string;
  /** Reported by the enrolment script once it has verified role-group membership. */
  exchangeRoleAssigned: boolean;
}

/** Outcome of probing the tenant: which permissions landed, and what licence. */
export interface M365EnrolmentVerification {
  ok: boolean;
  licenceProfile: M365LicenceProfile | null;
  /** False means the P-EXO controls cannot run on this tenant. */
  exoRoleAssigned: boolean;
  /** Application permissions that answered, by Graph path. */
  grantedScopes: string[];
  /** Permissions the module needs and that are still missing. */
  missingScopes: string[];
  error?: string;
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
  /**
   * Scope at which the threshold was overridden.
   * 'agent'  = an agent-level assignment has threshold_override set
   * 'group'  = a group-level assignment has threshold_override set (closest ancestor wins)
   * null     = no override — using template default
   */
  thresholdOverrideScope: 'agent' | 'group' | null;
  /** Raw threshold override value. null when no scope-level override is set. */
  thresholdOverride: number | null;
  /** Raw window_seconds override value. null when no scope-level override is set. */
  windowSecondsOverride: number | null;
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
  /**
   * ID of the agent whose LAN/WAN IP matches the event source.
   * null  = unknown source (external IP or unregistered agent)
   * Set when source_agent_id is populated in the DB.
   */
  sourceAgentId?: number | null;
  /** 'lan' | 'wan' — how the peer was identified. null when sourceAgentId is null. */
  sourceIpType?: 'lan' | 'wan' | null;
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
  /** ID of the currently active ban (only set when status='banned') */
  activeBanId?: number | null;
  /** Scope of the active ban — drives whether Lift (global) or Exclude (local) is offered. */
  activeBanScope?: BanScope | null;
  /**
   * True when the active ban originated from the calling tenant's own agents.
   * Only the origin tenant — or the Default/master tenant (god view) — may lift a
   * GLOBAL ban; every other tenant must override it locally via an exclusion.
   * Never reveals WHICH other tenant a ban came from.
   */
  activeBanIsOrigin?: boolean;
  /** True when the calling tenant has already excluded (locally overridden) the active ban. */
  activeBanExcluded?: boolean;
  /**
   * True when the calling tenant has issued a "clear suspicious" for this IP,
   * snapshotting the current total_failures as a baseline.
   * The IP will become suspicious again if new failures arrive after the clear.
   * Only meaningful for non-admin tenant views.
   */
  clearedForTenant?: boolean;
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
  /**
   * True when THIS ban originated from the calling tenant's own agents.
   * Exposed to every tenant (it reveals "it's mine", never which other tenant
   * it came from). The origin tenant may lift a global ban outright — it is
   * their detection, so their false positive must disappear everywhere. Any
   * other tenant can only opt out locally via an exclusion.
   */
  isOriginTenant: boolean;
  bannedByUserId: number | null;
  bannedAt: string;
  expiresAt: string | null;
  isActive: boolean;
  /**
   * True when the calling tenant has created a per-tenant exclusion for this global ban.
   * The ban stays globally active; agents of this tenant won't enforce it.
   * Only meaningful for scope='global' bans viewed by non-admin users.
   */
  isExcludedByTenant?: boolean;
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
  /** Username of the creator (LEFT JOIN users); null when unknown or deleted. */
  createdByUsername?: string | null;
  createdAt: string;
  /** Computed per operating tenant by the server (whitelist delete rule). */
  canDelete?: boolean;
}

export interface CreateWhitelistRequest {
  ip: string;
  label?: string | null;
  scope?: WhitelistScope;
  scopeId?: number | null;
}

// ============================================
// Obliguard — Rate limiting (per-IP, firewall-enforced)
// ============================================

/**
 * Three independent, separately-toggled per-IP limiting mechanisms:
 *   - 'connection' : cap on concurrent connections per source IP (connlimit / ct count)
 *   - 'rate'       : cap on new connections per second per source IP (hashlimit / meter)
 *   - 'volume'     : cap on bandwidth in mbit/s per source IP (traffic shaping —
 *                    tc on Linux, dummynet on macOS; not a firewall mechanism)
 * `maxValue` is interpreted per type: conns, conns/sec, or mbit/sec respectively.
 */
export type RateLimitType = 'connection' | 'rate' | 'volume';

/**
 * What happens to traffic that exceeds `maxValue` (soft tier):
 *   - 'drop'   : drop the offending packets/connection (works on every platform,
 *                incl. Windows — the only enforcement mode available there)
 *   - 'reject' : drop + send TCP RST (connection/rate types only)
 *   - 'shape'  : queue/throttle excess to the limit — true traffic shaping,
 *                only meaningful for the 'volume' type (Linux tc / macOS dummynet)
 */
export type RateLimitAction = 'drop' | 'reject' | 'shape';

export type RateLimitScope = 'global' | 'tenant' | 'group' | 'agent';

export interface RateLimitPolicy {
  id: number;
  type: RateLimitType;
  scope: RateLimitScope;
  scopeId: number | null;
  tenantId: number | null;
  enabled: boolean;
  /** TCP destination port the limit applies to. null = all inbound TCP. */
  port: number | null;
  /** connection: max concurrent conns/IP. rate: max new conns/sec/IP. volume: max mbit/sec/IP. */
  maxValue: number;
  /** Escalate to an auto-ban when traffic exceeds maxValue × this. null = never. */
  banMultiplier: number | null;
  /** Action on the soft tier (over maxValue, under ban threshold). */
  action: RateLimitAction;
  /** TTL for the escalation ban. null = permanent. */
  banTtlSeconds: number | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRateLimitPolicyRequest {
  type: RateLimitType;
  scope?: RateLimitScope;
  scopeId?: number | null;
  enabled?: boolean;
  port?: number | null;
  maxValue: number;
  banMultiplier?: number | null;
  action?: RateLimitAction;
  banTtlSeconds?: number | null;
}

/**
 * A resolved rate limit rule sent to the agent for firewall enforcement.
 * Flattened from a RateLimitPolicy after global→group→agent resolution.
 */
export interface RateLimitRule {
  type: RateLimitType;
  port: number | null;
  maxValue: number;
  banMultiplier: number | null;
  action: RateLimitAction;
  banTtlSeconds: number | null;
}

/**
 * Manually add an IP to the reputation module with a desired status.
 * Routed server-side to the appropriate table (ip_bans, ip_whitelist, or ip_reputation).
 */
export interface AddIpReputationRequest {
  ip: string;
  status: IpStatus;
  /** Used when status='whitelisted' */
  label?: string | null;
  /** Used when status='banned' */
  reason?: string | null;
  /** Used when status='banned' or 'whitelisted' */
  scope?: BanScope | WhitelistScope;
  scopeId?: number | null;
  /** Used when status='banned' (ISO timestamp, null = permanent) */
  expiresAt?: string | null;
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
   * RFC-1918 LAN IPs of all active non-loopback interfaces on this machine.
   * Used by the server to build agent-to-agent peer links on the NetMap.
   */
  lanIPs?: string[];
  /**
   * Log samples requested by the server.
   * Key = log file path, value = last N lines.
   */
  logSamples?: Record<string, string[]>;
  /**
   * Capabilities of this agent build (heartbeat, optional; W2-1). Stored as
   * reported: at most 32 entries of at most 32 characters.
   */
  capabilities?: string[];
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
  /**
   * Resolved per-IP rate limiting rules to enforce in the local firewall.
   * Empty/absent = no rate limiting. Whitelisted IPs are exempted by the agent.
   */
  rateLimits?: RateLimitRule[];
  command?: string;
}

// ============================================
// Firewall rule management
// ============================================

export interface FirewallRule {
  id: string;
  name: string;
  direction: 'in' | 'out' | 'both';
  action: 'allow' | 'block';
  protocol: string;
  localPort: string;
  remoteIp: string;
  enabled: boolean;
  source: 'system' | 'obliguard';
  platform: string;
}

export interface FirewallAddRequest {
  name?: string;
  direction: 'in' | 'out';
  action: 'allow' | 'block';
  protocol: string;
  localPort?: string;
  remoteIp?: string;
}

export interface FirewallCommandResponse {
  success: boolean;
  error?: string;
  rules?: FirewallRule[];
  platform?: string;
}
