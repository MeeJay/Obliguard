import type { ReactNode } from 'react';
import { ShieldCheck, ScanSearch, Gauge, Globe, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { EmptyState } from '@/components/common/EmptyState';
import { RemoteBlocklistsSection } from '@/components/settings/RemoteBlocklistsSection';
import { BanPolicyTab } from '@/components/policies/BanPolicyTab';
import { useTabParam } from '@/hooks/useTabParam';
import { useCan } from '@/hooks/usePermission';
import { ServiceTemplatesPage } from '@/pages/ServiceTemplatesPage';
import { RateLimitPage } from '@/pages/RateLimitPage';

/** Tabs of the hub, in display order. */
const POLICY_TABS = ['templates', 'limits', 'blocklists', 'banPolicy'] as const;
export type PolicyTab = (typeof POLICY_TABS)[number];

interface PolicyTabDefinition {
  tab: SegmentedTab<PolicyTab>;
  /** Already resolved capability predicate (mirrors the server guards). */
  visible: boolean;
  render: () => ReactNode;
}

/**
 * IPS Policies hub (mirrors Obliance PoliciesPage): one page with a
 * SegmentedTabs bar (?tab=, via useTabParam) embedding the pages that
 * configure how attacks are detected and blocked:
 *   - Service templates (templates.write, or read-only with ips.view);
 *   - Network limits (rate_limit.write);
 *   - Remote blocklists (remote_blocklists; writes stay platform admin on
 *     the Default tenant, enforced by the section and the server);
 *   - Ban policy (auto-ban duration and repeat-offender ladder, W12-3): one
 *     platform policy, edited by the platform admin on the Default tenant,
 *     shown as a read-only summary to everyone else who reaches the hub.
 * Tabs the user may not see are left out of the URL whitelist, so a shared
 * link to a hidden tab falls back to the first visible one. The route guard
 * (App.tsx) admits any of the three capabilities.
 */
export function PoliciesPage() {
  const { t } = useTranslation();
  const canTemplates = useCan(['templates.write', 'ips.view']);
  const canLimits = useCan('rate_limit.write');
  const canBlocklists = useCan('remote_blocklists');
  // Read-only for everyone admitted to the hub; editable by the platform
  // admin on the Default tenant (the tab and the server check it).
  const canBanPolicy = canTemplates || canLimits || canBlocklists;

  const definitions: Record<PolicyTab, PolicyTabDefinition> = {
    templates: {
      tab: { id: 'templates', label: t('policies.tabs.templates', { defaultValue: 'Service templates' }), icon: <ScanSearch size={16} /> },
      visible: canTemplates,
      render: () => <ServiceTemplatesPage embedded />,
    },
    limits: {
      tab: { id: 'limits', label: t('policies.tabs.limits', { defaultValue: 'Network limits' }), icon: <Gauge size={16} /> },
      visible: canLimits,
      render: () => <RateLimitPage embedded />,
    },
    blocklists: {
      tab: { id: 'blocklists', label: t('policies.tabs.blocklists', { defaultValue: 'Remote blocklists' }), icon: <Globe size={16} /> },
      visible: canBlocklists,
      render: () => <RemoteBlocklistsSection />,
    },
    banPolicy: {
      tab: { id: 'banPolicy', label: t('policies.tabs.banPolicy', { defaultValue: 'Ban policy' }), icon: <Timer size={16} /> },
      visible: canBanPolicy,
      render: () => <BanPolicyTab />,
    },
  };

  const visibleTabs = POLICY_TABS.filter((id) => definitions[id].visible);
  const [tab, setTab] = useTabParam<PolicyTab>(visibleTabs, visibleTabs[0] ?? 'templates');
  const active = visibleTabs.includes(tab) ? definitions[tab] : null;

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        icon={<ShieldCheck size={20} />}
        title={t('policies.title', { defaultValue: 'Policies' })}
        description={t('policies.description', {
          defaultValue: 'How attacks are detected and blocked: log parsers and ban thresholds, per-IP network limits and imported blocklists.',
        })}
      />
      {visibleTabs.length > 1 && (
        <SegmentedTabs
          tabs={visibleTabs.map((id) => definitions[id].tab)}
          value={tab}
          onChange={setTab}
          fill={false}
          ariaLabel={t('policies.title', { defaultValue: 'Policies' })}
        />
      )}
      {active ? (
        <div role="tabpanel" aria-label={typeof active.tab.label === 'string' ? active.tab.label : undefined}>
          {active.render()}
        </div>
      ) : (
        <EmptyState
          icon={<ShieldCheck size={32} strokeWidth={1.5} />}
          title={t('policies.noAccess', { defaultValue: 'No policy is available to you' })}
          description={t('policies.noAccessHint', { defaultValue: 'Ask an administrator for the service template, network limit or remote blocklist permission.' })}
        />
      )}
    </PageContainer>
  );
}
