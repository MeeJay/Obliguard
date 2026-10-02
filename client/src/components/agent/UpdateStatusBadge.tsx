import { useState } from 'react';
import { AlertTriangle, ArrowUpCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { AgentDevice } from '@obliview/shared';
import { agentApi } from '@/api/agent.api';
import { cn } from '@/utils/cn';
import {
  AGENT_UPDATE_MAX_OFFERS,
  agentUpdateErrorMessage,
  updateErrorLabel,
  updatePhaseClasses,
  updatePhaseLabel,
  visibleUpdateAttempt,
} from '@/utils/agentUpdate';

/** Longest agent-reported reason shown inline (the tooltip carries the full text). */
const INLINE_REASON_MAX = 48;

interface Props {
  device: Pick<AgentDevice, 'id' | 'update' | 'agentVersion'>;
  /** Show the Retry button on a failed attempt (monitor_rw in the device's own tenant). */
  canRetry?: boolean;
  /** Called with the refreshed device after a successful Retry. */
  onRetried?: (device: AgentDevice) => void;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * State of the latest agent update attempt (AgentDevice.update, W2-1):
 *  - in flight (offered / downloading / verifying / installing / restarting): blue pill;
 *  - failed: "Update failed: <reason>" in red, plus Retry when allowed.
 * The tooltip lists the target version, offers made out of the cap, the last
 * error and when the attempt last changed. Settled or superseded attempts
 * render nothing.
 */
export function UpdateStatusBadge({ device, canRetry = false, onRetried, size = 'md', className }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const u = visibleUpdateAttempt(device);
  if (!u) return null;

  const failed = u.phase === 'failed';
  const reason = failed ? updateErrorLabel(u.lastError, t) : null;
  const inlineReason = reason && reason.length > INLINE_REASON_MAX ? `${reason.slice(0, INLINE_REASON_MAX - 1)}…` : reason;
  const label = failed
    ? t('agents.update.failedWithReason', { defaultValue: 'Update failed: {{reason}}', reason: inlineReason })
    : u.phase === 'offered'
      ? t('agents.update.offeredCount', {
          defaultValue: 'Update offered ({{attempts}}/{{max}})',
          attempts: u.attempts,
          max: AGENT_UPDATE_MAX_OFFERS,
        })
      : updatePhaseLabel(u.phase, t);

  const updatedAt = new Date(u.updatedAt);
  const tooltip = [
    `${updatePhaseLabel(u.phase, t)} — v${u.targetVersion}`,
    t('agents.update.tooltipAttempts', {
      defaultValue: 'Offers: {{attempts}}/{{max}}',
      attempts: u.attempts,
      max: AGENT_UPDATE_MAX_OFFERS,
    }),
    u.lastError ? t('agents.update.tooltipError', { defaultValue: 'Last error: {{error}}', error: updateErrorLabel(u.lastError, t) }) : null,
    Number.isNaN(updatedAt.getTime())
      ? null
      : t('agents.update.tooltipUpdated', { defaultValue: 'Changed {{date}}', date: updatedAt.toLocaleString() }),
  ].filter(Boolean).join('\n');

  const retry = async (e: React.MouseEvent) => {
    // Rows of the agent list are clickable: keep the click on the button.
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      const updated = await agentApi.retryUpdate(device.id);
      toast.success(t('agents.update.retried', 'Update retried: offered again at the next heartbeat'));
      onRetried?.(updated);
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agents.update.retryFailed', 'Failed to retry the update')));
    } finally {
      setBusy(false);
    }
  };

  const Icon = failed ? AlertTriangle : u.phase === 'offered' ? ArrowUpCircle : RefreshCw;
  const spin = !failed && u.phase !== 'offered';
  const sm = size === 'sm';

  return (
    <span className={cn('inline-flex items-center gap-1', className)} data-update-phase={u.phase}>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap',
          sm ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]',
          updatePhaseClasses(u.phase),
        )}
        title={tooltip}
      >
        <Icon size={sm ? 9 : 11} className={spin ? 'animate-spin' : undefined} />
        {label}
      </span>
      {failed && canRetry && (
        <button
          type="button"
          onClick={retry}
          disabled={busy}
          title={t('agents.update.retryTitle', 'Reset the attempt and offer the update again at the next heartbeat')}
          className={cn(
            'inline-flex items-center gap-1 rounded border border-red-500/40 font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50',
            sm ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]',
          )}
        >
          <RotateCcw size={sm ? 9 : 11} className={busy ? 'animate-spin' : undefined} />
          {t('agents.update.retry', 'Retry')}
        </button>
      )}
    </span>
  );
}
