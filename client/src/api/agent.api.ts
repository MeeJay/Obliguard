import apiClient from './client';
import type {
  AgentApiKey, AgentDevice, AgentDisplayConfig, AgentThresholds, ApiResponse, NotificationTypeConfig,
  AgentUpdatePolicy, AgentUpdateRequestResult, AgentVersionDistribution, AgentTenantUpdatePolicyInfo,
} from '@obliview/shared';
import type { AgentPushSnapshot } from '../types/agent';

/** Filters of GET /agent/devices. */
export interface ListDevicesFilter {
  status?: AgentDevice['status'];
  groupId?: number;
  /** With groupId: include the agents of every descendant group. */
  recursive?: boolean;
}

/** GET /agent/version (downloadUrl: legacy servers only). */
export interface AgentServedVersion {
  version: string;
  missingBuilds?: string[];
  downloadUrl?: string;
}

export const agentApi = {
  // ── API Keys ─────────────────────────────────────────────────────────────

  async listKeys(): Promise<AgentApiKey[]> {
    const res = await apiClient.get<ApiResponse<AgentApiKey[]>>('/agent/keys');
    return res.data.data!;
  },

  async createKey(name: string): Promise<AgentApiKey> {
    const res = await apiClient.post<ApiResponse<AgentApiKey>>('/agent/keys', { name });
    return res.data.data!;
  },

  async deleteKey(id: number): Promise<void> {
    await apiClient.delete(`/agent/keys/${id}`);
  },

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

  async bulkDeleteDevices(deviceIds: number[]): Promise<void> {
    await apiClient.delete('/agent/devices/bulk', { data: { deviceIds } });
  },

  async bulkSendCommand(deviceIds: number[], command: string): Promise<void> {
    await apiClient.post('/agent/devices/bulk-command', { deviceIds, command });
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
