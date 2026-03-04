import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus,
  Trash2,
  Key,
  Cpu,
  Monitor,
  CheckCircle,
  XCircle,
  Clock,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  Pencil,
  PauseCircle,
  PowerOff,
  X,
  Settings2,
} from 'lucide-react';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { AgentApiKey, AgentDevice, MonitorGroup } from '@obliview/shared';
import { agentApi } from '@/api/agent.api';
import { groupsApi } from '@/api/groups.api';
import { getSocket } from '@/socket/socketClient';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useUiStore } from '@/store/uiStore';
import toast from 'react-hot-toast';

type Tab = 'keys' | 'devices';
type DeviceStatusFilter = 'pending' | 'approved' | 'refused' | 'suspended' | 'all';
/** 'keep' = no change; null = remove from group; number = assign to group */
type GroupSelection = 'keep' | null | number;

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateKey(key: string) {
  return key.slice(0, 8) + '...' + key.slice(-4);
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusBadge(status: AgentDevice['status']) {
  const styles: Record<AgentDevice['status'], { icon: React.ReactNode; label: string; cls: string }> = {
    pending: {
      icon: <Clock size={11} />,
      label: 'Pending',
      cls: 'bg-yellow-500/10 text-yellow-400',
    },
    approved: {
      icon: <CheckCircle size={11} />,
      label: 'Approved',
      cls: 'bg-status-up/10 text-status-up',
    },
    refused: {
      icon: <XCircle size={11} />,
      label: 'Refused',
      cls: 'bg-status-down/10 text-status-down',
    },
    suspended: {
      icon: <PauseCircle size={11} />,
      label: 'Suspended',
      cls: 'bg-text-muted/15 text-text-muted',
    },
  };
  const s = styles[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
      {s.icon}
      {s.label}
    </span>
  );
}

// ── CopyButton ────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
      title="Copy"
    >
      {copied ? <Check size={14} className="text-status-up" /> : <Copy size={14} />}
    </button>
  );
}

// ── TriStateCheckbox ──────────────────────────────────────────────────────────

/**
 * Tri-state checkbox: true / false / null (indeterminate = mixed values across selection).
 * Any click resolves the indeterminate state to true or false.
 */
function TriStateCheckbox({
  value,
  onChange,
  label,
  description,
}: {
  value: boolean | null;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = value === null;
    }
  }, [value]);

  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <input
        ref={ref}
        type="checkbox"
        checked={value === true}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 accent-accent w-4 h-4"
      />
      <div>
        <p className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">{label}</p>
        {description && <p className="text-xs text-text-muted leading-relaxed">{description}</p>}
      </div>
    </label>
  );
}

// ── ApproveModal ──────────────────────────────────────────────────────────────

