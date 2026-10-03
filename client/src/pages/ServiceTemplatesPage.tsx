import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ListTree, Lock, Pencil, Plus, ScanSearch, Trash2, Unlock } from 'lucide-react';
import type {
  AgentDevice,
  CreateServiceTemplateRequest,
  GroupTreeNode,
  ServiceTemplate,
  UpdateServiceTemplateRequest,
} from '@obliview/shared';
import { serviceTemplatesApi, templateApiError } from '@/api/serviceTemplates.api';
import { agentApi } from '@/api/agent.api';
import { Button } from '@/components/common/Button';
import { MasterDetail } from '@/components/common/MasterDetail';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { useConfirm } from '@/components/common/ConfirmDialog';
import type { ActionMenuItem } from '@/components/common/ActionMenu';
import { TemplateList } from '@/components/serviceTemplates/TemplateList';
import { EDITOR_TABS, TemplateEditor, type EditorTab } from '@/components/serviceTemplates/TemplateEditor';
import { useCan, useIsPlatformAdmin } from '@/hooks/usePermission';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useTabParam } from '@/hooks/useTabParam';
import { useGroupStore } from '@/store/groupStore';
import { useTenantStore } from '@/store/tenantStore';

/** URL parameter holding the selected template (an id, or 'new'). */
const TEMPLATE_PARAM = 'template';

/** The groups of one tenant (god view trees may hold other tenants' groups). */
function ownTree(nodes: GroupTreeNode[], tenantId: number | null): GroupTreeNode[] {
  if (tenantId == null) return nodes;
  return nodes
    .filter((n) => n.tenantId == null || n.tenantId === tenantId)
    .map((n) => ({ ...n, children: ownTree(n.children, tenantId) }));
}

