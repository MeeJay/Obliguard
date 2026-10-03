import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, History, TerminalSquare } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { AgentDevice } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import { agentApi } from '@/api/agent.api';
import { LastSeenPill } from '@/components/agent/LastSeenPill';
import { UpdateStatusBadge } from '@/components/agent/UpdateStatusBadge';
import { EmptyState } from '@/components/common/EmptyState';
import { EvaluateOnlyBanner } from '@/components/common/EvaluateOnlyBanner';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { SOCKET_RESYNC_EVENT } from '@/hooks/useSocket';
import { useCan } from '@/hooks/usePermission';
import { useTabParam } from '@/hooks/useTabParam';
import { getSocket } from '@/socket/socketClient';
import { toDevicePatch } from '@/store/agentStore';
import { useGroupStore } from '@/store/groupStore';
import { useSocketStore } from '@/store/socketStore';
import { useTenantStore } from '@/store/tenantStore';
import { isUpdateFailed, visibleUpdateAttempt } from '@/utils/agentUpdate';
import { AgentHeader, type CrossAppLink } from './agentDetail/AgentHeader';
import { GroupChoiceModal } from './agentDetail/GroupChoiceModal';
import { DEFAULT_AGENT_DETAIL_TAB, LEGACY_TAB_ALIASES, agentActions, type AgentDetailTab } from './agentDetail/model';
import { AGENT_DETAIL_TAB_DEFS, type AgentDetailTabContext, type AgentDetailTabDef } from './agentDetail/tabs';
import { TimelineTab, TIMELINE_TAB_ID } from './agentDetail/TimelineTab';
import { CommandsTab, COMMANDS_TAB_ID } from './agentDetail/CommandsTab';
import { useAgentLifecycle } from './agentDetail/useAgentLifecycle';
import { useAgentWatch } from './agentDetail/useAgentWatch';

// ── Agent detail page (shell) ─────────────────────────────────────────────────
//
// Mirrors Obliance DeviceDetailPage: a lifecycle header (status, last seen,
// tenant, group, update state, Approve / Refuse, Actions menu), a labelled tab
// bar synced to ?tab=, and one component per tab (agentDetail/tabs.tsx).
// This file owns the device row, its live updates and the agent watch; the
// tabs own their data.

/**
 * Timeline tab (W13-2): bans, attacks, updates, outages, approvals and the
 * agent's audit rows (it absorbed the W11-1 Activity tab). Not in
 * model.AGENT_DETAIL_TABS / tabs.tsx yet (files of another lot), so it is
 * appended to the registry here with a widened id.
 */
const TIMELINE_TAB_DEF: AgentDetailTabDef = {
  id: TIMELINE_TAB_ID as AgentDetailTab,
  icon: History,
  labelKey: 'agentDetail.tabs.timeline',
  defaultLabel: 'Timeline',
  render: (ctx) => <TimelineTab {...ctx} />,
};
/**
 * Commands tab (W14-1): the agent's command queue (restart, firewall resync,
 * uninstall) with acknowledgement, result and history. Agents only (not
 * routers); appended here like the Timeline tab (model / tabs.tsx belong to
 * another lot).
 */
const COMMANDS_TAB_DEF: AgentDetailTabDef = {
  id: COMMANDS_TAB_ID as AgentDetailTab,
  icon: TerminalSquare,
  labelKey: 'agentDetail.tabs.commands',
  defaultLabel: 'Commands',
  visible: (device) => device.deviceType === 'agent',
  render: (ctx) => <CommandsTab {...ctx} />,
};
const TAB_DEFS: ReadonlyArray<AgentDetailTabDef> = [...AGENT_DETAIL_TAB_DEFS, TIMELINE_TAB_DEF, COMMANDS_TAB_DEF];

/** ?tab= bookmarks of tabs merged into another one (the W11-1 Activity tab). */
const MERGED_TAB_ALIASES: Readonly<Record<string, AgentDetailTab>> = {
  activity: TIMELINE_TAB_ID as AgentDetailTab,
};

