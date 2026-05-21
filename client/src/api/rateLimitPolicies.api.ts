import apiClient from './client';
import type { ApiResponse, RateLimitPolicy, CreateRateLimitPolicyRequest } from '@obliview/shared';

export const rateLimitPoliciesApi = {
  async list(scope?: string): Promise<RateLimitPolicy[]> {
    const params = scope && scope !== 'all' ? { scope } : undefined;
    const res = await apiClient.get<ApiResponse<RateLimitPolicy[]>>('/rate-limit-policies', { params });
    return res.data.data!;
  },

  async create(data: CreateRateLimitPolicyRequest): Promise<RateLimitPolicy> {
    const res = await apiClient.post<ApiResponse<RateLimitPolicy>>('/rate-limit-policies', data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/rate-limit-policies/${id}`);
  },
};