function parseSelection(raw: string | null): number | 'new' | null {
  if (raw === 'new') return 'new';
  const id = raw ? Number(raw) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

interface ServiceTemplatesPageProps {
  /**
   * Rendered inside another page (Policies hub): no PageContainer /
   * PageHeader, and the editor tab lives in ?templateTab= (the hub owns ?tab=).
   */
  embedded?: boolean;
}

/**
 * Service templates (log parsers + thresholds) in a list / detail layout:
 * searchable list with origin badges on the left, tabbed editor
 * (Parser | Thresholds | Assignments | Usage) on the right. The selection is
 * kept in the URL (?template=<id>|new&tab=<tab>).
 *
 * Writes follow the server rules: templates.write for everything; a shared
 * platform template (built-ins included) only from the Default tenant or by
 * a platform admin; a tenant template only by its own tenant.
 */
export function ServiceTemplatesPage({ embedded = false }: ServiceTemplatesPageProps = {}) {
  const { t } = useTranslation();
  const confirmAction = useConfirm();
  const canWrite = useCan('templates.write');
  const isPlatformAdmin = useIsPlatformAdmin();
  const isMaster = useIsMasterTenant();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const tree = useGroupStore((s) => s.tree);
  const fetchTree = useGroupStore((s) => s.fetchTree);

  const [searchParams, setSearchParams] = useSearchParams();
  const selection = parseSelection(searchParams.get(TEMPLATE_PARAM));
  const [tab, setTab] = useTabParam<EditorTab>(EDITOR_TABS, 'parser', { param: embedded ? 'templateTab' : 'tab' });

  const [templates, setTemplates] = useState<ServiceTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<ServiceTemplate | null>(null);
  const [agents, setAgents] = useState<AgentDevice[]>([]);

  const canEditTemplate = useCallback((tpl: ServiceTemplate) => {
    if (!canWrite) return false;
    if (tpl.tenantId == null) return isPlatformAdmin || isMaster;
    return tpl.tenantId === currentTenantId;
  }, [canWrite, isPlatformAdmin, isMaster, currentTenantId]);

  const select = useCallback((next: number | 'new' | null, nextTab?: EditorTab) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === null) p.delete(TEMPLATE_PARAM);
      else p.set(TEMPLATE_PARAM, String(next));
      const tabKey = embedded ? 'templateTab' : 'tab';
      if (nextTab && nextTab !== 'parser') p.set(tabKey, nextTab);
      else if (nextTab || next === 'new' || next === null) p.delete(tabKey);
      return p;
    }, { replace: true });
  }, [setSearchParams, embedded]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await serviceTemplatesApi.list());
    } catch (err) {
      toast.error(templateApiError(err, t('serviceTemplates.errors.load', { defaultValue: 'Failed to load service templates' })));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const selectedId = typeof selection === 'number' ? selection : null;

  // setSearchParams (hence select) changes with every URL update: read it
  // through a ref so a tab switch does not refetch the template. The request
  // sequence drops a late answer for a template no longer selected.
  const selectRef = useRef(select);
  selectRef.current = select;
  const detailSeq = useRef(0);
  const loadDetail = useCallback(async (id: number) => {
    const seq = ++detailSeq.current;
    try {
      const full = await serviceTemplatesApi.get(id);
      if (seq === detailSeq.current) setDetail(full);
    } catch (err) {
      if (seq !== detailSeq.current) return;
      setDetail(null);
      toast.error(templateApiError(err, t('serviceTemplates.errors.loadOne', { defaultValue: 'Failed to load the template' })));
      selectRef.current(null);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  // Group tree + agents: assignment targets and labels.
  useEffect(() => {
    if (tree.length === 0) void fetchTree();
    let cancelled = false;
    agentApi.listDevices()
      .then((list) => { if (!cancelled) setAgents(list); })
      // Labels fall back to "Agent #id" without the device list.
      .catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTenantId]);

  useEffect(() => {
    if (selectedId == null) { detailSeq.current++; setDetail(null); return; }
    setDetail((prev) => (prev?.id === selectedId ? prev : null));
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const ownGroups = useMemo(() => ownTree(tree, currentTenantId), [tree, currentTenantId]);
  const ownAgents = useMemo(
    () => agents.filter((d) => (currentTenantId == null || d.tenantId === currentTenantId) && d.accessLevel !== 'ro'),
    [agents, currentTenantId],
  );

  // ── Actions ──

  const handleSubmit = async (data: CreateServiceTemplateRequest | UpdateServiceTemplateRequest) => {
    if (selection === 'new') {
      try {
        const created = await serviceTemplatesApi.create(data as CreateServiceTemplateRequest);
        toast.success(t('serviceTemplates.toast.created', { defaultValue: 'Template created' }));
        await load();
        select(created.id, 'assignments');
      } catch (err) {
        toast.error(templateApiError(err, t('serviceTemplates.errors.create', { defaultValue: 'Failed to create the template' })));
        throw err;
      }
      return;
    }
    if (!detail) return;
    try {
      const updated = await serviceTemplatesApi.update(detail.id, data as UpdateServiceTemplateRequest);
      toast.success(t('serviceTemplates.toast.updated', { defaultValue: 'Template updated' }));
      setDetail({ ...updated, assignments: detail.assignments });
      void load();
    } catch (err) {
      toast.error(templateApiError(err, t('serviceTemplates.errors.update', { defaultValue: 'Failed to update the template' })));
      throw err;
    }
  };

  const toggleEnabled = async (tpl: ServiceTemplate) => {
    try {
      const updated = await serviceTemplatesApi.update(tpl.id, { enabled: !tpl.enabled });
      toast.success(updated.enabled
        ? t('serviceTemplates.toast.enabled', { defaultValue: 'Template turned on' })
        : t('serviceTemplates.toast.disabled', { defaultValue: 'Template turned off' }));
      setTemplates((list) => list.map((x) => (x.id === tpl.id ? { ...x, ...updated } : x)));
      setDetail((d) => (d?.id === tpl.id ? { ...updated, assignments: d.assignments } : d));
    } catch (err) {
      toast.error(templateApiError(err, t('serviceTemplates.errors.update', { defaultValue: 'Failed to update the template' })));
    }
  };

  const remove = async (tpl: ServiceTemplate) => {
    const ok = await confirmAction({
      title: t('serviceTemplates.actions.delete', { defaultValue: 'Delete template' }),
      message: t('serviceTemplates.deleteConfirm', {
        defaultValue: 'Delete "{{name}}"? Its assignments are removed too. This cannot be undone.',
        name: tpl.name,
      }),
      danger: true,
    });
    if (!ok) return;
    try {
      await serviceTemplatesApi.delete(tpl.id);
      toast.success(t('serviceTemplates.toast.deleted', { defaultValue: 'Template deleted' }));
      if (selectedId === tpl.id) select(null);
      void load();
    } catch (err) {
      toast.error(templateApiError(err, t('serviceTemplates.errors.delete', { defaultValue: 'Failed to delete the template' })));
    }
  };

  const rowActions = (tpl: ServiceTemplate): ActionMenuItem[] => {
    const editable = canEditTemplate(tpl);
    return [
      {
        key: 'edit',
        icon: <Pencil className="h-4 w-4" />,
        label: t('serviceTemplates.actions.edit', { defaultValue: 'Edit' }),
        onClick: () => select(tpl.id, 'parser'),
        hidden: !editable,
      },
      {
        key: 'toggle',
        icon: tpl.enabled ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />,
        label: tpl.enabled
          ? t('serviceTemplates.actions.disable', { defaultValue: 'Turn off by default' })
          : t('serviceTemplates.actions.enable', { defaultValue: 'Turn on by default' }),
        onClick: () => void toggleEnabled(tpl),
        hidden: !editable,
      },
      {
        key: 'assign',
        icon: <ListTree className="h-4 w-4" />,
        label: t('serviceTemplates.actions.assignments', { defaultValue: 'Assignments' }),
        onClick: () => select(tpl.id, 'assignments'),
      },
      {
        key: 'delete',
        icon: <Trash2 className="h-4 w-4" />,
        label: t('serviceTemplates.actions.delete', { defaultValue: 'Delete template' }),
        onClick: () => void remove(tpl),
        danger: true,
        separator: true,
        hidden: !editable || tpl.isBuiltin,
      },
    ];
  };

  // ── Panes ──

  const editorTemplate = selection === 'new' ? null : detail;
  const showEditor = selection === 'new' || (detail != null && detail.id === selectedId);

  const master = (
    <TemplateList
      templates={templates}
      loading={loading}
      selectedId={selection}
      onSelect={(id) => select(id)}
      onRefresh={() => {
        void load();
        if (selectedId != null) void loadDetail(selectedId);
      }}
      onCreate={canWrite ? () => select('new') : undefined}
      rowActions={rowActions}
    />
  );

  const detailPane = showEditor ? (
    <TemplateEditor
      key={editorTemplate?.id ?? 'new'}
      template={editorTemplate}
      tab={tab}
      onTabChange={setTab}
      canEdit={editorTemplate ? canEditTemplate(editorTemplate) : canWrite}
      // A tenant template is only assigned within its own tenant (god view: read-only).
      canAssign={canWrite && (editorTemplate == null || editorTemplate.tenantId == null || editorTemplate.tenantId === currentTenantId)}
      groups={tree}
      agents={agents}
      ownGroups={ownGroups}
      ownAgents={ownAgents}
      onSubmit={handleSubmit}
      onCancelCreate={() => select(null)}
      onToggleEnabled={(tpl) => void toggleEnabled(tpl)}
      onDelete={(tpl) => void remove(tpl)}
      onReload={() => {
        if (selectedId != null) void loadDetail(selectedId);
      }}
    />
  ) : selection !== null ? (
    <div className="flex h-40 items-center justify-center rounded-xl bg-bg-secondary text-sm text-text-muted">
      {t('common.loading', { defaultValue: 'Loading…' })}
    </div>
  ) : null;

  const emptyDetail = (
    <div className="flex flex-col items-center justify-center rounded-xl bg-bg-secondary px-6 py-12 text-center">
      <ScanSearch size={40} strokeWidth={1.5} className="mb-3 text-text-muted" aria-hidden="true" />
      <p className="text-sm font-medium text-text-primary">
        {t('serviceTemplates.empty.selectOne', { defaultValue: 'Select a template, or create one' })}
      </p>
      <p className="mt-2 max-w-lg text-xs text-text-muted">
        {t('serviceTemplates.empty.howItWorks', {
          defaultValue: 'Built-in templates use parsers compiled into the agent; custom templates use a regex with named groups. Assign a template to groups or agents to turn it on or off there or to change its threshold. Ban mode triggers automatic bans; Track only stores events without banning.',
        })}
      </p>
      {canWrite && (
        <Button size="sm" className="mt-4" onClick={() => select('new')}>
          <Plus size={14} className="mr-1" />
          {t('serviceTemplates.actions.new', { defaultValue: 'New template' })}
        </Button>
      )}
    </div>
  );

  const body = (
    <MasterDetail
      master={master}
      detail={detailPane}
      hasDetail={selection !== null}
      onBack={() => select(null)}
      detailTitle={selection === 'new'
        ? t('serviceTemplates.editor.newTitle', { defaultValue: 'New template' })
        : detail?.name}
      emptyDetail={emptyDetail}
      masterClassName="lg:w-80 lg:shrink-0"
    />
  );

  if (embedded) return body;

  return (
    <PageContainer className="space-y-4">
      <PageHeader
        icon={<ScanSearch size={20} />}
        title={t('serviceTemplates.title', { defaultValue: 'Service templates' })}
        description={t('serviceTemplates.subtitle', { defaultValue: 'Log parsing rules and ban thresholds for each service' })}
      />
      {body}
    </PageContainer>
  );
}
