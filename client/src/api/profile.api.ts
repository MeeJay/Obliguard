import apiClient from './client';
import type { User, UserPreferences } from '@obliview/shared';

export const profileApi = {
  async get(): Promise<User> {
    const res = await apiClient.get('/profile');
    return res.data.data;
  },

  async update(data: { displayName?: string | null; email?: string | null; preferredLanguage?: string; preferences?: UserPreferences | null }): Promise<User> {
    const res = await apiClient.put('/profile', data);
    return res.data.data;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await apiClient.put('/profile/password', { currentPassword, newPassword });
  },

  /** Set a local password for SSO-only accounts (no current password required). */
  async setLocalPassword(password: string): Promise<void> {
    await apiClient.post('/sso/set-password', { password });
  },
};
