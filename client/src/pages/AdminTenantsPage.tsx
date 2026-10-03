import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, Plus, Pencil, Users, X, Check, Trash2, PackageX, RefreshCw, AlertTriangle } from 'lucide-react';
import type { Tenant, TenantRole } from '@obliview/shared';
import { TENANT_ROLE_DEFAULT } from '@obliview/shared';
import toast from 'react-hot-toast';
import apiClient from '@/api/client';
import { apiErrorMessage } from '@/api/ipReputation.api';
import { isStepUpCancelled } from '@/utils/withTwoFactor';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { MasterDetail } from '@/components/common/MasterDetail';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { usersApi, type PermissionSetSummary } from '@/api/users.api';
import { cn } from '@/utils/cn';

interface TenantMember {
  id: number;
  username: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  /** Permission-set slug ('admin' = every capability). */
  tenantRole: TenantRole;
}

/** GET /tenants/:id/agents-summary: what blocks a deletion (owner decision 13). */
interface TenantAgentSummary {
  /** Enrolled agents (approved + suspended): non-zero blocks the deletion under 'refuse'. */
  total: number;
  approved: number;
  suspended: number;
  uninstalling: number;
  unenrolled: number;
  routers: number;
  policy: 'refuse' | 'uninstall';
}

const DEFAULT_TENANT_ID = 1;

/** Poll interval of the agent summary while agents are uninstalling. */
const UNINSTALL_POLL_MS = 15_000;

const inputCls = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

