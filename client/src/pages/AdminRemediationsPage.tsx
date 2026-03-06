import { useState, useEffect } from 'react';
import {
  Plus, Pencil, Trash2, ShieldCheck, Zap, Globe,
  Loader2, ChevronDown, ChevronUp,
} from 'lucide-react';
import type {
  RemediationAction,
  RemediationBinding,
  RemediationActionType,
  WebhookRemediationConfig,
  ScriptRemediationConfig,
  DockerRestartRemediationConfig,
  SshRemediationConfig,
} from '@obliview/shared';
import { remediationApi } from '../api/remediation.api';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

// ─── Type metadata ─────────────────────────────────────────────────────────────

const ACTION_TYPE_LABELS: Record<RemediationActionType, string> = {
  webhook:        'Generic Webhook',
  n8n:            'N8N Workflow',
  script:         'Custom Script',
  docker_restart: 'Docker Restart',
  ssh:            'SSH Command',
};

const ACTION_TYPE_DESCRIPTIONS: Record<RemediationActionType, string> = {
  webhook:        'HTTP request to any endpoint',
  n8n:            'Trigger an N8N workflow via webhook',
  script:         'Run a shell script on the server',
  docker_restart: 'Restart a Docker container',
  ssh:            'Run a command on a remote host via SSH',
};

const ACTION_TYPES = Object.keys(ACTION_TYPE_LABELS) as RemediationActionType[];

// ─── Config editors ────────────────────────────────────────────────────────────

function WebhookForm({
  config, onChange, isN8n,
}: {
  config: Partial<WebhookRemediationConfig>;
  onChange: (c: Partial<WebhookRemediationConfig>) => void;
  isN8n?: boolean;
}) {
  return (
    <div className="space-y-3">
      <Input label={isN8n ? 'N8N Webhook URL' : 'URL'} type="url" required
        value={config.url ?? ''} onChange={e => onChange({ ...config, url: e.target.value })}
        placeholder="https://..." />
      {!isN8n && (
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Method</label>
          <select value={config.method ?? 'POST'} onChange={e => onChange({ ...config, method: e.target.value as WebhookRemediationConfig['method'] })}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
            {['POST', 'GET', 'PUT', 'PATCH'].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}
      <Input label="Timeout (ms)" type="number" min={1000} max={60000}
        value={String(config.timeoutMs ?? 10000)}
        onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} />
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Extra Headers <span className="font-normal text-text-muted">(JSON object)</span>
        </label>
        <textarea rows={2}
          value={config.headers ? JSON.stringify(config.headers, null, 2) : ''}
          onChange={e => {
            try { onChange({ ...config, headers: JSON.parse(e.target.value || '{}') }); } catch { /* ignore */ }
          }}
          placeholder='{"Authorization": "Bearer ..."}'
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none font-mono text-xs" />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Extra body fields <span className="font-normal text-text-muted">(JSON, merged with event payload)</span>
        </label>
        <textarea rows={2}
          value={config.bodyExtra ? JSON.stringify(config.bodyExtra, null, 2) : ''}
          onChange={e => {
            try { onChange({ ...config, bodyExtra: JSON.parse(e.target.value || '{}') }); } catch { /* ignore */ }
          }}
          placeholder='{"token": "abc"}'
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none font-mono text-xs" />
      </div>
    </div>
  );
}

function ScriptForm({ config, onChange }: {
  config: Partial<ScriptRemediationConfig>;
  onChange: (c: Partial<ScriptRemediationConfig>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">Script</label>
        <textarea rows={6} required
          value={config.script ?? ''}
          onChange={e => onChange({ ...config, script: e.target.value })}
          placeholder={'#!/bin/sh\n# Available env vars: MONITOR_ID, MONITOR_NAME, STATUS, PREV_STATUS, TRIGGER\necho "Monitor $MONITOR_NAME is $STATUS"'}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono text-xs" />
      </div>
      <Input label="Shell" value={config.shell ?? '/bin/sh'}
        onChange={e => onChange({ ...config, shell: e.target.value })}
        placeholder="/bin/sh" />
      <Input label="Timeout (ms)" type="number" min={1000} max={120000}
        value={String(config.timeoutMs ?? 30000)}
        onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} />
    </div>
  );
}

function DockerForm({ config, onChange }: {
  config: Partial<DockerRestartRemediationConfig>;
  onChange: (c: Partial<DockerRestartRemediationConfig>) => void;
}) {
  return (
    <div className="space-y-3">
      <Input label="Container Name" required
        value={config.containerName ?? ''}
        onChange={e => onChange({ ...config, containerName: e.target.value })}
        placeholder="my-nginx" />
      <Input label="Docker Socket Path"
        value={config.socketPath ?? '/var/run/docker.sock'}
        onChange={e => onChange({ ...config, socketPath: e.target.value })}
        placeholder="/var/run/docker.sock" />
    </div>
  );
}

function SshForm({
  config, onChange, isEdit,
}: {
  config: Partial<SshRemediationConfig & { credential?: string }>;
  onChange: (c: Partial<SshRemediationConfig & { credential?: string }>) => void;
  isEdit?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Input label="Host" required
            value={config.host ?? ''}
            onChange={e => onChange({ ...config, host: e.target.value })}
            placeholder="192.168.1.10" />
        </div>
        <Input label="Port" type="number" min={1} max={65535}
          value={String(config.port ?? 22)}
          onChange={e => onChange({ ...config, port: Number(e.target.value) })} />
      </div>
      <Input label="Username" required
        value={config.username ?? ''}
        onChange={e => onChange({ ...config, username: e.target.value })}
        placeholder="root" />
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">Auth Type</label>
        <select value={config.authType ?? 'password'}
          onChange={e => onChange({ ...config, authType: e.target.value as 'password' | 'key' })}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
          <option value="password">Password</option>
          <option value="key">Private Key</option>
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          {config.authType === 'key' ? 'Private Key' : 'Password'}
          {isEdit && <span className="ml-1 text-text-muted font-normal">(leave blank to keep existing)</span>}
        </label>
        {config.authType === 'key' ? (
          <textarea rows={4}
            value={config.credential ?? ''}
            onChange={e => onChange({ ...config, credential: e.target.value })}
            placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...'}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono text-xs" />
        ) : (
          <input type="password" autoComplete="new-password"
            value={config.credential ?? ''}
            onChange={e => onChange({ ...config, credential: e.target.value })}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        )}
      </div>
      <Input label="Command" required
        value={config.command ?? ''}
        onChange={e => onChange({ ...config, command: e.target.value })}
        placeholder="sudo systemctl restart nginx" />
      <Input label="Timeout (ms)" type="number" min={1000} max={60000}
        value={String(config.timeoutMs ?? 15000)}
        onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} />
      <p className="text-xs text-text-muted">{t('remediations.credentialsNote')}</p>
    </div>
  );
}

