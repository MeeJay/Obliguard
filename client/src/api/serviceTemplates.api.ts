import apiClient from './client';
import type {
  ApiResponse,
  ServiceTemplate,
  ServiceTemplateAssignment,
  ResolvedServiceConfig,
  CreateServiceTemplateRequest,
  UpdateServiceTemplateRequest,
  UpsertServiceAssignmentRequest,
} from '@obliview/shared';

/** Target of an assignment or owner of a local template. */
export type ServiceTemplateScope = 'group' | 'agent';

/**
 * Where a template comes from (display only):
 *   - 'builtin'  = platform built-in parser (tenant_id NULL, is_builtin)
 *   - 'platform' = custom template shared by every tenant (tenant_id NULL)
 *   - 'tenant'   = custom template of one tenant
 *   - 'local'    = template owned by one group or agent (owner_scope set)
 */
export type ServiceTemplateOrigin = 'builtin' | 'platform' | 'tenant' | 'local';

export function templateOrigin(t: Pick<ServiceTemplate, 'isBuiltin' | 'tenantId' | 'ownerScope'>): ServiceTemplateOrigin {
  if (t.ownerScope != null) return 'local';
  if (t.isBuiltin) return 'builtin';
  return t.tenantId == null ? 'platform' : 'tenant';
}

/** The server's error text of a failed request, else `fallback`. */
export function templateApiError(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: unknown; message?: unknown } } })?.response?.data;
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (typeof data?.message === 'string' && data.message) return data.message;
  return fallback;
}

export const serviceTemplatesApi = {
  /** Platform + tenant templates visible to the operating tenant (local templates excluded). */
  async list(): Promise<ServiceTemplate[]> {
    const res = await apiClient.get<ApiResponse<ServiceTemplate[]>>('/service-templates');
    return res.data.data!;
  },

  /** One template with its assignments (only those on the operating tenant's targets; Default sees all). */
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
    await apiClient.delete<ApiResponse<never>>(`/service-templates/${id}`);
  },

  /** Creates or updates the assignment; fields left undefined keep their stored value. */
  async upsertAssignment(
    templateId: number,
    scope: ServiceTemplateScope,
    scopeId: number,
    data: UpsertServiceAssignmentRequest,
  ): Promise<ServiceTemplateAssignment> {
    const res = await apiClient.put<ApiResponse<ServiceTemplateAssignment>>(
      `/service-templates/${templateId}/assign/${scope}/${scopeId}`,
      data,
    );
    return res.data.data!;
  },

  async deleteAssignment(templateId: number, scope: ServiceTemplateScope, scopeId: number): Promise<void> {
    await apiClient.delete<ApiResponse<never>>(`/service-templates/${templateId}/assign/${scope}/${scopeId}`);
  },

  async requestSample(templateId: number, deviceId: number): Promise<void> {
    await apiClient.post<ApiResponse<never>>(`/service-templates/${templateId}/sample/${deviceId}`);
  },

  /** Returns resolved (inherited) service configs for a specific agent device. */
  async getResolvedForDevice(deviceId: number): Promise<ResolvedServiceConfig[]> {
    const res = await apiClient.get<ApiResponse<ResolvedServiceConfig[]>>(
      `/agent/devices/${deviceId}/templates`,
    );
    return res.data.data ?? [];
  },

  /** Returns all global templates with their effective status for a specific group. */
  async getResolvedForGroup(groupId: number): Promise<ResolvedServiceConfig[]> {
    const res = await apiClient.get<ApiResponse<ResolvedServiceConfig[]>>(
      `/service-templates/resolved/group/${groupId}`,
    );
    return res.data.data ?? [];
  },

  /** Returns local templates owned by a specific agent or group. */
  async listLocal(scope: ServiceTemplateScope, scopeId: number): Promise<ServiceTemplate[]> {
    const res = await apiClient.get<ApiResponse<ServiceTemplate[]>>(
      `/service-templates/local/${scope}/${scopeId}`,
    );
    return res.data.data ?? [];
  },
};
