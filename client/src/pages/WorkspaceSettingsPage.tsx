import { useTranslation } from 'react-i18next';
import { SlidersHorizontal } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { useTenantStore } from '@/store/tenantStore';

/**
 * Workspace (tenant) level of the IPS settings cascade (W13), for holders of
 * the 'settings' capability. The global settings page stays platform-admin
 * only; this page edits the operating tenant's level only, which the server
 * allows to 'settings' holders since the settings rows are tenant-scoped.
 */
export function WorkspaceSettingsPage() {
  const { t } = useTranslation();
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  const currentTenantName = useTenantStore(s => s.tenants.find(tn => tn.id === s.currentTenantId)?.name ?? null);

  return (
    <PageContainer className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        icon={<SlidersHorizontal size={20} />}
        title={t('settings.tenantSettingsTitle', { defaultValue: 'Workspace agent settings: {{name}}', name: currentTenantName ?? '' })}
        description={t('settings.tenantSettingsDesc', { defaultValue: "Apply to this workspace's agents, above the global defaults; groups and agents may override them." })}
      />
      {/* Remount on a tenant switch: the panel reads the operating tenant. */}
      <SettingsPanel
        key={currentTenantId ?? 'none'}
        level="tenant"
        scopeId={null}
        className="rounded-lg border border-border bg-bg-secondary p-5 max-sm:p-4"
        updatePolicyHref="/manage/agents"
      />
    </PageContainer>
  );
}
