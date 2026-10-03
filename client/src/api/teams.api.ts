import apiClient from './client';
import type {
  UserTeam,
  TeamPermission,
  ApiResponse,
  CreateTeamRequest,
  UpdateTeamRequest,
  SetTeamMembersRequest,
  PermissionLevel,
  PermissionScope,
} from '@obliview/shared';

/**
 * Team permission scope: 'group' (a group and its subtree), 'agent' (one
 * agent) or 'ungrouped' (every agent of the team's tenant without a group;
 * scopeId 0 by convention).
 */
export type TeamPermissionScope = PermissionScope | 'ungrouped';

/** A team grant as the server stores it (the scope may be 'ungrouped'). */
export type TeamGrant = Omit<TeamPermission, 'scope'> & { scope: TeamPermissionScope };

export interface TeamDetail extends UserTeam {
  memberIds: number[];
  permissions: TeamGrant[];
}

export interface SetTeamGrantsRequest {
  permissions: Array<{ scope: TeamPermissionScope; scopeId: number; level: PermissionLevel }>;
}

export const teamsApi = {
  async list(): Promise<UserTeam[]> {
    const res = await apiClient.get<ApiResponse<UserTeam[]>>('/teams');
    return res.data.data!;
  },

  /** Platform admin: fetch all teams across all tenants (includes tenantName on each team) */
  async listAll(): Promise<UserTeam[]> {
    const res = await apiClient.get<ApiResponse<UserTeam[]>>('/teams?scope=all');
    return res.data.data!;
  },

  async getById(id: number): Promise<TeamDetail> {
    const res = await apiClient.get<ApiResponse<TeamDetail>>(`/teams/${id}`);
    return res.data.data!;
  },

  async create(data: CreateTeamRequest): Promise<UserTeam> {
    const res = await apiClient.post<ApiResponse<UserTeam>>('/teams', data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateTeamRequest): Promise<UserTeam> {
    const res = await apiClient.put<ApiResponse<UserTeam>>(`/teams/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/teams/${id}`);
  },

  async getMembers(id: number): Promise<number[]> {
    const res = await apiClient.get<ApiResponse<number[]>>(`/teams/${id}/members`);
    return res.data.data!;
  },

  /** Members added must belong to the team's tenant (400 otherwise). */
  async setMembers(id: number, data: SetTeamMembersRequest): Promise<void> {
    await apiClient.put(`/teams/${id}/members`, data);
  },

  async getPermissions(id: number): Promise<TeamGrant[]> {
    const res = await apiClient.get<ApiResponse<TeamGrant[]>>(`/teams/${id}/permissions`);
    return res.data.data!;
  },

  /** Replace every grant; each group / agent must belong to the team's tenant (400 otherwise). */
  async setPermissions(id: number, data: SetTeamGrantsRequest): Promise<TeamGrant[]> {
    const res = await apiClient.put<ApiResponse<TeamGrant[]>>(`/teams/${id}/permissions`, data);
    return res.data.data!;
  },

  async removePermission(teamId: number, permId: number): Promise<void> {
    await apiClient.delete(`/teams/${teamId}/permissions/${permId}`);
  },
};
