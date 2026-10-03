import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import type { AgentDevice } from '@obliview/shared';
import { agentLifecycleStatus, type AgentLifecycleStatus } from './model';

// ─── Combined agent status badge (mirrors Obliance DeviceStatusBadge) ────────
//
// One pill for the approval state, a requested uninstall, a running update
// and the live channel, so the header never shows "ONLINE" for an agent that
// is suspended or still waiting for approval.

const STATUS_CONFIG: Record<AgentLifecycleStatus, { key: string; fallback: string; color: string; dot: string }> = {
  online:        { key: 'status.agent.online',        fallback: 'Online',           color: 'text-green-400 bg-green-400/10 border-green-400/30',   dot: 'bg-green-400' },
  offline:       { key: 'status.agent.offline',       fallback: 'Offline',          color: 'text-red-400 bg-red-400/10 border-red-400/30',         dot: 'bg-red-400' },
  pending:       { key: 'status.agent.pending',       fallback: 'Pending',          color: 'text-blue-400 bg-blue-400/10 border-blue-400/30',      dot: 'bg-blue-400' },
  refused:       { key: 'status.agent.refused',       fallback: 'Refused',          color: 'text-red-400 bg-red-400/10 border-red-400/30',         dot: 'bg-red-400' },
  suspended:     { key: 'status.agent.suspended',     fallback: 'Suspended',        color: 'text-gray-400 bg-gray-400/10 border-gray-400/30',      dot: 'bg-gray-400' },
  uninstalling:  { key: 'status.agent.uninstalling',  fallback: 'Pending uninstall', color: 'text-orange-400 bg-orange-400/10 border-orange-400/30', dot: 'bg-orange-400 animate-pulse' },
  updating:      { key: 'status.agent.updating',      fallback: 'Updating',         color: 'text-blue-400 bg-blue-400/10 border-blue-400/30',      dot: 'bg-blue-400 animate-pulse' },
  misconfigured: { key: 'status.agent.misconfigured', fallback: 'Misconfigured',    color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30', dot: 'bg-yellow-400' },
};

type BadgeDevice = Pick<
  AgentDevice,
  'status' | 'wsConnected' | 'deviceType' | 'mikrotikStatus' | 'pendingCommand' | 'uninstallCommandedAt' | 'update'
>;

export function AgentStatusBadge({ device, size = 'md' }: { device: BadgeDevice; size?: 'sm' | 'md' }) {
  const { t } = useTranslation();
  const status = agentLifecycleStatus(device);
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs',
        cfg.color,
      )}
      data-status={status}
    >
      <span className={clsx('rounded-full', size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2', cfg.dot)} aria-hidden="true" />
      {t(cfg.key, { defaultValue: cfg.fallback })}
    </span>
  );
}
