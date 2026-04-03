import { useState, useEffect, useCallback } from 'react';
import { Shield, ShieldOff, Plus, Trash2, RefreshCw, Search, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { firewallApi } from '../../api/firewall.api';
import type { FirewallRule, FirewallAddRequest } from '@obliview/shared';

interface Props {
  deviceId: number;
  wsConnected: boolean;
}

export function FirewallPanel({ deviceId, wsConnected }: Props) {
  const [rules, setRules] = useState<FirewallRule[]>([]);
  const [platform, setPlatform] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());

  const loadRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await firewallApi.getRules(deviceId);
      setRules(result.rules ?? []);
      setPlatform(result.platform ?? '');
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? (err as Error)?.message ?? 'Failed to fetch firewall rules';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    if (wsConnected) void loadRules();
  }, [wsConnected, loadRules]);

  const handleDelete = async (ruleId: string) => {
    if (!confirm('Delete this firewall rule?')) return;
    setPending(p => new Set(p).add(ruleId));
    try {
      const result = await firewallApi.deleteRule(deviceId, ruleId);
      if (result.rules) setRules(result.rules);
      toast.success('Rule deleted');
    } catch { toast.error('Failed to delete rule'); }
    finally { setPending(p => { const n = new Set(p); n.delete(ruleId); return n; }); }
  };

  const handleToggle = async (ruleId: string, enabled: boolean) => {
    setPending(p => new Set(p).add(ruleId));
    try {
      const result = await firewallApi.toggleRule(deviceId, ruleId, enabled);
      if (result.rules) setRules(result.rules);
    } catch { toast.error('Failed to toggle rule'); }
    finally { setPending(p => { const n = new Set(p); n.delete(ruleId); return n; }); }
  };

  const handleAdd = async (req: FirewallAddRequest) => {
    try {
      const result = await firewallApi.addRule(deviceId, req);
      if (result.rules) setRules(result.rules);
      toast.success('Rule created');
      setShowAdd(false);
    } catch { toast.error('Failed to create rule'); }
  };

  const supportsToggle = platform === 'windows';
  const filtered = filter
    ? rules.filter(r =>
        r.name.toLowerCase().includes(filter.toLowerCase()) ||
        r.localPort.includes(filter) ||
        r.remoteIp.includes(filter))
    : rules;

  if (!wsConnected) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <ShieldOff size={32} className="text-text-muted mb-3" />
        <p className="text-sm text-text-muted">Agent is not connected</p>
        <p className="text-xs text-text-muted mt-1">Cannot manage firewall rules while offline</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">Firewall Rules</h3>
          {platform && <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-bg-tertiary">{platform}</span>}
          <span className="text-xs text-text-muted">{rules.length} rules</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void loadRules()} disabled={loading}
            className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-bg-hover transition-colors disabled:opacity-40">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors">
            <Plus size={12} /> Add Rule
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
        <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Filter by name, port, or IP..."
          className="w-full pl-8 pr-3 py-1.5 text-xs rounded border border-border bg-bg-secondary text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent" />
      </div>

      {/* Table */}
      {loading ? (
        <div className="py-12 text-center">
          <RefreshCw size={20} className="animate-spin mx-auto mb-2 text-accent" />
          <p className="text-sm text-text-muted">Fetching rules from agent...</p>
          <p className="text-xs text-text-muted mt-1">This may take a few seconds</p>
        </div>
      ) : error ? (
        <div className="py-12 text-center">
          <ShieldOff size={24} className="mx-auto mb-2 text-status-down" />
          <p className="text-sm text-status-down font-medium">Failed to load firewall rules</p>
          <p className="text-xs text-text-muted mt-1 max-w-sm mx-auto">{error}</p>
          <button onClick={() => void loadRules()} className="mt-3 px-3 py-1 rounded text-xs text-accent border border-accent/30 hover:bg-accent/10 transition-colors">
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-text-muted">{filter ? 'No rules match the filter' : 'No firewall rules found on this agent'}</div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden max-h-[60vh] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-bg-tertiary sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-text-muted">Name</th>
                <th className="text-center px-2 py-2 font-medium text-text-muted">Dir</th>
                <th className="text-center px-2 py-2 font-medium text-text-muted">Action</th>
                <th className="text-left px-2 py-2 font-medium text-text-muted">Protocol</th>
                <th className="text-left px-2 py-2 font-medium text-text-muted">Port</th>
                <th className="text-left px-2 py-2 font-medium text-text-muted">Remote IP</th>
                {supportsToggle && <th className="text-center px-2 py-2 font-medium text-text-muted">Status</th>}
                <th className="text-right px-2 py-2 font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(rule => (
                <tr key={rule.id} className={`hover:bg-bg-hover transition-colors ${!rule.enabled ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2 max-w-[200px]">
                    <div className="truncate text-text-primary font-mono text-[11px]">{rule.name}</div>
                    {rule.source === 'obliguard' && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[8px] font-medium bg-amber-500/10 text-amber-400 mt-0.5">Obliguard</span>
                    )}
                  </td>
                  <td className="text-center px-2 py-2">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium ${
                      rule.direction === 'in' ? 'bg-blue-500/10 text-blue-400' :
                      rule.direction === 'out' ? 'bg-purple-500/10 text-purple-400' :
                      'bg-gray-500/10 text-gray-400'
                    }`}>
                      {rule.direction.toUpperCase()}
                    </span>
                  </td>
                  <td className="text-center px-2 py-2">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium ${
                      rule.action === 'allow' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
                    }`}>
                      {rule.action.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-text-secondary">{rule.protocol}</td>
                  <td className="px-2 py-2 font-mono text-text-secondary">{rule.localPort}</td>
                  <td className="px-2 py-2 font-mono text-text-secondary truncate max-w-[120px]">{rule.remoteIp}</td>
                  {supportsToggle && (
                    <td className="text-center px-2 py-2">
                      <button
                        onClick={() => void handleToggle(rule.id, !rule.enabled)}
                        disabled={pending.has(rule.id) || rule.source === 'obliguard'}
                        className={`w-7 h-3.5 rounded-full transition-colors ${rule.enabled ? 'bg-accent' : 'bg-bg-tertiary'} disabled:opacity-40`}
                        role="switch" aria-checked={rule.enabled}
                      >
                        <span className={`block w-2.5 h-2.5 rounded-full bg-white transition-transform ${rule.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                      </button>
                    </td>
                  )}
                  <td className="text-right px-2 py-2">
                    {rule.source !== 'obliguard' && (
                      <button onClick={() => void handleDelete(rule.id)} disabled={pending.has(rule.id)}
                        className="p-1 rounded text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors disabled:opacity-40">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Rule Modal */}
      {showAdd && <AddRuleModal platform={platform} onAdd={handleAdd} onClose={() => setShowAdd(false)} />}
    </div>
  );
}

