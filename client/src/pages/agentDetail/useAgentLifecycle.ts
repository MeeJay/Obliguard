import { useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { AgentDevice } from '@obliview/shared';
import { agentApi } from '@/api/agent.api';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { agentUpdateErrorMessage } from '@/utils/agentUpdate';

/** One lifecycle action in flight (buttons of that action show a busy state). */
export type AgentLifecycleBusy =
  | 'approve' | 'refuse' | 'suspend' | 'reinstate' | 'requeue' | 'moveGroup'
  | 'requestUpdate' | 'cancelUpdate' | 'uninstall' | 'delete';

export interface AgentLifecycle {
  busy: AgentLifecycleBusy | null;
  /** groupId undefined: approve without choosing a group (no agents.manage; the server keeps / derives it). */
  approve: (groupId: number | null | undefined) => Promise<boolean>;
  refuse: () => Promise<void>;
  suspend: () => Promise<void>;
  reinstate: () => Promise<void>;
  requeue: () => Promise<void>;
  moveGroup: (groupId: number | null) => Promise<boolean>;
  requestUpdate: () => Promise<void>;
  cancelUpdate: () => Promise<void>;
  uninstall: () => Promise<void>;
  remove: () => Promise<void>;
}

function apiErrorText(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

/**
 * Lifecycle actions of the agent detail page (header ActionMenu, inline
 * Approve / Refuse, Danger Zone). Every destructive action goes through
 * useConfirm (never window.confirm: it does nothing in the Android WebView);
 * uninstall and delete require typing the hostname. Availability (capability,
 * tenant, team grant) is decided by model.agentActions: these only run.
 */
export function useAgentLifecycle(
  device: AgentDevice | null,
  onDevice: (device: AgentDevice) => void,
  onDeleted: () => void,
): AgentLifecycle {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const [busy, setBusy] = useState<AgentLifecycleBusy | null>(null);
  const name = device ? (device.name ?? device.hostname) : '';

  const run = useCallback(async <T,>(key: AgentLifecycleBusy, fn: () => Promise<T>, failure: string): Promise<T | null> => {
    setBusy(key);
    try {
      return await fn();
    } catch (err) {
      toast.error(apiErrorText(err, failure));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const patchStatus = useCallback(async (key: AgentLifecycleBusy, data: Parameters<typeof agentApi.updateDevice>[1], ok: string, failure: string) => {
    if (!device) return false;
    const updated = await run(key, () => agentApi.updateDevice(device.id, data), failure);
    if (!updated) return false;
    onDevice(updated);
    toast.success(ok);
    return true;
  }, [device, onDevice, run]);

  // A group in the body also needs agents.manage server-side (deviceEditCapabilities):
  // without it the approval is sent alone and the server keeps the agent's group
  // (or derives the enrollment key's default group).
  const approve = useCallback((groupId: number | null | undefined) => patchStatus(
    'approve',
    groupId === undefined ? { status: 'approved' } : { status: 'approved', groupId },
    t('agentDetail.lifecycle.approved', { defaultValue: '{{name}} approved', name }),
    t('agentDetail.lifecycle.approveFailed', { defaultValue: 'Failed to approve the agent' }),
  ), [patchStatus, t, name]);

  const refuse = useCallback(async () => {
    const ok = await askConfirm({
      title: t('agentDetail.lifecycle.refuseTitle', { defaultValue: 'Refuse this agent?' }),
      message: t('agentDetail.lifecycle.refuseConfirm', {
        defaultValue: '{{name}} will be refused: it enters backoff mode and receives no configuration. You can put it back to pending later.',
        name,
      }),
      confirmLabel: t('agentDetail.lifecycle.refuse', { defaultValue: 'Refuse' }),
      danger: true,
    });
    if (!ok) return;
    await patchStatus(
      'refuse', { status: 'refused' },
      t('agentDetail.lifecycle.refused', { defaultValue: '{{name}} refused', name }),
      t('agentDetail.lifecycle.refuseFailed', { defaultValue: 'Failed to refuse the agent' }),
    );
  }, [askConfirm, patchStatus, t, name]);

  const suspend = useCallback(async () => {
    const ok = await askConfirm({
      title: t('agentDetail.lifecycle.suspendTitle', { defaultValue: 'Suspend this agent?' }),
      message: t('agentDetail.lifecycle.suspendConfirm', {
        defaultValue: '{{name}} stops receiving configuration and its events are ignored until it is reinstated. Nothing is deleted.',
        name,
      }),
      confirmLabel: t('agentDetail.lifecycle.suspend', { defaultValue: 'Suspend' }),
      danger: true,
    });
    if (!ok) return;
    await patchStatus(
      'suspend', { status: 'suspended' },
      t('agentDetail.lifecycle.suspended', { defaultValue: '{{name}} suspended', name }),
      t('agentDetail.lifecycle.suspendFailed', { defaultValue: 'Failed to suspend the agent' }),
    );
  }, [askConfirm, patchStatus, t, name]);

  const reinstate = useCallback(async () => {
    await patchStatus(
      'reinstate', { status: 'approved' },
      t('agentDetail.lifecycle.reinstated', { defaultValue: '{{name}} reinstated', name }),
      t('agentDetail.lifecycle.reinstateFailed', { defaultValue: 'Failed to reinstate the agent' }),
    );
  }, [patchStatus, t, name]);

  const requeue = useCallback(async () => {
    await patchStatus(
      'requeue', { status: 'pending' },
      t('agentDetail.lifecycle.requeued', { defaultValue: '{{name}} is pending approval again', name }),
      t('agentDetail.lifecycle.requeueFailed', { defaultValue: 'Failed to put the agent back to pending' }),
    );
  }, [patchStatus, t, name]);

  const moveGroup = useCallback((groupId: number | null) => patchStatus(
    'moveGroup', { groupId },
    t('agentDetail.lifecycle.moved', { defaultValue: '{{name}} moved', name }),
    t('agentDetail.lifecycle.moveFailed', { defaultValue: 'Failed to move the agent' }),
  ), [patchStatus, t, name]);

  const requestUpdate = useCallback(async () => {
    if (!device) return;
    const ok = await askConfirm({
      title: t('agentDetail.lifecycle.updateTitle', { defaultValue: 'Update the agent?' }),
      message: t('agentUpdate.confirmUpdate', {
        defaultValue: 'Update {{name}} to v{{version}}?',
        name,
        version: device.latestAgentVersion,
      }),
      confirmLabel: t('agentUpdate.updateNow', 'Update now'),
    });
    if (!ok) return;
    setBusy('requestUpdate');
    try {
      onDevice(await agentApi.requestUpdate(device.id));
      toast.success(t('agentUpdate.requestedToast', 'Update requested: the agent updates at its next heartbeat'));
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentUpdate.requestFailed', { defaultValue: 'Failed to request the update' })));
    } finally {
      setBusy(null);
    }
  }, [askConfirm, device, onDevice, t, name]);

  const cancelUpdate = useCallback(async () => {
    if (!device) return;
    setBusy('cancelUpdate');
    try {
      onDevice(await agentApi.cancelUpdate(device.id));
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentUpdate.cancelFailed', { defaultValue: 'Failed to cancel the update' })));
    } finally {
      setBusy(null);
    }
  }, [device, onDevice, t]);

  const uninstall = useCallback(async () => {
    if (!device) return;
    const ok = await askConfirm({
      title: t('agentDetail.lifecycle.uninstallTitle', { defaultValue: 'Uninstall the agent?' }),
      message: t('agentDetail.lifecycle.uninstallConfirm', {
        defaultValue: 'The agent on {{name}} removes its service and its firewall rules when it receives the command (immediately when connected, otherwise at its next contact). The agent entry is deleted a few minutes later.',
        name,
      }),
      confirmLabel: t('agentDetail.lifecycle.uninstall', { defaultValue: 'Uninstall' }),
      danger: true,
      requireText: device.hostname,
    });
    if (!ok) return;
    const sent = await run('uninstall', async () => {
      await agentApi.sendCommand(device.id, 'uninstall');
      return true;
    }, t('agentDetail.lifecycle.uninstallFailed', { defaultValue: 'Failed to queue the uninstall command' }));
    if (!sent) return;
    // The badge shows "Pending uninstall" until the row disappears.
    onDevice({ ...device, pendingCommand: 'uninstall' });
    toast.success(t('agentDetail.lifecycle.uninstallQueued', { defaultValue: 'Uninstall command queued for {{name}}', name }));
  }, [askConfirm, device, onDevice, run, t, name]);

  const remove = useCallback(async () => {
    if (!device) return;
    const ok = await askConfirm({
      title: t('agentDetail.lifecycle.deleteTitle', { defaultValue: 'Delete the agent?' }),
      message: t('agentDetail.lifecycle.deleteConfirm', {
        defaultValue: 'Delete {{name}} and its settings from Obliguard. The agent software stays installed on the host: use Uninstall to remove it.',
        name,
      }),
      danger: true,
      requireText: device.hostname,
    });
    if (!ok) return;
    const done = await run('delete', async () => {
      await agentApi.deleteDevice(device.id);
      return true;
    }, t('agentDetail.lifecycle.deleteFailed', { defaultValue: 'Failed to delete the agent' }));
    if (!done) return;
    toast.success(t('agentDetail.lifecycle.deleted', { defaultValue: '{{name}} deleted', name }));
    onDeleted();
  }, [askConfirm, device, onDeleted, run, t, name]);

  return useMemo(() => ({
    busy, approve, refuse, suspend, reinstate, requeue, moveGroup, requestUpdate, cancelUpdate, uninstall, remove,
  }), [busy, approve, refuse, suspend, reinstate, requeue, moveGroup, requestUpdate, cancelUpdate, uninstall, remove]);
}
