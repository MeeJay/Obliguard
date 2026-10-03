import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, ArrowLeftRight, Check, CheckCircle2, ChevronDown, Clock, Cpu, Download, Eye, Folder,
  FolderInput, PauseCircle, Pencil, PlayCircle, PowerOff, RefreshCw, RotateCcw, Server, Trash2, Wifi, X, XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentDevice } from '@obliview/shared';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { IconButton } from '@/components/common/IconButton';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useGroupStore } from '@/store/groupStore';
import { anonHostname, anonIp } from '@/utils/anonymize';
import { findGroupInTree, isUpdateInFlight, visibleUpdateAttempt } from '@/utils/agentUpdate';
import { cn } from '@/utils/cn';
import { AgentStatusBadge } from './AgentStatusBadge';
import type { AgentActionAvailability } from './model';
import type { AgentLifecycle } from './useAgentLifecycle';

export interface CrossAppLink { appType: string; name: string; url: string; color: string | null }

const pillBtn = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed coarse:min-h-10';

/**
 * Agent detail header (mirrors Obliance DeviceDetailPage): back link, name
 * (inline rename), combined status, last seen, tenant (god view), group,
 * evaluate-only and update state; Approve / Refuse inline for a pending
 * agent; every other lifecycle action in a labelled "Actions" menu (a sheet
 * on phones).
 */
