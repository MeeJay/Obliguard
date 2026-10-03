import apiClient from './client';
import type {
  AgentDevice, AgentDisplayConfig, AgentThresholds, ApiResponse, NotificationTypeConfig,
  AgentUpdatePolicy, AgentUpdateRequestResult, AgentVersionDistribution, AgentTenantUpdatePolicyInfo,
} from '@obliview/shared';
import type { AgentPushSnapshot } from '../types/agent';

// ── Paced fleet rollout (W12-4) — mirror of server agentUpdateRollout.service ──

/** Level that froze an agent ('unresolved': the policy could not be read, fail closed). */
export type RolloutFrozenLevel = 'global' | 'tenant' | 'group' | 'agent' | 'unresolved';

export interface RolloutFrozenAgent {
  id: number;
  name: string | null;
  hostname: string;
  tenantId: number;
  level: RolloutFrozenLevel;
  sourceGroupId: number | null;
  sourceGroupName: string | null;
}

/** GET /agent/updates/preview: what "update all outdated" would do now, and the rollout progress. */
export interface AgentUpdateRolloutPreview {
  latestVersion: string | null;
  /** Default tenant: every tenant's agents. */
  allTenants: boolean;
  /** Sent back with updateAll (refused with 409 when the session switched tenant since). */
  scopeTenantId: number;
  outdated: number;
  /** Outdated, not frozen, with a build for their platform. */
  targets: number;
  toRequest: number;
  alreadyRequested: number;
  inFlight: number;
  auto: number;
  online: number;
  offline: number;
  byTenant: Array<{ tenantId: number; tenantName: string | null; targets: number; frozen: number }>;
  byGroup: Array<{ tenantId: number; groupId: number | null; groupName: string | null; targets: number }>;
  byPlatform: Array<{ platform: string; targets: number }>;
  frozen: {
    total: number;
    byLevel: Record<RolloutFrozenLevel, number>;
    agents: RolloutFrozenAgent[];
    truncated: boolean;
  };
  noBuild: number;
  /** Outdated agents whose update to this version failed: not requested again by updateAll (Retry them one by one). */
  failed: number;
  unknownVersion: number;
  /** Pending requests: what cancelAllUpdates clears. */
  pending: number;
  progress: { waiting: number; offered: number; inProgress: number; succeeded: number; failed: number };
  rollout: { maxPerWindow: number; windowSeconds: number; offersInWindow: number; estimatedMinutes: number };
}

export interface AgentUpdateAllResult {
  requested: number;
  targetVersion: string | null;
  skipped: AgentUpdateRequestResult['skipped'];
  byTenant: Array<{ tenantId: number; requested: number }>;
  preview: AgentUpdateRolloutPreview;
}

export interface AgentUpdateCancelAllResult {
  cancelled: number;
  byTenant: Array<{ tenantId: number; cancelled: number }>;
  /** Outdated agents under the 'auto' policy: still offered the update. */
  autoContinuing: number;
}

/** Filters of GET /agent/devices. */
export interface ListDevicesFilter {
  status?: AgentDevice['status'];
  groupId?: number;
  /** With groupId: include the agents of every descendant group. */
  recursive?: boolean;
}

/** Status chips of the fleet list (OR-ed); mirror of server agentList.service. */
export const AGENT_LIST_CHIPS = [
  'online', 'offline', 'pending', 'suspended', 'refused',
  'updating', 'update_failed', 'evaluate_only', 'outdated',
] as const;
export type AgentListChip = typeof AGENT_LIST_CHIPS[number];

export const AGENT_LIST_SORT_FIELDS = [
  'name', 'status', 'lastSeen', 'version', 'events24h', 'bans24h', 'group', 'tenant',
] as const;
export type AgentListSortField = typeof AGENT_LIST_SORT_FIELDS[number];

export type AgentListDeviceType = 'agent' | 'mikrotik' | 'm365';

/** Server page-size cap of GET /agent/devices?paged=1. */
export const AGENT_LIST_MAX_PAGE_SIZE = 200;

