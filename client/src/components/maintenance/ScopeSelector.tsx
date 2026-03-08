import { useState, useEffect, useRef } from 'react';
import { Globe, Monitor, Server, Folder, RefreshCw, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MonitorGroup, AgentDevice, MaintenanceScopeType } from '@obliview/shared';
import type { Monitor as MonitorType } from '@/store/monitorStore';
import { groupsApi } from '@/api/groups.api';
import { monitorsApi } from '@/api/monitors.api';
import { agentApi } from '@/api/agent.api';
import { cn } from '@/utils/cn';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScopeTarget {
  scopeType: MaintenanceScopeType;
  scopeId: number | null;
  /** Children to disable after creating the group-scoped window */
  disables?: Array<{ scopeType: 'agent'; scopeId: number }>;
}

// ── Internal selection state ──────────────────────────────────────────────────

interface Selection {
  global: boolean;
  /** Monitor groups whose entire content is selected */
  monitorGroupIds: Set<number>;
  /** Monitors explicitly excluded from a selected parent group */
  deselectedMonitorIds: Set<number>;
  /** Monitors selected individually (not via a group) */
  individualMonitorIds: Set<number>;
  /** Agent groups whose entire content is selected */
  agentGroupIds: Set<number>;
  /** Agents explicitly excluded from a selected parent group */
  deselectedAgentIds: Set<number>;
  /** Agents selected individually */
  individualAgentIds: Set<number>;
}

function emptySelection(): Selection {
  return {
    global: false,
    monitorGroupIds: new Set(),
    deselectedMonitorIds: new Set(),
    individualMonitorIds: new Set(),
    agentGroupIds: new Set(),
    deselectedAgentIds: new Set(),
    individualAgentIds: new Set(),
  };
}

function cloneSelection(s: Selection): Selection {
  return {
    global: s.global,
    monitorGroupIds: new Set(s.monitorGroupIds),
    deselectedMonitorIds: new Set(s.deselectedMonitorIds),
    individualMonitorIds: new Set(s.individualMonitorIds),
    agentGroupIds: new Set(s.agentGroupIds),
    deselectedAgentIds: new Set(s.deselectedAgentIds),
    individualAgentIds: new Set(s.individualAgentIds),
  };
}