export function AgentHeader({
  device,
  actions,
  lifecycle,
  lastSeen,
  updateBadge,
  crossAppLinks,
  refreshing,
  onRefresh,
  onRename,
  onApprove,
  onMoveGroup,
}: {
  device: AgentDevice;
  actions: AgentActionAvailability;
  lifecycle: AgentLifecycle;
  /** LastSeenPill of the device (composed by the page shell). */
  lastSeen: ReactNode;
  /** UpdateStatusBadge with its Retry gate (composed by the page shell; null for routers). */
  updateBadge: ReactNode;
  crossAppLinks: CrossAppLink[];
  refreshing: boolean;
  onRefresh: () => void;
  onRename: (name: string | null) => Promise<void>;
  onApprove: () => void;
  onMoveGroup: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const groupName = useGroupStore(s => (device.groupId != null ? findGroupInTree(s.tree, device.groupId)?.name ?? null : null));

  const displayName = device.name ?? device.hostname;
  // Attempt shown by UpdateStatusBadge (null when settled / superseded).
  const updateShown = device.deviceType === 'agent' ? visibleUpdateAttempt(device) : null;
  const osLabel = device.osInfo
    ? [device.osInfo.distro ?? device.osInfo.platform, device.osInfo.release].filter(Boolean).join(' ')
    : null;
  const busy = lifecycle.busy !== null;

  async function saveRename() {
    setRenaming(false);
    const trimmed = nameDraft.trim();
    if (trimmed === (device.name ?? '')) return;
    await onRename(trimmed || null);
  }

  const menuItems: ActionMenuItem[] = [
    {
      key: 'requestUpdate',
      icon: <Download className="w-4 h-4" />,
      label: t('agentUpdate.updateNow', 'Update now'),
      description: device.latestAgentVersion
        ? t('agentDetail.actions.updateTo', { defaultValue: 'To v{{version}}', version: device.latestAgentVersion })
        : undefined,
      hidden: !actions.requestUpdate,
      disabled: busy,
      onClick: () => void lifecycle.requestUpdate(),
    },
    {
      key: 'cancelUpdate',
      icon: <Clock className="w-4 h-4" />,
      label: t('agentDetail.actions.cancelUpdate', { defaultValue: 'Cancel the update request' }),
      hidden: !actions.cancelUpdate,
      disabled: busy,
      onClick: () => void lifecycle.cancelUpdate(),
    },
    {
      key: 'moveGroup',
      icon: <FolderInput className="w-4 h-4" />,
      label: t('agentDetail.actions.moveGroup', { defaultValue: 'Move to group…' }),
      hidden: !actions.moveGroup,
      disabled: busy,
      separator: true,
      onClick: onMoveGroup,
    },
    {
      key: 'suspend',
      icon: <PauseCircle className="w-4 h-4" />,
      label: t('agentDetail.lifecycle.suspend', { defaultValue: 'Suspend' }),
      hidden: !actions.suspend,
      disabled: busy,
      onClick: () => void lifecycle.suspend(),
    },
    {
      key: 'reinstate',
      icon: <PlayCircle className="w-4 h-4" />,
      label: t('agentDetail.lifecycle.reinstate', { defaultValue: 'Reinstate' }),
      hidden: !actions.reinstate,
      disabled: busy,
      onClick: () => void lifecycle.reinstate(),
    },
    {
      key: 'requeue',
      icon: <RotateCcw className="w-4 h-4" />,
      label: t('agentDetail.actions.requeue', { defaultValue: 'Back to pending' }),
      hidden: !actions.requeue,
      disabled: busy,
      onClick: () => void lifecycle.requeue(),
    },
    {
      key: 'uninstall',
      icon: <PowerOff className="w-4 h-4" />,
      label: t('agentDetail.lifecycle.uninstall', { defaultValue: 'Uninstall' }),
      hidden: !actions.uninstall,
      disabled: busy,
      danger: true,
      separator: true,
      onClick: () => void lifecycle.uninstall(),
    },
    {
      key: 'delete',
      icon: <Trash2 className="w-4 h-4" />,
      label: t('common.delete', { defaultValue: 'Delete' }),
      hidden: !actions.delete,
      disabled: busy,
      danger: true,
      separator: !actions.uninstall,
      onClick: () => void lifecycle.remove(),
    },
    ...crossAppLinks.map((link, i): ActionMenuItem => ({
      key: `app-${link.appType}`,
      icon: <ArrowLeftRight className="w-4 h-4" />,
      label: t('agentDetail.actions.openIn', { defaultValue: 'Open in {{app}}', app: link.name }),
      separator: i === 0,
      onClick: () => { window.open(link.url, '_blank', 'noopener,noreferrer'); },
    })),
  ];
  const hasMenu = menuItems.some(i => !i.hidden);

  return (
    <div className="space-y-2">
      <Link
        to="/agents"
        className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors coarse:min-h-8"
      >
        <ArrowLeft size={14} />
        {t('agentDetail.backToAgents', { defaultValue: 'Agents' })}
      </Link>

      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {renaming ? (
              <form
                className="flex items-center gap-1 min-w-0 max-sm:w-full"
                onSubmit={e => { e.preventDefault(); void saveRename(); }}
              >
                <input
                  value={nameDraft}
                  onChange={e => setNameDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setRenaming(false); }}
                  autoFocus
                  aria-label={t('agentDetail.rename', { defaultValue: 'Rename' })}
                  placeholder={device.hostname}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  className="text-xl font-semibold bg-bg-tertiary border border-accent rounded px-2 py-0.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent min-w-[8rem] max-sm:min-w-0 max-sm:flex-1"
                />
                <IconButton type="submit" size="sm" variant="plain" label={t('common.save', { defaultValue: 'Save' })}
                  icon={<Check className="w-4 h-4" />} className="text-green-400 hover:text-green-400" />
                <IconButton type="button" size="sm" variant="plain" label={t('common.cancel', { defaultValue: 'Cancel' })}
                  icon={<X className="w-4 h-4" />} onClick={() => setRenaming(false)} />
              </form>
            ) : (
              <div className="flex items-center gap-1 min-w-0">
                <h1 className="text-xl font-semibold text-text-primary truncate">{anonHostname(displayName)}</h1>
                {actions.rename && (
                  <IconButton
                    size="sm"
                    variant="plain"
                    label={t('agentDetail.rename', { defaultValue: 'Rename' })}
                    icon={<Pencil className="w-3.5 h-3.5" />}
                    onClick={() => { setNameDraft(device.name ?? ''); setRenaming(true); }}
                  />
                )}
              </div>
            )}
            <AgentStatusBadge device={device} />
            {lastSeen}
            {/* God view: the owning tenant, so the admin knows which customer they act on. */}
            <TenantBadge tenantId={device.tenantId} size="md" />
            {device.groupId != null && (
              <Link
                to={`/group/${device.groupId}`}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary hover:border-accent/40 transition-colors"
              >
                <Folder className="w-3 h-3" />
                {groupName ?? t('agentDetail.groupFallback', { defaultValue: 'Group #{{id}}', id: device.groupId })}
              </Link>
            )}
            {device.evaluateOnly && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400"
                title={t('evaluateOnly.badgeTooltip', { defaultValue: 'Evaluate-only mode: events are observed but no bans are created or enforced.' })}
              >
                <Eye className="w-3 h-3" />
                {t('evaluateOnly.badge', { defaultValue: 'Evaluate-only' })}
              </span>
            )}
            {/* ── Agent update (C17-1): attempt state, then availability / request ── */}
            {updateBadge}
            {device.updateAvailable && device.latestAgentVersion && !device.updatePending && !updateShown && (
              <span className="rounded-full px-2 py-0.5 text-[11px] font-medium bg-amber-500/10 text-amber-400">
                {t('agentUpdate.updateAvailable', { defaultValue: 'Update available: v{{version}}', version: device.latestAgentVersion })}
              </span>
            )}
            {device.updatePending && !isUpdateInFlight(updateShown) && (
              <span className="rounded-full px-2 py-0.5 text-[11px] font-medium bg-blue-500/10 text-blue-400">
                {t('agentUpdate.updateRequested', { defaultValue: 'Update to v{{version}} requested', version: device.updateRequestedVersion })}
              </span>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
            {device.hostname !== displayName && (
              <span className="flex items-center gap-1"><Server size={11} className="text-text-muted" />{anonHostname(device.hostname)}</span>
            )}
            {osLabel && (
              <span className="flex items-center gap-1">
                <Cpu size={11} className="text-text-muted" />
                {osLabel}{device.osInfo?.arch ? ` (${device.osInfo.arch})` : ''}
              </span>
            )}
            {device.ip && (
              <span className="flex items-center gap-1 font-mono">
                <Wifi size={11} className="text-text-muted" />{anonIp(device.ip)}
              </span>
            )}
            {device.agentVersion && (
              <span className="font-mono text-text-muted">
                {t('agentDetail.agentVersion', { defaultValue: 'Agent v{{version}}', version: device.agentVersion })}
              </span>
            )}
          </div>
        </div>

        {/* Below md the action cluster gets its own full-width row. */}
        <div className="flex items-center gap-2 flex-wrap shrink-0 max-md:w-full">
          {actions.approve && (
            <button type="button" onClick={onApprove} disabled={busy}
              className={cn(pillBtn, 'bg-green-500 hover:bg-green-400 text-white')}>
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t('agentDetail.lifecycle.approve', { defaultValue: 'Approve' })}
            </button>
          )}
          {actions.refuse && (
            <button type="button" onClick={() => void lifecycle.refuse()} disabled={busy}
              className={cn(pillBtn, 'bg-red-500 hover:bg-red-400 text-white')}>
              <XCircle className="w-3.5 h-3.5" />
              {t('agentDetail.lifecycle.refuse', { defaultValue: 'Refuse' })}
            </button>
          )}
          {crossAppLinks.map(link => (
            <a
              key={link.appType}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="max-md:hidden flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border transition-colors"
              style={{ color: link.color ?? '#58a6ff', borderColor: `${link.color ?? '#58a6ff'}40`, backgroundColor: `${link.color ?? '#58a6ff'}0d` }}
            >
              <ArrowLeftRight size={12} />
              {link.name}
            </a>
          ))}
          <IconButton
            label={t('common.refresh', { defaultValue: 'Refresh' })}
            icon={<RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />}
            onClick={onRefresh}
          />
          {hasMenu && (
            <ActionMenu
              items={menuItems}
              label={t('agentDetail.actions.label', { defaultValue: 'Agent actions' })}
              trigger={(p) => (
                <button
                  {...p}
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover transition-colors coarse:min-h-10"
                >
                  {t('agentDetail.actions.button', { defaultValue: 'Actions' })}
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}
