import apiClient from './client';
import type { ApiResponse, IpWhitelist, CreateWhitelistRequest } from '@obliview/shared';

export const whitelistApi = {
  async list(): Promise<IpWhitelist[]> {
    const res = await apiClient.get<ApiResponse<IpWhitelist[]>>('/whitelist');
    return res.data.data!;
  },

  async create(data: CreateWhitelistRequest): Promise<IpWhitelist> {
    const res = await apiClient.post<ApiResponse<IpWhitelist>>('/whitelist', data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/whitelist/${id}`);
  },
};
