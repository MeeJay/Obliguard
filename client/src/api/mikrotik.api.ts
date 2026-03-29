import apiClient from './client';
import type { MikroTikCredentials, CreateMikroTikDeviceRequest, UpdateMikroTikCredentialsRequest, ApiResponse } from '@obliview/shared';

export const mikrotikApi = {
  async createDevice(data: CreateMikroTikDeviceRequest): Promise<{ deviceId: number; uuid: string }> {
    const res = await apiClient.post<ApiResponse<{ deviceId: number; uuid: string }>>('/mikrotik', data);
    return res.data.data!;
  },

  async getCredentials(deviceId: number): Promise<MikroTikCredentials> {
    const res = await apiClient.get<ApiResponse<MikroTikCredentials>>(`/mikrotik/${deviceId}/credentials`);
    return res.data.data!;
  },

  async updateCredentials(deviceId: number, data: UpdateMikroTikCredentialsRequest): Promise<void> {
    await apiClient.put(`/mikrotik/${deviceId}/credentials`, data);
  },

  async testConnection(deviceId: number): Promise<{ success: boolean; identity?: string; error?: string }> {
    const res = await apiClient.post<ApiResponse<{ success: boolean; identity?: string; error?: string }>>(`/mikrotik/${deviceId}/test`);
    return res.data.data!;
  },

  async syncBans(deviceId: number): Promise<{ added: number; removed: number; error?: string }> {
    const res = await apiClient.post<ApiResponse<{ added: number; removed: number; error?: string }>>(`/mikrotik/${deviceId}/sync-bans`);
    return res.data.data!;
  },

  async pollImport(): Promise<void> {
    await apiClient.post('/mikrotik/import/poll');
  },
};
