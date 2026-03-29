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
}

export interface RemoteBlocklistStats {
  total: number;
  enabled: number;
  sources: number;
  lastSync: string | null;
}

export const remoteBlocklistApi = {
  list: () =>
    apiClient.get<{ data: RemoteBlocklist[] }>('/remote-blocklists').then(r => r.data.data),

  create: (data: { name: string; sourceType: 'oblitools' | 'url'; url: string; apiKey?: string; syncInterval?: number }) =>
    apiClient.post<{ data: RemoteBlocklist }>('/remote-blocklists', data).then(r => r.data.data),

  update: (id: number, data: { name?: string; url?: string; apiKey?: string; enabled?: boolean; syncInterval?: number }) =>
    apiClient.put<{ data: RemoteBlocklist }>(`/remote-blocklists/${id}`, data).then(r => r.data.data),

  delete: (id: number) =>
    apiClient.delete(`/remote-blocklists/${id}`),

  forceSync: (id: number) =>
    apiClient.post(`/remote-blocklists/${id}/sync`),

  listIps: (params?: { blocklistId?: number; search?: string; enabled?: boolean; limit?: number; offset?: number }) =>
    apiClient.get<{ data: RemoteBlockedIp[]; total: number }>('/remote-blocklists/ips', { params }).then(r => r.data),

  toggleIp: (id: number, enabled: boolean) =>
    apiClient.put(`/remote-blocklists/ips/${id}/toggle`, { enabled }),

  stats: () =>
    apiClient.get<{ data: RemoteBlocklistStats }>('/remote-blocklists/stats').then(r => r.data.data),
};
