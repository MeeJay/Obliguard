import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, Cpu, Check, Minus } from 'lucide-react';
import type { GroupTreeNode, AgentDevice } from '@obliview/shared';
import { cn } from '@/utils/cn';

interface TargetTreePickerProps {
  tree: GroupTreeNode[];
  devices: AgentDevice[];
  selGroups: Set<number>;
  selAgents: Set<number>;
  onChange: (groups: Set<number>, agents: Set<number>) => void;
}

type CheckState = 'checked' | 'indeterminate' | 'unchecked';

/**
 * Hierarchical multi-select picker (Group → Subgroup → Device) with cascading
 * tristate selection:
 *   - Checking a group selects every agent under it (cascade, shown checked).
 *     A fully-selected group is stored as a single group target.
 *   - Checking/unchecking an individual agent under a selected group "explodes"
 *     the group into per-agent targets, so the group then shows an indeterminate
 *     "–" state.
 */
export function TargetTreePicker({ tree, devices, selGroups, selAgents, onChange }: TargetTreePickerProps) {
  // ── Build lookup maps ──────────────────────────────────────────────────────
  const childrenOf = new Map<number, number[]>();
  const parentOf = new Map<number, number>();
  const agentsOf = new Map<number, AgentDevice[]>();
  const ungrouped: AgentDevice[] = [];

  const walk = (nodes: GroupTreeNode[], parent?: number) => {
    for (const n of nodes) {
      if (parent !== undefined) parentOf.set(n.id, parent);
      childrenOf.set(n.id, n.children.map(c => c.id));
      walk(n.children, n.id);
    }
  };
  walk(tree);

  for (const d of devices) {
    if (d.groupId == null) { ungrouped.push(d); continue; }
    const arr = agentsOf.get(d.groupId) ?? [];
    arr.push(d);
    agentsOf.set(d.groupId, arr);
  }

  const descendantGroups = (gid: number): number[] => {
    const out: number[] = [];
    const rec = (id: number) => { for (const c of childrenOf.get(id) ?? []) { out.push(c); rec(c); } };
    rec(gid);
    return out;
  };
  const descendantAgents = (gid: number): number[] => {
    const out: number[] = [];
    const rec = (id: number) => {
      for (const a of agentsOf.get(id) ?? []) out.push(a.id);
      for (const c of childrenOf.get(id) ?? []) rec(c);
    };
    rec(gid);
    return out;
  };
  // Nearest ancestor group present in selGroups (optionally including gid itself).
  const selectedAncestor = (gid: number, includeSelf: boolean): number | null => {
    let cur: number | undefined = includeSelf ? gid : parentOf.get(gid);
    while (cur !== undefined) {
      if (selGroups.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  };
  const agentCoveringGroup = (d: AgentDevice): number | null =>
    d.groupId == null ? null : selectedAncestor(d.groupId, true);

  const hasSelectedDescendant = (gid: number): boolean => {
    for (const a of descendantAgents(gid)) if (selAgents.has(a)) return true;
    for (const g of descendantGroups(gid)) if (selGroups.has(g)) return true;
    return false;
  };

  const groupState = (gid: number): CheckState => {
    if (selGroups.has(gid) || selectedAncestor(gid, false) !== null) return 'checked';
    if (hasSelectedDescendant(gid)) return 'indeterminate';
    return 'unchecked';
  };
  const agentChecked = (d: AgentDevice): boolean => selAgents.has(d.id) || agentCoveringGroup(d) !== null;

  // ── Toggle logic (cascade) ─────────────────────────────────────────────────
  const toggleGroup = (gid: number) => {
    const g = new Set(selGroups);
    const a = new Set(selAgents);
    const anc = selectedAncestor(gid, false);
    if (anc !== null) {
      // Group is covered by a selected ancestor → explode ancestor to agents,
      // then drop this subtree's agents.
      g.delete(anc);
      for (const ag of descendantAgents(anc)) a.add(ag);
      for (const ag of descendantAgents(gid)) a.delete(ag);
    } else if (g.has(gid)) {
      // Uncheck: remove the group + clean up any redundant descendant selections.
      g.delete(gid);
      for (const sg of descendantGroups(gid)) g.delete(sg);
      for (const ag of descendantAgents(gid)) a.delete(ag);
    } else {
      // Check: collapse descendants into this single group target.
      for (const sg of descendantGroups(gid)) g.delete(sg);
      for (const ag of descendantAgents(gid)) a.delete(ag);
      g.add(gid);
    }
    onChange(g, a);
  };

  const toggleAgent = (d: AgentDevice) => {
    const g = new Set(selGroups);
    const a = new Set(selAgents);
    const cov = agentCoveringGroup(d);
    if (cov !== null) {
      // Explode the covering group into per-agent targets, minus this one.
      g.delete(cov);
      for (const ag of descendantAgents(cov)) a.add(ag);
      a.delete(d.id);
    } else if (a.has(d.id)) {
      a.delete(d.id);
    } else {
      a.add(d.id);
    }
    onChange(g, a);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const renderGroup = (node: GroupTreeNode, depth: number) => (
    <GroupNode
      key={node.id}
      node={node}
      depth={depth}
      state={groupState(node.id)}
      agents={agentsOf.get(node.id) ?? []}
      agentChecked={agentChecked}
      onToggleGroup={toggleGroup}
      onToggleAgent={toggleAgent}
      renderChild={renderGroup}
    />
  );

  return (
    <div className="rounded-md border border-border bg-bg-tertiary/40 max-h-72 overflow-y-auto p-1">
      {tree.length === 0 && ungrouped.length === 0 && (
        <p className="px-2 py-3 text-sm text-text-muted text-center">No groups or agents</p>
      )}
      {tree.map(node => renderGroup(node, 0))}
      {ungrouped.length > 0 && (
        <div>
          <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">Ungrouped agents</div>
          {ungrouped.map(d => (
            <DeviceRow key={d.id} device={d} depth={1} checked={agentChecked(d)} onToggle={() => toggleAgent(d)} />
          ))}
        </div>
      )}
    </div>
  );
}

interface GroupNodeProps {
  node: GroupTreeNode;
  depth: number;
  state: CheckState;
  agents: AgentDevice[];
  agentChecked: (d: AgentDevice) => boolean;
  onToggleGroup: (id: number) => void;
  onToggleAgent: (d: AgentDevice) => void;
  renderChild: (node: GroupTreeNode, depth: number) => React.ReactNode;
}

function GroupNode({ node, depth, state, agents, agentChecked, onToggleGroup, onToggleAgent, renderChild }: GroupNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0 || agents.length > 0;

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm transition-colors cursor-pointer',
          state === 'checked' ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-bg-hover',
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => onToggleGroup(node.id)}
      >
        {hasChildren ? (
          <span onClick={e => { e.stopPropagation(); setExpanded(!expanded); }} className="shrink-0 cursor-pointer text-text-muted">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <SelIndicator state={state} />
        <Folder size={14} className="shrink-0 text-accent" />
        <span className="truncate flex-1">{node.name}</span>
      </div>

      {expanded && (
        <div>
          {node.children.map(child => renderChild(child, depth + 1))}
          {agents.map(d => (
            <DeviceRow key={d.id} device={d} depth={depth + 1} checked={agentChecked(d)} onToggle={() => onToggleAgent(d)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceRow({ device, depth, checked, onToggle }: { device: AgentDevice; depth: number; checked: boolean; onToggle: () => void }) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm transition-colors cursor-pointer',
        checked ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-hover',
      )}
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
      onClick={onToggle}
    >
      <span className="w-3.5 shrink-0" />
      <SelIndicator state={checked ? 'checked' : 'unchecked'} />
      <Cpu size={14} className="shrink-0 text-text-muted" />
      <span className="truncate flex-1">{device.name || device.hostname}</span>
    </div>
  );
}

function SelIndicator({ state }: { state: CheckState }) {
  const active = state !== 'unchecked';
  return (
    <span className={cn(
      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
      active ? 'bg-accent border-accent text-white' : 'border-border bg-bg-secondary',
    )}>
      {state === 'checked' && <Check size={11} />}
      {state === 'indeterminate' && <Minus size={11} />}
    </span>
  );
}
