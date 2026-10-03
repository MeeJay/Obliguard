import apiClient from './client';
import type { ApiResponse, BanScope, IpBan, CreateBanRequest } from '@obliview/shared';

/** Lifecycle state of a ban row (server: BAN_STATE_SQL). */
export type BanState = 'active' | 'expired' | 'lifted';

export type BanSortBy = 'createdAt' | 'expiresAt' | 'ip';

/** What a Lift from the current tenant does to a row (server: planLift). */
export type BanLiftAction = 'deactivate' | 'exclude';

/** A row of GET /bans: the ban plus names instead of ids. */
export interface BanListItem extends IpBan {
  /** The current tenant opted out of this global ban (local Lift). */
  isExcludedByTenant: boolean;
  state: BanState;
  liftedAt: string | null;
  /** Author's username, when the current tenant may see it. */
  createdByUsername: string | null;
  /** Group name / agent display name / tenant name of a scoped ban. */
  scopeName: string | null;
  /** Owning tenant's name (scoped bans). */
  tenantName: string | null;
  /** The Lift the current tenant would perform; null when it cannot lift the row. */
  liftAction: BanLiftAction | null;
}

export interface BanListParams {
  state?: BanState | 'all';
  /** Legacy filter (true = active, false = every state); ignored when `state` is set. */
  active?: boolean;
  scope?: BanScope;
  /** auto | manual | external */
  type?: string;
  search?: string;
  /** God view only: rows of these tenants. */
  tenantIds?: number[];
  sortBy?: BanSortBy;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface BulkLiftResult {
  lifted: number;
  excluded: number;
  skipped: number;
  refused: number;
  /** Per-row refusals; `code` / `params` translate through localizeApiError() (api/client.ts). */
  errors: Array<{ id: number; status: number; error: string; code?: string; params?: Record<string, string | number | boolean> }>;
}

/** The server's error text of a failed request, else `fallback`. */
export function apiError(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: unknown; message?: unknown } } })?.response?.data;
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (typeof data?.message === 'string' && data.message) return data.message;
  return fallback;
}

export const bansApi = {
  async list(params: BanListParams = {}): Promise<{ data: BanListItem[]; total: number }> {
    const { tenantIds, ...rest } = params;
    const query: Record<string, unknown> = { ...rest };
    if (tenantIds && tenantIds.length > 0) query.tenants = tenantIds.join(',');
    const res = await apiClient.get<ApiResponse<BanListItem[]> & { total: number }>('/bans', { params: query });
    return { data: res.data.data!, total: res.data.total };
  },

  async create(data: CreateBanRequest): Promise<IpBan> {
    const res = await apiClient.post<ApiResponse<IpBan>>('/bans', data);
    return res.data.data!;
  },

  /** Lift: global from Default, local (exclusion of a global ban) elsewhere. */
  async lift(id: number): Promise<void> {
    await apiClient.delete(`/bans/${id}`);
  },

  /** Lift several bans, row by row with the same rule as lift(). */
  async bulkLift(ids: number[]): Promise<BulkLiftResult> {
    const res = await apiClient.post<BulkLiftResult & { success: boolean }>('/bans/bulk-lift', { ids });
    const { lifted, excluded, skipped, refused, errors } = res.data;
    return { lifted, excluded, skipped, refused, errors: errors ?? [] };
  },

  /** Re-enable a global ban on the current tenant (drops its exclusion). */
  async removeExclusion(id: number): Promise<void> {
    await apiClient.delete(`/bans/${id}/exclude`);
  },

  async promoteToGlobal(id: number): Promise<IpBan> {
    const res = await apiClient.post<ApiResponse<IpBan>>(`/bans/${id}/promote-global`);
    return res.data.data!;
  },
};
