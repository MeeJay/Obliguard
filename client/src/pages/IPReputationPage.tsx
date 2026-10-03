import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Fingerprint, Globe, ShieldCheck, ShieldOff, Loader2 } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useTabParam } from '@/hooks/useTabParam';

/**
 * IP Reputation hub (Obliance PoliciesPage pattern): one page, four tabs
 * (?tab=activity|bans|whitelist|remote; activity is the default and is
 * written as "no parameter"). Every tab is a lazy, self-contained component
 * of pages/ipReputation/ that reads its own URL parameters:
 *
 *   export default function XTab(): JSX.Element
 *
 * The IP detail drawer is not part of the hub: it is global (?ip=, mounted
 * once in AppLayout), so any tab or page opens it with useIpDrawer().open(ip).
 */
type HubTab = 'activity' | 'bans' | 'whitelist' | 'remote';

const TAB_ORDER: readonly HubTab[] = ['activity', 'bans', 'whitelist', 'remote'];

/** Tab id → its lazy component. A tab without a component is not offered. */
const TAB_COMPONENTS: Partial<Record<HubTab, LazyExoticComponent<ComponentType>>> = {
  activity: lazy(() => import('./ipReputation/ActivityTab')),
  bans: lazy(() => import('./ipReputation/BansTab')),
  whitelist: lazy(() => import('./ipReputation/WhitelistTab')),
  remote: lazy(() => import('./ipReputation/RemoteTab')),
};

const AVAILABLE_TABS: readonly HubTab[] = TAB_ORDER.filter((id) => TAB_COMPONENTS[id] !== undefined);

const TAB_ICONS: Record<HubTab, ReactNode> = {
  activity: <Activity size={16} />,
  bans: <ShieldOff size={16} />,
  whitelist: <ShieldCheck size={16} />,
  remote: <Globe size={16} />,
};

export function IPReputationPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useTabParam<HubTab>(AVAILABLE_TABS, 'activity');

  const labels: Record<HubTab, string> = {
    activity: t('ipReputation.tabs.activity', { defaultValue: 'Activity' }),
    bans: t('ipReputation.tabs.bans', { defaultValue: 'Bans' }),
    whitelist: t('ipReputation.tabs.whitelist', { defaultValue: 'Whitelist' }),
    remote: t('ipReputation.tabs.remote', { defaultValue: 'Remote' }),
  };
  const tabs: SegmentedTab<HubTab>[] = TAB_ORDER.map((id) => ({
    id,
    label: labels[id],
    icon: TAB_ICONS[id],
    hidden: TAB_COMPONENTS[id] === undefined,
  }));
  const Current = TAB_COMPONENTS[tab] ?? TAB_COMPONENTS.activity!;
  const title = t('ipReputation.title', { defaultValue: 'IP Reputation' });

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        icon={<Fingerprint size={20} />}
        title={title}
        description={t('ipReputation.subtitle', { defaultValue: 'Every IP seen by your agents: activity, bans, whitelist and remote blocklists.' })}
      />
      {AVAILABLE_TABS.length > 1 && (
        <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} fill={false} ariaLabel={title} />
      )}
      <div role={AVAILABLE_TABS.length > 1 ? 'tabpanel' : undefined} aria-label={labels[tab]}>
        <Suspense
          fallback={(
            <div className="flex items-center justify-center py-16" role="status" aria-label={t('common.loading', { defaultValue: 'Loading…' })}>
              <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </div>
          )}
        >
          <Current />
        </Suspense>
      </div>
    </PageContainer>
  );
}
