import apiClient from './client';

export interface RemoteBlocklist {
  id: number;
  name: string;
  sourceType: 'oblitools' | 'url';
  url: string;
  hasApiKey: boolean;
  enabled: boolean;
  syncInterval: number;
  lastSyncAt: string | null;
  lastSyncCount: number;
  /** The list creates global 'remote' bans for its 'banned' entries (migration 037). */
  enforce: boolean;
  tenantId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteBlockedIp {
  id: number;
  blocklistId: number;
  blocklistName: string;
  sourceType: string;
  ip: string;
  reason: string | null;
  firstSeen: string;
  lastSeen: string;
  reports: number;
  sources: string[];
  enabled: boolean;
  /** 'banned' | 'suspicious' as reported by the source. */
  status: string;
  /** Enforce flag of the owning list. */
  listEnforce: boolean;
  /** A ban is wanted: list enforcing, entry enabled and 'banned'. */
  enforced: boolean;
}

export interface RemoteBlocklistStats {
  total: number;
  enabled: number;
  /** Entries that currently carry a ban. */
  enforced: number;
  sources: number;
  lastSync: string | null;
}

/** GET /remote-blocklists/ips filters (limit / offset paging). */
export interface RemoteIpListParams {
  blocklistId?: number;
  /** Substring of the address. */
  search?: string;
  /** true = enforced entries only, false = disabled ones only. */
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export interface RemoteIpPage {
  data: RemoteBlockedIp[];
  total: number;
}

export const remoteBlocklistApi = {
  list: () =>
    apiClient.get<{ data: RemoteBlocklist[] }>('/remote-blocklists').then(r => r.data.data),

  create: (data: { name: string; sourceType: 'oblitools' | 'url'; url: string; apiKey?: string; syncInterval?: number; enforce?: boolean }) =>
    apiClient.post<{ data: RemoteBlocklist }>('/remote-blocklists', data).then(r => r.data.data),

  update: (id: number, data: { name?: string; url?: string; apiKey?: string; enabled?: boolean; syncInterval?: number; enforce?: boolean }) =>
    apiClient.put<{ data: RemoteBlocklist }>(`/remote-blocklists/${id}`, data).then(r => r.data.data),

  delete: (id: number) =>
    apiClient.delete(`/remote-blocklists/${id}`),

  forceSync: (id: number) =>
    apiClient.post(`/remote-blocklists/${id}/sync`),

  listIps: (params?: RemoteIpListParams): Promise<RemoteIpPage> =>
    apiClient.get<RemoteIpPage>('/remote-blocklists/ips', { params })
      .then(r => ({ data: r.data.data, total: Number(r.data.total) || 0 })),

  /** Enable / disable one imported address (platform admin on the Default tenant). */
  toggleIp: (id: number, enabled: boolean) =>
    apiClient.put(`/remote-blocklists/ips/${id}/toggle`, { enabled }),

  stats: () =>
    apiClient.get<{ data: RemoteBlocklistStats }>('/remote-blocklists/stats').then(r => r.data.data),
};
