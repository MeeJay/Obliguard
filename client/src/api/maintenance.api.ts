import apiClient from './client';
import type {
  MaintenanceWindow,
  CreateMaintenanceWindowRequest,
  MaintenanceScopeType,
  ApiResponse,
} from '@obliview/shared';

export const maintenanceApi = {
  async list(params?: { scopeType?: string }): Promise<MaintenanceWindow[]> {
    const res = await apiClient.get<ApiResponse<MaintenanceWindow[]>>('/maintenance', { params });
    return res.data.data!;
  },

  async create(data: CreateMaintenanceWindowRequest): Promise<MaintenanceWindow> {
    const res = await apiClient.post<ApiResponse<MaintenanceWindow>>('/maintenance', data);
    return res.data.data!;
  },

  async update(id: number, data: Partial<CreateMaintenanceWindowRequest>): Promise<MaintenanceWindow> {
    const res = await apiClient.put<ApiResponse<MaintenanceWindow>>(`/maintenance/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/maintenance/${id}`);
  },

  async getEffective(scopeType: MaintenanceScopeType, scopeId: number): Promise<MaintenanceWindow[]> {
    const res = await apiClient.get<ApiResponse<MaintenanceWindow[]>>(
      `/maintenance/effective/${scopeType}/${scopeId}`,
    );
    return res.data.data!;
  },

  async disableForScope(windowId: number, scopeType: MaintenanceScopeType, scopeId: number): Promise<void> {
    await apiClient.post(`/maintenance/${windowId}/disable`, { scopeType, scopeId });
  },

  async enableForScope(windowId: number, scopeType: MaintenanceScopeType, scopeId: number): Promise<void> {
    await apiClient.post(`/maintenance/${windowId}/enable`, { scopeType, scopeId });
  },
};
