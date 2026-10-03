import apiClient from './client';
import type {
  ApiResponse,
  RateLimitPolicy,
  CreateRateLimitPolicyRequest,
  UpdateRateLimitPolicyRequest,
  RateLimitEnforcement,
} from '@obliview/shared';

export type { UpdateRateLimitPolicyRequest, RateLimitEnforcement };

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

  async update(id: number, data: UpdateRateLimitPolicyRequest): Promise<RateLimitPolicy> {
    const res = await apiClient.patch<ApiResponse<RateLimitPolicy>>(`/rate-limit-policies/${id}`, data);
    return res.data.data!;
  },

  async getEnforcement(): Promise<RateLimitEnforcement> {
    const res = await apiClient.get<ApiResponse<{ enforcement: RateLimitEnforcement }>>('/rate-limit-policies/enforcement');
    return res.data.data!.enforcement;
  },

  /** Platform admin operating the Default tenant only. */
  async setEnforcement(enforcement: RateLimitEnforcement): Promise<RateLimitEnforcement> {
    const res = await apiClient.put<ApiResponse<{ enforcement: RateLimitEnforcement }>>('/rate-limit-policies/enforcement', { enforcement });
    return res.data.data!.enforcement;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/rate-limit-policies/${id}`);
  },
};
