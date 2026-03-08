import apiClient from './client';
import type { ApiResponse, IpBan, CreateBanRequest } from '@obliview/shared';

export const bansApi = {
  async list(params?: {
    active?: boolean;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ data: IpBan[]; total: number }> {
    const res = await apiClient.get<ApiResponse<IpBan[]> & { total: number }>('/bans', { params });
    return { data: res.data.data!, total: res.data.total };
  },

  async create(data: CreateBanRequest): Promise<IpBan> {
    const res = await apiClient.post<ApiResponse<IpBan>>('/bans', data);
    return res.data.data!;
  },

  async lift(id: number): Promise<void> {
    await apiClient.delete(`/bans/${id}`);
  },

  async promoteToGlobal(id: number): Promise<IpBan> {
    const res = await apiClient.post<ApiResponse<IpBan>>(`/bans/${id}/promote-global`);
    return res.data.data!;
  },
};
