import { useEffect, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { FolderInput, KeyRound, PauseCircle, PlayCircle, PowerOff, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NotificationTypeConfig } from '@obliview/shared';
import { agentApi } from '@/api/agent.api';
import { agentKeysApi } from '@/api/agentKeys.api';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { agentUpdateErrorMessage } from '@/utils/agentUpdate';
import { NotificationTypesPanel } from '@/components/agent/NotificationTypesPanel';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { useCan, useIsPlatformAdmin } from '@/hooks/usePermission';
import { cn } from '@/utils/cn';
import { AgentSettingsPanel } from './AgentSettingsPanel';
import { type AgentTabProps } from './parts';
import type { AgentActionAvailability } from './model';
import type { AgentLifecycle } from './useAgentLifecycle';

export interface SettingsTabProps extends AgentTabProps {
  actions: AgentActionAvailability;
  lifecycle: AgentLifecycle;
  /** Opens the move-group dialog owned by the page shell. */
  onMoveGroup: () => void;
}

function DangerRow({
  title, description, button,
}: { title: string; description: string; button: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start max-sm:gap-2">
      <div className="min-w-0">
        <p className="text-sm text-text-primary">{title}</p>
        <p className="text-xs text-text-muted mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{button}</div>
    </div>
  );
}

const dangerBtn = 'flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed coarse:min-h-10';

/**
 * Settings: agent settings (heartbeat, WAN matching, evaluate-only, update
 * policy), the other IPS settings of the cascade (W13-1: automatic bans,
 * Windows firewall backend, with their inherited value and source),
 * notification types, and the Danger Zone (mirrors Obliance
 * DeviceDetailPage): move, suspend / reinstate, uninstall, delete — each
 * shown only when model.agentActions allows it.
 */
export function SettingsTab({ device, onDeviceChange, readOnly, actions, lifecycle, onMoveGroup }: SettingsTabProps) {
  const { t } = useTranslation();
  const canManage = useCan('agents.manage');
  const canKeys = useCan('agents.keys');
  const isPlatformAdmin = useIsPlatformAdmin();
  const settingsReadOnly = readOnly || !canManage;
  const askConfirm = useConfirm();

  // Release the API-key binding (after a re-key): agents.manage, Go agents only
  // (formerly in the AdminAgentPage edit modal).
  const canRelease = !settingsReadOnly && device.deviceType === 'agent' && device.apiKeyId != null;
  const [boundKeyName, setBoundKeyName] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  useEffect(() => {
    setBoundKeyName(null);
    if (!canRelease || !canKeys || device.apiKeyId == null) return;
    let cancelled = false;
    const keyId = device.apiKeyId;
    agentKeysApi.list()
      .then((keys) => { if (!cancelled) setBoundKeyName(keys.find((k) => k.id === keyId)?.name ?? null); })
      .catch(() => { /* the key name is a hint only: the row still works without it */ });
    return () => { cancelled = true; };
  }, [canRelease, canKeys, device.apiKeyId]);

  const releaseBinding = async () => {
    if (!(await askConfirm({
      title: t('agents.releaseKeyBinding'),
      message: t('agents.releaseKeyBindingDesc'),
      confirmLabel: t('agents.releaseKeyBinding'),
      danger: true,
    }))) return;
    setReleasing(true);
    try {
      onDeviceChange(await agentApi.updateDevice(device.id, { apiKeyId: null }));
      toast.success(t('agentDetail.danger.releaseDone', { defaultValue: 'API key binding released' }));
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agentDetail.danger.releaseFailed', { defaultValue: 'Failed to release the API key binding' })));
    } finally {
      setReleasing(false);
    }
  };

  const rows: ReactNode[] = [];
  if (canRelease) {
    rows.push(
      <DangerRow
        key="release"
        title={t('agents.releaseKeyBinding')}
        description={(boundKeyName ? t('agents.boundKey', { name: boundKeyName }) + '. ' : '') + t('agents.releaseKeyBindingDesc')}
        button={
          <button type="button" onClick={() => void releaseBinding()} disabled={releasing || lifecycle.busy !== null}
            className={cn(dangerBtn, 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10')}>
            <KeyRound className="w-3.5 h-3.5" />
            {t('agentDetail.danger.release', { defaultValue: 'Release' })}
          </button>
        }
      />,
    );
  }
  if (actions.moveGroup) {
    rows.push(
      <DangerRow
        key="move"
        title={t('agentDetail.danger.moveTitle', { defaultValue: 'Move to another group' })}
        description={t('agentDetail.danger.moveDesc', { defaultValue: 'The settings, templates, policies and notifications of the target group apply to this agent from then on.' })}
        button={
          <button type="button" onClick={onMoveGroup} disabled={lifecycle.busy !== null}
            className={cn(dangerBtn, 'border-accent/40 text-accent hover:bg-accent/10')}>
            <FolderInput className="w-3.5 h-3.5" />
            {t('agentDetail.lifecycle.move', { defaultValue: 'Move' })}
          </button>
        }
      />,
    );
  }
  if (actions.suspend || actions.reinstate) {
    rows.push(
      <DangerRow
        key="suspend"
        title={actions.suspend
          ? t('agentDetail.danger.suspendTitle', { defaultValue: 'Suspend the agent' })
          : t('agentDetail.danger.reinstateTitle', { defaultValue: 'Reinstate the agent' })}
        description={actions.suspend
          ? t('agentDetail.danger.suspendDesc', { defaultValue: 'Block the agent without deleting it: no configuration is sent and its events are ignored until it is reinstated.' })
          : t('agentDetail.danger.reinstateDesc', { defaultValue: 'The agent is suspended. Reinstate it to resume its configuration and enforcement.' })}
        button={actions.suspend ? (
          <button type="button" onClick={() => void lifecycle.suspend()} disabled={lifecycle.busy !== null}
            className={cn(dangerBtn, 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10')}>
            <PauseCircle className="w-3.5 h-3.5" />
            {t('agentDetail.lifecycle.suspend', { defaultValue: 'Suspend' })}
          </button>
        ) : (
          <button type="button" onClick={() => void lifecycle.reinstate()} disabled={lifecycle.busy !== null}
            className={cn(dangerBtn, 'border-green-500/40 text-green-400 hover:bg-green-500/10')}>
            <PlayCircle className="w-3.5 h-3.5" />
            {t('agentDetail.lifecycle.reinstate', { defaultValue: 'Reinstate' })}
          </button>
        )}
      />,
    );
  }
  if (actions.uninstall) {
    rows.push(
      <DangerRow
        key="uninstall"
        title={t('agentDetail.danger.uninstallTitle', { defaultValue: 'Uninstall the agent' })}
        description={t('agentDetail.danger.uninstallDesc', { defaultValue: 'Remove the agent service and its firewall rules from the host. The entry is deleted a few minutes after the agent confirms.' })}
        button={
          <button type="button" onClick={() => void lifecycle.uninstall()} disabled={lifecycle.busy !== null}
            className={cn(dangerBtn, 'border-red-500/40 text-red-400 hover:bg-red-500/10')}>
            <PowerOff className="w-3.5 h-3.5" />
            {t('agentDetail.lifecycle.uninstall', { defaultValue: 'Uninstall' })}
          </button>
        }
      />,
    );
  }
  if (actions.delete) {
    rows.push(
      <DangerRow
        key="delete"
        title={t('agentDetail.danger.deleteTitle', { defaultValue: 'Delete the agent' })}
        description={t('agentDetail.danger.deleteDesc', { defaultValue: 'Remove this agent and its settings from Obliguard. The software stays on the host: uninstall it first to remove it.' })}
        button={
          <button type="button" onClick={() => void lifecycle.remove()} disabled={lifecycle.busy !== null}
            className={cn(dangerBtn, 'border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20')}>
            <Trash2 className="w-3.5 h-3.5" />
            {t('common.delete', { defaultValue: 'Delete' })}
          </button>
        }
      />,
    );
  }

  return (
    <div className="space-y-6">
      <AgentSettingsPanel
        device={device}
        onUpdate={onDeviceChange}
        readOnly={settingsReadOnly}
        canEditUpdatePolicy={isPlatformAdmin && !readOnly && device.deviceType === 'agent'}
      />

      {/* IPS settings cascade, agent level. The keys edited by the panels
          above / below (their writes land in the same cascade) are hidden. */}
      <SettingsPanel
        level="agent"
        scopeId={device.id}
        title={t('settings.ipsTitle', { defaultValue: 'IPS settings' })}
        description={t('settings.ipsAgentDesc', { defaultValue: 'Inherited from the global, workspace and group settings unless set here.' })}
        hide={[
          'checkIntervalSeconds', 'maxMissedPushes', 'evaluateOnly', 'notificationTypes', 'updatePolicy',
          // The firewall backend only means something to a Windows Go agent.
          ...(device.deviceType === 'agent' && device.osInfo?.platform === 'windows' ? [] : ['windowsFirewallBackend' as const]),
        ]}
        readOnly={settingsReadOnly}
      />

      {/* Notification types — per-agent overrides */}
      <NotificationTypesPanel
        config={device.notificationTypes ?? null}
        scope="device"
        readOnly={settingsReadOnly}
        onSave={async (notifTypes: NotificationTypeConfig | null) => {
          onDeviceChange(await agentApi.updateDevice(device.id, { notificationTypes: notifTypes }));
        }}
      />

      {/* ── Danger Zone ── */}
      {rows.length > 0 && (
        <section className="p-5 bg-bg-secondary border border-red-500/30 rounded-xl space-y-4" aria-labelledby="agent-danger-zone">
          <h3 id="agent-danger-zone" className="text-sm font-semibold text-red-400 uppercase tracking-wide">
            {t('agentDetail.danger.title', { defaultValue: 'Danger Zone' })}
          </h3>
          {rows.map((row, i) => (
            <div key={i} className="space-y-4">
              {i > 0 && <div className="h-px bg-border" />}
              {row}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
