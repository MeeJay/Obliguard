import { db } from '../db';
import type { PermissionLevel, UserPermissions, Capability } from '@obliview/shared';
import { ALL_CAPABILITIES } from '@obliview/shared';

export const permissionService = {
  /**
   * Get all team IDs a user belongs to.
   */
  async getUserTeamIds(userId: number): Promise<number[]> {
    const rows = await db('team_memberships')
      .where({ user_id: userId })
      .select('team_id');
    return rows.map((r) => r.team_id);
  },

  /**
   * Check if user (via any of their teams) has canCreate permission.
   */
  async canCreate(userId: number, isAdmin: boolean): Promise<boolean> {
    if (isAdmin) return true;
    const row = await db('user_teams')
      .join('team_memberships', 'user_teams.id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .where('user_teams.can_create', true)
      .first();
    return !!row;
  },

  /**
   * Get the effective permission level for a user on a specific monitor.
   * Returns 'rw', 'ro', or null (no access).
   * Checks: direct monitor permissions + group permissions (with inheritance via closure table).
   */
  async getMonitorPermission(
    userId: number,
    monitorId: number,
    isAdmin: boolean,
  ): Promise<PermissionLevel | null> {
    if (isAdmin) return 'rw';

    // Check if monitor is in a general group (always readable)
    const monitorRow = await db('monitors').where({ id: monitorId }).select('group_id').first();
    if (!monitorRow) return null;

    if (monitorRow.group_id) {
      const generalGroup = await db('monitor_groups')
        .where({ id: monitorRow.group_id, is_general: true })
        .first();
      if (generalGroup) {
        // General group: at minimum RO. Check if any team gives RW.
        const rwPerm = await this._getHighestPermission(userId, 'monitor', monitorId);
        const groupRw = await this._getGroupPermissionViaClosureForMonitor(userId, monitorRow.group_id);
        if (rwPerm === 'rw' || groupRw === 'rw') return 'rw';
        return 'ro';
      }
    }

    // Direct monitor permission
    const directLevel = await this._getHighestPermission(userId, 'monitor', monitorId);

    // Group permission (inherited via closure table)
    let groupLevel: PermissionLevel | null = null;
    if (monitorRow.group_id) {
      groupLevel = await this._getGroupPermissionViaClosureForMonitor(userId, monitorRow.group_id);
    }

    // Return highest: rw > ro > null
    return this._highest(directLevel, groupLevel);
  },

  /**
   * Check if user can read a monitor.
   */
  async canReadMonitor(userId: number, monitorId: number, isAdmin: boolean): Promise<boolean> {
    const perm = await this.getMonitorPermission(userId, monitorId, isAdmin);
    return perm !== null;
  },

  /**
   * Check if user can write (edit/delete) a monitor.
   */
  async canWriteMonitor(userId: number, monitorId: number, isAdmin: boolean): Promise<boolean> {
    const perm = await this.getMonitorPermission(userId, monitorId, isAdmin);
    return perm === 'rw';
  },

  /**
   * Get effective permission for a user on a group.
   * Checks direct group permissions + ancestor permissions via closure table.
   */
  async getGroupPermission(
    userId: number,
    groupId: number,
    isAdmin: boolean,
  ): Promise<PermissionLevel | null> {
    if (isAdmin) return 'rw';

    // General groups are always readable
    const group = await db('monitor_groups').where({ id: groupId }).select('is_general').first();
    if (group?.is_general) {
      const level = await this._getGroupPermissionViaClosure(userId, groupId);
      return level ?? 'ro';
    }

    return this._getGroupPermissionViaClosure(userId, groupId);
  },

  async canReadGroup(userId: number, groupId: number, isAdmin: boolean): Promise<boolean> {
    const perm = await this.getGroupPermission(userId, groupId, isAdmin);
    return perm !== null;
  },

  async canWriteGroup(userId: number, groupId: number, isAdmin: boolean): Promise<boolean> {
    const perm = await this.getGroupPermission(userId, groupId, isAdmin);
    return perm === 'rw';
  },

  /**
   * Get all monitor IDs visible to a user.
   * Returns 'all' for admins.
   */
  async getVisibleMonitorIds(userId: number, isAdmin: boolean): Promise<number[] | 'all'> {
    if (isAdmin) return 'all';

    const teamIds = await this.getUserTeamIds(userId);
    if (teamIds.length === 0) {
      // Still show monitors in general groups
      const generalMonitors = await db('monitors')
        .join('monitor_groups', 'monitors.group_id', 'monitor_groups.id')
        .where('monitor_groups.is_general', true)
        .select('monitors.id');
      return generalMonitors.map((r) => r.id);
    }

    // Monitors via group permissions (inherited through closure table)
    const groupMonitors = await db('monitors')
      .join('group_closure', 'group_closure.descendant_id', 'monitors.group_id')
      .join('team_permissions', function () {
        this.on('team_permissions.scope_id', 'group_closure.ancestor_id')
          .andOn(db.raw("team_permissions.scope = 'group'"));
      })
      .whereIn('team_permissions.team_id', teamIds)
      .select('monitors.id');

    // Monitors via direct monitor permissions
    const directMonitors = await db('team_permissions')
      .whereIn('team_id', teamIds)
      .where('scope', 'monitor')
      .select('scope_id as id');

    // Monitors in general groups
    const generalMonitors = await db('monitors')
      .join('monitor_groups', 'monitors.group_id', 'monitor_groups.id')
      .where('monitor_groups.is_general', true)
      .select('monitors.id');

    const ids = new Set<number>();
    for (const r of groupMonitors) ids.add(r.id);
    for (const r of directMonitors) ids.add(r.id);
    for (const r of generalMonitors) ids.add(r.id);

    return [...ids];
  },

  /**
   * Get all group IDs visible to a user.
   * A group is visible if the user has any permission on it, any ancestor has permission,
   * or any monitor inside it has a direct permission.
   * Returns 'all' for admins.
   */
  async getVisibleGroupIds(userId: number, isAdmin: boolean): Promise<number[] | 'all'> {
    if (isAdmin) return 'all';

    const teamIds = await this.getUserTeamIds(userId);
    if (teamIds.length === 0) {
      // Only general groups
      const generalRows = await db('monitor_groups')
        .where({ is_general: true })
        .select('id');
      return generalRows.map((r) => r.id);
    }

    // Groups with direct or ancestor group permissions → includes descendants
    const groupPerms = await db('team_permissions')
      .whereIn('team_id', teamIds)
      .where('scope', 'group')
      .select('scope_id');
    const permGroupIds = groupPerms.map((r) => r.scope_id);

    // All descendants of those groups
    let descendantIds: number[] = [];
    if (permGroupIds.length > 0) {
      const descRows = await db('group_closure')
        .whereIn('ancestor_id', permGroupIds)
        .select('descendant_id');
      descendantIds = descRows.map((r) => r.descendant_id);
    }

    // Groups that contain monitors with direct monitor permissions
    const monitorPerms = await db('team_permissions')
      .whereIn('team_id', teamIds)
      .where('scope', 'monitor')
      .select('scope_id');
    const monitorIds = monitorPerms.map((r) => r.scope_id);

    let monitorGroupIds: number[] = [];
    if (monitorIds.length > 0) {
      const mgRows = await db('monitors')
        .whereIn('id', monitorIds)
        .whereNotNull('group_id')
        .select('group_id');
      monitorGroupIds = mgRows.map((r) => r.group_id);
    }

    // Ancestor groups of monitorGroupIds (for tree navigation)
    let ancestorIds: number[] = [];
    if (monitorGroupIds.length > 0) {
      const ancRows = await db('group_closure')
        .whereIn('descendant_id', monitorGroupIds)
        .select('ancestor_id');
      ancestorIds = ancRows.map((r) => r.ancestor_id);
    }

    // Also ancestor groups of permGroupIds (for tree navigation)
    if (permGroupIds.length > 0) {
      const ancRows = await db('group_closure')
        .whereIn('descendant_id', permGroupIds)
        .select('ancestor_id');
      ancestorIds = [...ancestorIds, ...ancRows.map((r) => r.ancestor_id)];
    }

    // General groups
    const generalRows = await db('monitor_groups')
      .where({ is_general: true })
      .select('id');
    const generalIds = generalRows.map((r) => r.id);

    const ids = new Set<number>();
    for (const id of descendantIds) ids.add(id);
    for (const id of monitorGroupIds) ids.add(id);
    for (const id of ancestorIds) ids.add(id);
    for (const id of generalIds) ids.add(id);

    return [...ids];
  },

  /**
   * Build the full UserPermissions object for the current user.
   * Sent to the client on login/session check so the UI can adapt.
   */
  async getUserPermissions(userId: number, isAdmin: boolean, tenantId?: number): Promise<UserPermissions> {
    if (isAdmin) {
      return { canCreate: true, teams: [], permissions: {}, capabilities: [...ALL_CAPABILITIES] };
    }

    const teamIds = await this.getUserTeamIds(userId);
    const canCreate = await this.canCreate(userId, false);

    const perms = await db('team_permissions')
      .whereIn('team_id', teamIds)
      .select('scope', 'scope_id', 'level');

    const permissions: Record<string, PermissionLevel> = {};
    for (const p of perms) {
      const key = `${p.scope}:${p.scope_id}`;
      const existing = permissions[key];
      if (!existing || (existing === 'ro' && p.level === 'rw')) {
        permissions[key] = p.level;
      }
    }

    const capabilities = await this.getUserCapabilities(userId, false, tenantId);

    return { canCreate, teams: teamIds, permissions, capabilities };
  },

  /**
   * Resolve the feature capabilities a user effectively holds for a tenant.
   *
   * Platform admin ⇒ all. Otherwise capabilities are derived from TENANT
   * MEMBERSHIP: Obligate transmits only a tenant *role* (the permission-set
   * name) in the SSO assertion — it no longer ships a granular capability list
   * (`permissionGroup.service.resolveForUserAndApp` returns `{ slug, role }`
   * per tenant, no `capabilities`). The app therefore owns the role→capability
   * matrix. Any member of the current tenant (admin or member) is operational:
   * they may manage bans / whitelist / devices / groups *within that tenant*
   * (the routes' tenant-scoping still constrains WHICH resources they touch;
   * platform-admin-only actions stay behind `requireRole('admin')`).
   *
   * Viewing is NOT a capability — any authenticated tenant member may view;
   * these gate mutations only. A tenantId is required to grant tenant-derived
   * capabilities; without it we fall back to the legacy team_permissions store.
   */
  async getUserCapabilities(
    userId: number,
    isAdmin: boolean,
    tenantId?: number,
  ): Promise<Capability[]> {
    if (isAdmin) return [...ALL_CAPABILITIES];

    const held = new Set<string>();

    // Primary source: tenant membership. Membership in the current tenant grants
    // the full operational capability set (see doc comment above).
    if (tenantId != null) {
      const membership = await db('user_tenants')
        .where({ user_id: userId, tenant_id: tenantId })
        .first();
      if (membership) {
        for (const c of ALL_CAPABILITIES) held.add(c);
      }
    }

    // Legacy/explicit source: capabilities pinned onto team_permissions rows.
    // Obligate no longer populates these, but keep honouring any that exist so
    // manual grants (or a future Obligate that ships capabilities) still work.
    const teamIds = await this.getUserTeamIds(userId);
    if (teamIds.length > 0) {
      const rows = await db('team_permissions')
        .whereIn('team_id', teamIds)
        .whereNotNull('capabilities')
        .select('capabilities');
      for (const r of rows) {
        const raw = (r as { capabilities: unknown }).capabilities;
        let arr: unknown;
        try {
          arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          arr = null;
        }
        if (Array.isArray(arr)) {
          for (const c of arr) if (typeof c === 'string') held.add(c);
        }
      }
    }

    // Only surface capabilities we actually recognise/enforce.
    return ALL_CAPABILITIES.filter((c) => held.has(c));
  },

  /**
   * Get user IDs that have at least read access to a specific monitor.
   * Used for Socket.io broadcasts.
   */
  async getUsersWithMonitorAccess(monitorId: number): Promise<number[]> {
    const monitorRow = await db('monitors').where({ id: monitorId }).select('group_id').first();
    if (!monitorRow) return [];

    // Users via direct monitor permission
    const directUsers = await db('team_memberships')
      .join('team_permissions', 'team_memberships.team_id', 'team_permissions.team_id')
      .where('team_permissions.scope', 'monitor')
      .where('team_permissions.scope_id', monitorId)
      .select('team_memberships.user_id');

    const userIds = new Set<number>(directUsers.map((r) => r.user_id));

    // Users via group permission (inherited)
    if (monitorRow.group_id) {
      const groupUsers = await db('team_memberships')
        .join('team_permissions', 'team_memberships.team_id', 'team_permissions.team_id')
        .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
        .where('team_permissions.scope', 'group')
        .where('group_closure.descendant_id', monitorRow.group_id)
        .select('team_memberships.user_id');
      for (const r of groupUsers) userIds.add(r.user_id);
    }

    // Users who can see general groups
    if (monitorRow.group_id) {
      const isGeneral = await db('monitor_groups')
        .where({ id: monitorRow.group_id, is_general: true })
        .first();
      if (isGeneral) {
        // All non-admin users can see general group monitors
        const allUsers = await db('users').where({ is_active: true }).select('id');
        for (const r of allUsers) userIds.add(r.id);
      }
    }

    return [...userIds];
  },

  // ── Private helpers ──

  /**
   * Get the highest permission level from all teams for a specific scope+scopeId.
   */
  async _getHighestPermission(
    userId: number,
    scope: string,
    scopeId: number,
  ): Promise<PermissionLevel | null> {
    const rows = await db('team_permissions')
      .join('team_memberships', 'team_permissions.team_id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .where('team_permissions.scope', scope)
      .where('team_permissions.scope_id', scopeId)
      .select('team_permissions.level');

    if (rows.length === 0) return null;
    return rows.some((r) => r.level === 'rw') ? 'rw' : 'ro';
  },

  /**
   * Get the highest group permission for a user on a group,
   * checking all ancestors via closure table.
   */
  async _getGroupPermissionViaClosure(
    userId: number,
    groupId: number,
  ): Promise<PermissionLevel | null> {
    const rows = await db('team_permissions')
      .join('team_memberships', 'team_permissions.team_id', 'team_memberships.team_id')
      .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
      .where('team_memberships.user_id', userId)
      .where('team_permissions.scope', 'group')
      .where('group_closure.descendant_id', groupId)
      .select('team_permissions.level');

    if (rows.length === 0) return null;
    return rows.some((r) => r.level === 'rw') ? 'rw' : 'ro';
  },

  /**
   * Same as _getGroupPermissionViaClosure but for checking monitor's group.
   */
  async _getGroupPermissionViaClosureForMonitor(
    userId: number,
    groupId: number,
  ): Promise<PermissionLevel | null> {
    return this._getGroupPermissionViaClosure(userId, groupId);
  },

  _highest(a: PermissionLevel | null, b: PermissionLevel | null): PermissionLevel | null {
    if (a === 'rw' || b === 'rw') return 'rw';
    if (a === 'ro' || b === 'ro') return 'ro';
    return null;
  },
};
