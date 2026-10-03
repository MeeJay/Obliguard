import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import type { AgentDevice } from '@obliview/shared';
import { visibleUpdateAttempt } from '@/utils/agentUpdate';

/**
 * Every presentation status of an agent / remote device. The badge is the
 * single place that turns the raw AgentDevice fields (approval `status`,
 * `wsConnected`, `update.phase`, `evaluateOnly`, `mikrotikStatus`) into one
 * of these, so every page shows the same word and colour for the same state.
 */
export type AgentStatusKey =
  | 'online'
  | 'offline'
  | 'pending'
  | 'suspended'
  | 'refused'
  | 'updating'
  | 'update_failed'
  | 'evaluate_only'
  | 'misconfigured';

const STATUS_CONFIG: Record<AgentStatusKey, { i18nKey: string; fallback: string; color: string; dot: string }> = {
  online:        { i18nKey: 'status.agent.online',        fallback: 'Online',        color: 'text-status-up bg-status-up/10 border-status-up/30',     dot: 'bg-status-up' },
  offline:       { i18nKey: 'status.agent.offline',       fallback: 'Offline',       color: 'text-text-muted bg-text-muted/10 border-text-muted/30', dot: 'bg-text-muted' },
  pending:       { i18nKey: 'status.agent.pending',       fallback: 'Pending',       color: 'text-blue-400 bg-blue-400/10 border-blue-400/30',       dot: 'bg-blue-400 animate-pulse' },
  suspended:     { i18nKey: 'status.agent.suspended',     fallback: 'Suspended',     color: 'text-text-muted bg-text-muted/10 border-text-muted/20', dot: 'bg-text-muted' },
  refused:       { i18nKey: 'status.agent.refused',       fallback: 'Refused',       color: 'text-red-400 bg-red-400/10 border-red-400/30',          dot: 'bg-red-400' },
  updating:      { i18nKey: 'status.agent.updating',      fallback: 'Updating',      color: 'text-blue-400 bg-blue-400/10 border-blue-400/30',       dot: 'bg-blue-400 animate-pulse' },
  update_failed: { i18nKey: 'status.agent.updateFailed',  fallback: 'Update failed', color: 'text-orange-400 bg-orange-400/10 border-orange-400/30', dot: 'bg-orange-400' },
  evaluate_only: { i18nKey: 'status.agent.evaluateOnly',  fallback: 'Evaluate only', color: 'text-amber-400 bg-amber-400/10 border-amber-400/30',    dot: 'bg-amber-400' },
  misconfigured: { i18nKey: 'status.agent.misconfigured', fallback: 'Misconfigured', color: 'text-orange-400 bg-orange-400/10 border-orange-400/30', dot: 'bg-orange-400 animate-pulse' },
};

/** Update phases during which the agent itself is busy updating (it may be
 *  briefly disconnected while restarting): "Updating" wins over "Offline". */
const AGENT_SIDE_UPDATE_PHASES: ReadonlySet<string> = new Set(['downloading', 'verifying', 'installing', 'restarting']);

/** The AgentDevice fields the status is derived from (socket patches and
 *  list rows can pass partial objects). */
export type AgentStatusSource = Pick<AgentDevice, 'status' | 'wsConnected'>
  & Partial<Pick<AgentDevice, 'update' | 'agentVersion' | 'evaluateOnly' | 'deviceType' | 'mikrotikStatus'>>;

/**
 * Primary status of a device (never 'evaluate_only': dry-run is an extra
 * flag on top of the presence state, rendered as a second pill).
 *
 * Precedence: approval first (refused > suspended > pending) — a device that
 * is not approved has no meaningful presence; then a MikroTik that never
 * delivered anything; then an update the agent is executing; then presence
 * (offline beats a merely offered / failed update, which is only actionable
 * once the agent is back); then a failed or offered update on a connected
 * agent.
 */
export function resolveAgentStatus(device: AgentStatusSource): AgentStatusKey {
  if (device.status === 'refused') return 'refused';
  if (device.status === 'suspended') return 'suspended';
  if (device.status === 'pending') return 'pending';

  if (device.deviceType === 'mikrotik' && device.mikrotikStatus === 'misconfigured') return 'misconfigured';

  const attempt = visibleUpdateAttempt({ update: device.update ?? null, agentVersion: device.agentVersion ?? null });
  if (attempt && AGENT_SIDE_UPDATE_PHASES.has(attempt.phase)) return 'updating';
  if (!device.wsConnected) return 'offline';
  if (attempt?.phase === 'failed') return 'update_failed';
  if (attempt?.phase === 'offered') return 'updating';
  return 'online';
}

interface Props {
  /** Device to derive the status from. */
  device?: AgentStatusSource;
  /** Explicit status (wins over `device`), e.g. for legends or filters. */
  status?: AgentStatusKey;
  size?: 'sm' | 'md';
  showDot?: boolean;
  /** Show the "Evaluate only" pill next to the status when the device is
   *  in effective dry-run mode (approved devices only). Default true. */
  showEvaluateOnly?: boolean;
  className?: string;
}

export function AgentStatusBadge({ device, status, size = 'md', showDot = true, showEvaluateOnly = true, className }: Props) {
  const { t } = useTranslation();
  const key: AgentStatusKey = status ?? (device ? resolveAgentStatus(device) : 'offline');
  const cfg = STATUS_CONFIG[key] ?? STATUS_CONFIG.offline;
  const evaluateOnly = STATUS_CONFIG.evaluate_only;
  const showEvaluateOnlyPill = showEvaluateOnly
    && key !== 'evaluate_only'
    && !!device?.evaluateOnly
    && device.status === 'approved';

  return (
    <span className={clsx('inline-flex items-center gap-1.5', className)}>
      <StatusPill size={size} showDot={showDot} color={cfg.color} dot={cfg.dot} label={t(cfg.i18nKey, cfg.fallback)} />
      {showEvaluateOnlyPill && (
        <StatusPill size={size} showDot={false} color={evaluateOnly.color} dot={evaluateOnly.dot} label={t(evaluateOnly.i18nKey, evaluateOnly.fallback)} />
      )}
    </span>
  );
}

function StatusPill({ size, showDot, color, dot, label }: { size: 'sm' | 'md'; showDot: boolean; color: string; dot: string; label: string }) {
  return (
    <span className={clsx(
      'inline-flex items-center gap-1.5 font-medium border rounded-full whitespace-nowrap',
      size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-xs px-2.5 py-1',
      color,
    )}>
      {showDot && <span className={clsx('rounded-full shrink-0', size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2', dot)} />}
      {label}
    </span>
  );
}
