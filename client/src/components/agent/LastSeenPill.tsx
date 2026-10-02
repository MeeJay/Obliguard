import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';

// ─── Last-seen pill (mirrors Obliance DeviceDetailPage LastSeenPill) ─────────
//
// Relative delay since the agent last talked to the server ("5m", "2h", "3d"),
// colour-coded: green < 5 min, yellow < 1 h, orange < 24 h, red beyond.
// Fed by AgentDevice.lastSeenAt (heartbeats / events / pushes only), never by
// updatedAt, which admin edits and commands also move.

export function LastSeenPill({ lastSeenAt, className }: { lastSeenAt: string | null | undefined; className?: string }) {
  const { t } = useTranslation();
  // Re-render every 30 s so the label drifts on its own while the page stays open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const date = lastSeenAt ? new Date(lastSeenAt) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border border-transparent bg-bg-tertiary text-text-muted',
          className,
        )}
        title={t('agents.update.neverSeen', 'Never seen')}
      >
        <Clock size={11} />
        —
      </span>
    );
  }

  const diffMs = Math.max(0, Date.now() - date.getTime());
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);

  let text: string;
  let color: string;
  if (mins < 5) {
    text = `${Math.max(mins, 1)}m`;
    color = 'bg-green-400/10 text-green-400 border-green-400/30';
  } else if (mins < 60) {
    text = `${mins}m`;
    color = 'bg-yellow-400/10 text-yellow-400 border-yellow-400/30';
  } else if (hours < 24) {
    text = `${hours}h`;
    color = 'bg-orange-400/10 text-orange-400 border-orange-400/30';
  } else {
    text = `${days}d`;
    color = 'bg-red-400/10 text-red-400 border-red-400/30';
  }

  return (
    <span
      className={cn('inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border', color, className)}
      title={t('agents.update.lastSeenAt', { defaultValue: 'Last seen {{date}}', date: date.toLocaleString() })}
    >
      <Clock size={11} />
      {text}
    </span>
  );
}
