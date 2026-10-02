import apiClient from './client';
import type { ResolvedSettings, ApiResponse, SettingsScope } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';

interface ResolvedWithOverrides {
  resolved: ResolvedSettings;
  overrides: Record<string, number>;
}

export const settingsApi = {
  async getGlobalResolved(): Promise<ResolvedWithOverrides> {
    const res = await apiClient.get<ApiResponse<ResolvedWithOverrides>>('/settings/global/resolved');
    return res.data.data!;
  },

  async getGroupResolved(groupId: number): Promise<ResolvedWithOverrides> {
    const res = await apiClient.get<ApiResponse<ResolvedWithOverrides>>(`/settings/group/${groupId}/resolved`);
    return res.data.data!;
  },

  /**
   * @deprecated Monitors do not exist in Obliguard: no request is sent. Kept
   * only for components/settings/SettingsPanel.tsx (now unused) until removed.
   */
  async getMonitorResolved(_monitorId: number): Promise<ResolvedWithOverrides> {
    throw new Error('Monitor settings are not available in Obliguard');
  },

  async set(scope: SettingsScope, scopeId: string, key: SettingsKey, value: number): Promise<void> {
    await apiClient.put(`/settings/${scope}/${scopeId}`, { key, value });
  },

  async setBulk(
    scope: SettingsScope,
    scopeId: string,
    overrides: Array<{ key: SettingsKey; value: number }>,
  ): Promise<void> {
    await apiClient.put(`/settings/${scope}/${scopeId}/bulk`, { overrides });
  },

  async remove(scope: SettingsScope, scopeId: string, key: SettingsKey): Promise<void> {
    await apiClient.delete(`/settings/${scope}/${scopeId}/${key}`);
  },
};
