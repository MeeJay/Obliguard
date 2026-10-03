import { useCallback, useEffect, useState } from 'react';
import { BrickWall, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { AgentCommand, AgentCommandStatus, AgentCommandType, ApiResponse } from '@obliview/shared';
import { AGENT_COMMAND_CAPABILITY, SOCKET_EVENTS } from '@obliview/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import { useCan } from '@/hooks/usePermission';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { cn } from '@/utils/cn';
import { isStepUpCancelled } from '@/utils/withTwoFactor';
import { SectionTitle, formatTs, relativeTime, useWindowEvent } from './parts';
import type { SettingsTabProps } from './SettingsTab';

/** Tab id of the Commands tab (registered by AgentDetailPage, W14-1). */
export const COMMANDS_TAB_ID = 'commands';

/** Rows asked per load (server cap: 200). */
const LIMIT = 100;

// ── API (server: POST/GET /agent/devices/:id/commands) ───────────────────────

async function fetchCommands(deviceId: number): Promise<AgentCommand[]> {
  const res = await apiClient.get<ApiResponse<AgentCommand[]>>(`/agent/devices/${deviceId}/commands`, { params: { limit: LIMIT } });
  return res.data.data ?? [];
}

async function queueCommand(deviceId: number, type: AgentCommandType): Promise<AgentCommand> {
  const res = await apiClient.post<ApiResponse<AgentCommand>>(`/agent/devices/${deviceId}/commands`, { type });
  return res.data.data!;
}

function errorText(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

// ── Labels ────────────────────────────────────────────────────────────────────

function commandLabel(type: AgentCommandType, t: TFunction): string {
  switch (type) {
    case 'restart': return t('commands.type.restart', { defaultValue: 'Restart agent' });
    case 'firewall_resync': return t('commands.type.firewall_resync', { defaultValue: 'Firewall resync' });
    case 'uninstall': return t('commands.type.uninstall', { defaultValue: 'Uninstall' });
    default: return type;
  }
}

const STATUS_STYLE: Record<AgentCommandStatus, string> = {
  queued: 'bg-bg-tertiary text-text-secondary',
  sent: 'bg-accent/15 text-accent',
  acked: 'bg-accent/15 text-accent',
  succeeded: 'bg-status-up/15 text-status-up',
  failed: 'bg-status-down/15 text-status-down',
  expired: 'bg-bg-tertiary text-text-muted',
};

function statusLabel(c: AgentCommand, t: TFunction): string {
  if (c.legacy) return t('commands.status.legacy', { defaultValue: 'Delivered (no acknowledgement)' });
  switch (c.status) {
    case 'queued': return t('commands.status.queued', { defaultValue: 'Queued' });
    case 'sent': return t('commands.status.sent', { defaultValue: 'Sent' });
    case 'acked': return t('commands.status.acked', { defaultValue: 'Running' });
    case 'succeeded': return t('commands.status.succeeded', { defaultValue: 'Succeeded' });
    case 'failed': return t('commands.status.failed', { defaultValue: 'Failed' });
    case 'expired': return t('commands.status.expired', { defaultValue: 'Expired' });
    default: return c.status;
  }
}

/** One line from the agent's result (error, message or resync counters). */
function resultText(c: AgentCommand, t: TFunction): string {
  const r = c.result;
  if (!r) return '';
  const counters = typeof r.desired === 'number'
    ? t('commands.result.resync', {
      defaultValue: '{{desired}} bans enforced, +{{added}} / -{{removed}}',
      desired: r.desired, added: Number(r.added ?? 0), removed: Number(r.removed ?? 0),
    })
    : '';
  const text = typeof r.error === 'string' ? r.error : typeof r.message === 'string' ? r.message : '';
  return [counters, text].filter(Boolean).join(' — ');
}

// ── Tab ───────────────────────────────────────────────────────────────────────

/**
 * Commands tab (W14-1): the agent's command queue with acknowledgement,
 * result and history, plus the actions (restart, firewall resync,
 * uninstall). Restart and resync need agents.manage and an agent build that
 * advertises the command queue; uninstall goes through the lifecycle flow
 * (agents.delete, hostname confirmation, step-up).
 */
export function CommandsTab({ device, readOnly, refreshKey, actions, lifecycle }: SettingsTabProps) {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const canManage = useCan('agents.manage');
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<AgentCommandType | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCommands(await fetchCommands(device.id));
    } catch (err) {
      toast.error(errorText(err, t('commands.loadFailed', { defaultValue: 'Failed to load the command history' })));
    } finally {
      setLoading(false);
    }
  }, [device.id, t]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useWindowEvent(SOCKET_RESYNC_EVENT, () => { void load(); });

  // Live status of this agent's commands (owning tenant + Default).
  const socketGeneration = useSocketStore(s => s.generation);
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onCommand = (data: { deviceId?: number; command?: AgentCommand }) => {
      const cmd = data?.command;
      if (data?.deviceId !== device.id || !cmd) return;
      setCommands(prev => {
        const i = prev.findIndex(c => c.id === cmd.id);
        if (i === -1) return [cmd, ...prev].slice(0, LIMIT);
        const next = prev.slice();
        next[i] = cmd;
        return next;
      });
    };
    socket.on(SOCKET_EVENTS.AGENT_COMMAND_UPDATED, onCommand);
    return () => { socket.off(SOCKET_EVENTS.AGENT_COMMAND_UPDATED, onCommand); };
  }, [device.id, socketGeneration]);

  const isAgent = device.deviceType === 'agent';
  const supportsQueue = (device.capabilities ?? []).includes(AGENT_COMMAND_CAPABILITY);
  const pending = (type: AgentCommandType) =>
    commands.some(c => c.type === type && !c.finishedAt && (c.status === 'queued' || c.status === 'sent' || c.status === 'acked'));
  const canQueue = !readOnly && canManage && isAgent && device.status === 'approved' && supportsQueue;

  const run = async (type: Exclude<AgentCommandType, 'uninstall'>) => {
    const name = device.name || device.hostname;
    const ok = await askConfirm(type === 'restart'
      ? {
        title: t('commands.restartTitle', { defaultValue: 'Restart the agent?' }),
        message: t('commands.restartConfirm', {
          defaultValue: 'The agent service on {{name}} restarts (immediately when connected, otherwise at its next contact). Bans stay enforced by the firewall meanwhile.',
          name,
        }),
        confirmLabel: t('commands.restart', { defaultValue: 'Restart' }),
      }
      : {
        title: t('commands.resyncTitle', { defaultValue: 'Resync the firewall?' }),
        message: t('commands.resyncConfirm', {
          defaultValue: 'The agent on {{name}} re-applies the full ban list: missing bans are added and bans no longer active are lifted.',
          name,
        }),
        confirmLabel: t('commands.resync', { defaultValue: 'Resync' }),
      });
    if (!ok) return;
    setBusy(type);
    try {
      const cmd = await queueCommand(device.id, type);
      setCommands(prev => [cmd, ...prev.filter(c => c.id !== cmd.id)].slice(0, LIMIT));
      toast.success(t('commands.queued', { defaultValue: '{{command}} queued', command: commandLabel(type, t) }));
    } catch (err) {
      if (!isStepUpCancelled(err)) {
        toast.error(errorText(err, t('commands.queueFailed', { defaultValue: 'Failed to queue the command' })));
      }
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async () => {
    await lifecycle.uninstall();
    void load();
  };

  return (
    <div className="space-y-4">
      {!readOnly && isAgent && (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <SectionTitle>{t('commands.actionsTitle', { defaultValue: 'Actions' })}</SectionTitle>
          <div className="p-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!canQueue || pending('restart')}
                loading={busy === 'restart'}
                onClick={() => void run('restart')}
              >
                <RotateCw size={14} className="mr-1.5" />
                {t('commands.restart', { defaultValue: 'Restart' })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!canQueue || pending('firewall_resync')}
                loading={busy === 'firewall_resync'}
                onClick={() => void run('firewall_resync')}
              >
                <BrickWall size={14} className="mr-1.5" />
                {t('commands.resync', { defaultValue: 'Resync' })}
              </Button>
              {actions.uninstall && (
                <Button
                  variant="danger"
                  size="sm"
                  loading={lifecycle.busy === 'uninstall'}
                  onClick={() => void uninstall()}
                >
                  <Trash2 size={14} className="mr-1.5" />
                  {t('commands.uninstall', { defaultValue: 'Uninstall' })}
                </Button>
              )}
            </div>
            {canManage && device.status === 'approved' && !supportsQueue && (
              <p className="text-xs text-text-muted">
                {t('commands.unsupported', {
                  defaultValue: 'This agent version only supports the uninstall command. Update the agent to restart it or resync its firewall remotely.',
                })}
              </p>
            )}
            {canManage && device.status !== 'approved' && (
              <p className="text-xs text-text-muted">
                {t('commands.notApproved', { defaultValue: 'Commands are delivered to approved agents only.' })}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-bg-secondary flex flex-col">
        <SectionTitle
          extra={
            <IconButton
              size="sm"
              label={t('common.refresh', { defaultValue: 'Refresh' })}
              icon={<RefreshCw size={12} className={loading ? 'animate-spin' : ''} />}
              onClick={() => void load()}
            />
          }
        >
          {t('commands.historyTitle', { defaultValue: 'Command history' })}
        </SectionTitle>

        <div className="min-h-[160px]">
          {loading && commands.length === 0 ? (
            <div className="flex items-center justify-center py-16"><LoadingSpinner /></div>
          ) : commands.length === 0 ? (
            <EmptyState title={t('commands.empty', { defaultValue: 'No command sent to this agent yet' })} compact />
          ) : (
            <TableScroll className="rounded-none">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase text-text-muted border-b border-border">
                    <th className="text-left px-4 py-2 font-medium">{t('commands.colCommand', { defaultValue: 'Command' })}</th>
                    <th className="text-left px-4 py-2 font-medium">{t('commands.colStatus', { defaultValue: 'Status' })}</th>
                    <th className="text-left px-4 py-2 font-medium whitespace-nowrap">{t('commands.colRequested', { defaultValue: 'Requested' })}</th>
                    <th className="text-left px-4 py-2 font-medium whitespace-nowrap">{t('commands.colFinished', { defaultValue: 'Finished' })}</th>
                    <th className="text-left px-4 py-2 font-medium">{t('commands.colResult', { defaultValue: 'Result' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {commands.map(c => (
                    <tr key={c.id} className="border-b border-border last:border-0 align-top">
                      <td className="px-4 py-2 text-text-primary whitespace-nowrap">{commandLabel(c.type, t)}</td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span className={cn('inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_STYLE[c.status])}>
                          {statusLabel(c, t)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-text-secondary whitespace-nowrap" title={formatTs(c.createdAt)}>
                        {relativeTime(c.createdAt, t)}
                        <span className="text-text-muted">
                          {' · '}{c.createdByName ?? t('commands.bySystem', { defaultValue: 'system' })}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-text-secondary whitespace-nowrap">
                        {c.finishedAt ? formatTs(c.finishedAt) : c.expiresAt && c.status === 'queued'
                          ? t('commands.expiresAt', { defaultValue: 'expires {{date}}', date: formatTs(c.expiresAt) })
                          : '—'}
                      </td>
                      <td className="px-4 py-2 text-text-secondary break-words max-w-md">{resultText(c, t) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </div>
      </div>
    </div>
  );
}
