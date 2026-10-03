import { useState, useEffect, useRef, type FormEvent } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Bell,
  TestTube2,
  Zap,
  Loader2,
  Building2,
  ChevronDown,
  ChevronRight,
  X,
  Eye,
  Lock,
} from 'lucide-react';
import type {
  NotificationChannel,
  NotificationPluginMeta,
  NotificationBinding,
  SmtpServer,
} from '@obliview/shared';
import { NOTIFICATION_REDACTED, isMasterTenant } from '@obliview/shared';
import { notificationsApi } from '@/api/notifications.api';
import { smtpServerApi } from '@/api/smtpServer.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { useConfirm } from '@/components/common/ConfirmDialog';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useTenantStore } from '@/store/tenantStore';
import { useIsPlatformAdmin } from '@/hooks/usePermission';

/**
 * A binding as the server returns it: every row carries the tenant it belongs
 * to (a tenant's global binding covers its own agents; the Default tenant's
 * covers every tenant). A tenant only receives its own rows; the Default
 * tenant receives every tenant's (god view).
 */
type TenantBinding = NotificationBinding;

// ── Tenant sharing panel (per channel) ──────────────────────────────────────

interface TenantSharingPanelProps {
  channelId: number;
  currentTenantId: number | null;
}

function TenantSharingPanel({ channelId, currentTenantId }: TenantSharingPanelProps) {
  const { t } = useTranslation();
  const { tenants } = useTenantStore();
  const [sharedTenantIds, setSharedTenantIds] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addingId, setAddingId] = useState<number | ''>('');
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    setLoading(true);
    notificationsApi.getChannelTenants(channelId)
      .then((ids) => {
        if (isMounted.current) {
          setSharedTenantIds(ids);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!isMounted.current) return;
        setLoading(false);
        toast.error(t('notifications.failedLoadTenants', 'Failed to load the workspaces this channel is shared with'));
      });
    return () => { isMounted.current = false; };
  }, [channelId, t]);

  const applyChange = async (newIds: number[]) => {
    setSaving(true);
    try {
      await notificationsApi.setChannelTenants(channelId, newIds);
      setSharedTenantIds(newIds);
    } catch {
      toast.error(t('notifications.failedTenantAssign'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = (tenantId: number) => {
    if (!sharedTenantIds) return;
    applyChange(sharedTenantIds.filter((id) => id !== tenantId));
  };

  const handleAdd = () => {
    if (!addingId || !sharedTenantIds) return;
    const id = Number(addingId);
    if (sharedTenantIds.includes(id)) return;
    applyChange([...sharedTenantIds, id]);
    setAddingId('');
  };

  // Available: exclude the channel's owner tenant (current) and already-shared ones
  const availableTenants = tenants.filter(
    (t) => t.id !== currentTenantId && !(sharedTenantIds ?? []).includes(t.id),
  );

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-1.5 px-3 py-2 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        {t('common.loading')}…
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-border bg-bg-primary px-3 py-2.5 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        {t('notifications.sharedWith')}
      </p>

      {/* Current shared tenants */}
      <div className="flex flex-wrap gap-1.5 min-h-[22px]">
        {sharedTenantIds && sharedTenantIds.length === 0 && (
          <span className="text-xs text-text-muted italic">{t('notifications.notShared')}</span>
        )}
        {sharedTenantIds?.map((tid) => {
          const tenant = tenants.find((t) => t.id === tid);
          return (
            <span
              key={tid}
              className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary border border-border px-2 py-0.5 text-xs text-text-primary"
            >
              <Building2 size={10} className="text-text-muted shrink-0" />
              {tenant?.name ?? t('notifications.tenantFallback', { id: tid, defaultValue: 'Tenant #{{id}}' })}
              <IconButton
                label={t('notifications.removeTenantAccess')}
                icon={<X size={10} />}
                onClick={() => handleRemove(tid)}
                disabled={saving}
                variant="danger"
                size="xs"
                touchTarget="overlay"
                className="ml-0.5"
              />
            </span>
          );
        })}
        {saving && <Loader2 size={12} className="animate-spin text-text-muted self-center" />}
      </div>

      {/* Add tenant */}
      {availableTenants.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={addingId}
            onChange={(e) => setAddingId(e.target.value ? Number(e.target.value) : '')}
            className="rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{t('notifications.selectTenant')}</option>
            {availableTenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleAdd}
            disabled={!addingId || saving}
            className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Plus size={11} />
            {t('notifications.grantAccess')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function NotificationsPage() {
  const { t } = useTranslation();
  const confirmAction = useConfirm();
  const { currentTenantId, tenants } = useTenantStore();
  const isMultiTenant = tenants.length > 1;
  // /admin/smtp-servers is platform-admin only: a tenant admin holding
  // notifications.manage does not load it (no 403 toast).
  const isPlatformAdmin = useIsPlatformAdmin();

  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [plugins, setPlugins] = useState<NotificationPluginMeta[]>([]);
  const [globalBindings, setGlobalBindings] = useState<TenantBinding[]>([]);
  const [smtpServers, setSmtpServers] = useState<SmtpServer[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  // Read-only view of a channel shared to this workspace (secrets masked server-side)
  const [viewOnly, setViewOnly] = useState(false);
  const [selectedType, setSelectedType] = useState('');
  const [formName, setFormName] = useState('');
  const [formConfig, setFormConfig] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);

  // Which channel IDs have their tenant sharing panel expanded
  const [expandedTenants, setExpandedTenants] = useState<Set<number>>(new Set());

  const load = async () => {
    try {
      const [ch, pl, gb] = await Promise.all([
        notificationsApi.listChannels(),
        notificationsApi.getPlugins(),
        notificationsApi.getBindings('global', null),
      ]);
      setChannels(ch);
      setPlugins(pl);
      setGlobalBindings(gb);
    } catch {
      toastLoadError(t('notifications.failedLoad', 'Failed to load notifications'), () => void load());
    }
  };

  const loadSmtpServers = () => {
    smtpServerApi.list().then(setSmtpServers).catch(() => {
      toastLoadError(t('notifications.failedLoadSmtp', 'Failed to load SMTP servers'), loadSmtpServers);
    });
  };

  /** Page-load failure: an error toast with a Retry action (one per message). */
  const toastLoadError = (message: string, retry: () => void) => {
    toast.error((tst) => (
      <span className="flex items-center gap-3">
        <span>{message}</span>
        <button
          type="button"
          className="shrink-0 text-xs font-medium text-accent hover:underline"
          onClick={() => { toast.dismiss(tst.id); retry(); }}
        >
          {t('common.retry', 'Retry')}
        </button>
      </span>
    ), { id: `notifications-load:${message}` });
  };

  useEffect(() => {
    void load();
    if (isPlatformAdmin) loadSmtpServers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPlugin = plugins.find((p) => p.type === selectedType);

  const openCreate = () => {
    setEditingId(null);
    setViewOnly(false);
    setSelectedType(plugins[0]?.type || '');
    setFormName('');
    setFormConfig({});
    setShowForm(true);
  };

  const openEdit = (ch: NotificationChannel) => {
    setEditingId(ch.id);
    setViewOnly(false);
    setSelectedType(ch.type);
    setFormName(ch.name);
    setFormConfig({ ...ch.config });
    setShowForm(true);
  };

  const openView = (ch: NotificationChannel) => {
    openEdit(ch);
    setViewOnly(true);
  };

  /** Masked secrets of a read-only channel render as bullets, never as the placeholder. */
  const displayValue = (value: unknown): string =>
    value === NOTIFICATION_REDACTED ? '••••••••' : String(value ?? '');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (viewOnly) return;
    setSaving(true);
    try {
      if (editingId) {
        await notificationsApi.updateChannel(editingId, {
          name: formName,
          config: formConfig,
        });
        toast.success(t('notifications.updated'));
      } else {
        await notificationsApi.createChannel({
          name: formName,
          type: selectedType,
          config: formConfig,
        });
        toast.success(t('notifications.created'));
      }
      setShowForm(false);
      load();
    } catch {
      toast.error(t('notifications.failedSave'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!(await confirmAction({ message: t('notifications.confirmDelete', { name }), danger: true }))) return;
    try {
      await notificationsApi.deleteChannel(id);
      toast.success(t('notifications.deleted'));
      setExpandedTenants((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
      load();
    } catch {
      toast.error(t('notifications.failedDelete'));
    }
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      await notificationsApi.testChannel(id);
      toast.success(t('notifications.testSent'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('notifications.testFailed');
      toast.error(msg);
    } finally {
      setTesting(null);
    }
  };

  const toggleGlobalBinding = async (channelId: number) => {
    const existing = globalBindings.find((b) => b.channelId === channelId && isOwnBinding(b));
    try {
      if (existing) {
        await notificationsApi.removeBinding(channelId, 'global', null);
        toast.success(t('notifications.removedFromGlobal'));
      } else {
        await notificationsApi.addBinding(channelId, 'global', null);
        toast.success(t('notifications.addedToGlobal'));
      }
      load();
    } catch {
      toast.error(t('notifications.failedBinding'));
    }
  };

  // The toggle reflects the operating tenant's own global binding only (a row
  // without tenantId comes from a pre-034 server: treated as our own).
  const isOwnBinding = (b: TenantBinding) => b.tenantId === undefined || b.tenantId === currentTenantId;

  const isGloballyBound = (channelId: number) =>
    globalBindings.some((b) => b.channelId === channelId && isOwnBinding(b));

  // Default tenant (god view): the other tenants that bound the channel globally.
  const showTenantColumn = currentTenantId !== null && isMasterTenant(currentTenantId);
  const otherTenantsBinding = (channelId: number): number[] =>
    showTenantColumn
      ? [...new Set(globalBindings
          .filter((b) => b.channelId === channelId && !isOwnBinding(b))
          .map((b) => b.tenantId as number))]
      : [];

  const tenantName = (id: number) => tenants.find((x) => x.id === id)?.name ?? `Tenant #${id}`;

  const toggleTenantPanel = (channelId: number) => {
    setExpandedTenants((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  return (
    <PageContainer>
      <PageHeader
        className="mb-6"
        title={t('notifications.title')}
        actions={(
          <Button size="sm" onClick={openCreate}>
            <Plus size={16} className="mr-1.5" />
            {t('notifications.newChannel')}
          </Button>
        )}
      />

      {/* Create/Edit Form */}
      {showForm && (
        <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-5">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">
            {viewOnly
              ? t('notifications.viewChannel', 'Channel (read-only)')
              : editingId ? t('notifications.editChannel') : t('notifications.newChannel')}
          </h2>
          {viewOnly && (
            <p className="mb-4 flex items-center gap-1.5 text-xs text-text-muted">
              <Lock size={12} className="shrink-0" />
              {t('notifications.readOnlyHint', 'This channel is shared with this workspace by its owner. It cannot be edited here and its secrets are hidden.')}
            </p>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <fieldset disabled={viewOnly} className="space-y-4 min-w-0">
            <Input
              label={t('notifications.channelName')}
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t('notifications.channelNamePlaceholder')}
              required
            />

            {!editingId && (
              <div className="space-y-1">
                <label className="block text-sm font-medium text-text-secondary">{t('common.type')}</label>
                <select
                  value={selectedType}
                  onChange={(e) => {
                    setSelectedType(e.target.value);
                    setFormConfig({});
                  }}
                  className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {plugins.map((p) => (
                    <option key={p.type} value={p.type}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {selectedPlugin && (
                  <p className="text-xs text-text-muted mt-1">{selectedPlugin.description}</p>
                )}
              </div>
            )}

            {/* Dynamic config fields */}
            {(selectedPlugin || plugins.find((p) => p.type === selectedType))?.configFields.map((field) => {
              if (field.type === 'boolean') {
                return (
                  <div key={field.key} className="flex items-center gap-2">
                    <div className="relative h-4 w-4 shrink-0">
                      <input
                        type="checkbox"
                        id={`cfg-${field.key}`}
                        checked={Boolean(formConfig[field.key])}
                        onChange={(e) =>
                          setFormConfig({ ...formConfig, [field.key]: e.target.checked })
                        }
                        className="peer appearance-none h-4 w-4 rounded border cursor-pointer transition-colors bg-bg-tertiary border-border checked:bg-accent checked:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                      />
                      <svg className="pointer-events-none absolute top-0 left-0 hidden h-4 w-4 text-white peer-checked:block" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2.5 8L6 11.5L13.5 4.5" />
                      </svg>
                    </div>
                    <label htmlFor={`cfg-${field.key}`} className="text-sm text-text-secondary">
                      {field.label}
                    </label>
                  </div>
                );
              }
              if (field.type === 'smtp_server_select') {
                return (
                  <div key={field.key} className="space-y-1">
                    <label className="block text-sm font-medium text-text-secondary">
                      {field.label}{field.required && <span className="text-status-down ml-1">*</span>}
                    </label>
                    <select
                      value={String(formConfig[field.key] ?? '')}
                      onChange={(e) => setFormConfig({ ...formConfig, [field.key]: e.target.value ? Number(e.target.value) : '' })}
                      required={field.required}
                      className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      <option value="">{t('notifications.selectSmtp')}</option>
                      {smtpServers.map((s) => (
                        <option key={s.id} value={s.id}>{s.name} ({s.host}:{s.port})</option>
                      ))}
                    </select>
                    {smtpServers.length === 0 && (
                      <p className="text-xs text-amber-400">{t('notifications.noSmtp')}</p>
                    )}
                  </div>
                );
              }
              return (
                <Input
                  key={field.key}
                  label={field.label}
                  type={viewOnly ? 'text' : field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                  value={viewOnly ? displayValue(formConfig[field.key]) : String(formConfig[field.key] ?? '')}
                  onChange={(e) =>
                    setFormConfig({
                      ...formConfig,
                      [field.key]: field.type === 'number' ? Number(e.target.value) : e.target.value,
                    })
                  }
                  placeholder={field.placeholder}
                  required={field.required}
                />
              );
            })}
            </fieldset>

            <div className="flex items-center gap-3">
              {!viewOnly && (
                <Button type="submit" loading={saving}>
                  {editingId ? t('common.save') : t('common.create')}
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                  setViewOnly(false);
                }}
              >
                {viewOnly ? t('common.close') : t('common.cancel')}
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Channel list */}
      <div className="rounded-lg border border-border bg-bg-secondary">
        {channels.length === 0 ? (
          <div className="py-12 text-center">
            <Bell size={32} className="mx-auto mb-3 text-text-muted" />
            <p className="text-text-muted">{t('notifications.noChannels')}</p>
            <p className="text-sm text-text-muted mt-1">
              {t('notifications.noChannelsDesc')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {channels.map((ch) => {
              const plugin = plugins.find((p) => p.type === ch.type);
              const isShared = ch.isShared === true;
              // Not owned by this workspace: no edit/delete/sharing/global binding
              const readOnly = ch.readOnly ?? isShared;
              const isExpanded = expandedTenants.has(ch.id);

              return (
                <div key={ch.id} className="px-4 py-3 group">
                  {/* Main row */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary">{ch.name}</span>
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-muted">
                          {plugin?.name || ch.type}
                        </span>
                        {!ch.isEnabled && (
                          <span className="rounded-full bg-status-down/10 px-2 py-0.5 text-[10px] font-medium text-status-down">
                            {t('status.disabled')}
                          </span>
                        )}
                        {/* Badge for shared channels showing the source tenant */}
                        {isShared && ch.tenantId && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                            <Building2 size={9} className="shrink-0" />
                            {tenantName(ch.tenantId)}
                          </span>
                        )}
                        {readOnly && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-muted">
                            <Lock size={9} className="shrink-0" />
                            {t('notifications.readOnlyShared', 'Read-only')}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Default tenant: the other workspaces whose global binding uses this channel */}
                    {otherTenantsBinding(ch.id).length > 0 && (
                      <span
                        className="hidden sm:inline-flex shrink-0 items-center gap-1 rounded-md bg-bg-tertiary px-2 py-1 text-[11px] text-text-muted max-w-[16rem] truncate"
                        title={t('notifications.globalInTenantsHint', 'Bound globally by these workspaces (covers their own agents only)')}
                      >
                        <Building2 size={11} className="shrink-0" />
                        <span className="truncate">
                          {t('notifications.globalInTenants', 'Global in')}: {otherTenantsBinding(ch.id).map(tenantName).join(', ')}
                        </span>
                      </span>
                    )}

                    {/* Global binding: owner only (a shared channel just shows its state) */}
                    {readOnly ? (
                      isGloballyBound(ch.id) && (
                        <span className="shrink-0 rounded-md bg-accent/10 px-2 py-1 text-xs font-medium text-accent">
                          <Zap size={12} className="inline mr-1" />
                          {t('notifications.globalActive')}
                        </span>
                      )
                    ) : (
                    <button
                      onClick={() => toggleGlobalBinding(ch.id)}
                      className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                        isGloballyBound(ch.id)
                          ? 'bg-accent/10 text-accent'
                          : 'text-text-muted hover:bg-bg-hover'
                      }`}
                      title={showTenantColumn
                        ? t('notifications.globalDefaultHint', 'Global binding of the Default workspace: covers the agents of every workspace')
                        : t('notifications.globalTenantHint', 'Global binding of this workspace: covers its own agents')}
                    >
                      <Zap size={12} className="inline mr-1" />
                      {isGloballyBound(ch.id) ? t('notifications.globalActive') : t('common.enable')}
                    </button>
                    )}

                    {/* Tenant sharing toggle — own channels only, multi-tenant mode only */}
                    {isMultiTenant && !isShared && !readOnly && (
                      <button
                        onClick={() => toggleTenantPanel(ch.id)}
                        className={`shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                          isExpanded
                            ? 'bg-bg-tertiary text-text-primary'
                            : 'text-text-muted hover:bg-bg-hover'
                        }`}
                        title={t('notifications.manageTenantAccess')}
                      >
                        <Building2 size={12} />
                        {t('notifications.workspaces')}
                        {isExpanded
                          ? <ChevronDown size={11} />
                          : <ChevronRight size={11} />}
                      </button>
                    )}

                    {/* Test — any visible channel */}
                    <IconButton
                      label={t('notifications.sendTest')}
                      icon={testing === ch.id
                        ? <Loader2 size={14} className="animate-spin" />
                        : <TestTube2 size={14} />}
                      onClick={() => void handleTest(ch.id)}
                      disabled={testing === ch.id}
                      variant="plain"
                      className="shrink-0 hover:text-accent can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                    />

                    {/* View (read-only) for shared channels, Edit / Delete for owned ones */}
                    {readOnly ? (
                      <IconButton
                        label={t('notifications.viewChannel', 'Channel (read-only)')}
                        icon={<Eye size={14} />}
                        onClick={() => openView(ch)}
                        variant="plain"
                        className="shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                      />
                    ) : (
                      <>
                        <IconButton
                          label={t('common.edit')}
                          icon={<Pencil size={14} />}
                          onClick={() => openEdit(ch)}
                          variant="plain"
                          className="shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                        />
                        <IconButton
                          label={t('common.delete')}
                          icon={<Trash2 size={14} />}
                          onClick={() => void handleDelete(ch.id, ch.name)}
                          variant="plain"
                          className="shrink-0 hover:text-status-down can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                        />
                      </>
                    )}
                  </div>

                  {/* Tenant sharing panel (expandable, own channels only) */}
                  {isExpanded && !isShared && (
                    <TenantSharingPanel channelId={ch.id} currentTenantId={currentTenantId} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