export function AgentDetailPage() {
  const { t } = useTranslation();
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const parsedId = deviceId ? Number.parseInt(deviceId, 10) : Number.NaN;
  const devId = Number.isFinite(parsedId) && parsedId > 0 ? parsedId : null;
  const currentTenantId = useTenantStore(s => s.currentTenantId);

  // ── Device row ─────────────────────────────────────────────────────────────
  const [device,        setDevice]        = useState<AgentDevice | null>(null);
  const [deviceLoading, setDeviceLoading] = useState(true);
  const [deleted,       setDeleted]       = useState(false);
  const [refreshKey,    setRefreshKey]    = useState(0);
  const [refreshing,    setRefreshing]    = useState(false);

  const reloadDevice = useCallback(async () => {
    if (!devId) return;
    const d = await agentApi.getDeviceById(devId);
    if (d) setDevice(d);
  }, [devId]);

  useEffect(() => {
    if (!devId) { setDeviceLoading(false); return; }
    let cancelled = false;
    setDeviceLoading(true);
    setDeleted(false);
    agentApi.getDeviceById(devId)
      .then(d => { if (!cancelled) setDevice(d); })
      .finally(() => { if (!cancelled) setDeviceLoading(false); });
    return () => { cancelled = true; };
  }, [devId]);

  // The group chip and the update-policy source need the group tree.
  const groupTreeEmpty = useGroupStore(s => s.tree.length === 0);
  const fetchGroupTree = useGroupStore(s => s.fetchTree);
  useEffect(() => { if (groupTreeEmpty) void fetchGroupTree(); }, [groupTreeEmpty, fetchGroupTree]);

  // ── Cross-app links (Obliview / Obliance... of the same host) ─────────────
  const [crossAppLinks, setCrossAppLinks] = useState<CrossAppLink[]>([]);
  useEffect(() => {
    setCrossAppLinks([]); // never show the previous agent's links
    if (!device?.uuid) return;
    let cancelled = false;
    fetch(`/api/auth/device-links?uuid=${encodeURIComponent(device.uuid)}`, { credentials: 'include' })
      .then(r => r.json())
      .then((d: { success: boolean; data?: CrossAppLink[] }) => {
        if (!cancelled && d.success && d.data) setCrossAppLinks(d.data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [device?.uuid]);

  // ── Live updates: channel state, device patches, deletion ─────────────────
  const socketGeneration = useSocketStore(s => s.generation);
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !devId) return;
    function handleStatus(data: { deviceId: number; wsConnected?: boolean }) {
      if (data.deviceId !== devId || data.wsConnected === undefined) return;
      setDevice(prev => prev ? { ...prev, wsConnected: data.wsConnected! } : prev);
    }
    // {deviceId, patch}: update attempt phase, presence (lastSeenAt), policy...
    function handleDeviceUpdated(data: unknown) {
      const p = toDevicePatch(data);
      if (!p || p.deviceId !== devId) return;
      const fields = Object.fromEntries(
        Object.entries(p.patch).filter(([k, v]) => v !== undefined && k !== 'id'),
      ) as Partial<AgentDevice>;
      if (Object.keys(fields).length === 0) return;
      setDevice(prev => prev ? { ...prev, ...fields } : prev);
    }
    function handleDeleted(data: { deviceId?: number }) {
      if (data?.deviceId === devId) setDeleted(true);
    }
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, handleStatus);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, handleDeviceUpdated);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_DELETED, handleDeleted);
    return () => {
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, handleStatus);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, handleDeviceUpdated);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_DELETED, handleDeleted);
    };
  }, [devId, socketGeneration]);

  // Reload after a socket reconnect (status may have moved meanwhile); the
  // tabs reload their own data on the same event.
  useEffect(() => {
    const onResync = () => { void reloadDevice().catch(() => {}); };
    window.addEventListener(SOCKET_RESYNC_EVENT, onResync);
    return () => window.removeEventListener(SOCKET_RESYNC_EVENT, onResync);
  }, [reloadDevice]);

  // Live IP activity of this agent for every tab (renewed, left on unmount).
  useAgentWatch(device && !deleted ? device.id : null);

  // ── Permissions ────────────────────────────────────────────────────────────
  // Another tenant's agent (Default god view): read-only here — the server
  // refuses writes with 403; switch to its tenant to change it.
  const foreign = !!device && currentTenantId != null && device.tenantId != null && device.tenantId !== currentTenantId;
  // A read-only team grant (RBAC-8) hides every write as well.
  const readOnly = foreign || device?.accessLevel === 'ro';
  const canManage  = useCan('agents.manage');
  const canApprove = useCan('agents.approve');
  const canUpdate  = useCan('agents.update');
  const canDelete  = useCan('agents.delete');

  const updateShown = device?.deviceType === 'agent' ? visibleUpdateAttempt(device) : null;
  const actions = useMemo(() => device
    ? agentActions(device, { canManage, canApprove, canUpdate, canDelete, foreign, updateFailed: isUpdateFailed(updateShown) })
    : null, [device, canManage, canApprove, canUpdate, canDelete, foreign, updateShown]);

  // ── Lifecycle actions + their dialogs ──────────────────────────────────────
  const onDeleted = useCallback(() => navigate('/agents', { replace: true }), [navigate]);
  const lifecycle = useAgentLifecycle(device, setDevice, onDeleted);
  const [groupDialog, setGroupDialog] = useState<'approve' | 'move' | null>(null);

  const rename = useCallback(async (name: string | null) => {
    if (!device) return;
    try {
      setDevice(await agentApi.updateDevice(device.id, { name }));
    } catch (err) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? t('agentDetail.renameFailed', { defaultValue: 'Failed to rename the agent' }));
    }
  }, [device, t]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshKey(k => k + 1);
    try { await reloadDevice(); } catch { /* the tabs show their own errors */ } finally { setRefreshing(false); }
  }, [reloadDevice]);

  // ── Tabs (?tab=, labelled bar) ─────────────────────────────────────────────
  // Timeline is shown to every reader of the agent; its audit rows (the
  // former Activity tab) only reach audit.read holders (server-side).
  const visibleDefs = useMemo(
    () => TAB_DEFS.filter(def => !device || !def.visible || def.visible(device)),
    [device],
  );
  const visibleIds = useMemo(() => visibleDefs.map(def => def.id), [visibleDefs]);
  const [tab, setTab] = useTabParam<AgentDetailTab>(visibleIds, DEFAULT_AGENT_DETAIL_TAB);
  // Bookmarks of the former icon rail (?tab=starmap / netlimits) and of the
  // Activity tab (?tab=activity) land on the tab now holding them.
  const [searchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  useEffect(() => {
    const alias = rawTab ? LEGACY_TAB_ALIASES[rawTab] ?? MERGED_TAB_ALIASES[rawTab] : undefined;
    if (alias && visibleIds.includes(alias)) setTab(alias);
  }, [rawTab, visibleIds, setTab]);

  // ── Loading / not found ────────────────────────────────────────────────────
  if (deviceLoading) {
    return <div className="flex items-center justify-center h-64"><LoadingSpinner /></div>;
  }
  if (!device || deleted || !actions) {
    return (
      <PageContainer>
        <EmptyState
          title={deleted
            ? t('agentDetail.deletedTitle', { defaultValue: 'This agent was deleted' })
            : t('agentDetail.notFound', { defaultValue: 'Agent not found' })}
          action={
            <Link to="/agents" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
              <ArrowLeft size={14} />
              {t('agentDetail.backToAgents', { defaultValue: 'Agents' })}
            </Link>
          }
        />
      </PageContainer>
    );
  }

  const activeDef = visibleDefs.find(def => def.id === tab) ?? visibleDefs[0];
  const tabContext: AgentDetailTabContext = {
    device,
    onDeviceChange: setDevice,
    readOnly,
    refreshKey,
    actions,
    lifecycle,
    onMoveGroup: () => setGroupDialog('move'),
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <PageContainer className="space-y-4">
      <AgentHeader
        device={device}
        actions={actions}
        lifecycle={lifecycle}
        lastSeen={<LastSeenPill lastSeenAt={device.lastSeenAt} />}
        updateBadge={device.deviceType === 'agent' && (
          // Retry: agents.update in the agent's own tenant; the server refuses it under 'off' (409).
          <UpdateStatusBadge
            device={device}
            canRetry={!readOnly && canUpdate && device.status === 'approved' && device.resolvedUpdatePolicy !== 'off'}
            onRetried={setDevice}
          />
        )}
        crossAppLinks={crossAppLinks}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        onRename={rename}
        onApprove={() => setGroupDialog('approve')}
        onMoveGroup={() => setGroupDialog('move')}
      />

      {/* ── Foreign-tenant / read-only grant banner ────────────────────────── */}
      {readOnly && (
        <div className="rounded-lg border border-border bg-bg-secondary px-4 py-2.5 text-sm text-text-secondary">
          {foreign
            ? t('agents.foreignReadOnly', 'This agent belongs to another tenant. It is read-only here: switch to its tenant to change it.')
            : t('agentDetail.readOnlyGrant', { defaultValue: 'Your team has read-only access to this agent.' })}
        </div>
      )}

      {/* ── Evaluate-only banner ───────────────────────────────────────────── */}
      {device.evaluateOnly && <EvaluateOnlyBanner source={device.evaluateOnlySource} />}

      {/* ── Labelled tab bar (mirrors Obliance DeviceDetailPage) ───────────── */}
      <SegmentedTabs
        tabs={visibleDefs.map(def => {
          const Icon = def.icon;
          return { id: def.id, label: t(def.labelKey, { defaultValue: def.defaultLabel }), icon: <Icon className="w-4 h-4" /> };
        })}
        value={activeDef.id}
        onChange={setTab}
        fill={false}
        ariaLabel={t('agentDetail.tabs.label', { defaultValue: 'Agent sections' })}
      />

      <div role="tabpanel" aria-label={t(activeDef.labelKey, { defaultValue: activeDef.defaultLabel })}>
        {activeDef.render(tabContext)}
      </div>

      {/* A group in the approval PATCH also needs agents.manage (the rename gate). */}
      {groupDialog && (
        <GroupChoiceModal
          mode={groupDialog}
          hostname={device.name ?? device.hostname}
          initialGroupId={device.groupId}
          busy={lifecycle.busy === (groupDialog === 'approve' ? 'approve' : 'moveGroup')}
          canPickGroup={actions.rename}
          onConfirm={groupDialog === 'approve' ? lifecycle.approve : (groupId) => lifecycle.moveGroup(groupId ?? null)}
          onClose={() => setGroupDialog(null)}
        />
      )}
    </PageContainer>
  );
}
