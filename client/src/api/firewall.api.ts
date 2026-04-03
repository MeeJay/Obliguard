import apiClient from './client';
import type { FirewallRule, FirewallAddRequest, FirewallCommandResponse } from '@obliview/shared';

export const firewallApi = {
  getRules: (deviceId: number) =>
    apiClient.get<{ data: { success: boolean; rules?: FirewallRule[]; platform?: string; error?: string } }>(
      `/agent/devices/${deviceId}/firewall/rules`,
    ).then(r => r.data.data),

  addRule: (deviceId: number, rule: FirewallAddRequest) =>
    apiClient.post<{ data: FirewallCommandResponse }>(
      `/agent/devices/${deviceId}/firewall/rules`, rule,
    ).then(r => r.data.data),

  deleteRule: (deviceId: number, ruleId: string) =>
    apiClient.delete<{ data: FirewallCommandResponse }>(
      `/agent/devices/${deviceId}/firewall/rules/${encodeURIComponent(ruleId)}`,
    ).then(r => r.data.data),

  toggleRule: (deviceId: number, ruleId: string, enabled: boolean) =>
    apiClient.patch<{ data: FirewallCommandResponse }>(
      `/agent/devices/${deviceId}/firewall/rules/${encodeURIComponent(ruleId)}`, { enabled },
    ).then(r => r.data.data),
};
