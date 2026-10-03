import { useState, useEffect, useCallback } from 'react';
import { Shield, ShieldOff, Plus, Trash2, RefreshCw, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { firewallApi } from '../../api/firewall.api';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import type { FirewallRule, FirewallAddRequest } from '@obliview/shared';

interface Props {
  deviceId: number;
  wsConnected: boolean;
  /** Another tenant's agent (Default god view): list only, no add/toggle/delete. */
  readOnly?: boolean;
}

/** The server's `error` message of a failed request, if any. */
function apiErrorMessage(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

export function FirewallPanel({ deviceId, wsConnected, readOnly = false }: Props) {
  const { t } = useTranslation();
  const confirmAction = useConfirm();
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
        ?? (err as Error)?.message ?? t('agentDetail.firewall.fetchFailed', { defaultValue: 'Failed to fetch firewall rules' });
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [deviceId, t]);

  useEffect(() => {
    if (wsConnected) void loadRules();
  }, [wsConnected, loadRules]);

  // The agent answers success:false (with its reason) when it refuses or
  // fails a command: that is an error too, not a "Rule deleted".
  const handleDelete = async (rule: FirewallRule) => {
    const ruleId = rule.id;
    if (!(await confirmAction({
      title: t('agentDetail.firewall.deleteTitle', { defaultValue: 'Delete firewall rule' }),
      message: t('agentDetail.firewall.deleteConfirm', { name: rule.name, defaultValue: 'Delete the firewall rule "{{name}}" on this agent?' }),
      danger: true,
    }))) return;
    setPending(p => new Set(p).add(ruleId));
    try {
      const result = await firewallApi.deleteRule(deviceId, ruleId);
      if (result.success === false) { toast.error(result.error || t('agentDetail.firewall.deleteFailed', { defaultValue: 'Failed to delete rule' })); return; }
      if (result.rules) setRules(result.rules);
      toast.success(t('agentDetail.firewall.deleted', { defaultValue: 'Rule deleted' }));
    } catch (err) { toast.error(apiErrorMessage(err) ?? t('agentDetail.firewall.deleteFailed', { defaultValue: 'Failed to delete rule' })); }
    finally { setPending(p => { const n = new Set(p); n.delete(ruleId); return n; }); }
  };

  const handleToggle = async (ruleId: string, enabled: boolean) => {
    setPending(p => new Set(p).add(ruleId));
    try {
      const result = await firewallApi.toggleRule(deviceId, ruleId, enabled);
      if (result.success === false) { toast.error(result.error || t('agentDetail.firewall.toggleFailed', { defaultValue: 'Failed to toggle rule' })); return; }
      if (result.rules) setRules(result.rules);
    } catch (err) { toast.error(apiErrorMessage(err) ?? t('agentDetail.firewall.toggleFailed', { defaultValue: 'Failed to toggle rule' })); }
    finally { setPending(p => { const n = new Set(p); n.delete(ruleId); return n; }); }
  };

  /** Resolves with the error to show in the form (null on success). */
  const handleAdd = async (req: FirewallAddRequest): Promise<AddRuleError | null> => {
    try {
      const result = await firewallApi.addRule(deviceId, req);
      if (result.success === false) return { message: result.error || t('agentDetail.firewall.createFailed', { defaultValue: 'Failed to create rule' }) };
      if (result.rules) setRules(result.rules);
      toast.success(t('agentDetail.firewall.created', { defaultValue: 'Rule created' }));
      setShowAdd(false);
      return null;
    } catch (err) {
      const data = (err as { response?: { data?: { error?: string; details?: Record<string, string[] | undefined> } } })?.response?.data;
      const fields: RuleFieldErrors = {};
      for (const [k, v] of Object.entries(data?.details ?? {})) {
        if (v?.length && (RULE_FIELDS as readonly string[]).includes(k)) fields[k as RuleField] = v[0];
      }
      return { message: data?.error ?? (err as Error)?.message ?? t('agentDetail.firewall.createFailed', { defaultValue: 'Failed to create rule' }), fields };
    }
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
        <p className="text-sm text-text-muted">{t('agentDetail.firewall.notConnected', { defaultValue: 'Agent is not connected' })}</p>
        <p className="text-xs text-text-muted mt-1">{t('agentDetail.firewall.notConnectedDesc', { defaultValue: 'Cannot manage firewall rules while offline' })}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">{t('agentDetail.firewall.title', { defaultValue: 'Firewall Rules' })}</h3>
          {platform && <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-bg-tertiary">{platform}</span>}
          <span className="text-xs text-text-muted">{t('agentDetail.firewall.ruleCount', { count: rules.length, defaultValue_one: '{{count}} rule', defaultValue_other: '{{count}} rules' })}</span>
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            label={t('common.refresh')}
            icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />}
            onClick={() => void loadRules()}
            disabled={loading}
            variant="accent"
          />
          {!readOnly && (
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors">
              <Plus size={12} /> {t('agentDetail.firewall.addRule', { defaultValue: 'Add Rule' })}
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
        <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
          placeholder={t('agentDetail.firewall.filterPlaceholder', { defaultValue: 'Filter by name, port, or IP...' })}
          className="w-full pl-8 pr-3 py-1.5 text-xs rounded border border-border bg-bg-secondary text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent" />
      </div>

      {/* Table */}
      {loading ? (
        <div className="py-12 text-center">
          <RefreshCw size={20} className="animate-spin mx-auto mb-2 text-accent" />
          <p className="text-sm text-text-muted">{t('agentDetail.firewall.fetching', { defaultValue: 'Fetching rules from agent...' })}</p>
          <p className="text-xs text-text-muted mt-1">{t('agentDetail.firewall.fetchingHint', { defaultValue: 'This may take a few seconds' })}</p>
        </div>
      ) : error ? (
        <div className="py-12 text-center">
          <ShieldOff size={24} className="mx-auto mb-2 text-status-down" />
          <p className="text-sm text-status-down font-medium">{t('agentDetail.firewall.loadFailed', { defaultValue: 'Failed to load firewall rules' })}</p>
          <p className="text-xs text-text-muted mt-1 max-w-sm mx-auto">{error}</p>
          <button onClick={() => void loadRules()} className="mt-3 px-3 py-1 rounded text-xs text-accent border border-accent/30 hover:bg-accent/10 transition-colors">
            {t('common.retry')}
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-text-muted">{filter
          ? t('agentDetail.firewall.noMatch', { defaultValue: 'No rules match the filter' })
          : t('agentDetail.firewall.empty', { defaultValue: 'No firewall rules found on this agent' })}</div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden max-h-[60vh] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-bg-tertiary sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-text-muted">{t('common.name')}</th>
                <th className="text-center px-2 py-2 font-medium text-text-muted">{t('agentDetail.firewall.colDirection', { defaultValue: 'Dir' })}</th>
                <th className="text-center px-2 py-2 font-medium text-text-muted">{t('agentDetail.firewall.colAction', { defaultValue: 'Action' })}</th>
                <th className="text-left px-2 py-2 font-medium text-text-muted">{t('agentDetail.firewall.colProtocol', { defaultValue: 'Protocol' })}</th>
                <th className="text-left px-2 py-2 font-medium text-text-muted">{t('agentDetail.firewall.colPort', { defaultValue: 'Port' })}</th>
                <th className="text-left px-2 py-2 font-medium text-text-muted">{t('agentDetail.firewall.colRemoteIp', { defaultValue: 'Remote IP' })}</th>
                {supportsToggle && <th className="text-center px-2 py-2 font-medium text-text-muted">{t('common.status')}</th>}
                <th className="text-right px-2 py-2 font-medium text-text-muted">{t('common.actions')}</th>
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
                      <span className="inline-flex justify-center">
                        <ToggleSwitch
                          size="sm"
                          checked={rule.enabled}
                          onChange={(next) => void handleToggle(rule.id, next)}
                          disabled={readOnly || pending.has(rule.id) || rule.source === 'obliguard'}
                          ariaLabel={rule.enabled
                            ? t('agentDetail.firewall.disableRule', { name: rule.name, defaultValue: 'Disable {{name}}' })
                            : t('agentDetail.firewall.enableRule', { name: rule.name, defaultValue: 'Enable {{name}}' })}
                        />
                      </span>
                    </td>
                  )}
                  <td className="text-right px-2 py-2">
                    {!readOnly && rule.source !== 'obliguard' && (
                      <IconButton
                        label={t('agentDetail.firewall.deleteRule', { name: rule.name, defaultValue: 'Delete {{name}}' })}
                        icon={<Trash2 size={12} />}
                        onClick={() => void handleDelete(rule)}
                        disabled={pending.has(rule.id)}
                        variant="danger"
                        size="sm"
                        touchTarget="overlay"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Rule Modal */}
      <Modal
        open={showAdd && !readOnly}
        onClose={() => setShowAdd(false)}
        title={t('agentDetail.firewall.addTitle', { defaultValue: 'Add Firewall Rule' })}
        size="sm"
        closeOnBackdrop={false}
        className="bg-bg-primary"
      >
        <AddRuleForm platform={platform} onAdd={handleAdd} onClose={() => setShowAdd(false)} />
      </Modal>
    </div>
  );
}

// ── Rule validation (mirrors server/src/validators/firewall.schema.ts) ──────
// The server and the agent re-validate; this only gives inline errors early.

const RULE_FIELDS = ['name', 'protocol', 'localPort', 'remoteIp'] as const;
type RuleField = typeof RULE_FIELDS[number];
type RuleFieldErrors = Partial<Record<RuleField, string>>;
interface AddRuleError { message: string; fields?: RuleFieldErrors }

const RULE_NAME_RE = /^[A-Za-z0-9 _.-]{1,64}$/;
const PORT_RE = /^([1-9][0-9]{0,4})(?:-([1-9][0-9]{0,4}))?$/;
const V4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const HEXTET_RE = /^[0-9a-fA-F]{1,4}$/;

function isAnyValue(v: string): boolean {
  const t = v.trim();
  return t === '' || t.toLowerCase() === 'any';
}

function isValidPort(v: string): boolean {
  const m = PORT_RE.exec(v);
  if (!m) return false;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return a <= 65535 && b <= 65535 && b >= a;
}

function isValidV6(v: string): boolean {
  let s = v;
  // A trailing dotted IPv4 fills the last two hextets.
  const last = s.lastIndexOf(':');
  if (s.slice(last + 1).includes('.')) {
    if (!V4_RE.test(s.slice(last + 1))) return false;
    s = `${s.slice(0, last + 1)}0:0`;
  }
  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return false;
  const parts = (x: string) => (x ? x.split(':') : []);
  const groups = dbl >= 0 ? [...parts(s.slice(0, dbl)), ...parts(s.slice(dbl + 2))] : s.split(':');
  if (dbl >= 0 ? groups.length > 7 : groups.length !== 8) return false;
  return groups.every((g) => HEXTET_RE.test(g));
}

/** IP address or CIDR network (same syntax the server accepts). */
function isValidIpOrCidr(v: string): boolean {
  if (v.length > 64 || /\s|%/.test(v)) return false;
  const [addr, prefix, extra] = v.split('/');
  if (extra !== undefined) return false;
  const family = V4_RE.test(addr) ? 4 : isValidV6(addr) ? 6 : 0;
  if (family === 0) return false;
  if (prefix === undefined) return true;
  return /^(0|[1-9][0-9]{0,2})$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

function validateRuleFields(f: { name: string; protocol: string; localPort: string; remoteIp: string }, t: TFunction): RuleFieldErrors {
  const errors: RuleFieldErrors = {};
  if (f.name !== '') {
    if (!RULE_NAME_RE.test(f.name)) errors.name = t('agentDetail.firewall.errNameChars', { defaultValue: '1-64 characters: letters, digits, space, _ . - only' });
    else if (f.name.trim() !== f.name) errors.name = t('agentDetail.firewall.errNameSpace', { defaultValue: 'Must not start or end with a space' });
    else if (f.name.toLowerCase() === 'all' || f.name.toLowerCase().startsWith('obliguard-block-')) errors.name = t('agentDetail.firewall.errNameReserved', { defaultValue: 'This name is reserved' });
  }
  if (!['tcp', 'udp', 'icmp', 'any'].includes(f.protocol)) errors.protocol = t('agentDetail.firewall.errProtocol', { defaultValue: 'Protocol must be TCP, UDP, ICMP or Any' });
  if (!isAnyValue(f.localPort)) {
    if (!isValidPort(f.localPort.trim())) errors.localPort = t('agentDetail.firewall.errPort', { defaultValue: 'A port from 1 to 65535 or a range like 8000-8100' });
    else if (f.protocol !== 'tcp' && f.protocol !== 'udp') errors.localPort = t('agentDetail.firewall.errPortProtocol', { defaultValue: 'A port needs protocol TCP or UDP' });
  }
  if (!isAnyValue(f.remoteIp) && !isValidIpOrCidr(f.remoteIp.trim())) {
    errors.remoteIp = t('agentDetail.firewall.errRemoteIp', { defaultValue: 'An IP address or a CIDR network (e.g. 203.0.113.0/24)' });
  }
  return errors;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-[11px] text-status-down">{message}</p>;
}

const inputClass = (invalid: boolean) =>
  `w-full px-3 py-1.5 rounded border bg-bg-secondary text-sm text-text-primary ${invalid ? 'border-status-down' : 'border-border'}`;

// ── Add Rule form (rendered inside the shared Modal) ─────────────────────────

function AddRuleForm({ platform, onAdd, onClose }: {
  platform: string;
  onAdd: (req: FirewallAddRequest) => Promise<AddRuleError | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [action, setAction] = useState<'allow' | 'block'>('block');
  const [protocol, setProtocol] = useState('tcp');
  const [localPort, setLocalPort] = useState('');
  const [remoteIp, setRemoteIp] = useState('');
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<AddRuleError | null>(null);
  const nameRequired = platform === 'windows';

  const fieldErrors = touched ? validateRuleFields({ name, protocol, localPort, remoteIp }, t) : {};
  const errorOf = (f: RuleField) => fieldErrors[f] ?? serverError?.fields?.[f];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setServerError(null);
    if (Object.keys(validateRuleFields({ name, protocol, localPort, remoteIp }, t)).length > 0) return;
    setSaving(true);
    try {
      const err = await onAdd({
        name: name || undefined,
        direction, action, protocol,
        localPort: isAnyValue(localPort) ? undefined : localPort.trim(),
        remoteIp: isAnyValue(remoteIp) ? undefined : remoteIp.trim(),
      });
      setServerError(err);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          {t('agentDetail.firewall.ruleName', { defaultValue: 'Rule Name' })} {nameRequired && <span className="text-status-down">*</span>}
        </label>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder={nameRequired
            ? t('agentDetail.firewall.nameRequiredWindows', { defaultValue: 'Required on Windows' })
            : t('agentDetail.firewall.nameOptional', { defaultValue: 'Optional — auto-generated' })}
          required={nameRequired} maxLength={64} aria-invalid={!!errorOf('name')}
          className={inputClass(!!errorOf('name'))} />
        <FieldError message={errorOf('name')} />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">{t('agentDetail.firewall.descriptionOptional', { defaultValue: 'Description (optional)' })}</label>
        <input type="text" value={description} onChange={e => setDescription(e.target.value)}
          placeholder={t('agentDetail.firewall.descriptionPlaceholder', { defaultValue: 'Internal note — stored in Obliguard only' })}
          className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('agentDetail.firewall.direction', { defaultValue: 'Direction' })}</label>
          <select value={direction} onChange={e => setDirection(e.target.value as 'in' | 'out')}
            className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary">
            <option value="in">{t('agentDetail.firewall.inbound', { defaultValue: 'Inbound' })}</option>
            <option value="out">{t('agentDetail.firewall.outbound', { defaultValue: 'Outbound' })}</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">{t('agentDetail.firewall.colAction', { defaultValue: 'Action' })}</label>
          <select value={action} onChange={e => setAction(e.target.value as 'allow' | 'block')}
            className="w-full px-3 py-1.5 rounded border border-border bg-bg-secondary text-sm text-text-primary">
            <option value="block">{t('agentDetail.firewall.block', { defaultValue: 'Block' })}</option>
            <option value="allow">{t('agentDetail.firewall.allow', { defaultValue: 'Allow' })}</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">{t('agentDetail.firewall.colProtocol', { defaultValue: 'Protocol' })}</label>
        <select value={protocol} onChange={e => setProtocol(e.target.value)}
          aria-invalid={!!errorOf('protocol')} className={inputClass(!!errorOf('protocol'))}>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
          <option value="any">{t('agentDetail.firewall.any', { defaultValue: 'Any' })}</option>
          <option value="icmp">ICMP</option>
        </select>
        <FieldError message={errorOf('protocol')} />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">{t('agentDetail.firewall.portOptional', { defaultValue: 'Port (optional)' })}</label>
        <input type="text" value={localPort} onChange={e => setLocalPort(e.target.value)} placeholder={t('agentDetail.firewall.portPlaceholder', { defaultValue: '443 or 8080-8090' })}
          aria-invalid={!!errorOf('localPort')} className={inputClass(!!errorOf('localPort'))} />
        <FieldError message={errorOf('localPort')} />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">{t('agentDetail.firewall.remoteIpOptional', { defaultValue: 'Remote IP (optional)' })}</label>
        <input type="text" value={remoteIp} onChange={e => setRemoteIp(e.target.value)} placeholder={t('agentDetail.firewall.remoteIpPlaceholder', { defaultValue: 'any, 203.0.113.7 or 203.0.113.0/24' })}
          aria-invalid={!!errorOf('remoteIp')} className={inputClass(!!errorOf('remoteIp'))} />
        <FieldError message={errorOf('remoteIp')} />
      </div>
      {serverError && !Object.values(serverError.fields ?? {}).some(Boolean) && (
        <p className="text-xs text-status-down">{serverError.message}</p>
      )}
      <div className="flex gap-2 pt-2">
        <button type="submit" disabled={saving}
          className="px-4 py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
          {saving
            ? t('agentDetail.firewall.creating', { defaultValue: 'Creating...' })
            : t('agentDetail.firewall.createRule', { defaultValue: 'Create Rule' })}
        </button>
        <button type="button" onClick={onClose}
          className="px-4 py-2 rounded text-sm text-text-muted hover:text-text-primary transition-colors">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
