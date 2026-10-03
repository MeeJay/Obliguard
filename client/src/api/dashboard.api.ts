import apiClient from './client';
import type {
  ApiResponse, DashboardSummary, IpsSeriesPoint, DashboardBreakdown, DashboardGroupStats,
} from '@obliview/shared';

export const dashboardApi = {
  /** Hero numbers (with day-over-day deltas), top IPs and per-agent counters of the operating tenant. */
  async summary(): Promise<DashboardSummary> {
    const res = await apiClient.get<ApiResponse<DashboardSummary>>('/dashboard/summary');
    return res.data.data!;
  },

  /** One point per day (2..90), oldest first, the last one live. */
  async timeseries(days = 30): Promise<IpsSeriesPoint[]> {
    const res = await apiClient.get<ApiResponse<IpsSeriesPoint[]>>('/dashboard/timeseries', { params: { days } });
    return res.data.data ?? [];
  },

  /** One point per hour (2..168), oldest first, the last one live. */
  async hourly(hours = 48): Promise<IpsSeriesPoint[]> {
    const res = await apiClient.get<ApiResponse<IpsSeriesPoint[]>>('/dashboard/hourly', { params: { hours } });
    return res.data.data ?? [];
  },

  /** Top services, countries and bans per agent over the last `hours`. */
  async breakdown(hours = 24): Promise<DashboardBreakdown> {
    const res = await apiClient.get<ApiResponse<DashboardBreakdown>>('/dashboard/breakdown', { params: { hours } });
    return res.data.data!;
  },

  /** Per-group cards (visible groups; groupId null = agents of no visible group). */
  async groups(): Promise<DashboardGroupStats[]> {
    const res = await apiClient.get<ApiResponse<DashboardGroupStats[]>>('/dashboard/groups');
    return res.data.data ?? [];
  },
};