/** Filters of GET /agent/devices?paged=1 (the /agents fleet list). */
export interface AgentListQuery {
  /** Hostname, display name or IP (substring, case-insensitive). */
  q?: string;
  chips?: AgentListChip[];
  /** A group id, 'none' = ungrouped agents. */
  groupId?: number | 'none';
  /** With groupId: include every descendant group. */
  recursive?: boolean;
  /** God view only: narrow to these tenants. */
  tenantIds?: number[];
  type?: AgentListDeviceType;
  sortBy?: AgentListSortField;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/** One row of the fleet list: the device plus its list-only columns. */
export type AgentListRow = AgentDevice & {
  groupName: string | null;
  tenantName: string | null;
  events24h: number;
  bans24h: number;
};

export type AgentListCounts = Record<AgentListChip | 'all', number>;

export interface AgentListPage {
  rows: AgentListRow[];
  /** Rows matching every filter. */
  total: number;
  page: number;
  pageSize: number;
  /** Per chip, on the set matched by the other filters ('all' = its size). */
  counts: AgentListCounts;
}

/** GET /agent/version (downloadUrl: legacy servers only). */
export interface AgentServedVersion {
  version: string;
  missingBuilds?: string[];
  downloadUrl?: string;
}

export const agentApi = {
  // ── Devices ───────────────────────────────────────────────────────────────

  async getDeviceById(id: number): Promise<AgentDevice | null> {
    try {
      const res = await apiClient.get<ApiResponse<AgentDevice>>(`/agent/devices/${id}`);
      return res.data.data ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Devices of the operating tenant. Accepts a bare status (legacy call sites)
   * or filters: groupId (+ recursive = the group's whole sub-tree) and status.
   */
  async listDevices(filter?: AgentDevice['status'] | ListDevicesFilter): Promise<AgentDevice[]> {
    const f: ListDevicesFilter = typeof filter === 'string' ? { status: filter } : (filter ?? {});
    const params: Record<string, string | number> = {};
    if (f.status) params.status = f.status;
    if (f.groupId != null) params.groupId = f.groupId;
    if (f.groupId != null && f.recursive) params.recursive = 1;
    const res = await apiClient.get<ApiResponse<AgentDevice[]>>('/agent/devices', { params });
    return res.data.data!;
  },

  /** One page of the fleet list, filtered, counted and sorted server-side. */
  async listPaged(query: AgentListQuery = {}, signal?: AbortSignal): Promise<AgentListPage> {
    const params: Record<string, string | number> = { paged: 1 };
    if (query.q?.trim()) params.q = query.q.trim();
    if (query.chips && query.chips.length > 0) params.chips = query.chips.join(',');
    if (query.groupId != null) params.groupId = query.groupId;
    if (query.groupId != null && query.groupId !== 'none' && query.recursive) params.recursive = 1;
    if (query.tenantIds && query.tenantIds.length > 0) params.tenants = query.tenantIds.join(',');
    if (query.type) params.type = query.type;
    if (query.sortBy) params.sortBy = query.sortBy;
    if (query.sortOrder) params.sortOrder = query.sortOrder;
    if (query.page) params.page = query.page;
    if (query.pageSize) params.pageSize = query.pageSize;
    const res = await apiClient.get<ApiResponse<AgentListPage>>('/agent/devices', { params, signal });
    return res.data.data!;
  },

  async updateDevice(
    id: number,
    data: {
      status?: AgentDevice['status'];
      groupId?: number | null;
      checkIntervalSeconds?: number;
      maxMissedPushes?: number | null;
      agentThresholds?: AgentThresholds;
      name?: string | null;
      sensorDisplayNames?: Record<string, string> | null;
      overrideGroupSettings?: boolean;
      displayConfig?: AgentDisplayConfig | null;
      notificationTypes?: NotificationTypeConfig | null;
      wanMatchingEnabled?: boolean;
      evaluateOnly?: boolean;
      /** Agent update policy override; null = inherit (C17-1). */
      updatePolicy?: AgentUpdatePolicy | null;
      /** Only null is accepted: releases the device ↔ API-key binding (after a re-key). */
      apiKeyId?: null;
    },
  ): Promise<AgentDevice> {
    const res = await apiClient.patch<ApiResponse<AgentDevice>>(`/agent/devices/${id}`, data);
    return res.data.data!;
  },

  async getDeviceMetrics(deviceId: number): Promise<AgentPushSnapshot | null> {
    try {
      const res = await apiClient.get<ApiResponse<AgentPushSnapshot>>(`/agent/devices/${deviceId}/metrics`);
      return res.data.data ?? null;
    } catch {
      return null;
    }
  },

  async updateDeviceThresholds(deviceId: number, thresholds: AgentThresholds): Promise<AgentDevice> {
    const res = await apiClient.patch<ApiResponse<AgentDevice>>(`/agent/devices/${deviceId}`, { agentThresholds: thresholds });
    return res.data.data!;
  },

  async deleteDevice(id: number): Promise<void> {
    await apiClient.delete(`/agent/devices/${id}`);
  },

  // ── Device commands ───────────────────────────────────────────────────────

  /** Queue a one-shot command for the agent (delivered on next push). */
  async sendCommand(id: number, command: string): Promise<void> {
    await apiClient.post(`/agent/devices/${id}/command`, { command });
  },

  // ── Bulk device operations ────────────────────────────────────────────────

  /** Ids outside the operating tenant or not writable by the caller are skipped. */
  async bulkDeleteDevices(deviceIds: number[]): Promise<{ affected: number; skipped: number } | undefined> {
    const res = await apiClient.delete<ApiResponse<{ affected: number; skipped: number }>>('/agent/devices/bulk', { data: { deviceIds } });
    return res.data?.data;
  },

  async bulkSendCommand(deviceIds: number[], command: string): Promise<{ affected: number; skipped: number } | undefined> {
    const res = await apiClient.post<ApiResponse<{ affected: number; skipped: number }>>('/agent/devices/bulk-command', { deviceIds, command });
    return res.data?.data;
  },

  async bulkUpdateDevices(
    deviceIds: number[],
    data: {
      groupId?: number | null;
      overrideGroupSettings?: boolean;
      status?: 'approved' | 'suspended';
      updatePolicy?: AgentUpdatePolicy | null;
    },
  ): Promise<{ affected: number; skipped: number } | undefined> {
    const res = await apiClient.patch<ApiResponse<{ affected: number; skipped: number }>>('/agent/devices/bulk', { deviceIds, ...data });
    return res.data.data;
  },

  // ── Agent updates (C17-1) ─────────────────────────────────────────────────

  /** "Update now": offered to the agent at its next heartbeat (policy permitting). */
  async requestUpdate(id: number): Promise<AgentDevice> {
    const res = await apiClient.post<ApiResponse<AgentDevice>>(`/agent/devices/${id}/agent-update`);
    return res.data.data!;
  },

  /**
   * Retry a failed (or capped) update attempt: the attempt is reset to
   * 'offered' with no offers counted and re-offered at the next heartbeat,
   * also under the 'manual' policy. Same 409 refusals as requestUpdate.
   */
  async retryUpdate(id: number): Promise<AgentDevice> {
    const res = await apiClient.post<ApiResponse<AgentDevice>>(`/agent/devices/${id}/update/retry`);
    return res.data.data!;
  },

  async cancelUpdate(id: number): Promise<AgentDevice> {
    const res = await apiClient.delete<ApiResponse<AgentDevice>>(`/agent/devices/${id}/agent-update`);
    return res.data.data!;
  },

  async bulkRequestUpdate(deviceIds: number[]): Promise<AgentUpdateRequestResult> {
    const res = await apiClient.post<ApiResponse<AgentUpdateRequestResult>>('/agent/devices/bulk-request-update', { deviceIds });
    return res.data.data!;
  },

  async requestGroupUpdate(groupId: number): Promise<AgentUpdateRequestResult> {
    const res = await apiClient.post<ApiResponse<AgentUpdateRequestResult>>(`/agent/groups/${groupId}/agent-update`);
    return res.data.data!;
  },

  async getVersionDistribution(): Promise<AgentVersionDistribution> {
    const res = await apiClient.get<ApiResponse<AgentVersionDistribution>>('/agent/devices/versions');
    return res.data.data!;
  },

  // ── Paced fleet rollout (W12-4) ───────────────────────────────────────────

  /** Preview of "update all outdated" (operating tenant; Default = every tenant) and rollout progress. */
  async getUpdateRolloutPreview(): Promise<AgentUpdateRolloutPreview> {
    const res = await apiClient.get<ApiResponse<AgentUpdateRolloutPreview>>('/agent/updates/preview');
    return res.data.data!;
  },

  /** Request the update of every outdated, non-frozen agent (offers paced by the server). */
  async updateAllOutdated(scopeTenantId: number): Promise<AgentUpdateAllResult> {
    const res = await apiClient.post<ApiResponse<AgentUpdateAllResult>>('/agent/updates/all', { scopeTenantId });
    return res.data.data!;
  },

  /** Clear every pending update request of the scope. */
  async cancelAllUpdates(): Promise<AgentUpdateCancelAllResult> {
    const res = await apiClient.post<ApiResponse<AgentUpdateCancelAllResult>>('/agent/updates/cancel-all');
    return res.data.data!;
  },

  /** Tenant level of the update policy (operating tenant; readable by members). */
  async getTenantUpdatePolicy(): Promise<AgentTenantUpdatePolicyInfo> {
    const res = await apiClient.get<ApiResponse<AgentTenantUpdatePolicyInfo>>('/agent/update-policy/tenant');
    return res.data.data!;
  },

  /** Set the operating tenant's policy (null = inherit the global one). Platform admins only. */
  async setTenantUpdatePolicy(updatePolicy: AgentUpdatePolicy | null): Promise<AgentTenantUpdatePolicyInfo> {
    const res = await apiClient.patch<ApiResponse<AgentTenantUpdatePolicyInfo>>('/agent/update-policy/tenant', { updatePolicy });
    return res.data.data!;
  },

  // ── Agent version ─────────────────────────────────────────────────────────

  /**
   * Served agent version. missingBuilds lists the artifacts whose build does
   * not match it (nothing is advertised to those platforms).
   */
  async getVersion(): Promise<AgentServedVersion> {
    const res = await apiClient.get<AgentServedVersion>('/agent/version');
    return res.data;
  },

  // ── Installer URLs ────────────────────────────────────────────────────────

  getInstallerLinuxUrl(apiKey: string): string {
    return `${window.location.origin}/api/agent/installer/linux?key=${encodeURIComponent(apiKey)}`;
  },

  getInstallerWindowsUrl(apiKey: string): string {
    return `${window.location.origin}/api/agent/installer/windows?key=${encodeURIComponent(apiKey)}`;
  },

  getInstallerMacosUrl(apiKey: string): string {
    return `${window.location.origin}/api/agent/installer/macos?key=${encodeURIComponent(apiKey)}`;
  },

  getInstallerFreeBSDUrl(apiKey: string): string {
    return `${window.location.origin}/api/agent/installer/freebsd?key=${encodeURIComponent(apiKey)}`;
  },

  getMsiUrl(): string {
    return `${window.location.origin}/api/agent/installer/windows.msi`;
  },
};
