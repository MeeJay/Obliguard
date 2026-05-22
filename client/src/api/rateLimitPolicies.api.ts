import apiClient from './client';
import type { ApiResponse, RateLimitPolicy, CreateRateLimitPolicyRequest } from '@obliview/shared';

export const rateLimitPoliciesApi = {
  async list(scope?: string, scopeId?: number | null): Promise<RateLimitPolicy[]> {
    const params: Record<string, string> = {};
    if (scope && scope !== 'all') params.scope = scope;
    if (scopeId != null) params.scopeId = String(scopeId);
    const res = await apiClient.get<ApiResponse<RateLimitPolicy[]>>('/rate-limit-policies', {
      params: Object.keys(params).length ? params : undefined,
    });
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
