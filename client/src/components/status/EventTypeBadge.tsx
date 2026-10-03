import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import type { IpEventType } from '@obliview/shared';

/**
 * Event kinds shown in the event streams: the stored `IpEventType`s plus the
 * synthetic rows the live views interleave (rate-limit drops, bans).
 */
export type EventTypeKey = IpEventType | 'rate_limited' | 'ban';

const EVENT_CONFIG: Record<EventTypeKey, { i18nKey: string; fallback: string; shortKey: string; short: string; color: string }> = {
  auth_failure: {
    i18nKey: 'status.event.authFailure', fallback: 'Auth failure',
    shortKey: 'status.event.authFailureShort', short: 'FAIL',
    color: 'text-red-400 bg-red-400/10 border-red-400/20',
  },
  auth_success: {
    i18nKey: 'status.event.authSuccess', fallback: 'Auth success',
    shortKey: 'status.event.authSuccessShort', short: 'OK',
    color: 'text-status-up bg-status-up/10 border-status-up/20',
  },
  port_scan: {
    i18nKey: 'status.event.portScan', fallback: 'Port scan',
    shortKey: 'status.event.portScanShort', short: 'SCAN',
    color: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
  },
  rate_limited: {
    i18nKey: 'status.event.rateLimited', fallback: 'Rate limited',
    shortKey: 'status.event.rateLimitedShort', short: 'LIMIT',
    color: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
  },
  ban: {
    i18nKey: 'status.event.ban', fallback: 'Ban',
    shortKey: 'status.event.banShort', short: 'BAN',
    color: 'text-red-500 bg-red-500/15 border-red-500/30',
  },
};

function isKnownEventType(type: string): type is EventTypeKey {
  return Object.prototype.hasOwnProperty.call(EVENT_CONFIG, type);
}

interface Props {
  /** Event type; unknown values (newer agents / server) render neutrally as-is. */
  type: EventTypeKey | string;
  /** Short uppercase label (FAIL / OK / SCAN …) for dense live streams. */
  short?: boolean;
  className?: string;
}

export function EventTypeBadge({ type, short = false, className }: Props) {
  const { t } = useTranslation();
  const cfg = isKnownEventType(type) ? EVENT_CONFIG[type] : null;
  const label = cfg
    ? (short ? t(cfg.shortKey, cfg.short) : t(cfg.i18nKey, cfg.fallback))
    : (short ? type.toUpperCase() : type);
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded border whitespace-nowrap',
        short ? 'px-1.5 py-0.5 text-[10px] font-bold' : 'px-2 py-0.5 text-[11px] font-medium',
        cfg?.color ?? 'bg-bg-tertiary text-text-muted border-border',
        className,
      )}
      title={short && cfg ? t(cfg.i18nKey, cfg.fallback) : undefined}
    >
      {label}
    </span>
  );
}
