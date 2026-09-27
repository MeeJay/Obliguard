import type { TFunction } from 'i18next';

type ApiErr = { response?: { data?: { error?: string; code?: string } } };

/** Human message for a failed agent-update / update-policy call (C17-1). */
export function agentUpdateErrorMessage(err: unknown, t: TFunction, fallback: string): string {
  const data = (err as ApiErr)?.response?.data;
  switch (data?.code) {
    case 'updatePolicyOff': return t('agentUpdate.errors.off', 'Updates are disabled for this agent (policy: off)');
    case 'alreadyCurrent': return t('agentUpdate.errors.current', 'This agent is already up to date');
    case 'notUpdatable': return t('agentUpdate.errors.notUpdatable', 'Only approved agents that reported a version can be updated');
    case 'versionUnavailable': return t('agentUpdate.errors.unavailable', 'No agent version is available on this server');
    default: return data?.error ?? fallback;
  }
}
