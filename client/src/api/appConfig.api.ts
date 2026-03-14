import apiClient from './client';
import type { AppConfig, AgentGlobalConfig, ObliviewConfig, OblimapConfig, OblianceConfig, ApiResponse } from '@obliview/shared';

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

  // ── Obliview integration ──────────────────────────────────────────────────

  /** Fetch Obliview URL + whether an API key has been set. Admin only. */
  async getObliviewConfig(): Promise<ObliviewConfig> {
    const res = await apiClient.get<ApiResponse<ObliviewConfig>>('/admin/config/obliview');
    return res.data.data!;
  },

  /** Save Obliview URL and/or API key. Pass apiKey=null to clear it. Admin only. */
  async patchObliviewConfig(data: { url?: string | null; apiKey?: string | null }): Promise<ObliviewConfig> {
    const res = await apiClient.patch<ApiResponse<ObliviewConfig>>('/admin/config/obliview', data);
    return res.data.data!;
  },

  /**
   * Ask the Obliguard server to look up a device UUID on the Obliview instance.
   * Returns the full URL to the Obliview agent page, or null if not found / not configured.
   */
  async getObliviewAgentLink(uuid: string): Promise<string | null> {
    try {
      const res = await apiClient.get<ApiResponse<{ url: string } | null>>(
        `/admin/config/obliview/agent-link/${encodeURIComponent(uuid)}`,
      );
      return res.data.data?.url ?? null;
    } catch {
      return null;
    }
  },

  // ── Oblimap integration ───────────────────────────────────────────────────

  async getOblimapConfig(): Promise<OblimapConfig> {
    const res = await apiClient.get<ApiResponse<OblimapConfig>>('/admin/config/oblimap');
    return res.data.data!;
  },

  async patchOblimapConfig(data: { url?: string | null; apiKey?: string | null }): Promise<OblimapConfig> {
    const res = await apiClient.patch<ApiResponse<OblimapConfig>>('/admin/config/oblimap', data);
    return res.data.data!;
  },

  async getOblimapAgentLink(uuid: string): Promise<string | null> {
    try {
      const res = await apiClient.get<ApiResponse<{ url: string } | null>>(
        `/admin/config/oblimap/agent-link/${encodeURIComponent(uuid)}`,
      );
      return res.data.data?.url ?? null;
    } catch {
      return null;
    }
  },

  // ── Obliance integration ──────────────────────────────────────────────────

  async getOblianceConfig(): Promise<OblianceConfig> {
    const res = await apiClient.get<ApiResponse<OblianceConfig>>('/admin/config/obliance');
    return res.data.data!;
  },

  async patchOblianceConfig(data: { url?: string | null; apiKey?: string | null }): Promise<OblianceConfig> {
    const res = await apiClient.patch<ApiResponse<OblianceConfig>>('/admin/config/obliance', data);
    return res.data.data!;
  },

  async getOblianceAgentLink(uuid: string): Promise<string | null> {
    try {
      const res = await apiClient.get<ApiResponse<{ url: string } | null>>(
        `/admin/config/obliance/agent-link/${encodeURIComponent(uuid)}`,
      );
      return res.data.data?.url ?? null;
    } catch {
      return null;
    }
  },
};
