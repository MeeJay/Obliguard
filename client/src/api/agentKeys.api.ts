import apiClient from './client';
import type { AgentKeyCreated as SharedAgentKeyCreated, AgentKeyView, ApiResponse } from '@obliview/shared';

/**
 * Agent enrolment keys (W10-2). The list is masked (prefix + last 4): the full
 * value comes back once from create(), and from reveal() for the Add-Agent
 * install commands (active keys only). All calls need agents.keys and work on
 * the operating tenant.
 */
export type AgentKey = AgentKeyView;

/** create() result: the only response carrying the full key. */
export type AgentKeyCreated = SharedAgentKeyCreated;

export interface AgentKeyPatch {
  name?: string;
  isActive?: boolean;
  /** null clears the default group. */
  defaultGroupId?: number | null;
}

export const agentKeysApi = {
  async list(): Promise<AgentKey[]> {
    const res = await apiClient.get<ApiResponse<AgentKey[]>>('/agent/keys');
    return res.data.data!;
  },

  async create(name: string, defaultGroupId: number | null = null): Promise<AgentKeyCreated> {
    const res = await apiClient.post<ApiResponse<AgentKeyCreated>>('/agent/keys', { name, defaultGroupId });
    return res.data.data!;
  },

  /** Rename, disable / re-enable (closes the key's live sessions), default group. */
  async update(id: number, patch: AgentKeyPatch): Promise<AgentKey & { closedSessions: number }> {
    const res = await apiClient.put<ApiResponse<AgentKey & { closedSessions: number }>>(`/agent/keys/${id}`, patch);
    return res.data.data!;
  },

  /** Full value of an active key (install commands). 404 when disabled. */
  async reveal(id: number): Promise<string> {
    const res = await apiClient.get<ApiResponse<{ id: number; key: string }>>(`/agent/keys/${id}/reveal`);
    return res.data.data!.key;
  },

  async remove(id: number): Promise<{ closedSessions: number }> {
    const res = await apiClient.delete<ApiResponse<{ closedSessions: number }>>(`/agent/keys/${id}`);
    return res.data.data ?? { closedSessions: 0 };
  },
};
