import apiClient from './client';
import type { ApiResponse, IpReputation, IpEvent } from '@obliview/shared';

export const ipReputationApi = {
  async list(params?: {
    status?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ data: IpReputation[]; total: number }> {
    const res = await apiClient.get<ApiResponse<IpReputation[]> & { total: number }>('/ip-reputation', { params });
    return { data: res.data.data!, total: res.data.total };
  },

  async getDetail(ip: string): Promise<{ reputation: IpReputation; events: IpEvent[] }> {
    const res = await apiClient.get<ApiResponse<{ reputation: IpReputation; events: IpEvent[] }>>(
      `/ip-reputation/${encodeURIComponent(ip)}`,
    );
    return res.data.data!;
  },
};