// ── Add Rule Modal ───────────────────────────────────────────────────────────

function AddRuleModal({ platform, onAdd, onClose }: {
  platform: string;
  onAdd: (req: FirewallAddRequest) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [action, setAction] = useState<'allow' | 'block'>('block');
  const [protocol, setProtocol] = useState('tcp');
  const [localPort, setLocalPort] = useState('');
  const [remoteIp, setRemoteIp] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRequired = platform === 'windows';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onAdd({
        name: name || undefined,
        direction, action, protocol,
        localPort: localPort || undefined,
        remoteIp: remoteIp || undefined,
      });
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-bg-primary border border-border rounded-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-primary">Add Firewall Rule</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Rule Name {nameRequired && <span className="text-status-down">*</span>}
            </label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder={nameRequired ? 'Required on Windows' : 'Optional — auto-generated'}
              required={nameRequired}
              className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary" />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Description (optional)</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="Internal note — stored in Obliguard only"
              className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Direction</label>
              <select value={direction} onChange={e => setDirection(e.target.value as 'in' | 'out')}
                className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary">
                <option value="in">Inbound</option>
                <option value="out">Outbound</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Action</label>
              <select value={action} onChange={e => setAction(e.target.value as 'allow' | 'block')}
                className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary">
                <option value="block">Block</option>
                <option value="allow">Allow</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Protocol</label>
            <select value={protocol} onChange={e => setProtocol(e.target.value)}
              className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary">
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="any">Any</option>
              <option value="icmp">ICMP</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Port (optional)</label>
            <input type="text" value={localPort} onChange={e => setLocalPort(e.target.value)} placeholder="80, 443, 8080-8090"
              className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary" />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Remote IP (optional)</label>
            <input type="text" value={remoteIp} onChange={e => setRemoteIp(e.target.value)} placeholder="any"
              className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary" />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="submit" disabled={saving}
              className="px-4 py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
              {saving ? 'Creating...' : 'Create Rule'}
            </button>
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded text-sm text-text-muted hover:text-text-primary transition-colors">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
