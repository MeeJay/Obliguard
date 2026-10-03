import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import type { IpReputation, IpStatus } from '@obliview/shared';

/**
 * Presentation status of an IP. Extends the server's computed `IpStatus`
 * with 'excluded': an active global ban the calling tenant overrode
 * locally — the IP is banned elsewhere but NOT enforced on this tenant.
 */
export type IpStatusKey = IpStatus | 'excluded';

const STATUS_CONFIG: Record<IpStatusKey, { i18nKey: string; fallback: string; color: string }> = {
  clean:       { i18nKey: 'status.ip.clean',       fallback: 'Clean',       color: 'text-text-muted bg-text-muted/10 border-text-muted/20' },
  suspicious:  { i18nKey: 'status.ip.suspicious',  fallback: 'Suspicious',  color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30' },
  banned:      { i18nKey: 'status.ip.banned',      fallback: 'Banned',      color: 'text-red-400 bg-red-400/10 border-red-400/30' },
  whitelisted: { i18nKey: 'status.ip.whitelisted', fallback: 'Whitelisted', color: 'text-status-up bg-status-up/10 border-status-up/30' },
  excluded:    { i18nKey: 'status.ip.excluded',    fallback: 'Excluded',    color: 'text-purple-400 bg-purple-400/10 border-purple-400/30' },
};

/** Status of a reputation row, with the tenant-local ban override folded in. */
export function resolveIpStatus(rep: Pick<IpReputation, 'status' | 'activeBanExcluded'>): IpStatusKey | undefined {
  if (rep.status === 'banned' && rep.activeBanExcluded) return 'excluded';
  return rep.status;
}

interface Props {
  status: IpStatusKey | null | undefined;
  size?: 'sm' | 'md';
  className?: string;
}

/** Renders nothing for a missing status (rows whose status was not computed). */
export function IpStatusBadge({ status, size = 'sm', className }: Props) {
  const { t } = useTranslation();
  if (!status) return null;
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.clean;
  return (
    <span className={clsx(
      'inline-flex items-center font-medium border rounded-full whitespace-nowrap',
      size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1',
      cfg.color,
      className,
    )}>
      {t(cfg.i18nKey, cfg.fallback)}
    </span>
  );
}
