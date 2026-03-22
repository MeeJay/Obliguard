import apiClient from './client';
import type { AppConfig, AgentGlobalConfig, ObligateConfig, ApiResponse } from '@obliview/shared';

export const appConfigApi = {
  async getConfig(): Promise<AppConfig> {
    const res = await apiClient.get<ApiResponse<AppConfig>>('/admin/config');
    return res.data.data!;
  },

  async setConfig(key: keyof AppConfig, value: boolean | number | null): Promise<void> {
    await apiClient.put(`/admin/config/${key}`, { value: String(value ?? '') });
  },

  async getAgentGlobal(): Promise<AgentGlobalConfig> {
    const res = await apiClient.get<ApiResponse<AgentGlobalConfig>>('/admin/config/agent-global');
    return res.data.data!;
  },

  async patchAgentGlobal(patch: Partial<AgentGlobalConfig>): Promise<AgentGlobalConfig> {
    const res = await apiClient.patch<ApiResponse<AgentGlobalConfig>>('/admin/config/agent-global', patch);
    return res.data.data!;
  },

  // ── Obligate SSO gateway ────────────────────────────────────────────────

  async getObligateConfig(): Promise<ObligateConfig> {
    const res = await apiClient.get<ApiResponse<ObligateConfig>>('/admin/config/obligate');
    return res.data.data!;
  },

  async patchObligateConfig(patch: { url?: string | null; apiKey?: string | null; enabled?: boolean }): Promise<ObligateConfig> {
    const res = await apiClient.put<ApiResponse<ObligateConfig>>('/admin/config/obligate', patch);
    return res.data.data!;
  },
};