// ── Inline form for creating / editing a tenant ────────────────────────────
function TenantForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: { name: string; slug: string };
  onSave: (name: string, slug: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const autoSlug = (n: string) =>
    n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const handleNameChange = (v: string) => {
    setName(v);
    if (!initial) setSlug(autoSlug(v));
  };

  const handleSubmit = async () => {
    if (!name.trim() || !slug.trim()) { setError(t('common.requiredField')); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(name.trim(), slug.trim());
    } catch (e: unknown) {
      setError(apiErrorMessage(e, t('common.error')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[10rem] flex-1">
          <label className="block text-xs text-text-muted mb-1">{t('tenant.name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            className={inputCls}
            placeholder={t('tenant.namePlaceholder')}
          />
        </div>
        <div className="w-40">
          <label className="block text-xs text-text-muted mb-1">{t('tenant.slug')}</label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className={inputCls}
            placeholder="my-org"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <Button size="sm" onClick={handleSubmit} disabled={saving} aria-label={t('common.save')}>
          <Check size={14} />
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving} aria-label={t('common.cancel')}>
          <X size={14} />
        </Button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

// ── Members panel ───────────────────────────────────────────────────────────
// A member's tenant role is a permission set (admin / user / viewer / custom
// slug): the role picker lists the sets. Writes go through apiClient so a
// role change can open the step-up prompt (users.role).
function MembersPanel({ tenantId, onClose }: { tenantId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [allUsers, setAllUsers] = useState<{ id: number; username: string }[]>([]);
  const [sets, setSets] = useState<PermissionSetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingId, setAddingId] = useState<number | ''>('');
  const [addingRole, setAddingRole] = useState<string>(TENANT_ROLE_DEFAULT);

  const fetchMembers = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: TenantMember[] }>(`/tenants/${tenantId}/members`);
      setMembers(res.data.data ?? []);
    } catch {
      toast.error(t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    fetchMembers();
    apiClient.get<{ data: { id: number; username: string }[] }>('/users')
      .then((res) => setAllUsers(res.data.data ?? []))
      .catch(() => { /* the add picker stays empty */ });
    usersApi.listPermissionSets().then(setSets).catch(() => toast.error(t('common.error')));
  }, [tenantId, fetchMembers, t]);

  /** Sends a membership write; a refused role (400) or any failure is toasted. */
  const send = async (method: 'post' | 'put' | 'delete', url: string, body?: unknown): Promise<boolean> => {
    try {
      await apiClient.request({ method, url, data: body });
      return true;
    } catch (err) {
      if (!isStepUpCancelled(err)) toast.error(apiErrorMessage(err, t('common.error')));
      return false;
    }
  };

  const addMember = async () => {
    if (!addingId) return;
    if (await send('post', `/tenants/${tenantId}/members`, { userId: addingId, role: addingRole })) {
      setAddingId('');
      fetchMembers();
    }
  };

  const changeRole = async (userId: number, role: string) => {
    if (await send('put', `/tenants/${tenantId}/members/${userId}`, { role })) fetchMembers();
  };

  const removeMember = async (userId: number) => {
    if (!(await askConfirm({ message: t('common.confirmDelete'), danger: true }))) return;
    if (await send('delete', `/tenants/${tenantId}/members/${userId}`)) fetchMembers();
  };

  const nonMembers = allUsers.filter((u) => !members.find((m) => m.id === u.id));
  const selectCls = 'rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

  /** Role options; a role whose set no longer exists still shows (it grants nothing). */
  const roleOptions = (current?: string) => (
    <>
      {current && !sets.some((s) => s.slug === current) && <option value={current}>{current}</option>}
      {sets.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={t('tenant.members')}
      icon={<Users size={15} />}
      footer={nonMembers.length > 0 ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          <select
            value={addingId}
            onChange={(e) => setAddingId(e.target.value ? Number(e.target.value) : '')}
            className={`flex-1 min-w-[8rem] ${selectCls} py-1.5 text-sm`}
            aria-label={t('tenant.selectUser')}
          >
            <option value="">{t('tenant.selectUser')}</option>
            {nonMembers.map((u) => (
              <option key={u.id} value={u.id}>{u.username}</option>
            ))}
          </select>
          <select
            value={addingRole}
            onChange={(e) => setAddingRole(e.target.value)}
            className={selectCls}
            aria-label={t('tenant.role', 'Role')}
          >
            {roleOptions(addingRole)}
          </select>
          <Button size="sm" onClick={addMember} disabled={!addingId}>
            {t('tenant.addMember')}
          </Button>
        </div>
      ) : undefined}
    >
      <div className="space-y-3">
        {loading ? (
          <p className="text-sm text-text-muted text-center py-4">{t('common.loading')}</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-4">{t('tenant.noMembers')}</p>
        ) : (
          members.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-sm text-text-primary font-medium">{m.username}</span>
                {m.display_name && (
                  <span className="ml-1 text-xs text-text-muted">({m.display_name})</span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <select
                  value={m.tenantRole}
                  onChange={(e) => changeRole(m.id, e.target.value)}
                  className={`${selectCls} ${m.tenantRole === 'admin' ? 'text-accent border-accent/40' : ''}`}
                  aria-label={t('tenant.role', 'Role')}
                  title={t('tenant.toggleRole')}
                >
                  {roleOptions(m.tenantRole)}
                </select>
                <IconButton
                  icon={<X size={13} />}
                  label={t('tenant.removeMember')}
                  onClick={() => removeMember(m.id)}
                  variant="danger"
                  size="sm"
                />
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

// ── Deletion (danger zone) ──────────────────────────────────────────────────
// Owner decision 13: the deletion is refused while enrolled agents remain.
// "Uninstall all agents" queues the uninstall; the agents leave the list once
// they acknowledged. The deletion asks for the workspace name, then the
// server asks for the step-up (tenant.delete) through the api client.
function TenantDangerZone({ tenant, onDeleted }: { tenant: Tenant; onDeleted: () => void }) {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const [summary, setSummary] = useState<TenantAgentSummary | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const [busy, setBusy] = useState<'uninstall' | 'delete' | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: TenantAgentSummary }>(`/tenants/${tenant.id}/agents-summary`);
      setSummary(res.data.data);
      setSummaryError(false);
    } catch {
      setSummaryError(true);
    }
  }, [tenant.id]);

  useEffect(() => {
    setSummary(null);
    fetchSummary();
  }, [fetchSummary]);

  // Agents acknowledge the uninstall on their own schedule: keep the count fresh.
  useEffect(() => {
    if (!summary || summary.uninstalling === 0) return;
    const timer = setInterval(fetchSummary, UNINSTALL_POLL_MS);
    return () => clearInterval(timer);
  }, [summary, fetchSummary]);

  const blocked = !!summary && summary.policy === 'refuse' && summary.total > 0;
  const toUninstall = summary ? summary.approved - summary.uninstalling : 0;

  const uninstallAll = async () => {
    if (!summary) return;
    const ok = await askConfirm({
      title: t('tenant.uninstallAllTitle', { defaultValue: 'Uninstall all agents' }),
      message: t('tenant.uninstallAllConfirm', {
        defaultValue: 'Send the uninstall command to the {{count}} agent(s) of "{{name}}"? Connected agents uninstall now, the others at their next connection. Their firewall bans are removed.',
        count: toUninstall,
        name: tenant.name,
      }),
      confirmLabel: t('tenant.uninstallAll', { defaultValue: 'Uninstall all agents' }),
      danger: true,
    });
    if (!ok) return;
    setBusy('uninstall');
    try {
      const res = await apiClient.post<{ data: { queued: number; delivered: number; summary: Omit<TenantAgentSummary, 'policy'> } }>(
        `/tenants/${tenant.id}/uninstall-agents`,
      );
      const d = res.data.data;
      toast.success(t('tenant.uninstallQueued', {
        defaultValue: 'Uninstall sent to {{queued}} agent(s) ({{delivered}} connected now).',
        queued: d.queued,
        delivered: d.delivered,
      }));
      setSummary((prev) => ({ ...d.summary, policy: prev?.policy ?? 'refuse' }));
    } catch (err) {
      if (!isStepUpCancelled(err)) toast.error(apiErrorMessage(err, t('common.error')));
    } finally {
      setBusy(null);
    }
  };

  const deleteTenant = async () => {
    const agentLine = summary && summary.total > 0 && summary.policy === 'uninstall'
      ? t('tenant.deleteUninstallNote', {
        defaultValue: 'Its {{count}} agent(s) receive the uninstall command; offline agents stay installed but locked out.',
        count: summary.total,
      })
      : '';
    const routerLine = summary && summary.routers > 0
      ? t('tenant.deleteRoutersNote', {
        defaultValue: 'The Obliguard entries of its {{count}} MikroTik router(s) are removed.',
        count: summary.routers,
      })
      : '';
    const ok = await askConfirm({
      title: t('tenant.deleteTitle', { defaultValue: 'Delete workspace' }),
      message: (
        <div className="space-y-2">
          <p>{t('tenant.confirmDelete')}</p>
          {agentLine && <p>{agentLine}</p>}
          {routerLine && <p>{routerLine}</p>}
          <p className="text-text-muted">
            {t('tenant.deleteTypeName', { defaultValue: 'Type "{{name}}" to confirm.', name: tenant.name })}
          </p>
        </div>
      ),
      danger: true,
      requireText: tenant.name,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await apiClient.delete(`/tenants/${tenant.id}`, { data: { confirmName: tenant.name } });
      toast.success(t('tenant.deleted', { defaultValue: 'Workspace "{{name}}" deleted.', name: tenant.name }));
      onDeleted();
    } catch (err) {
      if (isStepUpCancelled(err)) return;
      const data = (err as { response?: { data?: { code?: string; count?: number } } })?.response?.data;
      if (data?.code === 'TENANT_HAS_AGENTS') {
        toast.error(t('tenant.hasAgents', {
          defaultValue: 'This workspace still has {{count}} agent(s). Uninstall them first.',
          count: data.count ?? 0,
        }));
        fetchSummary();
      } else {
        toast.error(apiErrorMessage(err, t('common.error')));
      }
    } finally {
      setBusy(null);
    }
  };

  if (tenant.id === DEFAULT_TENANT_ID) {
    return (
      <p className="text-xs text-text-muted">
        {t('tenant.defaultUndeletable', { defaultValue: 'The default workspace cannot be deleted.' })}
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-red-400">
          <AlertTriangle size={14} />
          {t('tenant.dangerZone', { defaultValue: 'Danger zone' })}
        </h3>
        <IconButton
          icon={<RefreshCw size={13} />}
          label={t('common.refresh', { defaultValue: 'Refresh' })}
          onClick={fetchSummary}
          size="sm"
        />
      </div>

      {summaryError ? (
        <p className="text-xs text-red-400">{t('common.error')}</p>
      ) : !summary ? (
        <p className="text-xs text-text-muted">{t('common.loading')}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-text-muted">{t('tenant.agentsEnrolled', { defaultValue: 'Agents' })}</dt>
            <dd className={cn('text-sm font-semibold', summary.total > 0 ? 'text-text-primary' : 'text-text-muted')}>{summary.total}</dd>
          </div>
          <div>
            <dt className="text-text-muted">{t('tenant.agentsUninstalling', { defaultValue: 'Uninstalling' })}</dt>
            <dd className="text-sm font-semibold text-text-primary">{summary.uninstalling}</dd>
          </div>
          <div>
            <dt className="text-text-muted">{t('tenant.agentsSuspended', { defaultValue: 'Suspended' })}</dt>
            <dd className="text-sm font-semibold text-text-primary">{summary.suspended}</dd>
          </div>
          <div>
            <dt className="text-text-muted">{t('tenant.routers', { defaultValue: 'MikroTik routers' })}</dt>
            <dd className="text-sm font-semibold text-text-primary">{summary.routers}</dd>
          </div>
        </dl>
      )}

      {blocked && summary && (
        <p className="text-xs text-text-secondary">
          {t('tenant.deleteBlocked', {
            defaultValue: 'This workspace cannot be deleted while it has agents. Uninstall them first: they leave the list once they have acknowledged the command.',
          })}
          {summary.suspended > 0 && (
            <> {t('tenant.suspendedHint', {
              defaultValue: 'Suspended agents receive no command: reinstate them, or delete them from the agent list.',
            })}</>
          )}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {summary && summary.approved > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={uninstallAll}
            loading={busy === 'uninstall'}
            disabled={busy !== null || toUninstall <= 0}
          >
            <PackageX size={14} className="mr-1" />
            {t('tenant.uninstallAll', { defaultValue: 'Uninstall all agents' })}
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          onClick={deleteTenant}
          loading={busy === 'delete'}
          disabled={busy !== null || !summary || blocked}
        >
          <Trash2 size={14} className="mr-1" />
          {t('tenant.deleteTitle', { defaultValue: 'Delete workspace' })}
        </Button>
      </div>
    </div>
  );
}

// ── Tenant detail ───────────────────────────────────────────────────────────
function TenantDetail({
  tenant,
  onUpdate,
  onManageMembers,
  onDeleted,
}: {
  tenant: Tenant;
  onUpdate: (name: string, slug: string) => Promise<void>;
  onManageMembers: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);

  useEffect(() => { setEditing(false); }, [tenant.id]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-bg-secondary p-4">
        {editing ? (
          <TenantForm
            initial={{ name: tenant.name, slug: tenant.slug }}
            onSave={async (name, slug) => { await onUpdate(name, slug); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Building2 size={16} className="text-accent shrink-0" />
                <h2 className="truncate text-base font-semibold text-text-primary">{tenant.name}</h2>
                {tenant.id === DEFAULT_TENANT_ID && (
                  <span className="text-[10px] bg-accent/15 text-accent rounded px-1.5 py-0.5">
                    {t('tenant.default')}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted mt-0.5">
                /{tenant.slug} · {t('tenant.createdAt')} {new Date(tenant.createdAt).toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="ghost" onClick={onManageMembers} title={t('tenant.manageMembers')}>
                <Users size={13} className="mr-1" />
                {t('tenant.members')}
              </Button>
              <IconButton
                icon={<Pencil size={13} />}
                label={t('common.edit')}
                onClick={() => setEditing(true)}
                size="sm"
              />
            </div>
          </div>
        )}
      </div>

      <TenantDangerZone tenant={tenant} onDeleted={onDeleted} />
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export function AdminTenantsPage() {
  const { t } = useTranslation();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [membersForId, setMembersForId] = useState<number | null>(null);

  const fetchTenants = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: Tenant[] }>('/tenants');
      setTenants(res.data.data ?? []);
    } catch {
      toast.error(t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { fetchTenants(); }, [fetchTenants]);

  const selected = tenants.find((x) => x.id === selectedId) ?? null;

  const handleCreate = async (name: string, slug: string) => {
    const res = await apiClient.post<{ data: Tenant }>('/tenants', { name, slug });
    setCreating(false);
    await fetchTenants();
    setSelectedId(res.data.data.id);
  };

  const handleUpdate = async (id: number, name: string, slug: string) => {
    await apiClient.put(`/tenants/${id}`, { name, slug });
    await fetchTenants();
  };

  const handleDeleted = () => {
    setSelectedId(null);
    fetchTenants();
  };

  const master = (
    <div className="space-y-2">
      {creating && (
        <div className="p-4 rounded-xl border border-border bg-bg-secondary">
          <TenantForm onSave={handleCreate} onCancel={() => setCreating(false)} />
        </div>
      )}
      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : tenants.length === 0 ? (
        <EmptyState title={t('tenant.noTenants')} compact />
      ) : (
        tenants.map((tenant) => (
          <button
            key={tenant.id}
            type="button"
            onClick={() => setSelectedId(tenant.id)}
            aria-current={tenant.id === selectedId ? 'true' : undefined}
            className={cn(
              'w-full rounded-xl border px-4 py-3 text-left transition-colors',
              tenant.id === selectedId
                ? 'border-accent/60 bg-accent/10'
                : 'border-border bg-bg-secondary hover:bg-bg-hover',
            )}
          >
            <div className="flex items-center gap-2">
              <Building2 size={14} className="text-accent shrink-0" />
              <span className="truncate text-sm font-semibold text-text-primary">{tenant.name}</span>
              {tenant.id === DEFAULT_TENANT_ID && (
                <span className="text-[10px] bg-accent/15 text-accent rounded px-1.5 py-0.5">
                  {t('tenant.default')}
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted mt-0.5 truncate">/{tenant.slug}</p>
          </button>
        ))
      )}
    </div>
  );

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        icon={<Building2 size={20} />}
        title={t('tenant.pageTitle')}
        description={t('tenant.pageDesc')}
        actions={!creating ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} className="mr-1" />
            {t('tenant.create')}
          </Button>
        ) : undefined}
      />

      <MasterDetail
        master={master}
        masterClassName="lg:w-80 lg:shrink-0"
        detail={selected ? (
          <TenantDetail
            tenant={selected}
            onUpdate={(name, slug) => handleUpdate(selected.id, name, slug)}
            onManageMembers={() => setMembersForId(selected.id)}
            onDeleted={handleDeleted}
          />
        ) : null}
        detailTitle={selected?.name}
        onBack={() => setSelectedId(null)}
        emptyDetail={(
          <EmptyState
            icon={<Building2 size={24} />}
            title={t('tenant.selectOne', { defaultValue: 'Select a workspace' })}
            compact
          />
        )}
      />

      {membersForId !== null && (
        <MembersPanel tenantId={membersForId} onClose={() => setMembersForId(null)} />
      )}
    </PageContainer>
  );
}
