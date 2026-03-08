import apiClient from './client';
import type {
  RemediationAction,
  RemediationBinding,
  ResolvedRemediationBinding,
  RemediationActionType,
  OverrideModeR,
  RemediationTrigger,
  CreateRemediationActionRequest,
  AddRemediationBindingRequest,
  ApiResponse,
} from '@obliview/shared';

export const remediationApi = {
  async listActions(): Promise<RemediationAction[]> {
    const res = await apiClient.get<ApiResponse<RemediationAction[]>>('/remediation/actions');
    return res.data.data!;
  },

  async createAction(data: CreateRemediationActionRequest): Promise<RemediationAction> {
    const res = await apiClient.post<ApiResponse<RemediationAction>>('/remediation/actions', data);
    return res.data.data!;
  },

  async getResolved(
    scope: string,
    scopeId: number,
    groupId?: number | null,
  ): Promise<ResolvedRemediationBinding[]> {
    const res = await apiClient.get<ApiResponse<ResolvedRemediationBinding[]>>(
      `/remediation/resolved/${scope}/${scopeId}`,
      { params: groupId != null ? { groupId } : undefined },
    );
    return res.data.data!;
  },

  async getBindings(scope: string, scopeId: number): Promise<RemediationBinding[]> {
    const res = await apiClient.get<ApiResponse<RemediationBinding[]>>(
      `/remediation/bindings/${scope}/${scopeId}`,
    );
    return res.data.data!;
  },

  async addBinding(data: AddRemediationBindingRequest): Promise<RemediationBinding> {
    const res = await apiClient.post<ApiResponse<RemediationBinding>>('/remediation/bindings', data);
    return res.data.data!;
  },

  async updateBinding(
    id: number,
    data: { overrideMode?: OverrideModeR; triggerOn?: RemediationTrigger; cooldownSeconds?: number },
  ): Promise<RemediationBinding> {
    const res = await apiClient.patch<ApiResponse<RemediationBinding>>(`/remediation/bindings/${id}`, data);
    return res.data.data!;
  },

  async deleteBinding(id: number): Promise<void> {
    await apiClient.delete(`/remediation/bindings/${id}`);
  },
};

// Re-export action types for consumers
export type { RemediationActionType, OverrideModeR };
