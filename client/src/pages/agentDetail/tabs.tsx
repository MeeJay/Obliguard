import type { ReactNode } from 'react';
import { Activity, LayoutGrid, Layers, Settings, Shield, type LucideIcon } from 'lucide-react';
import type { AgentDevice } from '@obliview/shared';
import type { AgentDetailTab } from './model';
import { OverviewTab } from './OverviewTab';
import { EventsTab } from './EventsTab';
import { ServicesTab } from './ServicesTab';
import { FirewallTab } from './FirewallTab';
import { SettingsTab, type SettingsTabProps } from './SettingsTab';

/** Everything the shell hands to a tab body (each tab takes what it needs). */
export type AgentDetailTabContext = SettingsTabProps;

export interface AgentDetailTabDef {
  id: AgentDetailTab;
  icon: LucideIcon;
  /** i18n key + English default of the tab label. */
  labelKey: string;
  defaultLabel: string;
  /** Hide the tab for this device / user (default: always shown). */
  visible?: (device: AgentDevice) => boolean;
  render: (ctx: AgentDetailTabContext) => ReactNode;
}

/**
 * Tab registry of the agent detail page, in display order. A later lot adds
 * a tab with one id in model.AGENT_DETAIL_TABS and one entry here; the page
 * shell never branches on tab ids.
 */
export const AGENT_DETAIL_TAB_DEFS: ReadonlyArray<AgentDetailTabDef> = [
  {
    id: 'overview',
    icon: LayoutGrid,
    labelKey: 'agentDetail.tabs.overview',
    defaultLabel: 'Overview',
    render: (ctx) => <OverviewTab {...ctx} />,
  },
  {
    id: 'events',
    icon: Activity,
    labelKey: 'agentDetail.tabs.events',
    defaultLabel: 'Events',
    render: (ctx) => <EventsTab {...ctx} />,
  },
  {
    id: 'services',
    icon: Layers,
    labelKey: 'agentDetail.tabs.services',
    defaultLabel: 'Services & templates',
    render: (ctx) => <ServicesTab {...ctx} />,
  },
  {
    id: 'firewall',
    icon: Shield,
    labelKey: 'agentDetail.tabs.firewall',
    defaultLabel: 'Firewall',
    render: (ctx) => <FirewallTab {...ctx} />,
  },
  {
    id: 'settings',
    icon: Settings,
    labelKey: 'agentDetail.tabs.settings',
    defaultLabel: 'Settings',
    render: (ctx) => <SettingsTab {...ctx} />,
  },
];
