import apiClient from './client';
import type { ApiResponse, IpWhitelist, CreateWhitelistRequest, WhitelistScope } from '@obliview/shared';

/** A row of GET /whitelist: the entry plus names instead of ids. */
export interface WhitelistListItem extends IpWhitelist {
  /** Group name / agent display name / tenant name of a scoped entry. */
  scopeName?: string | null;
  /** Owning tenant's name (null for global entries). */
  tenantName?: string | null;
}

export type WhitelistSortBy = 'createdAt' | 'ip' | 'scope';

export interface WhitelistListParams {
  scope?: WhitelistScope;
  /** Address / CIDR (entries containing it, ranges inside it) or label text. */
  search?: string;
  /** Entries containing this address or range. */
  ip?: string;
  /** God view only: entries of these tenants. */
  tenantIds?: number[];
  sortBy?: WhitelistSortBy;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface WhitelistBulkDeleteResult {
  deleted: number;
  forbidden: number;
  notFound: number;
  errors: Array<{ id: number; status: number; error: string }>;
}

export const whitelistApi = {
  /** Every visible entry (capped at 1000, unpaged callers). */
  async list(): Promise<IpWhitelist[]> {
    const res = await apiClient.get<ApiResponse<IpWhitelist[]>>('/whitelist');
    return res.data.data!;
  },

  /** One page of the visible entries (Whitelist tab). */
  async listPage(params: WhitelistListParams = {}): Promise<{ data: WhitelistListItem[]; total: number }> {
    const { tenantIds, ...rest } = params;
    const query: Record<string, unknown> = { ...rest };
    if (tenantIds && tenantIds.length > 0) query.tenants = tenantIds.join(',');
    const res = await apiClient.get<ApiResponse<WhitelistListItem[]> & { total: number }>('/whitelist', { params: query });
    return { data: res.data.data!, total: res.data.total };
  },

  async create(data: CreateWhitelistRequest): Promise<IpWhitelist> {
    const res = await apiClient.post<ApiResponse<IpWhitelist>>('/whitelist', data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/whitelist/${id}`);
  },

  /** Remove several entries; global entries stay locked outside the Default tenant. */
  async bulkDelete(ids: number[]): Promise<WhitelistBulkDeleteResult> {
    const res = await apiClient.post<WhitelistBulkDeleteResult & { success: boolean }>('/whitelist/bulk-delete', { ids });
    const { deleted, forbidden, notFound, errors } = res.data;
    return { deleted, forbidden, notFound, errors: errors ?? [] };
  },
};
