import { useState, useEffect, useCallback, Fragment } from 'react';
import { Plus, Trash2, Check, Shield, Pencil, X, Lock } from 'lucide-react';
import { TENANT_CAPABILITIES, TENANT_CAPABILITY_CATEGORIES } from '@obliview/shared';
import type { TenantCapability } from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { IconButton } from '@/components/common/IconButton';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { usersApi, type PermissionSetSummary } from '@/api/users.api';
import apiClient from '@/api/client';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/**
 * Permission sets = tenant roles (user_tenants.role holds the slug). The
 * capability matrix is the shared catalogue (TENANT_CAPABILITIES), grouped by
 * category. Built-in sets (admin / user / viewer) cannot be renamed or
 * deleted; the admin set always holds every capability (read-only), the
 * content of user / viewer stays editable.
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

/** Server error message of an axios failure, else the fallback. */
function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export function PermissionSetsTab() {
  const { t } = useTranslation();
  const confirmAction = useConfirm();

  const [sets, setSets] = useState<PermissionSetSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Rename inline
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const fetchData = useCallback(async () => {
    try {
      setSets(await usersApi.listPermissionSets());
    } catch {
      toast.error(t('permissionSets.loadFailed', 'Failed to load permission sets'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleCapability = async (set: PermissionSetSummary, capKey: TenantCapability) => {
    if (set.isAdmin) return;
    const has = set.capabilities.includes(capKey);
    const updated = has
      ? set.capabilities.filter((c) => c !== capKey)
      : [...set.capabilities, capKey];

    // Optimistic update
    setSets((prev) =>
      prev.map((s) => (s.id === set.id ? { ...s, capabilities: updated } : s)),
    );

    try {
      await apiClient.put(`/permission-sets/${set.id}`, { capabilities: updated });
    } catch (err) {
      toast.error(apiError(err, t('permissionSets.updateFailed', 'Failed to update permission set')));
      fetchData(); // revert
    }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    const slug = slugify(name);
    if (!name || !slug) return;
    setCreating(true);
    try {
      await apiClient.post('/permission-sets', { name, slug, capabilities: ['ips.view'] });
      toast.success(t('permissionSets.created', 'Permission set created'));
      setNewName('');
      setShowCreate(false);
      fetchData();
    } catch (err) {
      toast.error(apiError(err, t('permissionSets.createFailed', 'Failed to create permission set')));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (set: PermissionSetSummary) => {
    const ok = await confirmAction({
      title: t('permissionSets.deleteTitle', 'Delete permission set'),
      message: t('permissionSets.deleteConfirm', {
        name: set.name,
        defaultValue: 'Delete the permission set "{{name}}"? Members holding it must be moved to another role first.',
      }),
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/permission-sets/${set.id}`);
      toast.success(t('permissionSets.deleted', 'Permission set deleted'));
      fetchData();
    } catch (err) {
      toast.error(apiError(err, t('permissionSets.deleteFailed', 'Failed to delete permission set')));
    }
  };

  const handleRename = async (set: PermissionSetSummary) => {
    const name = renameValue.trim();
    if (!name || name === set.name) {
      setRenamingId(null);
      return;
    }
    try {
      await apiClient.put(`/permission-sets/${set.id}`, { name });
      toast.success(t('permissionSets.renamed', 'Permission set renamed'));
      setRenamingId(null);
      fetchData();
    } catch (err) {
      toast.error(apiError(err, t('permissionSets.renameFailed', 'Failed to rename permission set')));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-text-muted text-sm">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold text-text-primary">
          {t('users.permissionSets', 'Permission Sets')}
        </h2>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus size={14} className="mr-1" />
          {t('common.new', 'New')}
        </Button>
      </div>
      <p className="text-xs text-text-muted mb-4">
        {t('permissionSets.hint', 'A permission set is a tenant role: each tenant member holds one. Built-in sets cannot be renamed or deleted; Admin always holds every capability.')}
      </p>

      {/* Create form */}
      {showCreate && (
        <div className="mb-4 rounded-lg border border-border bg-bg-secondary p-4">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
            {t('permissionSets.newTitle', 'New permission set')}
          </h3>
          <div className="flex items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('permissionSets.namePlaceholder', 'Set name (e.g. N1 Support)')}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              autoFocus
            />
            <Button size="sm" onClick={handleCreate} disabled={creating || !slugify(newName.trim())}>
              {creating ? '...' : t('common.create', 'Create')}
            </Button>
            <IconButton
              icon={<X size={16} />}
              label={t('common.cancel')}
              onClick={() => { setShowCreate(false); setNewName(''); }}
            />
          </div>
          {newName.trim() && (
            <p className="mt-2 text-[11px] text-text-muted">
              {t('permissionSets.slugPreview', 'Role slug')}: <code>{slugify(newName.trim())}</code>
            </p>
          )}
        </div>
      )}

      {/* Matrix table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-secondary border-b border-border">
              <th className="text-left px-3 py-2.5 text-text-secondary font-medium whitespace-nowrap">
                {t('permissionSets.capability', 'Capability')}
              </th>
              {sets.map((set) => (
                <th key={set.id} className="px-3 py-2.5 text-center min-w-[100px]">
                  <div className="flex items-center justify-center gap-1">
                    {renamingId === set.id ? (
                      <input
                        className="bg-bg-tertiary border border-border rounded px-1.5 py-0.5 text-xs text-text-primary w-24 text-center"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleRename(set)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(set);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        aria-label={t('permissionSets.rename', 'Rename')}
                        autoFocus
                      />
                    ) : (
                      <>
                        <span className="text-text-primary font-medium text-xs">{set.name}</span>
                        {set.isProtected && (
                          <span title={t('permissionSets.builtIn', 'Built-in set')}>
                            <Shield size={11} className="text-accent shrink-0" />
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="text-[10px] font-normal text-text-muted font-mono">{set.slug}</div>
                  {renamingId !== set.id && !set.isProtected && (
                    <div className="flex items-center justify-center gap-0.5 mt-1">
                      <IconButton
                        icon={<Pencil size={10} />}
                        label={t('permissionSets.rename', 'Rename')}
                        size="xs"
                        onClick={() => { setRenamingId(set.id); setRenameValue(set.name); }}
                      />
                      <IconButton
                        icon={<Trash2 size={10} />}
                        label={t('common.delete')}
                        size="xs"
                        variant="danger"
                        onClick={() => handleDelete(set)}
                      />
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TENANT_CAPABILITY_CATEGORIES.map((cat) => {
              const caps = TENANT_CAPABILITIES.filter((c) => c.category === cat.key);
              if (caps.length === 0) return null;
              return (
                <Fragment key={cat.key}>
                  <tr className="bg-bg-tertiary/60 border-b border-border">
                    <td
                      colSpan={sets.length + 1}
                      className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
                    >
                      {t(cat.labelKey, cat.label)}
                    </td>
                  </tr>
                  {caps.map((cap) => (
                    <tr
                      key={cap.key}
                      className="border-b border-border last:border-b-0 bg-bg-primary hover:bg-bg-hover transition-colors"
                    >
                      <td className="px-3 py-2 text-text-primary whitespace-nowrap text-xs">
                        <span className="font-medium">{t(cap.labelKey, cap.label)}</span>
                        <span className="ml-2 font-mono text-[10px] text-text-muted">{cap.key}</span>
                        {cap.defaultTenantOnly && (
                          <span className="ml-2 text-[10px] text-text-muted">
                            {t('permissionSets.defaultTenantOnly', '(Default tenant only)')}
                          </span>
                        )}
                      </td>
                      {sets.map((set) => {
                        const checked = set.isAdmin || set.capabilities.includes(cap.key);
                        const label = `${set.name}: ${t(cap.labelKey, cap.label)}`;
                        return (
                          <td key={set.id} className="px-3 py-2 text-center">
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              aria-label={label}
                              disabled={set.isAdmin}
                              onClick={() => toggleCapability(set, cap.key)}
                              className={`w-5 h-5 rounded border inline-flex items-center justify-center transition-colors ${
                                checked
                                  ? 'bg-accent border-accent text-white'
                                  : 'border-border bg-bg-tertiary hover:border-text-muted'
                              } ${set.isAdmin ? 'opacity-60 cursor-not-allowed' : ''}`}
                            >
                              {checked && (set.isAdmin ? <Lock size={10} /> : <Check size={12} strokeWidth={3} />)}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {sets.length === 0 && (
        <div className="text-sm text-text-muted py-8 text-center">
          {t('permissionSets.empty', 'No permission sets defined. Click "New" to create one.')}
        </div>
      )}
    </div>
  );
}
