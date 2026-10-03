import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface PageHeaderProps {
  /** Page title (already translated). Rendered as the page's single <h1>. */
  title: ReactNode;
  /** Leading icon, e.g. `<ShieldBan size={20} />`. Decorative (aria-hidden). */
  icon?: ReactNode;
  /** One-line help text under the title. */
  description?: ReactNode;
  /** Inline element right after the title (count pill, tenant badge…). */
  badge?: ReactNode;
  /** Right-hand action area (buttons, menus). Wraps under the title on phones. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The standard page header: icon + title (+ badge) + description on the
 * left, actions on the right. One title size for every page
 * (text-xl on phones, text-2xl from sm). Put it first inside PageContainer:
 *
 *   <PageContainer className="space-y-6">
 *     <PageHeader icon={<ShieldBan size={20} />} title={t('bans.title', { defaultValue: 'Bans' })}
 *       description={…} actions={<Button …/>} />
 *     …
 *   </PageContainer>
 */
export function PageHeader({ title, icon, description, badge, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-3', className)}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <span className="flex shrink-0 items-center text-text-muted" aria-hidden="true">
              {icon}
            </span>
          )}
          <h1 className="min-w-0 truncate text-xl font-semibold text-text-primary sm:text-2xl">{title}</h1>
          {badge && <span className="flex shrink-0 items-center">{badge}</span>}
        </div>
        {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
