import apiClient from './client';
import type {
  User,
  UserTeam,
  UserTenantAssignment,
  ApiResponse,
  CreateUserRequest,
  UpdateUserRequest,
  TenantRole,
  TenantCapability,
} from '@obliview/shared';

/** A permission set: a tenant role (its slug is stored as the member's role). */
export interface PermissionSetSummary {
  id: number;
  name: string;
  slug: string;
  capabilities: TenantCapability[];
  isDefault: boolean;
  /** admin / user / viewer: cannot be renamed or deleted. */
  isProtected: boolean;
  /** The admin set (every capability, content fixed). */
  isAdmin: boolean;
}

export interface CreateUserWithTenantRole extends CreateUserRequest {
  tenantRole?: TenantRole;
}

export const usersApi = {
  async list(): Promise<User[]> {
    const res = await apiClient.get<ApiResponse<User[]>>('/users');
    return res.data.data!;
  },

  async getById(id: number): Promise<User> {
    const res = await apiClient.get<ApiResponse<User>>(`/users/${id}`);
    return res.data.data!;
  },

  /**
   * Create a local account. `tenantRole`: the role of the new account in the
   * operating tenant. A manager that is not a platform admin always creates
   * the account there (default 'user', only a role it may grant); a platform
   * admin adds that membership only when it is given.
   */
  async create(data: CreateUserWithTenantRole): Promise<User> {
    const res = await apiClient.post<ApiResponse<User>>('/users', data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateUserRequest): Promise<User> {
    const res = await apiClient.put<ApiResponse<User>>(`/users/${id}`, data);
    return res.data.data!;
  },

  async changePassword(id: number, password: string): Promise<void> {
    await apiClient.put(`/users/${id}/password`, { password });
  },

  /** Admin reset of every second factor (TOTP + e-mail OTP) of another user. */
  async resetTwoFactor(id: number): Promise<void> {
    await apiClient.delete(`/users/${id}/2fa`);
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/users/${id}`);
  },

  async getTeams(id: number): Promise<UserTeam[]> {
    const res = await apiClient.get<ApiResponse<UserTeam[]>>(`/users/${id}/teams`);
    return res.data.data!;
  },

  async getTenants(id: number): Promise<UserTenantAssignment[]> {
    const res = await apiClient.get<ApiResponse<UserTenantAssignment[]>>(`/users/${id}/tenants`);
    return res.data.data!;
  },

  async setTenants(
    id: number,
    assignments: { tenantId: number; role: TenantRole }[],
  ): Promise<void> {
    await apiClient.put(`/users/${id}/tenants`, { assignments });
  },

  /** The permission sets, i.e. the tenant roles a membership can hold. */
  async listPermissionSets(): Promise<PermissionSetSummary[]> {
    const res = await apiClient.get<ApiResponse<PermissionSetSummary[]>>('/permission-sets');
    return res.data.data ?? [];
  },
};
