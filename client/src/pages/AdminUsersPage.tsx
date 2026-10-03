import { useState, useEffect, type FormEvent } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Key,
  Shield,
  ShieldOff,
  UserIcon,
  UserX,
  Users,
  FolderOpen,
  FolderX,
  Server,
  Check,
  ChevronRight,
  ChevronDown,
  Eye,
  Building2,
} from 'lucide-react';
import type {
  User,
  UserTeam,
  GroupTreeNode,
  PermissionLevel,
  UserTenantAssignment,
  AgentDevice,
} from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { usersApi, type PermissionSetSummary } from '@/api/users.api';
import { teamsApi, type TeamGrant, type TeamPermissionScope } from '@/api/teams.api';
import { groupsApi } from '@/api/groups.api';
import { agentApi } from '@/api/agent.api';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { IconButton } from '@/components/common/IconButton';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { MasterDetail } from '@/components/common/MasterDetail';
import { Drawer } from '@/components/common/Drawer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { MEDIA, matchesMedia, useIsCoarsePointer, useMediaQuery } from '@/hooks/useMediaQuery';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { PermissionSetsTab } from '@/components/PermissionSetsTab';

type Tab = 'users' | 'teams' | 'permissionSets';
type UserFormMode = 'create' | 'edit' | 'password' | null;
type TeamFormMode = 'create' | 'edit' | null;
/** role: 'admin' or a permission-set slug (the legacy 'member' reads as 'user'). */
type TenantDraft = Record<number, { isMember: boolean; role: string }>;
const normaliseTenantRole = (role: string | null | undefined): string => (!role || role === 'member' ? 'user' : role);

// Row actions: inline icons from md (hover-revealed with a mouse, always
// visible on touch), everything in a "⋯" menu below md.
const ROW_ACTION_CLS = 'hidden md:inline-flex shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100';

/** The server's refusal text (403 / 400 of the users.manage scope rules), else the fallback. */
function errorText(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
  return typeof msg === 'string' && msg ? msg : fallback;
}

/** Strip the og_ prefix of an Obligate account for display. */
const displayUsername = (u: User): string => (u.username.startsWith('og_') ? u.username.slice(3) : u.username);