function ApproveModal({
  device,
  groups,
  onApprove,
  onCancel,
}: {
  device: AgentDevice;
  groups: MonitorGroup[];
  onApprove: (groupId: number | null) => void;
  onCancel: () => void;
}) {
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const agentGroups = groups.filter(g => g.kind === 'agent');
  const selectedGroup = agentGroups.find(g => g.id === selectedGroupId);
  const hasGroupThresholds = selectedGroup?.agentThresholds != null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-primary shadow-2xl p-6">
        <h2 className="text-base font-semibold text-text-primary mb-1">Approve Device</h2>
        <p className="text-sm text-text-muted mb-4">
          Approve <span className="font-medium text-text-primary">{device.hostname}</span> and create its monitor?
        </p>

        <div className="space-y-1 mb-4">
          <label className="block text-sm font-medium text-text-secondary">Assign to Agent Group (optional)</label>
          <select
            value={selectedGroupId ?? ''}
            onChange={e => setSelectedGroupId(e.target.value ? Number(e.target.value) : null)}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">— No group —</option>
            {agentGroups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          {agentGroups.length === 0 && (
            <p className="text-xs text-text-muted mt-1">No agent groups found. Create one in Groups settings.</p>
          )}
          {hasGroupThresholds && (
            <p className="text-xs text-status-up mt-1">✓ Group default thresholds will be applied</p>
          )}
        </div>

        <div className="flex gap-2">
          <Button onClick={() => onApprove(selectedGroupId)} className="flex-1">
            <CheckCircle size={14} className="mr-1.5" />Approve
          </Button>
          <Button variant="secondary" onClick={onCancel} className="flex-1">Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── EditAgentModal ────────────────────────────────────────────────────────────

function EditAgentModal({
  device,
  groups,
  onSave,
  onCancel,
}: {
  device: AgentDevice;
  groups: MonitorGroup[];
  onSave: (data: {
    name: string | null;
    groupId?: number | null;
    heartbeatMonitoring: boolean;
    overrideGroupSettings: boolean;
    suspended: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(device.name ?? '');
  const [groupId, setGroupId] = useState<number | null>(device.groupId ?? null);
  const [heartbeatMonitoring, setHeartbeatMonitoring] = useState(device.heartbeatMonitoring);
  const [overrideGroupSettings, setOverrideGroupSettings] = useState(device.overrideGroupSettings);
  const [suspended, setSuspended] = useState(device.status === 'suspended');
  const [saving, setSaving] = useState(false);

  const agentGroups = groups.filter(g => g.kind === 'agent');

  const handleSave = async () => {
    setSaving(true);
    onSave({
      name: name.trim() || null,
      groupId,
      heartbeatMonitoring,
      overrideGroupSettings,
      suspended,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-primary shadow-2xl p-6">
        <h2 className="text-base font-semibold text-text-primary mb-1">Edit Agent</h2>
        <p className="text-xs text-text-muted mb-5">
          Hostname: <span className="font-mono text-text-secondary">{device.hostname}</span>
        </p>

        <div className="space-y-4">
          {/* Display name */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Display name</label>
            <Input
              placeholder={device.hostname}
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-text-muted mt-1">Leave empty to use hostname</p>
          </div>

          {/* Group */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Agent Group</label>
            <select
              value={groupId ?? ''}
              onChange={e => setGroupId(e.target.value === '' ? null : Number(e.target.value))}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">— No group —</option>
              {agentGroups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          {/* Heartbeat monitoring toggle */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={heartbeatMonitoring}
              onChange={e => setHeartbeatMonitoring(e.target.checked)}
              className="mt-0.5 accent-accent w-4 h-4"
            />
            <div>
              <p className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                Heartbeat monitoring
              </p>
              <p className="text-xs text-text-muted leading-relaxed">
                Alert if agent goes offline (DOWN). Disable for workstations.
              </p>
            </div>
          </label>

          {/* Override group settings */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={overrideGroupSettings}
              onChange={e => setOverrideGroupSettings(e.target.checked)}
              className="mt-0.5 accent-accent w-4 h-4"
            />
            <div>
              <p className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                Override group settings
              </p>
              <p className="text-xs text-text-muted leading-relaxed">
                Use this device's own thresholds and push interval instead of the group's.
              </p>
            </div>
          </label>

          {/* Suspend toggle */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={suspended}
              onChange={e => setSuspended(e.target.checked)}
              className="mt-0.5 accent-accent w-4 h-4"
            />
            <div>
              <p className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                Suspended
              </p>
              <p className="text-xs text-text-muted leading-relaxed">
                Block the agent without deleting it. The monitor is paused; the device cannot push data.
              </p>
            </div>
          </label>
        </div>

        <div className="flex gap-2 mt-6">
          <Button onClick={handleSave} loading={saving} className="flex-1">Save</Button>
          <Button variant="secondary" onClick={onCancel} className="flex-1">Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── BulkEditAgentModal ────────────────────────────────────────────────────────

function BulkEditAgentModal({
  devices,
  groups,
  onSave,
  onCancel,
}: {
  devices: AgentDevice[];
  groups: MonitorGroup[];
  onSave: (data: {
    groupId?: number | null;
    heartbeatMonitoring?: boolean;
    overrideGroupSettings?: boolean;
    status?: 'approved' | 'suspended';
  }) => void;
  onCancel: () => void;
}) {
  const agentGroups = groups.filter(g => g.kind === 'agent');

  // Compute initial tri-state values: single value if all same, null if mixed
  const allSameHeartbeat = devices.every(d => d.heartbeatMonitoring === devices[0].heartbeatMonitoring);
  const allSameOverride = devices.every(d => d.overrideGroupSettings === devices[0].overrideGroupSettings);

  const [groupSelection, setGroupSelection] = useState<GroupSelection>('keep');
  const [heartbeatMonitoring, setHeartbeatMonitoring] = useState<boolean | null>(
    allSameHeartbeat ? devices[0].heartbeatMonitoring : null,
  );
  const [overrideGroupSettings, setOverrideGroupSettings] = useState<boolean | null>(
    allSameOverride ? devices[0].overrideGroupSettings : null,
  );
  const [statusAction, setStatusAction] = useState<'no-change' | 'approved' | 'suspended'>('no-change');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const data: {
      groupId?: number | null;
      heartbeatMonitoring?: boolean;
      overrideGroupSettings?: boolean;
      status?: 'approved' | 'suspended';
    } = {};

    if (groupSelection !== 'keep') data.groupId = groupSelection;
    if (heartbeatMonitoring !== null) data.heartbeatMonitoring = heartbeatMonitoring;
    if (overrideGroupSettings !== null) data.overrideGroupSettings = overrideGroupSettings;
    if (statusAction !== 'no-change') data.status = statusAction;

    setSaving(true);
    onSave(data);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-primary shadow-2xl p-6">
        <h2 className="text-base font-semibold text-text-primary mb-1">
          Edit {devices.length} Agent{devices.length !== 1 ? 's' : ''}
        </h2>
        <p className="text-xs text-text-muted mb-5">
          Only changed fields will be applied. Mixed values show as indeterminate (—).
        </p>

        <div className="space-y-4">
          {/* Group */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Agent Group</label>
            <select
              value={
                groupSelection === 'keep' ? '__keep__'
                : groupSelection === null ? ''
                : String(groupSelection)
              }
              onChange={e => {
                const v = e.target.value;
                if (v === '__keep__') setGroupSelection('keep');
                else if (v === '') setGroupSelection(null);
                else setGroupSelection(Number(v));
              }}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="__keep__">— Keep current —</option>
              <option value="">— No group —</option>
              {agentGroups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          {/* Heartbeat monitoring */}
          <TriStateCheckbox
            value={heartbeatMonitoring}
            onChange={setHeartbeatMonitoring}
            label="Heartbeat monitoring"
            description="Alert if agent goes offline (DOWN). Disable for workstations."
          />

          {/* Override group settings */}
          <TriStateCheckbox
            value={overrideGroupSettings}
            onChange={setOverrideGroupSettings}
            label="Override group settings"
            description="Use each device's own thresholds and push interval instead of the group's."
          />

          {/* Status */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Status</label>
            <select
              value={statusAction}
              onChange={e => setStatusAction(e.target.value as 'no-change' | 'approved' | 'suspended')}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="no-change">— No change —</option>
              <option value="approved">Approve all</option>
              <option value="suspended">Suspend all</option>
            </select>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <Button onClick={handleSave} loading={saving} className="flex-1">Apply</Button>
          <Button variant="secondary" onClick={onCancel} className="flex-1">Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function AdminAgentPage() {
  const [tab, setTab] = useState<Tab>('devices');
  const [deviceFilter, setDeviceFilter] = useState<DeviceStatusFilter>('all');

  const [keys, setKeys] = useState<AgentApiKey[]>([]);
  const [devices, setDevices] = useState<AgentDevice[]>([]);
  const [groups, setGroups] = useState<MonitorGroup[]>([]);

  const { openAddAgentModal } = useUiStore();
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [saving, setSaving] = useState(false);

  const [approvingDevice, setApprovingDevice] = useState<AgentDevice | null>(null);
  const [editingDevice, setEditingDevice] = useState<AgentDevice | null>(null);

  // ── Bulk select state ────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const loadAll = useCallback(async () => {
    try {
      const [k, d] = await Promise.all([
        agentApi.listKeys(),
        agentApi.listDevices(),
      ]);
      setKeys(k);
      setDevices(d);
    } catch {
      toast.error('Failed to load agent data');
    }
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      const tree = await groupsApi.tree();
      const flat: MonitorGroup[] = [];
      const flatten = (nodes: typeof tree) => {
        for (const n of nodes) {
          flat.push(n);
          flatten(n.children);
        }
      };
      flatten(tree);
      setGroups(flat);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadAll();
    loadGroups();
  }, [loadAll, loadGroups]);

  // Live updates via Socket.io
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onPush = (data: { deviceId: number; agentVersion?: string }) => {
      if (!data.agentVersion) return;
      setDevices(prev => prev.map(d =>
        d.id === data.deviceId && d.agentVersion !== data.agentVersion
          ? { ...d, agentVersion: data.agentVersion! }
          : d,
      ));
    };

    const onDeviceUpdated = (data: AgentDevice) => {
      setDevices(prev => prev.map(d => d.id === data.id ? data : d));
    };

    // Auto-delete after uninstall: remove device from list & selection
    const onDeviceDeleted = (data: { deviceId: number }) => {
      setDevices(prev => prev.filter(d => d.id !== data.deviceId));
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(data.deviceId);
        return next;
      });
    };

    socket.on('agentPush', onPush);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);
    return () => {
      socket.off('agentPush', onPush);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);
    };
  }, []);

  const filteredDevices = deviceFilter === 'all'
    ? devices
    : devices.filter(d => d.status === deviceFilter);

  const pendingCount = devices.filter(d => d.status === 'pending').length;

  // ── Select-all checkbox indeterminate state ──────────────────────────────────
  const allSelected = filteredDevices.length > 0 && filteredDevices.every(d => selectedIds.has(d.id));
  const someSelected = !allSelected && filteredDevices.some(d => selectedIds.has(d.id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredDevices.map(d => d.id)));
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleFilterChange = (f: DeviceStatusFilter) => {
    setDeviceFilter(f);
    setSelectedIds(new Set());
  };

  // ── Key actions ──────────────────────────────────────────────────────────────

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;
    setSaving(true);
    try {
      await agentApi.createKey(newKeyName.trim());
      toast.success('API Key created');
      setNewKeyName('');
      setShowCreateKey(false);
      loadAll();
    } catch {
      toast.error('Failed to create key');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteKey = async (key: AgentApiKey) => {
    if (!confirm(`Delete key "${key.name}"? Devices using this key will stop pushing.`)) return;
    try {
      await agentApi.deleteKey(key.id);
      toast.success('Key deleted');
      loadAll();
    } catch {
      toast.error('Failed to delete key');
    }
  };

  // ── Device actions ───────────────────────────────────────────────────────────

  const handleApprove = async (groupId: number | null) => {
    if (!approvingDevice) return;
    try {
      await agentApi.updateDevice(approvingDevice.id, { status: 'approved', groupId });
      toast.success(`${approvingDevice.hostname} approved — monitors created`);
      setApprovingDevice(null);
      loadAll();
    } catch {
      toast.error('Failed to approve device');
    }
  };

  const handleRefuse = async (device: AgentDevice) => {
    if (!confirm(`Refuse device "${device.hostname}"? It will enter backoff mode.`)) return;
    try {
      await agentApi.updateDevice(device.id, { status: 'refused' });
      toast.success('Device refused');
      loadAll();
    } catch {
      toast.error('Failed to refuse device');
    }
  };

  const handleReinstate = async (device: AgentDevice) => {
    try {
      await agentApi.updateDevice(device.id, { status: 'pending' });
      toast.success('Device reinstated to pending');
      loadAll();
    } catch {
      toast.error('Failed to reinstate device');
    }
  };

  const handleDeleteDevice = async (device: AgentDevice) => {
    if (!confirm(`Delete device "${device.hostname}" and all its monitors?`)) return;
    try {
      await agentApi.deleteDevice(device.id);
      toast.success('Device deleted');
      setSelectedIds(prev => { const next = new Set(prev); next.delete(device.id); return next; });
      loadAll();
    } catch {
      toast.error('Failed to delete device');
    }
  };

  /** Send an uninstall command to a single device. */
  const handleUninstallDevice = async (device: AgentDevice) => {
    if (!confirm(
      `Uninstall agent on "${device.name ?? device.hostname}"?\n\n` +
      `The command will be sent on the agent's next push. The service will be removed from the machine. ` +
      `The device entry will be automatically deleted a few minutes after uninstall.`,
    )) return;
    try {
      await agentApi.sendCommand(device.id, 'uninstall');
      toast.success(`Uninstall command queued for ${device.name ?? device.hostname}`);
    } catch {
      toast.error('Failed to queue uninstall command');
    }
  };

  const handleEditSave = async (data: {
    name: string | null;
    groupId?: number | null;
    heartbeatMonitoring: boolean;
    overrideGroupSettings: boolean;
    suspended: boolean;
  }) => {
    if (!editingDevice) return;
    try {
      const newStatus = data.suspended ? 'suspended'
        : editingDevice.status === 'suspended' ? 'approved'
        : undefined;
      await agentApi.updateDevice(editingDevice.id, {
        name: data.name,
        ...(data.groupId !== undefined ? { groupId: data.groupId } : {}),
        heartbeatMonitoring: data.heartbeatMonitoring,
        overrideGroupSettings: data.overrideGroupSettings,
        ...(newStatus ? { status: newStatus } : {}),
      });
      toast.success('Agent updated');
      setEditingDevice(null);
      loadAll();
    } catch {
      toast.error('Failed to update agent');
    }
  };

  // ── Bulk actions ─────────────────────────────────────────────────────────────

  const selectedDevices = devices.filter(d => selectedIds.has(d.id));

  const handleBulkDelete = async () => {
    const count = selectedIds.size;
    if (!confirm(`Delete ${count} device${count !== 1 ? 's' : ''} and all their monitors? This cannot be undone.`)) return;
    try {
      await agentApi.bulkDeleteDevices([...selectedIds]);
      toast.success(`${count} device${count !== 1 ? 's' : ''} deleted`);
      setSelectedIds(new Set());
      loadAll();
    } catch {
      toast.error('Failed to delete devices');
    }
  };

  const handleBulkUninstall = async () => {
    const count = selectedIds.size;
    if (!confirm(
      `Send uninstall command to ${count} agent${count !== 1 ? 's' : ''}?\n\n` +
      `Each agent will uninstall itself on its next push. ` +
      `Device entries will be automatically deleted a few minutes after uninstall.`,
    )) return;
    try {
      await agentApi.bulkSendCommand([...selectedIds], 'uninstall');
      toast.success(`Uninstall command queued for ${count} agent${count !== 1 ? 's' : ''}`);
      setSelectedIds(new Set());
    } catch {
      toast.error('Failed to queue bulk uninstall command');
    }
  };

  const handleBulkEditSave = async (data: {
    groupId?: number | null;
    heartbeatMonitoring?: boolean;
    overrideGroupSettings?: boolean;
    status?: 'approved' | 'suspended';
  }) => {
    const count = selectedIds.size;
    try {
      await agentApi.bulkUpdateDevices([...selectedIds], data);
      toast.success(`${count} agent${count !== 1 ? 's' : ''} updated`);
      setShowBulkEditModal(false);
      setSelectedIds(new Set());
      loadAll();
    } catch {
      toast.error('Failed to update agents');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Cpu size={20} className="text-accent" />
          <h1 className="text-xl font-semibold text-text-primary">Agents</h1>
          {pendingCount > 0 && (
            <span className="rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs font-medium text-yellow-400">
              {pendingCount} pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadAll}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <Button onClick={openAddAgentModal}>
            <Plus size={14} className="mr-1.5" />Add Agent
          </Button>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-1 mb-6 rounded-lg bg-bg-secondary p-1 border border-border w-fit">
        <button
          onClick={() => setTab('devices')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            tab === 'devices' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          <Monitor size={13} className="inline mr-1.5" />
          Devices
          {pendingCount > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-yellow-500 text-white text-[10px] font-bold">
              {pendingCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('keys')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            tab === 'keys' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          <Key size={13} className="inline mr-1.5" />
          API Keys
        </button>
      </div>

      {/* ── Devices Tab ── */}
      {tab === 'devices' && (
        <>
          {/* Status filter */}
          <div className="flex gap-1 mb-4">
            {(['all', 'approved', 'refused', 'suspended', 'pending'] as DeviceStatusFilter[]).map(f => (
              <button
                key={f}
                onClick={() => handleFilterChange(f)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors capitalize ${
                  deviceFilter === f
                    ? 'bg-bg-tertiary text-text-primary font-medium'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {f}
                {f !== 'all' && (
                  <span className="ml-1.5 text-xs text-text-muted">
                    ({devices.filter(d => d.status === f).length})
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Bulk action bar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 mb-3 px-4 py-2.5 rounded-lg bg-accent/10 border border-accent/20">
              <span className="text-sm font-medium text-accent">
                {selectedIds.size} selected
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <Button size="sm" variant="secondary" onClick={() => setShowBulkEditModal(true)}>
                  <Settings2 size={12} className="mr-1.5" />Edit
                </Button>
                <Button size="sm" variant="secondary" onClick={handleBulkUninstall}>
                  <PowerOff size={12} className="mr-1.5" />Uninstall
                </Button>
                <Button size="sm" variant="danger" onClick={handleBulkDelete}>
                  <Trash2 size={12} className="mr-1.5" />Delete
                </Button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                  title="Clear selection"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          {/* Devices table */}
          <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
            {filteredDevices.length === 0 ? (
              <div className="py-12 text-center">
                <Cpu size={32} className="mx-auto mb-2 text-text-muted" />
                <p className="text-sm text-text-muted">
                  {deviceFilter === 'pending' ? 'No devices waiting for approval' : `No ${deviceFilter} devices`}
                </p>
                {deviceFilter === 'pending' && (
                  <p className="text-xs text-text-muted mt-1">
                    Click "Add Agent" to get the installation command
                  </p>
                )}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-bg-tertiary">
                    <th className="px-3 py-2.5 w-8">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        className="accent-accent w-4 h-4 cursor-pointer"
                        title={allSelected ? 'Deselect all' : 'Select all'}
                      />
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Hostname</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">IP</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">OS</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Agent</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Status</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Registered</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-text-muted uppercase tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredDevices.map(device => (
                    <tr
                      key={device.id}
                      className={`hover:bg-bg-hover transition-colors ${selectedIds.has(device.id) ? 'bg-accent/5' : ''}`}
                    >
                      {/* Checkbox */}
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(device.id)}
                          onChange={() => toggleSelect(device.id)}
                          className="accent-accent w-4 h-4 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3">
                        {device.status === 'approved' ? (
                          <Link
                            to={`/agents/${device.id}`}
                            className="font-medium text-text-primary hover:text-accent transition-colors"
                          >
                            {device.name ?? device.hostname}
                          </Link>
                        ) : (
                          <span className="font-medium text-text-primary">{device.name ?? device.hostname}</span>
                        )}
                        {device.name && (
                          <div className="text-[10px] text-text-muted mt-0.5">{device.hostname}</div>
                        )}
                        <div className="text-[10px] text-text-muted font-mono mt-0.5">{device.uuid.slice(0, 12)}…</div>
                      </td>
                      <td className="px-4 py-3 text-text-muted">{device.ip ?? '—'}</td>
                      <td className="px-4 py-3 text-text-muted">
                        {device.osInfo
                          ? `${device.osInfo.distro ?? device.osInfo.platform} ${device.osInfo.release ?? ''}`
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-text-muted">{device.agentVersion ?? '—'}</td>
                      <td className="px-4 py-3">{statusBadge(device.status)}</td>
                      <td className="px-4 py-3 text-text-muted text-xs">{formatDate(device.createdAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {device.status === 'pending' && (
                            <>
                              <Button size="sm" onClick={() => setApprovingDevice(device)}>
                                <CheckCircle size={12} className="mr-1" />Approve
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => handleRefuse(device)}>
                                Refuse
                              </Button>
                            </>
                          )}
                          {device.status === 'approved' && (
                            <Link
                              to={`/agents/${device.id}`}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                              title="View detail"
                            >
                              <ExternalLink size={12} />
                              View
                            </Link>
                          )}
                          {device.status === 'refused' && (
                            <Button size="sm" variant="secondary" onClick={() => handleReinstate(device)}>
                              Reinstate
                            </Button>
                          )}
                          {device.status === 'suspended' && (
                            <Button size="sm" variant="secondary" onClick={() => agentApi.updateDevice(device.id, { status: 'approved' }).then(loadAll)}>
                              Reinstate
                            </Button>
                          )}
                          {(device.status === 'approved' || device.status === 'suspended') && (
                            <button
                              onClick={() => setEditingDevice(device)}
                              className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                              title="Edit"
                            >
                              <Pencil size={13} />
                            </button>
                          )}
                          {/* Uninstall — approved devices only */}
                          {device.status === 'approved' && (
                            <button
                              onClick={() => handleUninstallDevice(device)}
                              className="p-1.5 rounded text-text-muted hover:text-orange-400 hover:bg-orange-400/10 transition-colors"
                              title="Uninstall agent"
                            >
                              <PowerOff size={13} />
                            </button>
                          )}
                          <button
                            onClick={() => handleDeleteDevice(device)}
                            className="p-1.5 rounded text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── API Keys Tab ── */}
      {tab === 'keys' && (
        <>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-text-muted">API Keys are used to authenticate agents during installation.</p>
            <Button size="sm" onClick={() => setShowCreateKey(true)}>
              <Plus size={13} className="mr-1" />New Key
            </Button>
          </div>

          {/* Create key form */}
          {showCreateKey && (
            <div className="mb-4 rounded-lg border border-border bg-bg-secondary p-4">
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">New API Key</h3>
              <div className="flex gap-2">
                <Input
                  placeholder="Key name (e.g. Production Servers)"
                  value={newKeyName}
                  onChange={e => setNewKeyName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateKey()}
                  autoFocus
                />
                <Button onClick={handleCreateKey} loading={saving} disabled={!newKeyName.trim()}>
                  Create
                </Button>
                <Button variant="secondary" onClick={() => { setShowCreateKey(false); setNewKeyName(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Keys list */}
          <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border">
            {keys.length === 0 ? (
              <div className="py-10 text-center">
                <Key size={28} className="mx-auto mb-2 text-text-muted" />
                <p className="text-sm text-text-muted">No API keys yet</p>
              </div>
            ) : (
              keys.map(key => (
                <div key={key.id} className="flex items-center gap-3 px-4 py-3 group">
                  <Key size={14} className="shrink-0 text-accent" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-text-primary text-sm">{key.name}</div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs font-mono text-text-muted">{truncateKey(key.key)}</span>
                      <CopyButton text={key.key} />
                      {key.deviceCount !== undefined && (
                        <span className="text-xs text-text-muted">{key.deviceCount} device{key.deviceCount !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-text-muted shrink-0 text-right">
                    <div>Created {formatDate(key.createdAt)}</div>
                    {key.lastUsedAt && <div>Last used {formatDate(key.lastUsedAt)}</div>}
                  </div>
                  <button
                    onClick={() => handleDeleteKey(key)}
                    className="shrink-0 p-1.5 rounded text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* Modals */}
      {approvingDevice && (
        <ApproveModal
          device={approvingDevice}
          groups={groups}
          onApprove={handleApprove}
          onCancel={() => setApprovingDevice(null)}
        />
      )}

      {editingDevice && (
        <EditAgentModal
          device={editingDevice}
          groups={groups}
          onSave={handleEditSave}
          onCancel={() => setEditingDevice(null)}
        />
      )}

      {showBulkEditModal && selectedDevices.length > 0 && (
        <BulkEditAgentModal
          devices={selectedDevices}
          groups={groups}
          onSave={handleBulkEditSave}
          onCancel={() => setShowBulkEditModal(false)}
        />
      )}
    </div>
  );
}
