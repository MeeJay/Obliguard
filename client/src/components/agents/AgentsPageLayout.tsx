import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupTreeNode } from '@obliview/shared';
import { Drawer } from '@/components/common/Drawer';
import { useGroupStore } from '@/store/groupStore';
import { useMediaQuery, useIsCoarsePointer, MEDIA } from '@/hooks/useMediaQuery';
import { GroupSidePanel, UNGROUPED } from './GroupSidePanel';
import { AgentTable } from './AgentTable';

interface AgentsPageLayoutProps {
  /** null = all agents, -1 = ungrouped, otherwise a group. */
  groupId: number | null;
  onGroupChange: (groupId: number | null) => void;
  /** With a group: include its sub-groups. */
  recursive: boolean;
  onRecursiveChange: (recursive: boolean) => void;
  /** Page header rendered above the table, in the scrolling column. */
  header?: ReactNode;
}

function findGroupName(nodes: GroupTreeNode[], id: number): string | null {
  for (const n of nodes) {
    if (n.id === id) return n.name;
    const hit = findGroupName(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * /agents shell (port of Obliance components/devices/DevicesPageLayout):
 *
 *   ┌────────────┬──────────────────────────────────────┐
 *   │ GroupSide  │ header / toolbar / chips / batch bar │
 *   │  Panel     │ agent table (the scrolling area)     │
 *   └────────────┴──────────────────────────────────────┘
 *
 * The group column is inline from lg with a mouse (and from xl on touch
 * screens, where the pinned sidebar leaves less room); below that it is an
 * off-canvas drawer opened from a "Groups" button in the table toolbar.
 * Both panes use min-h-0 so only the inner areas scroll.
 */
export function AgentsPageLayout({ groupId, onGroupChange, recursive, onRecursiveChange, header }: AgentsPageLayoutProps) {
  const { t } = useTranslation();
  const isLg = useMediaQuery(MEDIA.lg);
  const isXl = useMediaQuery(MEDIA.xl);
  const coarse = useIsCoarsePointer();
  const inlineGroups = isLg && (isXl || !coarse);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const tree = useGroupStore((s) => s.tree);

  // Leaving the drawer layout (rotation / resize) closes it.
  useEffect(() => {
    if (inlineGroups) setGroupsOpen(false);
  }, [inlineGroups]);

  const groupLabel = useMemo(() => {
    if (groupId === null) return t('agents.list.groups.all', 'All agents');
    if (groupId === UNGROUPED) return t('nav.ungrouped', 'Ungrouped');
    return findGroupName(tree, groupId) ?? t('agents.list.groups.title', 'Groups');
  }, [groupId, tree, t]);

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      {inlineGroups && <GroupSidePanel groupId={groupId} onGroupChange={onGroupChange} />}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto max-lg:overscroll-contain">
        <div className="space-y-4 p-3 sm:p-4 lg:p-6">
          {header}
          <AgentTable
            groupId={groupId}
            recursive={recursive}
            onRecursiveChange={onRecursiveChange}
            onOpenGroups={inlineGroups ? undefined : () => setGroupsOpen(true)}
            groupLabel={groupLabel}
          />
        </div>
      </div>
      {!inlineGroups && (
        <Drawer
          open={groupsOpen}
          onClose={() => setGroupsOpen(false)}
          side="left"
          size="md"
          bodyClassName="p-0"
          ariaLabel={t('agents.list.groups.title', 'Groups')}
        >
          <GroupSidePanel
            variant="drawer"
            groupId={groupId}
            onClose={() => setGroupsOpen(false)}
            onGroupChange={(gid) => {
              onGroupChange(gid);
              // Picking a group is the drawer's job done.
              setGroupsOpen(false);
            }}
          />
        </Drawer>
      )}
    </div>
  );
}
