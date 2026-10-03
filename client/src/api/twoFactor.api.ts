import apiClient from './client';
import type { ApiResponse } from '@obliview/shared';

export interface TwoFactorStatus {
  totpEnabled: boolean;
  emailOtpEnabled: boolean;
  email: string | null;
}

export interface TotpSetupData {
  secret: string;
  qrDataUrl: string;
}

/**
 * Proof of a second-factor change: a current TOTP code when TOTP is on,
 * otherwise the current password. A first TOTP enrolment needs none.
 */
export interface FactorProof {
  currentCode?: string;
  currentPassword?: string;
}

export const twoFactorApi = {
  async getStatus(): Promise<TwoFactorStatus> {
    const res = await apiClient.get<ApiResponse<TwoFactorStatus>>('/profile/2fa/status');
    return res.data.data!;
  },

  async totpSetup(proof: FactorProof = {}): Promise<TotpSetupData> {
    const res = await apiClient.post<ApiResponse<TotpSetupData>>('/profile/2fa/totp/setup', proof);
    return res.data.data!;
  },

  async totpEnable(code: string): Promise<void> {
    await apiClient.post('/profile/2fa/totp/enable', { code });
  },

  async totpDisable(proof: FactorProof): Promise<void> {
    await apiClient.delete('/profile/2fa/totp', { data: proof });
  },

  /** Codes always go to the profile address (the server refuses any other). */
  async emailSetup(proof: FactorProof): Promise<void> {
    await apiClient.post('/profile/2fa/email/setup', proof);
  },

  async emailEnable(code: string): Promise<void> {
    await apiClient.post('/profile/2fa/email/enable', { code });
  },

  async emailDisable(proof: FactorProof): Promise<void> {
    await apiClient.delete('/profile/2fa/email', { data: proof });
  },

  async verify(code: string, method: 'totp' | 'email'): Promise<{ user: unknown }> {
    const res = await apiClient.post<ApiResponse<{ user: unknown }>>('/profile/2fa/verify', { code, method });
    return res.data.data!;
  },

  async resendEmail(): Promise<void> {
    await apiClient.post('/profile/2fa/resend-email');
  },
};