function resolveTargets(
  sel: Selection,
  _monitorsByGroup: Map<number, MonitorType[]>,
  agentsByGroup: Map<number, AgentDevice[]>,
): ScopeTarget[] {
  if (sel.global) return [{ scopeType: 'global', scopeId: null }];

  const targets: ScopeTarget[] = [];

  for (const gId of sel.monitorGroupIds) {
    // Monitor groups/monitors are no longer used in Obliguard
    targets.push({ scopeType: 'group', scopeId: gId, disables: undefined });
  }

  // individualMonitorIds are no longer used in Obliguard

  for (const gId of sel.agentGroupIds) {
    const disables = (agentsByGroup.get(gId) ?? [])
      .filter((a) => sel.deselectedAgentIds.has(a.id))
      .map((a) => ({ scopeType: 'agent' as const, scopeId: a.id }));
    targets.push({ scopeType: 'group', scopeId: gId, disables: disables.length ? disables : undefined });
  }

  for (const aId of sel.individualAgentIds) {
    targets.push({ scopeType: 'agent', scopeId: aId });
  }

  return targets;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  defaultScopeType?: MaintenanceScopeType;
  defaultScopeId?: number;
  onChange: (targets: ScopeTarget[]) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ScopeSelector({ defaultScopeType, defaultScopeId, onChange }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [monitorGroups, setMonitorGroups] = useState<MonitorGroup[]>([]);
  const [agentGroups, setAgentGroups] = useState<MonitorGroup[]>([]);
  const [monitorsByGroup, setMonitorsByGroup] = useState<Map<number, MonitorType[]>>(new Map());
  const [agentsByGroup, setAgentsByGroup] = useState<Map<number, AgentDevice[]>>(new Map());
  const [ungroupedMonitors, setUngroupedMonitors] = useState<MonitorType[]>([]);
  const [ungroupedAgents, setUngroupedAgents] = useState<AgentDevice[]>([]);
  const [sel, setSel] = useState<Selection>(emptySelection());

  // Refs for the scrollable columns — used by auto-scroll on pre-selection
  const monitorScrollRef = useRef<HTMLDivElement>(null);
  const agentScrollRef = useRef<HTMLDivElement>(null);

  // ── Load data once on mount ────────────────────────────────────────────────

  useEffect(() => {
    let mounted = true;
    Promise.all([groupsApi.list(), monitorsApi.list(), agentApi.listDevices()])
      .then(([groups, monitors, devices]) => {
        if (!mounted) return;

        const mGroups: MonitorGroup[] = []; // monitors removed from Obliguard
        const aGroups = groups.filter((g: MonitorGroup) => g.kind === 'agent');

        const mByGroup = new Map<number, MonitorType[]>();
        const ungM: MonitorType[] = [];
        for (const m of monitors) {
          if (m.groupId !== null) {
            if (!mByGroup.has(m.groupId)) mByGroup.set(m.groupId, []);
            mByGroup.get(m.groupId)!.push(m);
          } else {
            ungM.push(m);
          }
        }

        const approved = devices.filter((a: AgentDevice) => a.status === 'approved');
        const aByGroup = new Map<number, AgentDevice[]>();
        const ungA: AgentDevice[] = [];
        for (const a of approved) {
          if (a.groupId !== null) {
            if (!aByGroup.has(a.groupId)) aByGroup.set(a.groupId, []);
            aByGroup.get(a.groupId)!.push(a);
          } else {
            ungA.push(a);
          }
        }

        // Sort everything alphabetically — same visual order as the sidebar
        mGroups.sort((a: MonitorGroup, b: MonitorGroup) => a.name.localeCompare(b.name));
        aGroups.sort((a: MonitorGroup, b: MonitorGroup) => a.name.localeCompare(b.name));
        mByGroup.forEach((arr) => arr.sort((a: MonitorType, b: MonitorType) => a.name.localeCompare(b.name)));
        aByGroup.forEach((arr) => arr.sort((a: AgentDevice, b: AgentDevice) => (a.name ?? a.hostname).localeCompare(b.name ?? b.hostname)));
        ungM.sort((a: MonitorType, b: MonitorType) => a.name.localeCompare(b.name));
        ungA.sort((a: AgentDevice, b: AgentDevice) => (a.name ?? a.hostname).localeCompare(b.name ?? b.hostname));

        setMonitorGroups(mGroups);
        setAgentGroups(aGroups);
        setMonitorsByGroup(mByGroup);
        setAgentsByGroup(aByGroup);
        setUngroupedMonitors(ungM);
        setUngroupedAgents(ungA);
        setLoading(false);

        // Apply pre-selection if provided
        if (defaultScopeType && defaultScopeId !== undefined) {
          const init = emptySelection();
          if (defaultScopeType === 'global') {
            init.global = true;
          } else if (defaultScopeType === 'group') {
            const g = groups.find((gr: MonitorGroup) => gr.id === defaultScopeId);
            if (g?.kind === 'agent') init.agentGroupIds.add(defaultScopeId);
          } else if (defaultScopeType === 'agent') {
            init.individualAgentIds.add(defaultScopeId);
          }
          setSel(init);
          onChange(resolveTargets(init, mByGroup, aByGroup));
        }
      })
      .catch(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-scroll to pre-selected element once data is loaded ───────────────
  useEffect(() => {
    if (loading || !defaultScopeType || defaultScopeId === undefined) return;

    const timer = setTimeout(() => {
      // Determine which column to scroll and the item key
      let column: HTMLDivElement | null = null;
      let key: string | null = null;

      if (defaultScopeType === 'group') {
        if (agentGroups.some((g) => g.id === defaultScopeId)) {
          column = agentScrollRef.current;
          key = `group-${defaultScopeId}`;
        } else {
          column = monitorScrollRef.current;
          key = `group-${defaultScopeId}`;
        }
      } else if (defaultScopeType === 'agent') {
        column = agentScrollRef.current;
        key = `agent-${defaultScopeId}`;
      }

      if (column && key) {
        const el = column.querySelector<HTMLElement>(`[data-item-key="${key}"]`);
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 60);

    return () => clearTimeout(timer);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Update helper ──────────────────────────────────────────────────────────

  function update(next: Selection) {
    setSel(next);
    onChange(resolveTargets(next, monitorsByGroup, agentsByGroup));
  }

  // ── Toggle: Global ─────────────────────────────────────────────────────────

  function toggleGlobal() {
    if (sel.global) {
      update(emptySelection());
    } else {
      const next = emptySelection();
      next.global = true;
      update(next);
    }
  }

  // ── Toggle: All monitors / all agents (column headers) ────────────────────

  function toggleAllMonitors() {
    const everyGroupSelected = monitorGroups.length > 0 && monitorGroups.every((g) => sel.monitorGroupIds.has(g.id));
    const everyUngroupedSelected = ungroupedMonitors.every((m) => sel.individualMonitorIds.has(m.id));
    const allSelected = everyGroupSelected && everyUngroupedSelected;

    const next = cloneSelection(sel);
    next.global = false;

    if (allSelected) {
      for (const g of monitorGroups) {
        next.monitorGroupIds.delete(g.id);
        (monitorsByGroup.get(g.id) ?? []).forEach((m) => next.deselectedMonitorIds.delete(m.id));
      }
      for (const m of ungroupedMonitors) next.individualMonitorIds.delete(m.id);
    } else {
      for (const g of monitorGroups) {
        next.monitorGroupIds.add(g.id);
        (monitorsByGroup.get(g.id) ?? []).forEach((m) => {
          next.individualMonitorIds.delete(m.id);
          next.deselectedMonitorIds.delete(m.id);
        });
      }
      for (const m of ungroupedMonitors) next.individualMonitorIds.add(m.id);
    }
    update(next);
  }

  function toggleAllAgents() {
    const everyGroupSelected = agentGroups.length > 0 && agentGroups.every((g) => sel.agentGroupIds.has(g.id));
    const everyUngroupedSelected = ungroupedAgents.every((a) => sel.individualAgentIds.has(a.id));
    const allSelected = everyGroupSelected && everyUngroupedSelected;

    const next = cloneSelection(sel);
    next.global = false;

    if (allSelected) {
      for (const g of agentGroups) {
        next.agentGroupIds.delete(g.id);
        (agentsByGroup.get(g.id) ?? []).forEach((a) => next.deselectedAgentIds.delete(a.id));
      }
      for (const a of ungroupedAgents) next.individualAgentIds.delete(a.id);
    } else {
      for (const g of agentGroups) {
        next.agentGroupIds.add(g.id);
        (agentsByGroup.get(g.id) ?? []).forEach((a) => {
          next.individualAgentIds.delete(a.id);
          next.deselectedAgentIds.delete(a.id);
        });
      }
      for (const a of ungroupedAgents) next.individualAgentIds.add(a.id);
    }
    update(next);
  }

  // ── Toggle: Monitor groups & children ─────────────────────────────────────

  function toggleMonitorGroup(gId: number) {
    const gMons = monitorsByGroup.get(gId) ?? [];
    const next = cloneSelection(sel);
    next.global = false;

    if (next.monitorGroupIds.has(gId)) {
      // Deselect (whether fully or partially selected)
      next.monitorGroupIds.delete(gId);
      gMons.forEach((m) => next.deselectedMonitorIds.delete(m.id));
    } else {
      next.monitorGroupIds.add(gId);
      gMons.forEach((m) => {
        next.individualMonitorIds.delete(m.id);
        next.deselectedMonitorIds.delete(m.id);
      });
    }
    update(next);
  }

  function toggleMonitorChild(monitorId: number, groupId: number) {
    const next = cloneSelection(sel);
    if (!next.monitorGroupIds.has(groupId)) return; // group not selected, noop

    if (next.deselectedMonitorIds.has(monitorId)) {
      // Re-include in group
      next.deselectedMonitorIds.delete(monitorId);
    } else {
      // Exclude from group
      next.deselectedMonitorIds.add(monitorId);
      // If every child is now excluded, deselect the group entirely
      const gMons = monitorsByGroup.get(groupId) ?? [];
      if (gMons.length > 0 && gMons.every((m) => next.deselectedMonitorIds.has(m.id))) {
        next.monitorGroupIds.delete(groupId);
        gMons.forEach((m) => next.deselectedMonitorIds.delete(m.id));
      }
    }
    update(next);
  }

  function toggleIndividualMonitor(monitorId: number) {
    const next = cloneSelection(sel);
    next.global = false;
    if (next.individualMonitorIds.has(monitorId)) next.individualMonitorIds.delete(monitorId);
    else next.individualMonitorIds.add(monitorId);
    update(next);
  }

  // ── Toggle: Agent groups & children ───────────────────────────────────────

  function toggleAgentGroup(gId: number) {
    const gAgents = agentsByGroup.get(gId) ?? [];
    const next = cloneSelection(sel);
    next.global = false;

    if (next.agentGroupIds.has(gId)) {
      next.agentGroupIds.delete(gId);
      gAgents.forEach((a) => next.deselectedAgentIds.delete(a.id));
    } else {
      next.agentGroupIds.add(gId);
      gAgents.forEach((a) => {
        next.individualAgentIds.delete(a.id);
        next.deselectedAgentIds.delete(a.id);
      });
    }
    update(next);
  }

  function toggleAgentChild(agentId: number, groupId: number) {
    const next = cloneSelection(sel);
    if (!next.agentGroupIds.has(groupId)) return;

    if (next.deselectedAgentIds.has(agentId)) {
      next.deselectedAgentIds.delete(agentId);
    } else {
      next.deselectedAgentIds.add(agentId);
      const gAgents = agentsByGroup.get(groupId) ?? [];
      if (gAgents.length > 0 && gAgents.every((a) => next.deselectedAgentIds.has(a.id))) {
        next.agentGroupIds.delete(groupId);
        gAgents.forEach((a) => next.deselectedAgentIds.delete(a.id));
      }
    }
    update(next);
  }

  function toggleIndividualAgent(agentId: number) {
    const next = cloneSelection(sel);
    next.global = false;
    if (next.individualAgentIds.has(agentId)) next.individualAgentIds.delete(agentId);
    else next.individualAgentIds.add(agentId);
    update(next);
  }

  // ── State queries ──────────────────────────────────────────────────────────

  function monitorGroupState(gId: number): 'selected' | 'partial' | 'none' {
    if (!sel.monitorGroupIds.has(gId)) return 'none';
    const deselCount = (monitorsByGroup.get(gId) ?? []).filter((m) => sel.deselectedMonitorIds.has(m.id)).length;
    return deselCount === 0 ? 'selected' : 'partial';
  }

  function agentGroupState(gId: number): 'selected' | 'partial' | 'none' {
    if (!sel.agentGroupIds.has(gId)) return 'none';
    const deselCount = (agentsByGroup.get(gId) ?? []).filter((a) => sel.deselectedAgentIds.has(a.id)).length;
    return deselCount === 0 ? 'selected' : 'partial';
  }

  function isMonitorEffective(m: MonitorType): boolean {
    if (sel.global) return true;
    if (m.groupId !== null && sel.monitorGroupIds.has(m.groupId)) return !sel.deselectedMonitorIds.has(m.id);
    return sel.individualMonitorIds.has(m.id);
  }

  function isMonitorExcluded(m: MonitorType): boolean {
    return m.groupId !== null && sel.monitorGroupIds.has(m.groupId) && sel.deselectedMonitorIds.has(m.id);
  }

  function isAgentEffective(a: AgentDevice): boolean {
    if (sel.global) return true;
    if (a.groupId !== null && sel.agentGroupIds.has(a.groupId)) return !sel.deselectedAgentIds.has(a.id);
    return sel.individualAgentIds.has(a.id);
  }

  function isAgentExcluded(a: AgentDevice): boolean {
    return a.groupId !== null && sel.agentGroupIds.has(a.groupId) && sel.deselectedAgentIds.has(a.id);
  }

  const allMonitorsSel =
    (monitorGroups.length > 0 || ungroupedMonitors.length > 0) &&
    monitorGroups.every((g) => sel.monitorGroupIds.has(g.id)) &&
    ungroupedMonitors.every((m) => sel.individualMonitorIds.has(m.id));

  const allAgentsSel =
    (agentGroups.length > 0 || ungroupedAgents.length > 0) &&
    agentGroups.every((g) => sel.agentGroupIds.has(g.id)) &&
    ungroupedAgents.every((a) => sel.individualAgentIds.has(a.id));

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-text-muted">
        <RefreshCw size={14} className="animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-2">

      {/* ── Global ────────────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={toggleGlobal}
        className={cn(
          'w-full flex items-center gap-2.5 px-3 py-2 rounded-md border text-sm font-medium transition-all',
          sel.global
            ? 'bg-purple-600/20 border-purple-500/40 text-purple-300'
            : 'bg-bg-tertiary border-border text-text-secondary hover:border-purple-500/30 hover:text-text-primary',
        )}
      >
        <Globe size={14} className={sel.global ? 'text-purple-400' : 'text-text-muted'} />
        <span className="flex-1 text-left">{t('maintenance.scopeGlobalBtn')}</span>
        {sel.global && <Check size={13} className="text-purple-400 shrink-0" />}
      </button>

      {/* ── Two columns ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">

        {/* ── Monitors column ─────────────────────────────────────────────── */}
        <div className="rounded-md border border-border flex flex-col overflow-hidden">
          {/* Column header — click to select/deselect all monitors */}
          <button
            type="button"
            onClick={toggleAllMonitors}
            className={cn(
              'flex items-center gap-2 px-2.5 py-1.5 border-b border-border text-xs font-semibold uppercase tracking-wider transition-colors shrink-0',
              allMonitorsSel
                ? 'bg-blue-600/20 text-blue-300'
                : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            <Monitor size={11} className={allMonitorsSel ? 'text-blue-400' : ''} />
            <span className="flex-1 text-left">{t('maintenance.colMonitors')}</span>
            {allMonitorsSel && <Check size={11} className="text-blue-400" />}
          </button>

          {/* Scrollable list */}
          <div ref={monitorScrollRef} className="overflow-y-auto max-h-52 p-1 space-y-px">
            {monitorGroups.length === 0 && ungroupedMonitors.length === 0 && (
              <p className="text-xs text-text-muted px-2 py-3 text-center">{t('maintenance.noMonitorsInList')}</p>
            )}

            {monitorGroups.map((g) => {
              const state = monitorGroupState(g.id);
              const gMons = monitorsByGroup.get(g.id) ?? [];
              return (
                <div key={g.id}>
                  {/* Group row */}
                  <button
                    type="button"
                    data-item-key={`group-${g.id}`}
                    onClick={() => toggleMonitorGroup(g.id)}
                    className={cn(
                      'w-full flex items-center gap-1.5 px-2 py-1 rounded text-sm text-left transition-colors',
                      state !== 'none'
                        ? 'bg-blue-600/20 text-blue-300'
                        : 'text-text-secondary hover:bg-white/5',
                    )}
                  >
                    <Folder size={12} className={state !== 'none' ? 'text-blue-400 shrink-0' : 'text-text-muted shrink-0'} />
                    <span className="flex-1 truncate font-medium">{g.name}</span>
                    {state === 'partial' && (
                      <span className="text-[9px] text-blue-400/70 font-bold shrink-0 ml-1">{t('maintenance.partialLabel')}</span>
                    )}
                    {state === 'selected' && <Check size={11} className="text-blue-400 shrink-0" />}
                  </button>

                  {/* Monitor children */}
                  {gMons.map((m) => {
                    const excluded = isMonitorExcluded(m);
                    const effective = isMonitorEffective(m);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        data-item-key={`monitor-${m.id}`}
                        onClick={() =>
                          state !== 'none'
                            ? toggleMonitorChild(m.id, g.id)
                            : toggleIndividualMonitor(m.id)
                        }
                        className={cn(
                          'w-full flex items-center gap-1.5 pl-5 pr-2 py-0.5 rounded text-xs text-left transition-colors',
                          excluded
                            ? 'text-red-400/60 line-through bg-red-500/5 hover:bg-red-500/10'
                            : effective
                              ? 'bg-blue-600/10 text-blue-300/80'
                              : 'text-text-muted hover:bg-white/5',
                        )}
                      >
                        <Monitor size={10} className="shrink-0" />
                        <span className="truncate">{m.name}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {/* Ungrouped monitors */}
            {ungroupedMonitors.length > 0 && (
              <>
                {monitorGroups.length > 0 && (
                  <div className="px-2 pt-1.5 pb-0.5">
                    <span className="text-[9px] text-text-muted font-semibold uppercase tracking-wider">{t('maintenance.noGroupLabel')}</span>
                  </div>
                )}
                {ungroupedMonitors.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    data-item-key={`monitor-${m.id}`}
                    onClick={() => toggleIndividualMonitor(m.id)}
                    className={cn(
                      'w-full flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-left transition-colors',
                      isMonitorEffective(m)
                        ? 'bg-blue-600/10 text-blue-300/80'
                        : 'text-text-muted hover:bg-white/5',
                    )}
                  >
                    <Monitor size={10} className="shrink-0" />
                    <span className="truncate">{m.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>

        {/* ── Agents column ───────────────────────────────────────────────── */}
        <div className="rounded-md border border-border flex flex-col overflow-hidden">
          {/* Column header */}
          <button
            type="button"
            onClick={toggleAllAgents}
            className={cn(
              'flex items-center gap-2 px-2.5 py-1.5 border-b border-border text-xs font-semibold uppercase tracking-wider transition-colors shrink-0',
              allAgentsSel
                ? 'bg-blue-600/20 text-blue-300'
                : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            <Server size={11} className={allAgentsSel ? 'text-blue-400' : ''} />
            <span className="flex-1 text-left">{t('maintenance.colAgents')}</span>
            {allAgentsSel && <Check size={11} className="text-blue-400" />}
          </button>

          {/* Scrollable list */}
          <div ref={agentScrollRef} className="overflow-y-auto max-h-52 p-1 space-y-px">
            {agentGroups.length === 0 && ungroupedAgents.length === 0 && (
              <p className="text-xs text-text-muted px-2 py-3 text-center">{t('maintenance.noAgentsInList')}</p>
            )}

            {agentGroups.map((g) => {
              const state = agentGroupState(g.id);
              const gAgents = agentsByGroup.get(g.id) ?? [];
              return (
                <div key={g.id}>
                  <button
                    type="button"
                    data-item-key={`group-${g.id}`}
                    onClick={() => toggleAgentGroup(g.id)}
                    className={cn(
                      'w-full flex items-center gap-1.5 px-2 py-1 rounded text-sm text-left transition-colors',
                      state !== 'none'
                        ? 'bg-blue-600/20 text-blue-300'
                        : 'text-text-secondary hover:bg-white/5',
                    )}
                  >
                    <Folder size={12} className={state !== 'none' ? 'text-blue-400 shrink-0' : 'text-text-muted shrink-0'} />
                    <span className="flex-1 truncate font-medium">{g.name}</span>
                    {state === 'partial' && (
                      <span className="text-[9px] text-blue-400/70 font-bold shrink-0 ml-1">{t('maintenance.partialLabel')}</span>
                    )}
                    {state === 'selected' && <Check size={11} className="text-blue-400 shrink-0" />}
                  </button>

                  {gAgents.map((a) => {
                    const excluded = isAgentExcluded(a);
                    const effective = isAgentEffective(a);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        data-item-key={`agent-${a.id}`}
                        onClick={() =>
                          state !== 'none'
                            ? toggleAgentChild(a.id, g.id)
                            : toggleIndividualAgent(a.id)
                        }
                        className={cn(
                          'w-full flex items-center gap-1.5 pl-5 pr-2 py-0.5 rounded text-xs text-left transition-colors',
                          excluded
                            ? 'text-red-400/60 line-through bg-red-500/5 hover:bg-red-500/10'
                            : effective
                              ? 'bg-blue-600/10 text-blue-300/80'
                              : 'text-text-muted hover:bg-white/5',
                        )}
                      >
                        <Server size={10} className="shrink-0" />
                        <span className="truncate">{a.name ?? a.hostname}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {/* Ungrouped agents */}
            {ungroupedAgents.length > 0 && (
              <>
                {agentGroups.length > 0 && (
                  <div className="px-2 pt-1.5 pb-0.5">
                    <span className="text-[9px] text-text-muted font-semibold uppercase tracking-wider">{t('maintenance.noGroupLabel')}</span>
                  </div>
                )}
                {ungroupedAgents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    data-item-key={`agent-${a.id}`}
                    onClick={() => toggleIndividualAgent(a.id)}
                    className={cn(
                      'w-full flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-left transition-colors',
                      isAgentEffective(a)
                        ? 'bg-blue-600/10 text-blue-300/80'
                        : 'text-text-muted hover:bg-white/5',
                    )}
                  >
                    <Server size={10} className="shrink-0" />
                    <span className="truncate">{a.name ?? a.hostname}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
