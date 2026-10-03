import { useState, useEffect, useCallback } from 'react';
import { Globe, Plus, RefreshCw, Trash2, Lock, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { remoteBlocklistApi, type RemoteBlocklist } from '@/api/remoteBlocklist.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { TableScroll } from '@/components/common/TableScroll';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useIsPlatformAdmin } from '@/hooks/usePermission';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { cn } from '@/utils/cn';

/**
 * A list row with the per-list 'enforce' switch (migration 037): when off,
 * the list only imports its addresses (listed in IP Reputation > Remote);
 * when on, every address becomes a global ban.
 */
type BlocklistRow = RemoteBlocklist;
type BlocklistPatch = Parameters<typeof remoteBlocklistApi.update>[1];

const OBLITOOLS_URL = 'https://guard.obli.tools/blocklist/api/blocklist';

/** Server error text of a failed API call (`{ error }` / `{ message }` body), if any. */
function apiError(err: unknown): string | undefined {
  const data = (err as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
  return data?.error ?? data?.message;
}

/** Page-load failure: an error toast with a Retry action (one per message). */
function toastLoadError(message: string, retryLabel: string, retry: () => void) {
  toast.error((tst) => (
    <span className="flex items-center gap-3">
      <span>{message}</span>
      <button
        type="button"
        className="shrink-0 text-xs font-medium text-accent hover:underline"
        onClick={() => { toast.dismiss(tst.id); retry(); }}
      >
        {retryLabel}
      </button>
    </span>
  ), { id: `blocklists-load:${message}` });
}

/**
 * Remote blocklists (Policies > Remote blocklists): the configured URL and
 * Obli.tools lists, their sync state and their enable / enforce switches.
 * The imported addresses themselves are listed in IP Reputation > Remote.
 *
 * Remote blocklists are an instance setting (owner decision 6): every write
 * (add, sync, enable, enforce, delete) is reserved to the platform admin
 * operating the Default tenant, as on the server; everyone else reads.
 * The Obli.tools contribution (pushing our auto-bans) stays in Settings.
 */
export function RemoteBlocklistsSection() {
  const { t } = useTranslation();
  const confirmAction = useConfirm();
  const isPlatformAdmin = useIsPlatformAdmin();
  const isMaster = useIsMasterTenant();
  const canWrite = isPlatformAdmin && isMaster;

  const [lists, setLists] = useState<BlocklistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<'url' | 'oblitools'>('url');
  const [formUrl, setFormUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formInterval, setFormInterval] = useState(600);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLists(await remoteBlocklistApi.list());
      setLoadError(false);
    } catch {
      setLoadError(true);
      toastLoadError(
        t('settings.blocklists.loadFailed', { defaultValue: 'Failed to load remote blocklists' }),
        t('common.retry', { defaultValue: 'Retry' }),
        () => void load(),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const mark = (id: number, on: boolean) => setBusy(prev => {
    const n = new Set(prev);
    if (on) n.add(id); else n.delete(id);
    return n;
  });

  const resetForm = () => {
    setFormName(''); setFormUrl(''); setFormApiKey(''); setFormType('url'); setFormInterval(600);
  };

  const handleAdd = async () => {
    if (formType === 'url' && !formUrl.trim()) {
      toast.error(t('settings.blocklists.urlRequired', { defaultValue: 'Enter the URL of the list' }));
      return;
    }
    setAdding(true);
    try {
      const url = formType === 'oblitools' ? OBLITOOLS_URL : formUrl.trim();
      await remoteBlocklistApi.create({
        name: formName.trim() || (formType === 'oblitools' ? 'Obli.tools Global' : url),
        sourceType: formType,
        url,
        apiKey: formApiKey || undefined,
        syncInterval: formInterval,
      });
      toast.success(t('settings.blocklists.added', { defaultValue: 'Blocklist added' }));
      setShowAdd(false);
      resetForm();
      void load();
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.blocklists.addFailed', { defaultValue: 'Failed to add blocklist' }));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!(await confirmAction({
      message: t('settings.blocklists.confirmDelete', {
        name,
        defaultValue: 'Delete the blocklist "{{name}}" and all its imported IPs?',
      }),
      danger: true,
    }))) return;
    mark(id, true);
    try {
      await remoteBlocklistApi.delete(id);
      toast.success(t('settings.blocklists.deleted', { defaultValue: 'Blocklist deleted' }));
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.blocklists.deleteFailed', { defaultValue: 'Failed to delete blocklist' }));
    } finally {
      mark(id, false);
    }
    void load();
  };

  const handleSync = async (id: number) => {
    mark(id, true);
    try {
      await remoteBlocklistApi.forceSync(id);
      toast.success(t('settings.blocklists.synced', { defaultValue: 'Sync completed' }));
      void load();
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.blocklists.syncFailed', { defaultValue: 'Sync failed' }));
    } finally {
      mark(id, false);
    }
  };

  const update = async (id: number, patch: BlocklistPatch) => {
    mark(id, true);
    try {
      await remoteBlocklistApi.update(id, patch);
    } catch (err) {
      toast.error(apiError(err) ?? t('settings.failedUpdate', { defaultValue: 'Failed to update' }));
    } finally {
      mark(id, false);
    }
    void load();
  };

  /** Turning enforcement on bans every address of the list on every agent: confirm it. */
  const handleEnforce = async (l: BlocklistRow, enforce: boolean) => {
    if (enforce && !(await confirmAction({
      title: t('settings.blocklists.enforceTitle', { defaultValue: 'Enforce this blocklist?' }),
      message: t('settings.blocklists.enforceConfirm', {
        name: l.name,
        defaultValue: 'Every address of "{{name}}" becomes a global ban on every agent at the next sync. Whitelisted addresses are never banned.',
      }),
      confirmLabel: t('settings.blocklists.enforceAction', { defaultValue: 'Enforce' }),
      danger: true,
    }))) return;
    await update(l.id, { enforce });
  };

  const th = 'px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted';
  const showEnforce = lists.some(l => typeof l.enforce === 'boolean');
  const colCount = showEnforce ? 7 : 6;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-text-muted" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-text-primary">{t('settings.blocklists.title', { defaultValue: 'Remote blocklists' })}</h2>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            {t('settings.blocklists.description', { defaultValue: 'Lists of attacking addresses pulled from a URL or from Obli.tools. A list bans its addresses only when it is enforced; the imported addresses are listed in IP Reputation > Remote.' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            label={t('common.refresh', { defaultValue: 'Refresh' })}
            icon={<RefreshCw size={14} className={cn(loading && 'animate-spin')} />}
            onClick={() => void load()}
          />
          {canWrite && (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus size={14} className="mr-1" />{t('settings.blocklists.add', { defaultValue: 'Add blocklist' })}
            </Button>
          )}
        </div>
      </div>

      {!canWrite && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs text-text-muted">
          <Lock size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{t('settings.blocklists.readOnly', { defaultValue: 'Remote blocklists are an instance setting: only a platform admin can change them, from the Default tenant.' })}</span>
        </div>
      )}

      <TableScroll className="bg-bg-secondary">
        <table className={cn('w-full text-sm', loading && lists.length > 0 && 'opacity-60 transition-opacity')} aria-busy={loading}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={th}>{t('settings.blocklists.colName', { defaultValue: 'Name' })}</th>
              <th scope="col" className={th}>{t('settings.blocklists.colType', { defaultValue: 'Type' })}</th>
              <th scope="col" className={cn(th, 'text-right')}>{t('settings.blocklists.colIps', { defaultValue: 'IPs' })}</th>
              <th scope="col" className={th}>{t('settings.blocklists.colLastSync', { defaultValue: 'Last sync' })}</th>
              <th scope="col" className={cn(th, 'text-center')}>{t('settings.blocklists.colEnabled', { defaultValue: 'Enabled' })}</th>
              {showEnforce && (
                <th scope="col" className={cn(th, 'text-center')} title={t('settings.blocklists.enforceHint', { defaultValue: 'Ban the addresses of this list on every agent' })}>
                  {t('settings.blocklists.colEnforce', { defaultValue: 'Enforce' })}
                </th>
              )}
              <th scope="col" className={cn(th, 'text-right')}>
                <span className="sr-only">{t('common.actions', { defaultValue: 'Actions' })}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {loading && lists.length === 0 ? (
              <TableSkeleton rows={3} cols={colCount} />
            ) : lists.length === 0 ? (
              loadError ? (
                <EmptyState
                  colSpan={colCount}
                  title={t('settings.blocklists.loadFailed', { defaultValue: 'Failed to load remote blocklists' })}
                  action={<Button size="sm" variant="secondary" onClick={() => void load()}>{t('common.refresh', { defaultValue: 'Refresh' })}</Button>}
                />
              ) : (
                <EmptyState
                  colSpan={colCount}
                  icon={<Globe size={32} strokeWidth={1.5} />}
                  title={t('settings.blocklists.empty', { defaultValue: 'No remote blocklists configured' })}
                  action={canWrite
                    ? <Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} className="mr-1" />{t('settings.blocklists.add', { defaultValue: 'Add blocklist' })}</Button>
                    : undefined}
                />
              )
            ) : lists.map(l => (
              <tr key={l.id} className="h-11 transition-colors hover:bg-bg-hover">
                <td className="max-w-[18rem] px-4 py-2">
                  <div className="truncate font-medium text-text-primary" title={l.name}>{l.name}</div>
                  {l.sourceType === 'url' && (
                    <div className="truncate font-mono text-[11px] text-text-muted" title={l.url}>{l.url}</div>
                  )}
                </td>
                <td className="px-4 py-2">
                  <span className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
                    l.sourceType === 'oblitools'
                      ? 'border-amber-500/20 bg-amber-500/10 text-amber-400'
                      : 'border-cyan-500/20 bg-cyan-500/10 text-cyan-400',
                  )}>
                    {l.sourceType === 'oblitools' ? 'Obli.tools' : 'URL'}
                  </span>
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-text-secondary">{l.lastSyncCount}</td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-text-muted">
                  {l.lastSyncAt ? new Date(l.lastSyncAt).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-2 text-center">
                  <span className="inline-flex justify-center">
                    <ToggleSwitch
                      size="sm"
                      checked={l.enabled}
                      disabled={!canWrite || busy.has(l.id)}
                      onChange={(next) => void update(l.id, { enabled: next })}
                      ariaLabel={`${l.enabled ? t('common.disable', { defaultValue: 'Disable' }) : t('common.enable', { defaultValue: 'Enable' })} ${l.name}`}
                    />
                  </span>
                </td>
                {showEnforce && (
                  <td className="px-4 py-2 text-center">
                    {typeof l.enforce === 'boolean' ? (
                      <span className="inline-flex items-center justify-center gap-1.5">
                        <ToggleSwitch
                          size="sm"
                          checked={l.enforce}
                          disabled={!canWrite || busy.has(l.id)}
                          onChange={(next) => void handleEnforce(l, next)}
                          ariaLabel={t('settings.blocklists.enforceLabel', { name: l.name, defaultValue: 'Enforce {{name}}' })}
                          title={l.enforce
                            ? t('settings.blocklists.enforcedHint', { defaultValue: 'Enforced: its addresses are banned on every agent' })
                            : t('settings.blocklists.importOnlyHint', { defaultValue: 'Import only: its addresses are listed, not banned' })}
                        />
                        {l.enforce && l.enabled && <ShieldAlert size={12} className="text-status-down" aria-hidden="true" />}
                      </span>
                    ) : <span className="text-text-muted">—</span>}
                  </td>
                )}
                <td className="px-4 py-2">
                  {canWrite && (
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        label={t('settings.blocklists.forceSync', { defaultValue: 'Force sync' })}
                        icon={<RefreshCw size={13} />}
                        variant="accent"
                        size="sm"
                        disabled={busy.has(l.id)}
                        onClick={() => void handleSync(l.id)}
                      />
                      <IconButton
                        label={t('common.delete', { defaultValue: 'Delete' })}
                        icon={<Trash2 size={13} />}
                        variant="danger"
                        size="sm"
                        disabled={busy.has(l.id)}
                        onClick={() => void handleDelete(l.id, l.name)}
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      {/* Add modal */}
      <Modal
        open={showAdd && canWrite}
        onClose={() => setShowAdd(false)}
        title={t('settings.blocklists.addTitle', { defaultValue: 'Add remote blocklist' })}
        icon={<Globe size={16} />}
        size="sm"
        closeOnBackdrop={false}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setShowAdd(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
            <Button loading={adding} onClick={() => void handleAdd()}>
              <Plus size={14} className="mr-1" />{t('settings.blocklists.addSubmit', { defaultValue: 'Add' })}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="rbl-type" className="mb-1 block text-sm font-medium text-text-secondary">
              {t('settings.blocklists.type', { defaultValue: 'Type' })}
            </label>
            <select
              id="rbl-type"
              value={formType}
              onChange={e => setFormType(e.target.value as 'url' | 'oblitools')}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="url">{t('settings.blocklists.typeUrl', { defaultValue: 'Custom URL' })}</option>
              <option value="oblitools">{t('settings.blocklists.typeOblitools', { defaultValue: 'Obli.tools Global' })}</option>
            </select>
          </div>
          <Input
            label={t('settings.blocklists.name', { defaultValue: 'Name' })}
            value={formName}
            onChange={e => setFormName(e.target.value)}
            placeholder={formType === 'oblitools' ? 'Obli.tools Global' : t('settings.blocklists.namePlaceholder', { defaultValue: 'My blocklist' })}
          />
          {formType === 'url' && (
            <Input
              label={t('settings.blocklists.url', { defaultValue: 'URL' })}
              type="url"
              value={formUrl}
              onChange={e => setFormUrl(e.target.value)}
              placeholder="https://example.com/blocklist.txt"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          )}
          <Input
            label={formType === 'url'
              ? t('settings.blocklists.apiKeyOptional', { defaultValue: 'API key (optional)' })
              : t('settings.blocklists.apiKey', { defaultValue: 'API key' })}
            type="password"
            value={formApiKey}
            onChange={e => setFormApiKey(e.target.value)}
            placeholder={formType === 'oblitools' ? 'oblg_xxxxxxxxxxxx' : t('settings.blocklists.apiKeyPlaceholder', { defaultValue: 'Optional Bearer token' })}
            autoComplete="off"
          />
          <div>
            <label htmlFor="rbl-interval" className="mb-1 block text-sm font-medium text-text-secondary">
              {t('settings.blocklists.syncInterval', { defaultValue: 'Sync interval' })}
            </label>
            <select
              id="rbl-interval"
              value={formInterval}
              onChange={e => setFormInterval(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value={300}>{t('settings.blocklists.interval5m', { defaultValue: '5 minutes' })}</option>
              <option value={600}>{t('settings.blocklists.interval10m', { defaultValue: '10 minutes' })}</option>
              <option value={1800}>{t('settings.blocklists.interval30m', { defaultValue: '30 minutes' })}</option>
              <option value={3600}>{t('settings.blocklists.interval1h', { defaultValue: '1 hour' })}</option>
            </select>
          </div>
          <p className="text-xs text-text-muted">
            {t('settings.blocklists.addEnforceNote', { defaultValue: 'A new list only imports its addresses. Turn on "Enforce" on the list to ban them on every agent.' })}
          </p>
        </div>
      </Modal>
    </div>
  );
}
