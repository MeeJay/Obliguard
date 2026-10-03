import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { CreateServiceTemplateRequest, ServiceTemplate, ServiceType } from '@obliview/shared';
import { serviceTemplatesApi } from '@/api/serviceTemplates.api';
import { ServiceTemplatesPanel } from '@/components/agent/ServiceTemplatesPanel';
import { MikroTikPanel } from '@/components/mikrotik/MikroTikPanel';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useCan } from '@/hooks/usePermission';
import { cn } from '@/utils/cn';
import { type AgentTabProps } from './parts';

function apiErrorText(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error
    ?? (err instanceof Error && err.message ? err.message : fallback);
}

// ── LocalTemplateModal ────────────────────────────────────────────────────────

const inputCls = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent';

function LocalTemplateModal({
  deviceId,
  onSave,
  onClose,
}: {
  deviceId: number;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name,          setName]          = useState('');
  const [serviceType,   setServiceType]   = useState('');
  const [logPath,       setLogPath]       = useState('');
  const [threshold,     setThreshold]     = useState('5');
  const [windowSeconds, setWindowSeconds] = useState('600');
  const [mode,          setMode]          = useState<'ban' | 'track'>('ban');
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !serviceType.trim()) {
      setError(t('agentDetail.localTemplates.required', { defaultValue: 'Name and service type are required.' }));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const data: CreateServiceTemplateRequest = {
        name:           name.trim(),
        serviceType:    serviceType.trim() as ServiceType,
        defaultLogPath: logPath.trim() || null,
        threshold:      Number(threshold) || 5,
        windowSeconds:  Number(windowSeconds) || 600,
        mode,
        ownerScope:     'agent',
        ownerScopeId:   deviceId,
      };
      await serviceTemplatesApi.create(data);
      onSave();
    } catch (err: unknown) {
      setError(apiErrorText(err, t('agentDetail.localTemplates.createFailed', { defaultValue: 'Failed to create the template' })));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('agentDetail.localTemplates.createTitle', { defaultValue: 'Create local template' })}
      size="sm"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button type="submit" form="local-template-form" loading={saving}>
            {t('agentDetail.localTemplates.create', { defaultValue: 'Create template' })}
          </Button>
        </>
      }
    >
      <p className="text-xs text-text-muted mb-4">
        {t('agentDetail.localTemplates.createDesc', { defaultValue: 'This template is private to this agent and auto-assigned to it.' })}
      </p>
      {error && <p className="text-xs text-red-400 mb-3" role="alert">{error}</p>}
      <form id="local-template-form" onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="lt-name" className="block text-sm font-medium text-text-secondary">{t('common.name', { defaultValue: 'Name' })}</label>
          <input id="lt-name" value={name} onChange={e => setName(e.target.value)} className={inputCls}
            placeholder={t('agentDetail.localTemplates.namePlaceholder', { defaultValue: 'e.g. SSH brute-force' })} />
        </div>
        <div className="space-y-1">
          <label htmlFor="lt-type" className="block text-sm font-medium text-text-secondary">{t('agentDetail.localTemplates.serviceType', { defaultValue: 'Service type' })}</label>
          <input id="lt-type" value={serviceType} onChange={e => setServiceType(e.target.value)} className={cn(inputCls, 'font-mono')}
            placeholder={t('agentDetail.localTemplates.serviceTypePlaceholder', { defaultValue: 'e.g. ssh, rdp, ftp' })}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </div>
        <div className="space-y-1">
          <label htmlFor="lt-path" className="block text-sm font-medium text-text-secondary">{t('agentDetail.localTemplates.logPath', { defaultValue: 'Log path' })}</label>
          <input id="lt-path" value={logPath} onChange={e => setLogPath(e.target.value)} className={cn(inputCls, 'font-mono')}
            placeholder="/var/log/auth.log" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="lt-threshold" className="block text-sm font-medium text-text-secondary">{t('agentDetail.localTemplates.threshold', { defaultValue: 'Threshold (failures)' })}</label>
            <input id="lt-threshold" type="number" min={1} value={threshold} onChange={e => setThreshold(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label htmlFor="lt-window" className="block text-sm font-medium text-text-secondary">{t('agentDetail.localTemplates.window', { defaultValue: 'Window (s)' })}</label>
            <input id="lt-window" type="number" min={60} value={windowSeconds} onChange={e => setWindowSeconds(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="space-y-1">
          <span className="block text-sm font-medium text-text-secondary">{t('agentDetail.localTemplates.mode', { defaultValue: 'Mode' })}</span>
          <div className="flex gap-1 rounded-md border border-border bg-bg-tertiary p-1" role="radiogroup">
            {(['ban', 'track'] as const).map(m => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  'flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors coarse:min-h-10',
                  mode === m
                    ? m === 'ban' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'
                    : 'text-text-muted hover:text-text-secondary',
                )}
              >
                {m === 'ban'
                  ? t('agentDetail.localTemplates.modeBan', { defaultValue: 'Ban' })
                  : t('agentDetail.localTemplates.modeTrack', { defaultValue: 'Track only' })}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-text-muted">
            {mode === 'ban'
              ? t('agentDetail.localTemplates.modeBanDesc', { defaultValue: 'Triggers auto-bans when the threshold is exceeded.' })
              : t('agentDetail.localTemplates.modeTrackDesc', { defaultValue: 'Logs events but never triggers bans.' })}
          </p>
        </div>
      </form>
    </Modal>
  );
}

// ── Local templates (owned by this agent) ────────────────────────────────────

function LocalTemplates({
  deviceId, readOnly, showCreate, onCloseCreate, refreshKey,
}: {
  deviceId: number;
  readOnly: boolean;
  showCreate: boolean;
  onCloseCreate: () => void;
  refreshKey: number;
}) {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const [localTemplates, setLocalTemplates] = useState<ServiceTemplate[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [expanded,       setExpanded]       = useState(true);
  const [deletingId,     setDeletingId]     = useState<number | null>(null);

  const loadLocal = useCallback(async () => {
    setLoading(true);
    try {
      setLocalTemplates(await serviceTemplatesApi.listLocal('agent', deviceId));
    } catch {
      setLocalTemplates([]);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { void loadLocal(); }, [loadLocal, refreshKey]);

  async function handleDelete(tpl: ServiceTemplate) {
    const ok = await askConfirm({
      title: t('agentDetail.localTemplates.deleteTitle', { defaultValue: 'Delete local template' }),
      message: t('agentDetail.localTemplates.deleteConfirm', {
        defaultValue: 'Permanently delete {{name}}? This template belongs to this agent only and will be removed completely.',
        name: tpl.name,
      }),
      danger: true,
    });
    if (!ok) return;
    setDeletingId(tpl.id);
    try {
      await serviceTemplatesApi.delete(tpl.id);
      toast.success(t('agentDetail.localTemplates.deleted', { defaultValue: 'Template deleted' }));
      void loadLocal();
    } catch (err) {
      toast.error(apiErrorText(err, t('agentDetail.localTemplates.deleteFailed', { defaultValue: 'Failed to delete the template' })));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      {(localTemplates.length > 0 || loading) && (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              aria-expanded={expanded}
              className="flex items-center gap-2 min-w-0 coarse:min-h-10"
            >
              {expanded
                ? <ChevronUp size={14} className="text-text-muted" />
                : <ChevronDown size={14} className="text-text-muted" />}
              <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                {t('agentDetail.localTemplates.title', { defaultValue: 'Local templates' })}
              </h2>
              {!loading && (
                <span className="text-xs text-text-muted">
                  {t('agentDetail.localTemplates.count', { defaultValue: '{{count}} local', count: localTemplates.length })}
                </span>
              )}
            </button>
            <IconButton
              size="sm"
              label={t('common.refresh', { defaultValue: 'Refresh' })}
              icon={<RefreshCw size={12} className={loading ? 'animate-spin' : ''} />}
              onClick={() => void loadLocal()}
            />
          </div>

          {expanded && (
            <div className="divide-y divide-border">
              {loading ? (
                <div className="py-6 text-center text-sm text-text-muted">{t('common.loading', { defaultValue: 'Loading…' })}</div>
              ) : (
                localTemplates.map(tpl => (
                  <div key={tpl.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="w-2 h-2 rounded-full flex-shrink-0 bg-indigo-400" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary">{tpl.name}</span>
                        <span className="inline-flex items-center rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono text-text-muted border border-border">
                          {tpl.serviceType}
                        </span>
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/15 text-indigo-400">
                          {t('agentDetail.localTemplates.localBadge', { defaultValue: 'local' })}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-text-muted flex flex-wrap gap-x-3">
                        <span>
                          {t('agentDetail.localTemplates.thresholdLine', {
                            defaultValue: 'Threshold: {{threshold}} / {{window}}s',
                            threshold: tpl.threshold,
                            window: tpl.windowSeconds,
                          })}
                        </span>
                        {tpl.defaultLogPath && (
                          <span className="font-mono truncate max-w-[220px]">{tpl.defaultLogPath}</span>
                        )}
                      </div>
                    </div>
                    {!readOnly && (
                      <IconButton
                        size="sm"
                        variant="danger"
                        label={t('agentDetail.localTemplates.delete', { defaultValue: 'Delete this local template' })}
                        icon={<Trash2 size={13} />}
                        disabled={deletingId === tpl.id}
                        onClick={() => void handleDelete(tpl)}
                      />
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {showCreate && !readOnly && (
        <LocalTemplateModal
          deviceId={deviceId}
          onSave={() => { onCloseCreate(); void loadLocal(); }}
          onClose={onCloseCreate}
        />
      )}
    </>
  );
}

// ── ServicesTab ──────────────────────────────────────────────────────────────

/**
 * Services & templates: the MikroTik connection (routers only), the service
 * templates applied to this agent (opt-out model) and its local templates.
 */
export function ServicesTab({ device, readOnly, refreshKey }: AgentTabProps) {
  const { t } = useTranslation();
  const canTemplates = useCan('templates.write');
  const canMikrotik = useCan('integrations.mikrotik');
  const templatesReadOnly = readOnly || !canTemplates;
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-4">
      {/* MikroTik connection (credentials are never god-viewed: not rendered for another tenant's router) */}
      {device.deviceType === 'mikrotik' && (
        readOnly || !canMikrotik ? (
          <p className="rounded-lg border border-border bg-bg-secondary px-4 py-2.5 text-xs text-text-muted">
            {readOnly && device.accessLevel === 'ro'
              ? t('agentDetail.readOnlyGrant', { defaultValue: 'Your team has read-only access to this agent.' })
              : readOnly
              ? t('agents.foreignReadOnly', 'This agent belongs to another tenant. It is read-only here: switch to its tenant to change it.')
              : t('agentDetail.services.mikrotikNoAccess', { defaultValue: 'Managing the router connection needs the MikroTik integration permission.' })}
          </p>
        ) : (
          <MikroTikPanel key={refreshKey} deviceId={device.id} mikrotikStatus={device.mikrotikStatus} />
        )
      )}

      {/* Service templates — opt-out model */}
      <ServiceTemplatesPanel
        key={refreshKey}
        scope="device"
        scopeId={device.id}
        readOnly={templatesReadOnly}
        onCreateLocal={templatesReadOnly ? undefined : () => setShowCreate(true)}
      />

      <LocalTemplates
        deviceId={device.id}
        readOnly={templatesReadOnly}
        showCreate={showCreate}
        onCloseCreate={() => setShowCreate(false)}
        refreshKey={refreshKey}
      />
    </div>
  );
}
