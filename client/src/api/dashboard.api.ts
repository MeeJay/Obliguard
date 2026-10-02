import apiClient from './client';
import type { ApiResponse, DashboardSummary } from '@obliview/shared';

export const dashboardApi = {
  /** Hero numbers, top IPs and per-agent counters of the operating tenant. */
  async summary(): Promise<DashboardSummary> {
    const res = await apiClient.get<ApiResponse<DashboardSummary>>('/dashboard/summary');
    return res.data.data!;
  },
};
