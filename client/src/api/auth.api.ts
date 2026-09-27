import apiClient from './client';
import type { User, UserPermissions, ApiResponse, LoginRequest } from '@obliview/shared';

export type LoginResult =
  | { user: User; requires2fa?: never }
  | { requires2fa: true; methods: { totp: boolean; email: boolean }; user?: never };

export interface MeResponse {
  user: User;
  permissions: UserPermissions;
  requires2faSetup: boolean;
  /** null = no usable tenant (non-admin without membership). */
  currentTenantId: number | null;
  noTenantAccess?: boolean;
  /** Favourite workspace opened at sign-in, or null. */
  preferredTenantId?: number | null;
}

export const authApi = {
  async login(data: LoginRequest): Promise<LoginResult> {
    const res = await apiClient.post<ApiResponse<LoginResult>>('/auth/login', data);
    return res.data.data!;
  },

  async logout(): Promise<void> {
    await apiClient.post('/auth/logout');
  },

  async me(): Promise<MeResponse> {
    const res = await apiClient.get<ApiResponse<MeResponse>>('/auth/me');
    return res.data.data!;
  },

  async getPermissions(): Promise<UserPermissions> {
    const res = await apiClient.get<ApiResponse<UserPermissions>>('/auth/permissions');
    return res.data.data!;
  },
};
