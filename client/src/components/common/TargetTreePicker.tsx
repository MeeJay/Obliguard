import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, Cpu, Check } from 'lucide-react';
import type { GroupTreeNode, AgentDevice } from '@obliview/shared';
import { cn } from '@/utils/cn';

interface TargetTreePickerProps {
  tree: GroupTreeNode[];
  devices: AgentDevice[];
  selectedGroups: Set<number>;
  selectedAgents: Set<number>;
  onToggleGroup: (id: number) => void;
  onToggleAgent: (id: number) => void;
}

/**
 * Hierarchical multi-select picker for rate/network limit targets.
 * Renders Group → Subgroup → Device, keeping that order, and lets the user
 * toggle any combination of groups, subgroups and individual devices.
 */
export function TargetTreePicker({
  tree, devices, selectedGroups, selectedAgents, onToggleGroup, onToggleAgent,
}: TargetTreePickerProps) {
  // group id → devices in that group
  const byGroup = new Map<number, AgentDevice[]>();
  const ungrouped: AgentDevice[] = [];
  for (const d of devices) {
    if (d.groupId == null) { ungrouped.push(d); continue; }
    const arr = byGroup.get(d.groupId) ?? [];
    arr.push(d);
    byGroup.set(d.groupId, arr);
  }

  return (
    <div className="rounded-md border border-border bg-bg-tertiary/40 max-h-72 overflow-y-auto p-1">
      {tree.length === 0 && ungrouped.length === 0 && (
        <p className="px-2 py-3 text-sm text-text-muted text-center">No groups or agents</p>
      )}
      {tree.map(node => (
        <GroupNode
          key={node.id}
          node={node}
          depth={0}
          byGroup={byGroup}
          selectedGroups={selectedGroups}
          selectedAgents={selectedAgents}
          onToggleGroup={onToggleGroup}
          onToggleAgent={onToggleAgent}
        />
      ))}
      {ungrouped.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">
            Ungrouped agents
          </div>
          {ungrouped.map(d => (
            <DeviceRow
              key={d.id}
              device={d}
              depth={1}
              selected={selectedAgents.has(d.id)}
              onToggle={() => onToggleAgent(d.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface GroupNodeProps {
  node: GroupTreeNode;
  depth: number;
  byGroup: Map<number, AgentDevice[]>;
  selectedGroups: Set<number>;
  selectedAgents: Set<number>;
  onToggleGroup: (id: number) => void;
  onToggleAgent: (id: number) => void;
}

function GroupNode({ node, depth, byGroup, selectedGroups, selectedAgents, onToggleGroup, onToggleAgent }: GroupNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const groupDevices = byGroup.get(node.id) ?? [];
  const hasChildren = node.children.length > 0 || groupDevices.length > 0;
  const selected = selectedGroups.has(node.id);

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm transition-colors cursor-pointer',
          selected ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-bg-hover',
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
        <SelIndicator selected={selected} />
        <Folder size={14} className="shrink-0 text-accent" />
        <span className="truncate flex-1">{node.name}</span>
      </div>

      {expanded && (
        <div>
          {node.children.map(child => (
            <GroupNode
              key={child.id}
              node={child}
              depth={depth + 1}
              byGroup={byGroup}
              selectedGroups={selectedGroups}
              selectedAgents={selectedAgents}
              onToggleGroup={onToggleGroup}
              onToggleAgent={onToggleAgent}
            />
          ))}
          {groupDevices.map(d => (
            <DeviceRow
              key={d.id}
              device={d}
              depth={depth + 1}
              selected={selectedAgents.has(d.id)}
              onToggle={() => onToggleAgent(d.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceRow({ device, depth, selected, onToggle }: { device: AgentDevice; depth: number; selected: boolean; onToggle: () => void }) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm transition-colors cursor-pointer',
        selected ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-hover',
      )}
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
      onClick={onToggle}
    >
      <span className="w-3.5 shrink-0" />
      <SelIndicator selected={selected} />
      <Cpu size={14} className="shrink-0 text-text-muted" />
      <span className="truncate flex-1">{device.name || device.hostname}</span>
    </div>
  );
}

function SelIndicator({ selected }: { selected: boolean }) {
  return (
    <span className={cn(
      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
      selected ? 'bg-accent border-accent text-white' : 'border-border bg-bg-secondary',
    )}>
      {selected && <Check size={11} />}
    </span>
  );
}
