import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Cpu, Plus, Router, Settings2 } from 'lucide-react';
import { AgentsPageLayout } from '@/components/agents/AgentsPageLayout';
import { UNGROUPED } from '@/components/agents/GroupSidePanel';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/common/Button';
import { AddMikroTikModal } from '@/components/mikrotik/AddMikroTikModal';
import { useCan } from '@/hooks/usePermission';
import { useUiStore } from '@/store/uiStore';

/**
 * /agents — the fleet list, open to every tenant member (owner decision:
 * "the fleet is visible to all members, read-only included"); every write is
 * gated by its capability inside AgentTable. Mirrors Obliance
 * DeviceListPage: the selected group (?groupId=, 'none' = ungrouped) and the
 * sub-group switch (?recursive=0) live in the URL next to the table filters
 * (?q=, ?status=, ?type=, ?tenants=). Keys, installers and the update policy
 * stay on the "Agent config" hub (/manage/agents).
 */
export function AgentListPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const openAddAgentModal = useUiStore((s) => s.openAddAgentModal);
  const canAddAgent = useCan('agents.keys');
  const canAddMikroTik = useCan('integrations.mikrotik');
  const canSeeAgentConfig = useCan(['agents.keys', 'agents.approve', 'agents.manage']);
  const [mikrotikOpen, setMikrotikOpen] = useState(false);

  const rawGroup = searchParams.get('groupId');
  const groupId = rawGroup === 'none'
    ? UNGROUPED
    : rawGroup && /^\d{1,9}$/.test(rawGroup) ? Number(rawGroup) : null;
  const recursive = searchParams.get('recursive') !== '0';

  const setParam = (key: string, value: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === null) next.delete(key); else next.set(key, value);
      return next;
    }, { replace: true });
  };

  const header = (
    <PageHeader
      icon={<Cpu size={20} />}
      title={t('agents.list.title', 'Agents')}
      description={t('agents.list.description', 'Every agent and remote device of the workspace: presence, version, activity and enforcement mode.')}
      actions={(
        <>
          {canSeeAgentConfig && (
            <Link
              to="/manage/agents"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-bg-hover coarse:min-h-10"
            >
              <Settings2 size={14} />
              {t('agents.list.config', 'Agent config')}
            </Link>
          )}
          {canAddMikroTik && (
            <Button variant="secondary" size="sm" onClick={() => setMikrotikOpen(true)}>
              <Router size={14} className="mr-1.5" />
              {t('agents.list.addMikroTik', 'Add MikroTik')}
            </Button>
          )}
          {canAddAgent && (
            <Button size="sm" onClick={openAddAgentModal}>
              <Plus size={14} className="mr-1.5" />
              {t('nav.addAgent', 'Add agent')}
            </Button>
          )}
        </>
      )}
    />
  );

  return (
    <>
      <AgentsPageLayout
        groupId={groupId}
        onGroupChange={(gid) => {
          setParam('groupId', gid === null ? null : gid === UNGROUPED ? 'none' : String(gid));
        }}
        recursive={recursive}
        onRecursiveChange={(r) => setParam('recursive', r ? null : '0')}
        header={header}
      />
      {canAddMikroTik && (
        <AddMikroTikModal open={mikrotikOpen} onClose={() => setMikrotikOpen(false)} onCreated={() => toast.success(t('agents.list.mikrotikCreated', 'MikroTik device created'))} />
      )}
    </>
  );
}
