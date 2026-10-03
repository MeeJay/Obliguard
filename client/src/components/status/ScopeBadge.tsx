import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import type { BanScope, RateLimitScope, WhitelistScope } from '@obliview/shared';
import { Tip } from '@/components/common/Tip';
import { useCanHover } from '@/hooks/useMediaQuery';

/** Scope of a ban, whitelist entry or rate-limit policy (same four levels). */
export type ScopeKey = BanScope | WhitelistScope | RateLimitScope;

const SCOPE_CONFIG: Record<ScopeKey, { i18nKey: string; fallback: string; hintKey: string; hint: string; color: string }> = {
  global: {
    i18nKey: 'status.scope.global', fallback: 'Global',
    hintKey: 'status.scope.globalHint', hint: 'Applies to every agent of every tenant',
    color: 'text-red-400 bg-red-400/10 border-red-400/30',
  },
  tenant: {
    i18nKey: 'status.scope.tenant', fallback: 'Tenant',
    hintKey: 'status.scope.tenantHint', hint: 'Applies to every agent of the tenant',
    color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30',
  },
  group: {
    i18nKey: 'status.scope.group', fallback: 'Group',
    hintKey: 'status.scope.groupHint', hint: 'Applies to the agents of the group and its subgroups',
    color: 'text-blue-400 bg-blue-400/10 border-blue-400/30',
  },
  agent: {
    i18nKey: 'status.scope.agent', fallback: 'Agent',
    hintKey: 'status.scope.agentHint', hint: 'Applies to a single agent',
    color: 'text-text-muted bg-text-muted/10 border-text-muted/20',
  },
};

interface Props {
  scope: ScopeKey;
  /** Name of the scope target (group name, agent hostname, tenant name).
   *  Shown in the tooltip; without it the tooltip explains the scope. */
  scopeName?: string | null;
  /** Explicit tooltip content (wins over the generated one). */
  tooltip?: ReactNode;
  /** Disable the tooltip (e.g. inside a legend). Default true. */
  showTooltip?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Scope pill (global / tenant / group / agent) with a hover / tap tooltip
 * naming the target. On touch the tap is kept from bubbling so a tap on the
 * pill inside a clickable row reveals the tooltip instead of navigating.
 */
export function ScopeBadge({ scope, scopeName, tooltip, showTooltip = true, size = 'sm', className }: Props) {
  const { t } = useTranslation();
  const canHover = useCanHover();
  const cfg = SCOPE_CONFIG[scope] ?? SCOPE_CONFIG.agent;
  const label = t(cfg.i18nKey, cfg.fallback);

  const pill = (
    <span className={clsx(
      'inline-flex items-center font-medium border rounded-full whitespace-nowrap',
      size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1',
      cfg.color,
      className,
    )}>
      {label}
    </span>
  );
  if (!showTooltip) return pill;

  const content = tooltip
    ?? (scopeName
      ? t('status.scope.named', '{{scope}}: {{name}}', { scope: label, name: scopeName })
      : t(cfg.hintKey, cfg.hint));

  return (
    <span className="inline-flex" onClick={canHover ? undefined : (e) => e.stopPropagation()}>
      <Tip content={content}>{pill}</Tip>
    </span>
  );
}
