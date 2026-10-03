import { useTranslation } from 'react-i18next';
import { EyeOff, Globe, Lock, MapPin, Shield, Users } from 'lucide-react';
import type { ServiceTemplate, ServiceTemplateMode, ServiceType } from '@obliview/shared';
import { TenantBadge } from '@/components/common/TenantBadge';
import { templateOrigin } from '@/api/serviceTemplates.api';
import { cn } from '@/utils/cn';

export const SERVICE_ICONS: Record<string, string> = {
  ssh: '🔐', rdp: '🖥', nginx: '🌐', apache: '🌐', iis: '🌐',
  ftp: '📁', mail: '✉️', mysql: '🗄', custom: '⚙️',
};

/** Service types offered when creating a template (custom first). */
export const SERVICE_TYPES: ReadonlyArray<{ value: ServiceType; label: string }> = [
  { value: 'custom', label: 'Custom' },
  { value: 'ssh', label: 'SSH' },
  { value: 'rdp', label: 'RDP' },
  { value: 'nginx', label: 'Nginx' },
  { value: 'apache', label: 'Apache' },
  { value: 'iis', label: 'IIS' },
  { value: 'ftp', label: 'FTP' },
  { value: 'mail', label: 'Mail' },
  { value: 'mysql', label: 'MySQL' },
];

export function serviceIcon(type: string): string {
  return SERVICE_ICONS[type] ?? '📡';
}

const chip = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-semibold';

/** Ban (feeds the ban engine) / Track only (stored, never bans). */
export function ModeChip({ mode, className }: { mode: ServiceTemplateMode; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn(chip, mode === 'ban' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400', className)}>
      {mode === 'ban' ? <Shield size={9} aria-hidden="true" /> : <EyeOff size={9} aria-hidden="true" />}
      {mode === 'ban'
        ? t('serviceTemplates.mode.ban', { defaultValue: 'Ban' })
        : t('serviceTemplates.mode.track', { defaultValue: 'Track only' })}
    </span>
  );
}

/** On / Off chip of the template's default enabled state. */
export function EnabledChip({ enabled, className }: { enabled: boolean; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn(chip, enabled ? 'bg-status-up/10 text-status-up' : 'bg-text-muted/15 text-text-muted', className)}>
      {enabled
        ? t('serviceTemplates.state.on', { defaultValue: 'On' })
        : t('serviceTemplates.state.off', { defaultValue: 'Off' })}
    </span>
  );
}

/**
 * Origin of a template: built-in / platform (shared by every tenant),
 * tenant (plus the owning tenant's name in the god view) or local (one group
 * or agent).
 */
export function OriginBadge({ template, className }: {
  template: Pick<ServiceTemplate, 'isBuiltin' | 'tenantId' | 'ownerScope'>;
  className?: string;
}) {
  const { t } = useTranslation();
  const origin = templateOrigin(template);
  if (origin === 'builtin') {
    return (
      <span className={cn(chip, 'bg-blue-500/15 text-blue-400', className)}>
        <Lock size={9} aria-hidden="true" />
        {t('serviceTemplates.origin.builtin', { defaultValue: 'Built-in' })}
      </span>
    );
  }
  if (origin === 'platform') {
    return (
      <span className={cn(chip, 'bg-blue-500/15 text-blue-400', className)}>
        <Globe size={9} aria-hidden="true" />
        {t('serviceTemplates.origin.platform', { defaultValue: 'Platform' })}
      </span>
    );
  }
  if (origin === 'local') {
    return (
      <span className={cn(chip, 'bg-emerald-500/15 text-emerald-400', className)}>
        <MapPin size={9} aria-hidden="true" />
        {template.ownerScope === 'agent'
          ? t('serviceTemplates.origin.localAgent', { defaultValue: 'Local (agent)' })
          : t('serviceTemplates.origin.localGroup', { defaultValue: 'Local (group)' })}
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <span className={cn(chip, 'bg-purple-500/15 text-purple-400')}>
        <Users size={9} aria-hidden="true" />
        {t('serviceTemplates.origin.tenant', { defaultValue: 'Tenant' })}
      </span>
      <TenantBadge tenantId={template.tenantId} />
    </span>
  );
}
