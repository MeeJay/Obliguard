import apiClient from './client';
import type {
  MonitorGroup,
  GroupTreeNode,
  ApiResponse,
  CreateGroupRequest,
  UpdateGroupRequest,
  AgentThresholds,
  AgentGroupConfig,
} from '@obliview/shared';

export const groupsApi = {
  async list(): Promise<MonitorGroup[]> {
    const res = await apiClient.get<ApiResponse<MonitorGroup[]>>('/groups');
    return res.data.data!;
  },

  async tree(): Promise<GroupTreeNode[]> {
    const res = await apiClient.get<ApiResponse<GroupTreeNode[]>>('/groups/tree');
    return res.data.data!;
  },

  async getById(id: number): Promise<MonitorGroup> {
    const res = await apiClient.get<ApiResponse<MonitorGroup>>(`/groups/${id}`);
    return res.data.data!;
  },

  async create(data: CreateGroupRequest): Promise<MonitorGroup> {
    const res = await apiClient.post<ApiResponse<MonitorGroup>>('/groups', data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateGroupRequest): Promise<MonitorGroup> {
    const res = await apiClient.put<ApiResponse<MonitorGroup>>(`/groups/${id}`, data);
    return res.data.data!;
  },

  async move(id: number, newParentId: number | null): Promise<MonitorGroup> {
    const res = await apiClient.post<ApiResponse<MonitorGroup>>(`/groups/${id}/move`, { newParentId });
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/groups/${id}`);
  },


  async reorder(items: { id: number; sortOrder: number }[]): Promise<void> {
    await apiClient.post('/groups/reorder', { items });
  },

  async updateAgentGroupConfig(
    id: number,
    data: { agentGroupConfig?: Partial<AgentGroupConfig>; agentThresholds?: AgentThresholds },
  ): Promise<MonitorGroup> {
    const res = await apiClient.patch<ApiResponse<MonitorGroup>>(`/groups/${id}/agent-config`, data);
    return res.data.data!;
  },
};