// ─── Action modal ─────────────────────────────────────────────────────────────

type AnyConfig = Record<string, unknown>;

function ActionModal({
  initial, onSave, onClose,
}: {
  initial?: RemediationAction;
  onSave: (name: string, type: RemediationActionType, config: AnyConfig, enabled: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<RemediationActionType>(initial?.type ?? 'webhook');
  const [name, setName] = useState(initial?.name ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [config, setConfig] = useState<AnyConfig>(() => {
    if (!initial) return { method: 'POST', timeoutMs: 10000 };
    const c = { ...(initial.config as unknown as AnyConfig) };
    // Remove masked credential
    if (c.credentialEnc === '[set]') delete c.credentialEnc;
    return c;
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(name, type, config, enabled);
    } finally {
      setSaving(false);
    }
  };

  const renderConfigForm = () => {
    switch (type) {
      case 'webhook':
        return <WebhookForm config={config as Partial<WebhookRemediationConfig>} onChange={c => setConfig(c as AnyConfig)} />;
      case 'n8n':
        return <WebhookForm config={config as Partial<WebhookRemediationConfig>} onChange={c => setConfig(c as AnyConfig)} isN8n />;
      case 'script':
        return <ScriptForm config={config as Partial<ScriptRemediationConfig>} onChange={c => setConfig(c as AnyConfig)} />;
      case 'docker_restart':
        return <DockerForm config={config as Partial<DockerRestartRemediationConfig>} onChange={c => setConfig(c as AnyConfig)} />;
      case 'ssh':
        return <SshForm config={config as Partial<SshRemediationConfig & { credential?: string }>} onChange={c => setConfig(c as AnyConfig)} isEdit={!!initial} />;
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-bg-primary shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <ShieldCheck size={16} /> {initial ? t('remediations.editAction') : t('remediations.newAction')}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 p-5 space-y-4">
          <Input label={t('remediations.nameLabel')} required value={name} onChange={e => setName(e.target.value)} placeholder={t('remediations.namePlaceholder')} />

          {/* Type selector — only for new actions */}
          {!initial && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-2">{t('remediations.actionType')}</label>
              <div className="grid grid-cols-1 gap-2">
                {ACTION_TYPES.map(t_ => (
                  <label key={t_} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    type === t_
                      ? 'border-accent bg-accent/5'
                      : 'border-border hover:border-accent/50 hover:bg-bg-hover'
                  }`}>
                    <input type="radio" name="actionType" value={t_} checked={type === t_}
                      onChange={() => { setType(t_); setConfig({}); }} className="mt-0.5 accent-accent" />
                    <div>
                      <div className="text-sm font-medium text-text-primary">{ACTION_TYPE_LABELS[t_]}</div>
                      <div className="text-xs text-text-muted">{ACTION_TYPE_DESCRIPTIONS[t_]}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Enabled toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">{t('remediations.enabledLabel')}</span>
            <button type="button" onClick={() => setEnabled(v => !v)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                enabled ? 'bg-accent' : 'bg-bg-tertiary border border-border'
              }`}>
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                enabled ? 'translate-x-4' : 'translate-x-0.5'
              }`} />
            </button>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-3">
              {t('remediations.sectionConfig', { type: ACTION_TYPE_LABELS[type] })}
            </p>
            {renderConfigForm()}
          </div>
        </form>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border shrink-0">
          <Button variant="secondary" onClick={onClose} type="button">{t('common.cancel')}</Button>
          <Button loading={saving} onClick={(e) => {
            // trigger form submit
            (e.currentTarget.closest('form') as HTMLFormElement | null)?.requestSubmit()
              ?? handleSubmit(e as unknown as React.FormEvent);
          }}>
            {initial ? t('common.save') : t('common.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Global Bindings inline panel ─────────────────────────────────────────────

function GlobalBindingsPanel({ actions }: { actions: RemediationAction[] }) {
  const { t } = useTranslation();
  const [bindings, setBindings] = useState<RemediationBinding[]>([]);
  const [open, setOpen] = useState(false);
  const [addingId, setAddingId] = useState<number | null>(null);

  useEffect(() => {
    remediationApi.getBindings('global', null)
      .then(setBindings)
      .catch(() => {});
  }, []);

  const isBound = (actionId: number) => bindings.some(b => b.actionId === actionId);

  const toggle = async (actionId: number) => {
    if (isBound(actionId)) {
      const b = bindings.find(b => b.actionId === actionId)!;
      await remediationApi.deleteBinding(b.id);
      setBindings(prev => prev.filter(b => b.actionId !== actionId));
      toast.success('Removed from global');
    } else {
      setAddingId(actionId);
      try {
        const nb = await remediationApi.addBinding({
          actionId, scope: 'global', overrideMode: 'merge', triggerOn: 'down', cooldownSeconds: 300,
        });
        setBindings(prev => [...prev, nb]);
        toast.success('Added to global');
      } catch { toast.error('Failed to add binding'); }
      finally { setAddingId(null); }
    }
  };

  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-text-primary hover:bg-bg-hover transition-colors rounded-lg">
        <span className="flex items-center gap-2">
          <Globe size={14} className="text-text-muted" />
          {t('remediations.globalBindings')}
          {bindings.length > 0 && (
            <span className="rounded-full bg-accent/10 text-accent text-xs px-2 py-0.5 font-medium">
              {bindings.length}
            </span>
          )}
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-border space-y-1 pt-3">
          <p className="text-xs text-text-muted mb-2">
            {t('remediations.globalBindingsDesc')}
          </p>
          {actions.length === 0 && (
            <p className="text-xs text-text-muted">{t('remediations.noActions')}</p>
          )}
          {actions.map(a => (
            <div key={a.id} className="flex items-center justify-between gap-2 py-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm text-text-primary truncate">{a.name}</span>
                <span className="text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded-full shrink-0">
                  {ACTION_TYPE_LABELS[a.type]}
                </span>
              </div>
              <button
                onClick={() => void toggle(a.id)}
                disabled={addingId === a.id}
                className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
                  isBound(a.id)
                    ? 'bg-accent/10 text-accent hover:bg-accent/20'
                    : 'text-text-muted border border-border hover:bg-bg-hover'
                }`}>
                {addingId === a.id ? <Loader2 size={11} className="animate-spin" /> : isBound(a.id) ? t('remediations.globalActive') : t('remediations.addToGlobal')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export function AdminRemediationsPage() {
  const { t } = useTranslation();
  const [actions, setActions]   = useState<RemediationAction[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing]   = useState<RemediationAction | undefined>(undefined);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<number | null>(null);

  const load = async () => {
    try {
      const a = await remediationApi.listActions();
      setActions(a);
    } catch {
      toast.error('Failed to load remediation actions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const openCreate = () => { setEditing(undefined); setShowModal(true); };
  const openEdit   = (a: RemediationAction) => { setEditing(a); setShowModal(true); };

  const handleSave = async (name: string, type: RemediationActionType, config: AnyConfig, enabled: boolean) => {
    try {
      if (editing) {
        const updated = await remediationApi.updateAction(editing.id, { name, config, enabled });
        setActions(prev => prev.map(a => a.id === editing.id ? updated : a));
        toast.success('Action updated');
      } else {
        const created = await remediationApi.createAction({ name, type, config, enabled });
        setActions(prev => [...prev, created]);
        toast.success('Action created');
      }
      setShowModal(false);
    } catch {
      toast.error('Failed to save action');
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Delete this remediation action? All bindings and run history will be removed.')) return;
    setDeleting(id);
    try {
      await remediationApi.deleteAction(id);
      setActions(prev => prev.filter(a => a.id !== id));
      toast.success('Action deleted');
    } catch {
      toast.error('Failed to delete action');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto min-w-0 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <ShieldCheck size={20} /> {t('remediations.title')}
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            Automated actions triggered when monitors change status
          </p>
        </div>
        <Button onClick={openCreate} className="flex items-center gap-1.5">
          <Plus size={15} /> {t('remediations.newAction')}
        </Button>
      </div>

      {/* Global Bindings panel */}
      <GlobalBindingsPanel actions={actions} />

      {/* Actions list */}
      <div className="rounded-lg border border-border bg-bg-secondary">
        {loading ? (
          <div className="py-12 flex items-center justify-center">
            <Loader2 size={24} className="animate-spin text-text-muted" />
          </div>
        ) : actions.length === 0 ? (
          <div className="py-12 text-center">
            <ShieldCheck size={32} className="mx-auto mb-3 text-text-muted opacity-40" />
            <p className="text-text-muted">{t('remediations.noActions')}</p>
            <p className="text-sm text-text-muted mt-1">
              Create actions to automate responses to monitor failures
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {actions.map(action => (
              <div key={action.id} className="px-4 py-3 group">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Zap size={13} className="text-amber-400 shrink-0" />
                      <span className="text-sm font-medium text-text-primary">{action.name}</span>
                      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-muted">
                        {ACTION_TYPE_LABELS[action.type]}
                      </span>
                      {!action.enabled && (
                        <span className="rounded-full bg-status-down/10 px-2 py-0.5 text-[10px] font-medium text-status-down">
                          {t('status.disabled')}
                        </span>
                      )}
                    </div>
                    {/* Config summary */}
                    <div className="text-xs text-text-muted mt-0.5 truncate">
                      {action.type === 'webhook' || action.type === 'n8n'
                        ? (action.config as WebhookRemediationConfig).url
                        : action.type === 'script'
                        ? `${(action.config as ScriptRemediationConfig).shell ?? '/bin/sh'}`
                        : action.type === 'docker_restart'
                        ? (action.config as DockerRestartRemediationConfig).containerName
                        : action.type === 'ssh'
                        ? `${(action.config as SshRemediationConfig).username}@${(action.config as SshRemediationConfig).host}`
                        : ''}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setExpandedRuns(expandedRuns === action.id ? null : action.id)}
                      className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                      title="View run history">
                      <ChevronDown size={14} className={expandedRuns === action.id ? 'rotate-180 transition-transform' : 'transition-transform'} />
                    </button>
                    <button onClick={() => openEdit(action)}
                      className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                      title={t('common.edit')}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => void handleDelete(action.id)} disabled={deleting === action.id}
                      className="p-1.5 rounded text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors disabled:opacity-40"
                      title={t('common.delete')}>
                      {deleting === action.id
                        ? <Loader2 size={14} className="animate-spin" />
                        : <Trash2 size={14} />}
                    </button>
                  </div>
                </div>

                {/* Run history expand */}
                {expandedRuns === action.id && <RunHistory actionId={action.id} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <ActionModal
          initial={editing}
          onSave={handleSave}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

// ─── Run history sub-component ────────────────────────────────────────────────

function RunHistory({ actionId }: { actionId: number }) {
  const [runs, setRuns] = useState<import('@obliview/shared').RemediationRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    remediationApi.getRunsForAction(actionId).then(setRuns).catch(() => {}).finally(() => setLoading(false));
  }, [actionId]);

  const statusColor = (s: string) => {
    if (s === 'success') return 'text-status-up';
    if (s === 'cooldown_skip') return 'text-text-muted';
    if (s === 'timeout') return 'text-yellow-400';
    return 'text-status-down';
  };

  return (
    <div className="mt-2 ml-5 border-l-2 border-border pl-3 space-y-1">
      {loading && <p className="text-xs text-text-muted animate-pulse">Loading…</p>}
      {!loading && runs.length === 0 && <p className="text-xs text-text-muted">No runs yet</p>}
      {runs.slice(0, 10).map(r => (
        <div key={r.id} className="flex items-start gap-2 text-xs py-0.5">
          <span className={`font-medium shrink-0 ${statusColor(r.status)}`}>{r.status}</span>
          <span className="text-text-muted shrink-0">•</span>
          <span className="text-text-muted shrink-0">{r.triggeredBy === 'down' ? '↓' : '↑'} monitor {r.monitorId}</span>
          {r.durationMs != null && <span className="text-text-muted shrink-0">{r.durationMs}ms</span>}
          {r.error && <span className="text-status-down truncate">{r.error}</span>}
          <span className="text-text-muted ml-auto shrink-0">{new Date(r.triggeredAt).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

export default AdminRemediationsPage;
