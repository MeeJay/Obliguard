import apiClient from './client';
import type {
  ApiResponse,
  ServiceTemplate,
  ResolvedServiceConfig,
  CreateServiceTemplateRequest,
  UpdateServiceTemplateRequest,
  UpsertServiceAssignmentRequest,
} from '@obliview/shared';

export const serviceTemplatesApi = {
  async list(): Promise<ServiceTemplate[]> {
    const res = await apiClient.get<ApiResponse<ServiceTemplate[]>>('/service-templates');
    return res.data.data!;
  },

  async get(id: number): Promise<ServiceTemplate> {
    const res = await apiClient.get<ApiResponse<ServiceTemplate>>(`/service-templates/${id}`);
    return res.data.data!;
  },

  async create(data: CreateServiceTemplateRequest): Promise<ServiceTemplate> {
    const res = await apiClient.post<ApiResponse<ServiceTemplate>>('/service-templates', data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateServiceTemplateRequest): Promise<ServiceTemplate> {
    const res = await apiClient.put<ApiResponse<ServiceTemplate>>(`/service-templates/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/service-templates/${id}`);
  },

  async upsertAssignment(
    templateId: number,
    scope: 'group' | 'agent',
    scopeId: number,
    data: UpsertServiceAssignmentRequest,
  ): Promise<void> {
    await apiClient.put(`/service-templates/${templateId}/assign/${scope}/${scopeId}`, data);
  },

  async deleteAssignment(templateId: number, scope: 'group' | 'agent', scopeId: number): Promise<void> {
    await apiClient.delete(`/service-templates/${templateId}/assign/${scope}/${scopeId}`);
  },

  async requestSample(templateId: number, deviceId: number): Promise<void> {
    await apiClient.post(`/service-templates/${templateId}/sample/${deviceId}`);
  },

  /** Returns resolved (inherited) service configs for a specific agent device. */
  async getResolvedForDevice(deviceId: number): Promise<ResolvedServiceConfig[]> {
    const res = await apiClient.get<ApiResponse<ResolvedServiceConfig[]>>(
      `/agent/devices/${deviceId}/templates`,
    );
    return res.data.data ?? [];
  },
};
