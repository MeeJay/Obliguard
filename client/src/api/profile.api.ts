import apiClient from './client';
import type { User, UserPreferences } from '@obliview/shared';

export const profileApi = {
  async get(): Promise<User> {
    const res = await apiClient.get('/profile');
    return res.data.data;
  },

  /**
   * Partial update: preferences are merged server-side. Changing the e-mail
   * address of a local account needs `currentPassword`.
   */
  async update(data: {
    displayName?: string | null;
    email?: string | null;
    preferredLanguage?: string;
    preferences?: Partial<UserPreferences> | null;
    currentPassword?: string;
  }): Promise<User> {
    const res = await apiClient.put('/profile', data);
    return res.data.data;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await apiClient.put('/profile/password', { currentPassword, newPassword });
  },
};