export function AdminUsersPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isWide = useMediaQuery(MEDIA.lg);
  // Touch: team-member rows toggle from anywhere in the row (mouse keeps the
  // box-only click).
  const coarse = useIsCoarsePointer();
  const currentUser = useAuthStore((s) => s.user);
  const myPermissions = useAuthStore((s) => s.permissions);
  const isPlatformAdmin = currentUser?.role === 'admin';
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const allTenants = useTenantStore((s) => s.tenants);
  const isMaster = isMasterTenant(currentTenantId);
  // Team writes follow the operating tenant: from Default the teams of other
  // tenants are listed (god view) but any PUT/DELETE on them returns 403.
  const isForeignTeam = (team: UserTeam | undefined): boolean =>
    !!team && currentTenantId != null && team.tenantId != null && team.tenantId !== currentTenantId;
  const [tab, setTab] = useState<Tab>('users');

  // Data
  const [users, setUsers] = useState<User[]>([]);
  const [teams, setTeams] = useState<UserTeam[]>([]);
  const [tree, setTree] = useState<GroupTreeNode[]>([]);
  const [devices, setDevices] = useState<AgentDevice[]>([]);
  /** Tenant roles a membership can hold (permission sets). */
  const [permissionSets, setPermissionSets] = useState<PermissionSetSummary[]>([]);

  // User form
  const [userFormMode, setUserFormMode] = useState<UserFormMode>(null);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formUsername, setFormUsername] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<'admin' | 'user'>('user');
  const [formTenantRole, setFormTenantRole] = useState('user');
  const [saving, setSaving] = useState(false);

  // Team form
  const [teamFormMode, setTeamFormMode] = useState<TeamFormMode>(null);
  const [editingTeam, setEditingTeam] = useState<UserTeam | null>(null);
  const [formTeamName, setFormTeamName] = useState('');
  const [formTeamDesc, setFormTeamDesc] = useState('');
  const [formCanCreate, setFormCanCreate] = useState(false);

  // Selected team (detail pane)
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [teamMembers, setTeamMembers] = useState<number[]>([]);
  const [teamPermissions, setTeamPermissions] = useState<TeamGrant[]>([]);
  const [rightTab, setRightTab] = useState<'members' | 'permissions'>('members');

  // Team tenant filter (platform admin on the Default tenant only)
  const [teamTenantFilter, setTeamTenantFilter] = useState<number | 'all'>('all');

  // Tenant assignment panel
  const [tenantPanelUser, setTenantPanelUser] = useState<User | null>(null);
  const [tenantAssignments, setTenantAssignments] = useState<UserTenantAssignment[]>([]);
  const [tenantDraft, setTenantDraft] = useState<TenantDraft>({});
  const [tenantPanelLoading, setTenantPanelLoading] = useState(false);
  const [tenantSaving, setTenantSaving] = useState(false);

  // ── Delegation (users.manage): which tenant roles may I grant? ──
  // Platform admin and tenant admin: every set. Any other holder of
  // users.manage: only a set whose capabilities it holds itself, never
  // 'admin' (the server enforces the same rule: userScope.assertGrantableRole).
  const myTenantRole = myPermissions?.tenantRole ?? null;
  const myCaps = new Set<string>(myPermissions?.tenantCapabilities ?? []);
  const canGrantSet = (ps: PermissionSetSummary): boolean =>
    isPlatformAdmin || myTenantRole === 'admin' ||
    (!ps.isAdmin && ps.slug !== 'admin' && ps.capabilities.every((c) => myCaps.has(c)));
  const grantableSets = permissionSets.filter(canGrantSet);
  // New accounts join the operating tenant: always for a delegated manager,
  // for a platform admin outside the Default tenant (a Default membership is
  // the god view, it is never given by default).
  const askTenantRole = !isPlatformAdmin || !isMaster;
  const defaultTenantRole = (): string =>
    grantableSets.some((ps) => ps.slug === 'user') ? 'user' : (grantableSets.find((ps) => !ps.isAdmin)?.slug ?? 'user');

  const load = async () => {
    try {
      const [u, tm, tr, d, sets] = await Promise.all([
        usersApi.list(),
        isPlatformAdmin && isMaster ? teamsApi.listAll() : teamsApi.list(),
        groupsApi.tree(),
        // Agents feed the permission tree; a caller that cannot list them
        // still manages group grants.
        agentApi.listDevices().catch(() => [] as AgentDevice[]),
        usersApi.listPermissionSets().catch(() => [] as PermissionSetSummary[]),
      ]);
      setUsers(u);
      setTeams(tm);
      setTree(tr);
      setDevices(d);
      setPermissionSets(sets);
    } catch (err) {
      toast.error(errorText(err, t('users.failedLoad', 'Failed to load data')));
    }
  };

  // Reload when the operating tenant changes: both lists are tenant-scoped.
  useEffect(() => {
    setSelectedTeamId(null);
    setTeamTenantFilter('all');
    load();
  }, [currentTenantId]);

  const loadTeamDetails = async (teamId: number) => {
    try {
      const detail = await teamsApi.getById(teamId);
      setTeamMembers(detail.memberIds);
      setTeamPermissions(detail.permissions);
    } catch {
      toast.error(t('users.teams.failedMembers'));
    }
  };

  const selectTeam = (teamId: number) => {
    setSelectedTeamId(teamId);
    loadTeamDetails(teamId);
    // Narrow screens: the detail replaces the list — bring its back bar into view.
    if (!matchesMedia(MEDIA.lg)) {
      requestAnimationFrame(() => {
        document.getElementById('admin-users-top')?.scrollIntoView({ block: 'start' });
      });
    }
  };

  // Tenant chips: only from the Default tenant (god view) for a platform admin.
  const teamTenants = (isPlatformAdmin && isMaster ? allTenants : [])
    .map((tn) => ({ id: tn.id, name: tn.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const filteredTeams = (teamTenants.length > 0 && teamTenantFilter !== 'all')
    ? teams.filter((tm) => tm.tenantId === teamTenantFilter)
    : teams;

  // ── User form handlers ──

  // The inline forms render above the list: on narrow screens bring them
  // into view after a row action.
  const revealForm = () => {
    if (isWide) return;
    requestAnimationFrame(() => {
      document.getElementById('admin-users-form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };

  const resetUserForm = () => {
    setUserFormMode(null);
    setEditingUser(null);
    setFormUsername('');
    setFormDisplayName('');
    setFormPassword('');
    setFormRole('user');
    setFormTenantRole(defaultTenantRole());
  };

  const startCreateUser = () => {
    resetUserForm();
    setUserFormMode('create');
    revealForm();
  };
  const startEditUser = (user: User) => {
    setEditingUser(user); setFormUsername(user.username); setFormDisplayName(user.displayName || ''); setFormRole(user.role); setUserFormMode('edit');
    revealForm();
  };
  const startPasswordUser = (user: User) => {
    setEditingUser(user); setFormPassword(''); setUserFormMode('password');
    revealForm();
  };

  const handleCreateUser = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await usersApi.create({
        username: formUsername,
        password: formPassword,
        displayName: formDisplayName || undefined,
        // The platform role is a platform admin's decision only.
        ...(isPlatformAdmin ? { role: formRole } : {}),
        ...(askTenantRole ? { tenantRole: formTenantRole } : {}),
      });
      toast.success(t('users.created'));
      resetUserForm();
      load();
    } catch (err) {
      toast.error(errorText(err, t('users.failedCreate')));
    } finally {
      setSaving(false);
    }
  };

  const handleEditUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSaving(true);
    try {
      await usersApi.update(editingUser.id, {
        // SSO accounts keep their Obligate username.
        ...(editingUser.foreignSource ? {} : { username: formUsername }),
        displayName: formDisplayName || null,
        ...(isPlatformAdmin && !editingUser.foreignSource ? { role: formRole } : {}),
      });
      toast.success(t('users.updated'));
      resetUserForm();
      load();
    } catch (err) {
      toast.error(errorText(err, t('users.failedUpdate')));
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChange = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSaving(true);
    try {
      await usersApi.changePassword(editingUser.id, formPassword);
      toast.success(t('users.passwordChanged', 'Password changed'));
      resetUserForm();
    } catch (err) {
      toast.error(errorText(err, t('users.failedPassword', 'Failed to change password')));
    } finally {
      setSaving(false);
    }
  };

  // Lost authenticator: removes every second factor and signs the user out.
  const handleResetTwoFactor = async (user: User) => {
    if (!(await confirm({
      message: t('users.confirmReset2fa', {
        username: displayUsername(user),
        defaultValue: 'Reset the two-factor authentication of {{username}}? Their TOTP and e-mail codes are removed and they are signed out everywhere.',
      }),
      danger: true,
      confirmLabel: t('users.reset2fa', 'Reset 2FA'),
    }))) return;
    try {
      await usersApi.resetTwoFactor(user.id);
      toast.success(t('users.reset2faDone', 'Two-factor authentication reset'));
    } catch (err) {
      toast.error(errorText(err, t('users.reset2faFailed', 'Failed to reset two-factor authentication')));
    }
  };

  const handleDeleteUser = async (user: User) => {
    if (!(await confirm({ message: t('users.confirmDelete', { username: displayUsername(user) }), danger: true }))) return;
    try {
      await usersApi.delete(user.id);
      toast.success(t('users.deleted'));
      load();
    } catch (err) {
      toast.error(errorText(err, t('users.failedDelete')));
    }
  };

  const handleToggleActive = async (user: User) => {
    try {
      await usersApi.update(user.id, { isActive: !user.isActive });
      toast.success(user.isActive ? t('users.disabled') : t('users.enabled'));
      load();
    } catch (err) {
      toast.error(errorText(err, t('users.failedUpdate')));
    }
  };

  // Row actions, shared by the desktop icons and the phone menu. Server rules
  // (users.manage scope): only a platform admin acts on a platform admin
  // account; SSO accounts are managed in Obligate (a platform admin may still
  // remove a disabled one); one's own password / 2FA go through the profile.
  // The server also refuses accounts the caller does not dominate in their
  // other tenants: its 403 text is shown.
  const userRowFlags = (user: User) => {
    const isLocal = user.foreignSource !== 'obligate';
    const isSelf = user.id === currentUser?.id;
    const inScope = isPlatformAdmin || (user.role !== 'admin' && !user.foreignSource);
    return {
      canEdit: isLocal && inScope,
      canPassword: !isSelf && !user.foreignSource && inScope,
      canMfa: !isSelf && isLocal && inScope,
      canToggle: !isSelf && isLocal && inScope,
      canTenants: isLocal && inScope && (isPlatformAdmin || !isSelf),
      canDelete: !isSelf && inScope && (isLocal || (isPlatformAdmin && !user.isActive)),
    };
  };

  const userMenuItems = (user: User): ActionMenuItem[] => {
    const f = userRowFlags(user);
    return [
      { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit'), onClick: () => startEditUser(user), hidden: !f.canEdit },
      { key: 'password', icon: <Key size={16} />, label: t('users.actions.password', 'Change password'), onClick: () => startPasswordUser(user), hidden: !f.canPassword },
      { key: 'tenants', icon: <Building2 size={16} />, label: t('users.actions.tenants', 'Manage tenant access'), onClick: () => openTenantPanel(user), hidden: !f.canTenants },
      { key: 'active', icon: user.isActive ? <UserX size={16} /> : <UserIcon size={16} />, label: user.isActive ? t('common.disable') : t('common.enable'), onClick: () => handleToggleActive(user), hidden: !f.canToggle },
      { key: 'mfa', icon: <ShieldOff size={16} />, label: t('users.reset2fa', 'Reset 2FA'), onClick: () => handleResetTwoFactor(user), hidden: !f.canMfa, danger: true, separator: true },
      { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete'), onClick: () => handleDeleteUser(user), hidden: !f.canDelete, danger: true, separator: !f.canMfa },
    ];
  };

  // ── Team form handlers ──

  const resetTeamForm = () => {
    setTeamFormMode(null);
    setEditingTeam(null);
    setFormTeamName('');
    setFormTeamDesc('');
    setFormCanCreate(false);
  };

  const startEditTeam = (team: UserTeam) => {
    setEditingTeam(team); setFormTeamName(team.name); setFormTeamDesc(team.description || ''); setFormCanCreate(team.canCreate); setTeamFormMode('edit');
    revealForm();
  };

  const handleCreateTeam = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Teams are always created in the operating tenant (the server ignores any tenantId).
      const team = await teamsApi.create({
        name: formTeamName,
        description: formTeamDesc || null,
        canCreate: formCanCreate,
      });
      toast.success(t('users.teams.created'));
      resetTeamForm();
      load();
      selectTeam(team.id);
    } catch (err) {
      toast.error(errorText(err, t('users.teams.failedCreate')));
    } finally {
      setSaving(false);
    }
  };

  const handleEditTeam = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingTeam) return;
    setSaving(true);
    try {
      await teamsApi.update(editingTeam.id, {
        name: formTeamName,
        description: formTeamDesc || null,
        canCreate: formCanCreate,
      });
      toast.success(t('users.teams.updated'));
      resetTeamForm();
      load();
    } catch (err) {
      toast.error(errorText(err, t('users.teams.failedUpdate')));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTeam = async (team: UserTeam) => {
    if (!(await confirm({ message: t('users.teams.confirmDelete', { name: team.name }), danger: true }))) return;
    try {
      await teamsApi.delete(team.id);
      toast.success(t('users.teams.deleted'));
      if (selectedTeamId === team.id) setSelectedTeamId(null);
      load();
    } catch (err) {
      toast.error(errorText(err, t('users.teams.failedDelete')));
    }
  };

  // ── Tenant panel handlers ──

  const openTenantPanel = async (user: User) => {
    setTenantPanelUser(user);
    setTenantPanelLoading(true);
    try {
      // A delegated manager only receives the operating tenant's row.
      const assignments = await usersApi.getTenants(user.id);
      setTenantAssignments(assignments);
      const draft: TenantDraft = {};
      for (const a of assignments) {
        draft[a.tenantId] = { isMember: a.isMember, role: normaliseTenantRole(a.role) };
      }
      setTenantDraft(draft);
    } catch (err) {
      toast.error(errorText(err, t('users.tenantPanel.failedLoad', 'Failed to load tenant assignments')));
      setTenantPanelUser(null);
    } finally {
      setTenantPanelLoading(false);
    }
  };

  const closeTenantPanel = () => {
    setTenantPanelUser(null);
    setTenantAssignments([]);
    setTenantDraft({});
  };

  const toggleTenantMember = (tenantId: number) => {
    setTenantDraft((prev) => {
      const current = prev[tenantId] ?? { isMember: false, role: defaultTenantRole() };
      return { ...prev, [tenantId]: { ...current, isMember: !current.isMember } };
    });
  };

  const setTenantRole = (tenantId: number, role: string) => {
    setTenantDraft((prev) => {
      const current = prev[tenantId] ?? { isMember: true, role };
      return { ...prev, [tenantId]: { ...current, role } };
    });
  };

  const saveTenantAssignments = async () => {
    if (!tenantPanelUser) return;
    setTenantSaving(true);
    try {
      // Rows not sent are kept by the server for a delegated manager.
      const assignments = Object.entries(tenantDraft)
        .filter(([, v]) => v.isMember)
        .map(([tenantId, v]) => ({ tenantId: Number(tenantId), role: v.role }));
      await usersApi.setTenants(tenantPanelUser.id, assignments);
      toast.success(t('users.tenantPanel.saved', 'Tenant assignments saved'));
      closeTenantPanel();
      load();
    } catch (err) {
      toast.error(errorText(err, t('users.tenantPanel.failedSave', 'Failed to save tenant assignments')));
    } finally {
      setTenantSaving(false);
    }
  };

  const selectedTeam = teams.find((tm) => tm.id === selectedTeamId);
  const teamReadOnly = isForeignTeam(selectedTeam);
  const teamDetailOpen = !!selectedTeam && tab === 'teams';

  // ── Members management ──

  const toggleMember = async (userId: number) => {
    if (!selectedTeamId || teamReadOnly) return;
    const newMembers = teamMembers.includes(userId)
      ? teamMembers.filter((id) => id !== userId)
      : [...teamMembers, userId];
    try {
      await teamsApi.setMembers(selectedTeamId, { userIds: newMembers });
      setTeamMembers(newMembers);
    } catch (err) {
      toast.error(errorText(err, t('users.teams.failedUpdateMembers')));
    }
  };

  // ── Permissions management ──

  const addPermission = async (scope: TeamPermissionScope, scopeId: number, level: PermissionLevel) => {
    if (!selectedTeamId || teamReadOnly) return;
    const existing = teamPermissions.find((p) => p.scope === scope && p.scopeId === scopeId);
    const newPerms = existing
      ? teamPermissions.map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.id === existing.id ? level : p.level }))
      : [...teamPermissions.map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.level })), { scope, scopeId, level }];
    try {
      await teamsApi.setPermissions(selectedTeamId, { permissions: newPerms });
      await loadTeamDetails(selectedTeamId);
    } catch (err) {
      const fallback = existing ? t('users.teams.failedUpdatePermission') : t('users.teams.failedAddPermission');
      toast.error(errorText(err, fallback));
    }
  };

  const removePermission = async (permId: number) => {
    if (!selectedTeamId || teamReadOnly) return;
    try {
      await teamsApi.removePermission(selectedTeamId, permId);
      setTeamPermissions((prev) => prev.filter((p) => p.id !== permId));
    } catch (err) {
      toast.error(errorText(err, t('users.teams.failedRemovePermission')));
    }
  };

  const togglePermissionLevel = async (perm: TeamGrant) => {
    const newLevel: PermissionLevel = perm.level === 'ro' ? 'rw' : 'ro';
    await addPermission(perm.scope, perm.scopeId, newLevel);
  };

  // ── Permission tree: groups + agents of the team's tenant + Ungrouped ──
  // The server refuses grants on groups / agents of another tenant (400):
  // only the team's own tenant is offered.
  const teamTenantId = selectedTeam?.tenantId ?? null;
  const permTree = teamTenantId != null
    ? tree.filter((n) => n.tenantId == null || n.tenantId === teamTenantId)
    : tree;
  const treeGroupIds = new Set<number>();
  const collectIds = (nodes: GroupTreeNode[]) => { for (const n of nodes) { treeGroupIds.add(n.id); collectIds(n.children); } };
  collectIds(permTree);
  const teamDevices = devices
    .filter((d) => (teamTenantId == null || d.tenantId === teamTenantId) && d.status !== 'refused')
    .sort((a, b) => (a.name ?? a.hostname).localeCompare(b.name ?? b.hostname));
  const devicesByGroup = new Map<number, AgentDevice[]>();
  const ungroupedDevices: AgentDevice[] = [];
  for (const device of teamDevices) {
    if (device.groupId != null && treeGroupIds.has(device.groupId)) {
      if (!devicesByGroup.has(device.groupId)) devicesByGroup.set(device.groupId, []);
      devicesByGroup.get(device.groupId)!.push(device);
    } else {
      ungroupedDevices.push(device);
    }
  }

  const assignedGroupIds = new Set(teamPermissions.filter((p) => p.scope === 'group').map((p) => p.scopeId));
  // Descendant groups covered by a grant on an ancestor (implicit coverage).
  const coveredGroupIds = new Set<number>();
  const collectDescendants = (nodes: GroupTreeNode[], coveredBy: number | null) => {
    for (const node of nodes) {
      const directlyAssigned = assignedGroupIds.has(node.id);
      if (coveredBy && !directlyAssigned) coveredGroupIds.add(node.id);
      collectDescendants(node.children, directlyAssigned ? node.id : coveredBy);
    }
  };
  collectDescendants(permTree, null);

  const getGroupPerm = (groupId: number) => teamPermissions.find((p) => p.scope === 'group' && p.scopeId === groupId);
  const getAgentPerm = (agentId: number) => teamPermissions.find((p) => p.scope === 'agent' && p.scopeId === agentId);
  // The single 'ungrouped' grant (scopeId 0 by convention).
  const ungroupedPerm = teamPermissions.find((p) => p.scope === 'ungrouped');

  const permActions: PermActions = { addPermission, removePermission, togglePermissionLevel, readOnly: teamReadOnly };

  const mainTabs: SegmentedTab<Tab>[] = [
    { id: 'users', label: t('users.tabUsers'), icon: <UserIcon size={14} /> },
    { id: 'teams', label: t('users.tabTeams'), icon: <Users size={14} /> },
    // Permission sets are platform objects (CRUD is platform-only).
    { id: 'permissionSets', label: t('users.tabPermissions', 'Permissions'), icon: <Shield size={14} />, hidden: !isPlatformAdmin },
  ];

  const selectCls = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent';

  return (
    <>
      {/* Scroll anchor (narrow screens: list → team detail). */}
      <div id="admin-users-top" aria-hidden="true" />
      {/* Users / teams list (master) + team detail: side by side from lg, one
          pane at a time below with a back button. */}
      <MasterDetail
        className="w-full h-full p-3 sm:p-4 lg:p-6 lg:gap-6 lg:items-stretch"
        masterClassName="lg:flex-1 lg:max-w-xl"
        detailClassName={teamDetailOpen ? 'lg:flex-[2] lg:max-w-2xl' : 'lg:flex-[2] lg:hidden'}
        hasDetail={teamDetailOpen}
        onBack={() => setSelectedTeamId(null)}
        detailTitle={selectedTeam?.name}
        master={
          <>
            <SegmentedTabs tabs={mainTabs} value={tab} onChange={setTab} className="mb-4" tabClassName="gap-1.5" />

            {/* ── Users Tab ── */}
            {tab === 'users' && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-text-primary">{t('users.tabUsers')}</h2>
                  <Button size="sm" onClick={startCreateUser}>
                    <Plus size={14} className="mr-1" />{t('common.new')}
                  </Button>
                </div>

                {/* User form */}
                {(userFormMode === 'create' || userFormMode === 'edit') && (
                  <div id="admin-users-form" className="mb-4 rounded-lg border border-border bg-bg-secondary p-4 scroll-mt-4">
                    <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                      {userFormMode === 'create' ? t('users.newUser') : t('users.editUser', { username: editingUser ? displayUsername(editingUser) : '' })}
                    </h3>
                    <form onSubmit={userFormMode === 'create' ? handleCreateUser : handleEditUser} className="space-y-3">
                      <Input label={t('users.usernameLabel')} value={formUsername} onChange={(e) => setFormUsername(e.target.value)} required pattern="[a-zA-Z0-9_.\-]+" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" disabled={userFormMode === 'edit' && !!editingUser?.foreignSource} />
                      <Input label={t('users.displayNameLabel')} value={formDisplayName} onChange={(e) => setFormDisplayName(e.target.value)} />
                      {userFormMode === 'create' && (
                        <Input label={t('users.passwordLabel')} type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
                      )}
                      {/* Platform role: only a platform admin may set it (server rule). */}
                      {isPlatformAdmin && !(userFormMode === 'edit' && editingUser?.foreignSource) && (
                        <div className="space-y-1">
                          <label htmlFor="user-platform-role" className="block text-sm font-medium text-text-secondary">{t('users.roleLabel')}</label>
                          <select id="user-platform-role" value={formRole} onChange={(e) => setFormRole(e.target.value as 'admin' | 'user')} className={selectCls}>
                            <option value="user">{t('users.roleUser')}</option>
                            <option value="admin">{t('users.roleAdmin')}</option>
                          </select>
                        </div>
                      )}
                      {/* Role of the new account in the operating tenant (permission set). */}
                      {userFormMode === 'create' && askTenantRole && (
                        <div className="space-y-1">
                          <label htmlFor="user-tenant-role" className="block text-sm font-medium text-text-secondary">
                            {t('users.tenantRoleInCurrent', 'Role in this tenant')}
                          </label>
                          <select id="user-tenant-role" value={formTenantRole} onChange={(e) => setFormTenantRole(e.target.value)} className={selectCls}>
                            {!grantableSets.some((ps) => ps.slug === formTenantRole) && (
                              <option value={formTenantRole}>{formTenantRole}</option>
                            )}
                            {grantableSets.map((ps) => (
                              <option key={ps.slug} value={ps.slug}>{ps.name}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" loading={saving}>{userFormMode === 'create' ? t('common.create') : t('common.save')}</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={resetUserForm}>{t('common.cancel')}</Button>
                      </div>
                    </form>
                  </div>
                )}

                {userFormMode === 'password' && editingUser && (
                  <div id="admin-users-form" className="mb-4 rounded-lg border border-border bg-bg-secondary p-4 scroll-mt-4">
                    <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                      {t('users.changePasswordTitle', { username: displayUsername(editingUser) })}
                    </h3>
                    <form onSubmit={handlePasswordChange} className="space-y-3">
                      <Input label={t('users.newPassword')} type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" loading={saving}>{t('users.changePassword')}</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={resetUserForm}>{t('common.cancel')}</Button>
                      </div>
                    </form>
                  </div>
                )}

                {/* User list */}
                <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border">
                  {users.length === 0 ? (
                    <p className="p-4 text-sm text-text-muted text-center">{t('users.noUsers', 'No users')}</p>
                  ) : users.map((user) => {
                    const f = userRowFlags(user);
                    return (
                      <div key={user.id} className="flex items-center gap-2 px-3 py-2.5 group">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-text-primary truncate">{displayUsername(user)}</span>
                            {user.displayName && <span className="text-xs text-text-muted">({user.displayName})</span>}
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              user.role === 'admin' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-muted'
                            }`}>
                              {user.role === 'admin' ? <><Shield size={10} className="inline mr-0.5" />{t('users.roleAdmin')}</> : t('users.roleUser')}
                            </span>
                            {user.foreignSource === 'obligate' && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-[#D3AB52]/15 border border-[#D3AB52]/40 px-1.5 py-0.5 text-[10px] font-medium text-[#D3AB52]">
                                SSO
                              </span>
                            )}
                            {!user.isActive && (
                              <span className="rounded-full bg-status-down/10 px-1.5 py-0.5 text-[10px] font-medium text-status-down">{t('common.off', 'Off')}</span>
                            )}
                          </div>
                        </div>
                        {f.canPassword && (
                          <IconButton label={t('users.actions.password', 'Change password')} icon={<Key size={13} />} size="sm" variant="plain"
                            onClick={() => startPasswordUser(user)} className={`${ROW_ACTION_CLS} hover:text-accent`} />
                        )}
                        {f.canMfa && (
                          <IconButton label={t('users.reset2fa', 'Reset 2FA')} icon={<ShieldOff size={13} />} size="sm" variant="plain"
                            onClick={() => handleResetTwoFactor(user)} className={`${ROW_ACTION_CLS} hover:text-status-down`} />
                        )}
                        {f.canToggle && (
                          <IconButton label={user.isActive ? t('common.disable') : t('common.enable')} icon={user.isActive ? <UserX size={13} /> : <UserIcon size={13} />}
                            size="sm" variant="plain" onClick={() => handleToggleActive(user)} className={ROW_ACTION_CLS} />
                        )}
                        {f.canEdit && (
                          <IconButton label={t('common.edit')} icon={<Pencil size={13} />} size="sm" variant="plain"
                            onClick={() => startEditUser(user)} className={ROW_ACTION_CLS} />
                        )}
                        {/* Tenant access — hidden for SSO users (managed from Obligate) */}
                        {f.canTenants && (
                          <IconButton label={t('users.actions.tenants', 'Manage tenant access')} icon={<Building2 size={13} />} size="sm" variant="plain"
                            onClick={() => openTenantPanel(user)} className={`${ROW_ACTION_CLS} hover:text-accent`} />
                        )}
                        {f.canDelete && (
                          <IconButton label={t('common.delete')} icon={<Trash2 size={13} />} size="sm" variant="plain"
                            onClick={() => handleDeleteUser(user)} className={`${ROW_ACTION_CLS} hover:text-status-down`} />
                        )}
                        {/* Phone: every action in one menu. */}
                        {userMenuItems(user).some((i) => !i.hidden) && (
                          <ActionMenu
                            items={userMenuItems(user)}
                            sheetTitle={displayUsername(user)}
                            triggerSize="sm"
                            triggerClassName="md:hidden shrink-0"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* ── Teams Tab ── */}
            {tab === 'teams' && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-text-primary">{t('users.tabTeams')}</h2>
                  <Button size="sm" onClick={() => { resetTeamForm(); setTeamFormMode('create'); revealForm(); }}>
                    <Plus size={14} className="mr-1" />{t('common.new')}
                  </Button>
                </div>

                {/* Tenant filter chips (platform admin on Default, several tenants) */}
                {teamTenants.length > 1 && (
                  <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1">
                    <button
                      onClick={() => setTeamTenantFilter('all')}
                      className={`shrink-0 px-3 py-1 coarse:py-2 rounded-full text-xs font-medium transition-colors ${
                        teamTenantFilter === 'all'
                          ? 'bg-accent text-white'
                          : 'bg-bg-secondary border border-border text-text-muted hover:text-text-primary'
                      }`}
                    >
                      {t('common.all', 'All')}
                    </button>
                    {teamTenants.map((tenant) => (
                      <button
                        key={tenant.id}
                        onClick={() => setTeamTenantFilter(tenant.id)}
                        className={`shrink-0 px-3 py-1 coarse:py-2 rounded-full text-xs font-medium transition-colors ${
                          teamTenantFilter === tenant.id
                            ? 'bg-accent text-white'
                            : 'bg-bg-secondary border border-border text-text-muted hover:text-text-primary'
                        }`}
                      >
                        <Building2 size={10} className="inline mr-1" />
                        {tenant.name}
                      </button>
                    ))}
                  </div>
                )}

                {/* Team form */}
                {(teamFormMode === 'create' || teamFormMode === 'edit') && (
                  <div id="admin-users-form" className="mb-4 rounded-lg border border-border bg-bg-secondary p-4 scroll-mt-4">
                    <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                      {teamFormMode === 'create' ? t('users.teams.newTeam') : t('users.teams.editTeam', { name: editingTeam?.name })}
                    </h3>
                    <form onSubmit={teamFormMode === 'create' ? handleCreateTeam : handleEditTeam} className="space-y-3">
                      <Input label={t('users.teams.nameLabel')} value={formTeamName} onChange={(e) => setFormTeamName(e.target.value)} required />
                      <Input label={t('users.teams.descLabel')} value={formTeamDesc} onChange={(e) => setFormTeamDesc(e.target.value)} />
                      <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                        <div className="relative h-4 w-4 shrink-0">
                          <input type="checkbox" checked={formCanCreate} onChange={(e) => setFormCanCreate(e.target.checked)}
                            className="peer appearance-none h-4 w-4 rounded border cursor-pointer transition-colors bg-bg-tertiary border-border checked:bg-accent checked:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30" />
                          <svg className="pointer-events-none absolute top-0 left-0 hidden h-4 w-4 text-white peer-checked:block" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2.5 8L6 11.5L13.5 4.5" />
                          </svg>
                        </div>
                        {t('users.teams.canCreate')}
                      </label>
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" loading={saving}>{teamFormMode === 'create' ? t('common.create') : t('common.save')}</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={resetTeamForm}>{t('common.cancel')}</Button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Team list */}
                <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border">
                  {filteredTeams.length === 0 ? (
                    <div className="py-8 text-center">
                      <Users size={28} className="mx-auto mb-2 text-text-muted" />
                      <p className="text-sm text-text-muted">{t('users.teams.noTeams')}</p>
                    </div>
                  ) : (
                    filteredTeams.map((team) => (
                      <div
                        key={team.id}
                        onClick={() => selectTeam(team.id)}
                        className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer group transition-colors ${
                          selectedTeamId === team.id ? 'bg-accent/5 border-l-2 border-l-accent' : 'hover:bg-bg-hover'
                        }`}
                      >
                        <Users size={14} className="shrink-0 text-text-muted" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium text-text-primary">{team.name}</span>
                            {team.canCreate && (
                              <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                                {t('users.teams.createBadge')}
                              </span>
                            )}
                            {team.tenantName && teamTenants.length > 0 && (
                              <span className="rounded bg-bg-tertiary border border-border px-1.5 py-0.5 text-[10px] text-text-muted flex items-center gap-0.5">
                                <Building2 size={9} />
                                {team.tenantName}
                              </span>
                            )}
                          </div>
                          {team.description && (
                            <p className="text-xs text-text-muted truncate">{team.description}</p>
                          )}
                        </div>
                        {!isForeignTeam(team) && (
                          <>
                            <IconButton label={t('common.edit')} icon={<Pencil size={13} />} size="sm" variant="plain" showTooltip={false}
                              onClick={(e) => { e.stopPropagation(); startEditTeam(team); }} className={ROW_ACTION_CLS} />
                            <IconButton label={t('common.delete')} icon={<Trash2 size={13} />} size="sm" variant="plain" showTooltip={false}
                              onClick={(e) => { e.stopPropagation(); handleDeleteTeam(team); }} className={`${ROW_ACTION_CLS} hover:text-status-down`} />
                            {/* Phone: actions in a menu — clicks (portal included) must not select the row. */}
                            <span className="md:hidden shrink-0" onClick={(e) => e.stopPropagation()}>
                              <ActionMenu
                                sheetTitle={team.name}
                                triggerSize="sm"
                                items={[
                                  { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit'), onClick: () => startEditTeam(team) },
                                  { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete'), onClick: () => handleDeleteTeam(team), danger: true, separator: true },
                                ]}
                              />
                            </span>
                          </>
                        )}
                        <ChevronRight size={14} className="shrink-0 text-text-muted" />
                      </div>
                    ))
                  )}
                </div>
              </>
            )}

            {/* ── Permission Sets Tab (platform admin) ── */}
            {tab === 'permissionSets' && isPlatformAdmin && <PermissionSetsTab />}
          </>
        }
        detail={teamDetailOpen && selectedTeam ? (
          <div className="lg:sticky lg:top-6">
            {/* Below lg the name is in MasterDetail's back bar. */}
            <h2 className="hidden lg:block text-lg font-semibold text-text-primary mb-1">{selectedTeam.name}</h2>
            {selectedTeam.description && (
              <p className="text-sm text-text-muted mb-4">{selectedTeam.description}</p>
            )}
            {teamReadOnly && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-bg-secondary p-3">
                <Eye size={14} className="mt-0.5 shrink-0 text-text-muted" />
                <p className="text-xs text-text-secondary">
                  {t('users.teams.readOnlyOtherTenant', {
                    tenant: selectedTeam.tenantName ?? `#${selectedTeam.tenantId}`,
                    defaultValue: 'This team belongs to {{tenant}}: it is read-only here. Switch to that tenant to edit it.',
                  })}
                </p>
              </div>
            )}

            <SegmentedTabs
              tabs={[
                { id: 'members', label: t('users.teams.tabMembers') },
                { id: 'permissions', label: t('users.teams.tabPermissions') },
              ]}
              value={rightTab}
              onChange={setRightTab}
              size="sm"
              className="mb-4"
            />

            {/* Members panel */}
            {rightTab === 'members' && (
              <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border lg:max-h-[60dvh] lg:supports-[not(height:100dvh)]:max-h-[60vh] lg:overflow-y-auto">
                {users.filter((u) => u.role !== 'admin').length === 0 ? (
                  <p className="p-4 text-sm text-text-muted text-center">{t('users.teams.noUsers')}</p>
                ) : (
                  users.filter((u) => u.role !== 'admin').map((user) => {
                    const isMember = teamMembers.includes(user.id);
                    return (
                      // Touch: the whole row toggles membership. Mouse: only the
                      // box (a click / text selection on the name changes nothing).
                      <div
                        key={user.id}
                        role="checkbox"
                        aria-checked={isMember}
                        aria-disabled={teamReadOnly}
                        tabIndex={teamReadOnly ? -1 : 0}
                        onClick={coarse ? () => toggleMember(user.id) : undefined}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleMember(user.id); } }}
                        className={`flex items-center gap-3 px-3 py-2 coarse:min-h-11 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 ${
                          teamReadOnly ? 'opacity-70' : 'hover:bg-bg-hover cursor-pointer'
                        }`}
                      >
                        <div
                          onClick={coarse ? undefined : () => toggleMember(user.id)}
                          className={`flex h-4 w-4 coarse:h-5 coarse:w-5 items-center justify-center rounded border shrink-0 ${
                            isMember ? 'border-accent bg-accent' : 'border-border bg-bg-tertiary'
                          }`}
                        >
                          {isMember && <Check size={12} className="text-white" />}
                        </div>
                        <span className="text-sm text-text-primary min-w-0 break-all">{displayUsername(user)}</span>
                        {user.displayName && <span className="text-xs text-text-muted">({user.displayName})</span>}
                        {!user.isActive && <span className="text-[10px] text-status-down">{t('users.disabled')}</span>}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Permissions panel — groups, their agents, and the Ungrouped bucket */}
            {rightTab === 'permissions' && (
              <div className="rounded-lg border border-border bg-bg-secondary lg:max-h-[70dvh] lg:supports-[not(height:100dvh)]:max-h-[70vh] lg:overflow-y-auto">
                {permTree.length === 0 && teamDevices.length === 0 && !ungroupedPerm ? (
                  <p className="p-4 text-sm text-text-muted text-center">{t('users.teams.noResources')}</p>
                ) : (
                  <div className="py-1">
                    {/* "Ungrouped" pseudo-group: every agent of the team's
                        tenant without a group (scope 'ungrouped'). */}
                    <PermUngroupedRow perm={ungroupedPerm} actions={permActions} />
                    {permTree.map((node) => (
                      <PermTreeNode
                        key={node.id}
                        node={node}
                        depth={0}
                        devicesByGroup={devicesByGroup}
                        getGroupPerm={getGroupPerm}
                        getAgentPerm={getAgentPerm}
                        assignedGroupIds={assignedGroupIds}
                        coveredGroupIds={coveredGroupIds}
                        actions={permActions}
                      />
                    ))}
                    {/* Agents without a group (covered by the Ungrouped grant) */}
                    {ungroupedDevices.map((device) => (
                      <PermAgentRow
                        key={device.id}
                        device={device}
                        depth={0}
                        perm={getAgentPerm(device.id)}
                        isCovered={!!ungroupedPerm && device.groupId == null}
                        actions={permActions}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}
      />

      {/* ── Tenant Assignment Panel ── */}
      <Drawer
        open={!!tenantPanelUser}
        onClose={closeTenantPanel}
        side="right"
        size="md"
        className="bg-bg-primary shadow-xl"
        bodyClassName="p-4 space-y-2"
        icon={<Building2 size={16} className="text-accent shrink-0" />}
        title={
          <span className="block">
            <span className="block truncate">{t('users.tenantPanel.title', 'Tenants')}</span>
            <span className="block truncate text-xs font-normal text-text-muted">{tenantPanelUser ? displayUsername(tenantPanelUser) : ''}</span>
          </span>
        }
        footer={tenantPanelUser?.role !== 'admin' ? (
          <>
            <Button size="sm" variant="secondary" onClick={closeTenantPanel}>{t('common.cancel')}</Button>
            <Button size="sm" loading={tenantSaving} onClick={saveTenantAssignments}>{t('common.save')}</Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" onClick={closeTenantPanel}>{t('common.close')}</Button>
        )}
      >
        {tenantPanelUser && (tenantPanelLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-text-muted">{t('common.loading')}</div>
          </div>
        ) : tenantPanelUser.role === 'admin' ? (
          /* Platform admin notice */
          <div className="rounded-lg border border-accent/20 bg-accent/5 p-3">
            <div className="flex items-start gap-2">
              <Shield size={14} className="text-accent mt-0.5 shrink-0" />
              <p className="text-xs text-text-secondary">
                {t('users.tenantPanel.adminNotice', 'Platform admins automatically access all tenants. No per-tenant assignment is needed.')}
              </p>
            </div>
          </div>
        ) : tenantAssignments.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-8">{t('users.tenantPanel.none', 'No tenants available')}</p>
        ) : (
          <>
            {!isPlatformAdmin && (
              <p className="text-xs text-text-muted pb-1">
                {t('users.tenantPanel.currentOnly', 'You manage the access to the current tenant only; the other memberships of this account are kept.')}
              </p>
            )}
            {tenantAssignments.map((assignment) => {
              const draft = tenantDraft[assignment.tenantId] ?? { isMember: assignment.isMember, role: normaliseTenantRole(assignment.role) };
              return (
                <div
                  key={assignment.tenantId}
                  className={`rounded-lg border p-3 transition-colors ${
                    draft.isMember ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-secondary'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Building2 size={14} className={draft.isMember ? 'text-accent shrink-0' : 'text-text-muted shrink-0'} />
                      <span className="text-sm font-medium text-text-primary truncate">{assignment.tenantName}</span>
                    </div>
                    {/* Toggle switch (invisible 40px+ hit area on touch) */}
                    <button
                      onClick={() => toggleTenantMember(assignment.tenantId)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 transition-colors coarse:after:absolute coarse:after:-inset-2.5 coarse:after:content-[''] ${
                        draft.isMember ? 'border-accent bg-accent' : 'border-border bg-bg-tertiary'
                      }`}
                      role="switch"
                      aria-checked={draft.isMember}
                      aria-label={assignment.tenantName}
                    >
                      <span
                        className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform mt-px ${
                          draft.isMember ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                  {/* Tenant role (permission set) — only when assigned */}
                  {draft.isMember && (
                    <div className="flex items-center gap-2 mt-2">
                      <label htmlFor={`tenant-role-${assignment.tenantId}`} className="text-[10px] text-text-muted">
                        {t('users.tenantRole', 'Role')}
                      </label>
                      <select
                        id={`tenant-role-${assignment.tenantId}`}
                        value={draft.role}
                        onChange={(e) => setTenantRole(assignment.tenantId, e.target.value)}
                        className="flex-1 rounded border border-border bg-bg-primary px-2 py-0.5 coarse:py-2 text-[11px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                      >
                        {/* The current role still shows when it cannot be granted (or its set is gone). */}
                        {!grantableSets.some((ps) => ps.slug === draft.role) && (
                          <option value={draft.role}>{permissionSets.find((ps) => ps.slug === draft.role)?.name ?? draft.role}</option>
                        )}
                        {grantableSets.map((ps) => (
                          <option key={ps.slug} value={ps.slug}>{ps.name}</option>
                        ))}
                      </select>
                      {draft.role === 'admin' && <Shield size={11} className="text-accent shrink-0" />}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ))}
      </Drawer>
    </>
  );
}

// ── Permission Tree Sub-Components ──

interface PermActions {
  addPermission: (scope: TeamPermissionScope, scopeId: number, level: PermissionLevel) => Promise<void>;
  removePermission: (permId: number) => Promise<void>;
  togglePermissionLevel: (perm: TeamGrant) => Promise<void>;
  /** Team of another tenant viewed from Default: show the grants, no controls. */
  readOnly: boolean;
}

/**
 * Right-hand controls of a permission-tree row (group / agent / ungrouped):
 * assigned → RO/RW toggle + remove; covered by an ancestor → "inherited";
 * otherwise RO / RW add buttons. Read-only: the level badge only.
 */
function PermControls({ perm, isCovered, onAdd, actions }: {
  perm: TeamGrant | undefined;
  isCovered: boolean;
  onAdd: (level: PermissionLevel) => void;
  actions: PermActions;
}) {
  const { t } = useTranslation();
  if (perm && actions.readOnly) {
    return (
      <span className={`px-2 py-0.5 rounded text-[11px] font-medium shrink-0 ${
        perm.level === 'rw' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-muted'
      }`}>
        {perm.level === 'rw' ? t('users.teams.rwLabel') : t('users.teams.roLabel')}
      </span>
    );
  }
  if (perm) {
    return (
      <>
        <button
          onClick={() => actions.togglePermissionLevel(perm)}
          className={`px-2 py-0.5 coarse:px-3 coarse:py-1.5 rounded text-[11px] font-medium transition-colors shrink-0 ${
            perm.level === 'rw'
              ? 'bg-accent/10 text-accent hover:bg-accent/20'
              : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover'
          }`}
          title={t('users.teams.toggleLevelHint', 'Click to toggle RO/RW')}
        >
          {perm.level === 'rw' ? <><Pencil size={10} className="inline mr-0.5" />{t('users.teams.rwLabel')}</> : <><Eye size={10} className="inline mr-0.5" />{t('users.teams.roLabel')}</>}
        </button>
        <IconButton
          label={t('users.teams.removePermission', 'Remove permission')}
          icon={<Trash2 size={11} />}
          size="xs"
          variant="plain"
          showTooltip={false}
          onClick={() => actions.removePermission(perm.id)}
          className="shrink-0 hover:text-status-down"
        />
      </>
    );
  }
  if (isCovered) {
    return <span className="text-[10px] text-text-muted italic shrink-0">{t('users.teams.inherited')}</span>;
  }
  if (actions.readOnly) return null;
  return (
    <>
      <button onClick={() => onAdd('ro')}
        className="px-1.5 py-0.5 coarse:px-3 coarse:py-1.5 text-[10px] rounded bg-bg-tertiary text-text-muted hover:bg-bg-hover shrink-0"
        title={t('users.teams.readOnly', 'Read Only')} aria-label={t('users.teams.readOnly', 'Read Only')}>
        {t('users.teams.roLabel')}
      </button>
      <button onClick={() => onAdd('rw')}
        className="px-1.5 py-0.5 coarse:px-3 coarse:py-1.5 coarse:ml-1.5 text-[10px] rounded bg-accent/10 text-accent hover:bg-accent/20 shrink-0"
        title={t('users.teams.readWrite', 'Read/Write')} aria-label={t('users.teams.readWrite', 'Read/Write')}>
        {t('users.teams.rwLabel')}
      </button>
    </>
  );
}

interface PermTreeNodeProps {
  node: GroupTreeNode;
  depth: number;
  devicesByGroup: Map<number, AgentDevice[]>;
  getGroupPerm: (groupId: number) => TeamGrant | undefined;
  getAgentPerm: (agentId: number) => TeamGrant | undefined;
  assignedGroupIds: Set<number>;
  coveredGroupIds: Set<number>;
  actions: PermActions;
}

function PermTreeNode({
  node,
  depth,
  devicesByGroup,
  getGroupPerm,
  getAgentPerm,
  assignedGroupIds,
  coveredGroupIds,
  actions,
}: PermTreeNodeProps) {
  const { t } = useTranslation();
  // Narrower indentation per level on phones (deep trees ate the name).
  const md = useMediaQuery(MEDIA.md);
  const [expanded, setExpanded] = useState(true);
  const perm = getGroupPerm(node.id);
  const isCovered = coveredGroupIds.has(node.id);
  const agents = devicesByGroup.get(node.id) ?? [];
  const hasChildren = node.children.length > 0 || agents.length > 0;

  return (
    <div>
      {/* Group row */}
      <div
        className={`flex flex-wrap md:flex-nowrap items-center gap-1.5 px-2 py-1.5 hover:bg-bg-hover transition-colors ${
          perm ? 'bg-accent/5' : isCovered ? 'bg-accent/[0.02]' : ''
        }`}
        style={{ paddingLeft: `${depth * (md ? 20 : 12) + 8}px` }}
      >
        <IconButton
          label={expanded ? t('users.teams.collapse', 'Collapse') : t('users.teams.expand', 'Expand')}
          icon={expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          size="xs"
          variant="plain"
          touchTarget="overlay"
          showTooltip={false}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className={`shrink-0 ${!hasChildren ? 'invisible' : ''}`}
        />
        <FolderOpen size={13} className={`shrink-0 ${perm ? 'text-accent' : isCovered ? 'text-accent/40' : 'text-text-muted'}`} />
        <span className={`flex-1 min-w-0 text-sm truncate ${perm ? 'text-text-primary font-medium' : isCovered ? 'text-text-muted' : 'text-text-primary'}`}>
          {node.name}
        </span>
        {node.isGeneral && (
          <span className="text-[10px] text-accent bg-accent/10 px-1 rounded shrink-0">{t('users.teams.generalBadge')}</span>
        )}
        <PermControls perm={perm} isCovered={isCovered} onAdd={(level) => actions.addPermission('group', node.id, level)} actions={actions} />
      </div>

      {/* Children: sub-groups, then the group's agents */}
      {expanded && (
        <>
          {node.children.map((child) => (
            <PermTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              devicesByGroup={devicesByGroup}
              getGroupPerm={getGroupPerm}
              getAgentPerm={getAgentPerm}
              assignedGroupIds={assignedGroupIds}
              coveredGroupIds={coveredGroupIds}
              actions={actions}
            />
          ))}
          {agents.map((device) => (
            <PermAgentRow
              key={device.id}
              device={device}
              depth={depth + 1}
              perm={getAgentPerm(device.id)}
              isCovered={assignedGroupIds.has(node.id) || coveredGroupIds.has(node.id)}
              actions={actions}
            />
          ))}
        </>
      )}
    </div>
  );
}

// "Ungrouped" pseudo-group row: scope 'ungrouped' on team_permissions (scope
// id 0 by convention) — every agent of the team's tenant without a group.
function PermUngroupedRow({ perm, actions }: { perm: TeamGrant | undefined; actions: PermActions }) {
  const { t } = useTranslation();
  return (
    <div className={`flex flex-wrap md:flex-nowrap items-center gap-1.5 px-2 py-1.5 hover:bg-bg-hover transition-colors ${perm ? 'bg-accent/5' : ''}`} style={{ paddingLeft: '8px' }}>
      <span className="shrink-0 w-4" />
      <FolderX size={13} className={`shrink-0 ${perm ? 'text-accent' : 'text-text-muted'}`} />
      <span className={`flex-1 min-w-0 text-sm truncate ${perm ? 'text-text-primary font-medium' : 'text-text-primary'}`}>
        {t('users.teams.ungroupedLabel', 'Ungrouped agents')}
      </span>
      <PermControls perm={perm} isCovered={false} onAdd={(level) => actions.addPermission('ungrouped', 0, level)} actions={actions} />
    </div>
  );
}

function PermAgentRow({ device, depth, perm, isCovered, actions }: {
  device: AgentDevice;
  depth: number;
  perm: TeamGrant | undefined;
  isCovered: boolean;
  actions: PermActions;
}) {
  const md = useMediaQuery(MEDIA.md);
  return (
    <div
      className={`flex flex-wrap md:flex-nowrap items-center gap-1.5 px-2 py-1.5 hover:bg-bg-hover transition-colors ${perm ? 'bg-accent/5' : ''}`}
      style={{ paddingLeft: `${depth * (md ? 20 : 12) + 28}px` }}
    >
      <Server size={13} className={`shrink-0 ${perm ? 'text-accent' : isCovered ? 'text-accent/40' : 'text-text-muted'}`} />
      <span className={`flex-1 min-w-0 text-sm truncate ${perm ? 'text-text-primary font-medium' : isCovered ? 'text-text-muted' : 'text-text-primary'}`}>
        {device.name ?? device.hostname}
      </span>
      <PermControls perm={perm} isCovered={isCovered && !perm} onAdd={(level) => actions.addPermission('agent', device.id, level)} actions={actions} />
    </div>
  );
}
