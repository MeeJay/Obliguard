import { useState, useEffect, type FormEvent } from 'react';
import { Plus, Pencil, Trash2, Bell, TestTube2, Zap, Loader2 } from 'lucide-react';
import type {
  NotificationChannel,
  NotificationPluginMeta,
  NotificationBinding,
  SmtpServer,
} from '@obliview/shared';
import { notificationsApi } from '@/api/notifications.api';
import { smtpServerApi } from '@/api/smtpServer.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export function NotificationsPage() {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [plugins, setPlugins] = useState<NotificationPluginMeta[]>([]);
  const [globalBindings, setGlobalBindings] = useState<NotificationBinding[]>([]);
  const [smtpServers, setSmtpServers] = useState<SmtpServer[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedType, setSelectedType] = useState('');
  const [formName, setFormName] = useState('');
  const [formConfig, setFormConfig] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);

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
      toast.error('Failed to load notifications');
    }
  };

  useEffect(() => {
    load();
    smtpServerApi.list().then(setSmtpServers).catch(() => {});
  }, []);

  const selectedPlugin = plugins.find((p) => p.type === selectedType);

  const openCreate = () => {
    setEditingId(null);
    setSelectedType(plugins[0]?.type || '');
    setFormName('');
    setFormConfig({});
    setShowForm(true);
  };

  const openEdit = (ch: NotificationChannel) => {
    setEditingId(ch.id);
    setSelectedType(ch.type);
    setFormName(ch.name);
    setFormConfig({ ...ch.config });
    setShowForm(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
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
    if (!confirm(t('notifications.confirmDelete', { name }))) return;
    try {
      await notificationsApi.deleteChannel(id);
      toast.success(t('notifications.deleted'));
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
    const existing = globalBindings.find((b) => b.channelId === channelId);
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

  const isGloballyBound = (channelId: number) =>
    globalBindings.some((b) => b.channelId === channelId);

  return (
    <div className="p-6 max-w-5xl min-w-0 mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('notifications.title')}</h1>
        <Button size="sm" onClick={openCreate}>
          <Plus size={16} className="mr-1.5" />
          {t('notifications.newChannel')}
        </Button>
      </div>

      {/* Create/Edit Form */}
      {showForm && (
        <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-5">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">
            {editingId ? t('notifications.editChannel') : t('notifications.newChannel')}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
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
                    <input
                      type="checkbox"
                      id={`cfg-${field.key}`}
                      checked={Boolean(formConfig[field.key])}
                      onChange={(e) =>
                        setFormConfig({ ...formConfig, [field.key]: e.target.checked })
                      }
                      className="h-4 w-4 rounded border-border bg-bg-tertiary text-accent focus:ring-accent"
                    />
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
                  type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                  value={String(formConfig[field.key] ?? '')}
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

            <div className="flex items-center gap-3">
              <Button type="submit" loading={saving}>
                {editingId ? t('common.save') : t('common.create')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
              >
                {t('common.cancel')}
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
              return (
                <div key={ch.id} className="flex items-center gap-3 px-4 py-3 group">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">{ch.name}</span>
                      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-muted">
                        {plugin?.name || ch.type}
                      </span>
                      {!ch.isEnabled && (
                        <span className="rounded-full bg-status-down/10 px-2 py-0.5 text-[10px] font-medium text-status-down">
                          {t('status.disabled')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Global binding toggle */}
                  <button
                    onClick={() => toggleGlobalBinding(ch.id)}
                    className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                      isGloballyBound(ch.id)
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-muted hover:bg-bg-hover'
                    }`}
                    title={isGloballyBound(ch.id) ? 'Remove from global' : 'Add to global notifications'}
                  >
                    <Zap size={12} className="inline mr-1" />
                    {isGloballyBound(ch.id) ? t('remediations.globalActive') : t('common.enable')}
                  </button>

                  {/* Test */}
                  <button
                    onClick={() => handleTest(ch.id)}
                    disabled={testing === ch.id}
                    className="shrink-0 p-1.5 text-text-muted hover:text-accent opacity-0 group-hover:opacity-100 transition-opacity"
                    title={t('notifications.sendTest')}
                  >
                    {testing === ch.id ? <Loader2 size={14} className="animate-spin" /> : <TestTube2 size={14} />}
                  </button>
                  <button
                    onClick={() => openEdit(ch)}
                    className="shrink-0 p-1.5 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                    title={t('common.edit')}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(ch.id, ch.name)}
                    className="shrink-0 p-1.5 text-text-muted hover:text-status-down opacity-0 group-hover:opacity-100 transition-opacity"
                    title={t('common.delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
