import apiClient from './client';

export interface IpDisplayName {
  ip: string;
  label: string;
  tenantId: number | null;
}

export const ipLabelsApi = {
  async list(): Promise<IpDisplayName[]> {
    const res = await apiClient.get<{ success: boolean; data: IpDisplayName[] }>('/ip-labels');
    return res.data.data ?? [];
  },

  async upsert(ip: string, label: string): Promise<void> {
    await apiClient.post('/ip-labels', { ip, label });
  },

  async remove(ip: string): Promise<void> {
    await apiClient.delete(`/ip-labels/${encodeURIComponent(ip)}`);
  },
};
