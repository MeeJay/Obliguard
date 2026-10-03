import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ResolvedSettingValue, SettingSource } from '@obliview/shared';

interface InheritanceBadgeProps {
  setting: Pick<ResolvedSettingValue, 'source' | 'sourceId' | 'sourceName'>;
  /** Link the source level to where it is edited (default true). */
  linked?: boolean;
}

/** Where the level that set a value is edited (null: nothing to open). */
export function settingSourceHref(source: SettingSource, sourceId: number | null): string | null {
  switch (source) {
    case 'global':
    case 'tenant':
      return '/settings';
    case 'group':
      return sourceId != null ? `/group/${sourceId}/edit?tab=agent` : null;
    case 'agent':
      return sourceId != null ? `/agents/${sourceId}?tab=settings` : null;
    default:
      return null;
  }
}

/**
 * Where an inherited setting comes from (W13-1 cascade: default -> global ->
 * tenant -> group chain -> agent), with a link to the level that sets it.
 */
export function InheritanceBadge({ setting, linked = true }: InheritanceBadgeProps) {
  const { t } = useTranslation();

  if (setting.source === 'default') {
    return (
      <span className="text-xs text-text-muted">
        {t('settings.source.default', { defaultValue: 'Default' })}
      </span>
    );
  }

  if (setting.source === 'agent') {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
        {t('settings.source.override', { defaultValue: 'Override' })}
      </span>
    );
  }

  const label = setting.source === 'global'
    ? t('settings.source.global', { defaultValue: 'Global' })
    : setting.source === 'tenant'
      ? t('settings.source.tenant', { defaultValue: 'Workspace: {{name}}', name: setting.sourceName })
      : t('settings.source.group', { defaultValue: 'Group: {{name}}', name: setting.sourceName });
  const title = t('settings.source.inheritedFrom', { defaultValue: 'Inherited from {{source}}', source: label });
  const href = linked ? settingSourceHref(setting.source, setting.sourceId) : null;

  return href ? (
    <Link to={href} title={title} className="text-xs text-accent hover:underline">
      {label}
    </Link>
  ) : (
    <span title={title} className="text-xs text-accent">
      {label}
    </span>
  );
}
