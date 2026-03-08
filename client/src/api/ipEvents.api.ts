import apiClient from './client';
import type { ApiResponse, IpEvent } from '@obliview/shared';

export const ipEventsApi = {
  async list(params?: {
    ip?: string;
    service?: string;
    eventType?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ data: IpEvent[]; total: number }> {
    const res = await apiClient.get<ApiResponse<IpEvent[]> & { total: number }>('/ip-events', { params });
    return { data: res.data.data!, total: res.data.total };
  },

  async getByIp(ip: string): Promise<IpEvent[]> {
    const res = await apiClient.get<ApiResponse<IpEvent[]>>(`/ip-events/${encodeURIComponent(ip)}`);
    return res.data.data!;
  },
};
