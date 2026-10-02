import { db } from '../db';
import type { Knex } from 'knex';
import type { PermissionLevel, UserPermissions, Capability } from '@obliview/shared';
import { ALL_CAPABILITIES } from '@obliview/shared';

/**
 * Team permission scopes read by the app. Legacy Obliview rows (scope
 * 'monitor') may still exist in team_permissions: they are ignored at read
 * time and dropped on the team's next setPermissions.
 */
const KNOWN_SCOPES = ['group', 'agent'] as const;

/**
 * Restrict a team_permissions/team_memberships query to the teams of one
 * tenant. Team grants are tenant-bound: a team of tenant A grants nothing
 * while the user operates tenant B. No tenant given = legacy unscoped read.
 */
function scopeTeamsToTenant(q: Knex.QueryBuilder, teamIdColumn: string, tenantId?: number | null): void {
  if (tenantId == null) return;
  q.whereIn(teamIdColumn, db('user_teams').where('tenant_id', tenantId).select('id'));
}

export const permissionService = {
  /**
   * Get all team IDs a user belongs to (only the teams of `tenantId` when given).
   */
  async getUserTeamIds(userId: number, tenantId?: number | null): Promise<number[]> {
    const q = db('team_memberships')
      .where({ user_id: userId })
      .select('team_id');
    scopeTeamsToTenant(q, 'team_memberships.team_id', tenantId);
    const rows = await q;
    return rows.map((r) => r.team_id);
  },

  /**
   * Check if user (via any of their teams of `tenantId` when given) has canCreate permission.
   */
  async canCreate(userId: number, isAdmin: boolean, tenantId?: number | null): Promise<boolean> {
    if (isAdmin) return true;
    const q = db('user_teams')
      .join('team_memberships', 'user_teams.id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .where('user_teams.can_create', true);
    if (tenantId != null) q.where('user_teams.tenant_id', tenantId);
    const row = await q.first();
    return !!row;
  },

  /**
   * Get effective permission for a user on a group.
   * Checks direct group permissions + ancestor permissions via closure table,
   * through the teams of `tenantId` when given.
   */
  async getGroupPermission(
    userId: number,
    groupId: number,
    isAdmin: boolean,
    tenantId?: number | null,
  ): Promise<PermissionLevel | null> {
    if (isAdmin) return 'rw';

    // General groups are always readable
    const group = await db('monitor_groups').where({ id: groupId }).select('is_general').first();
    if (group?.is_general) {
      const level = await this._getGroupPermissionViaClosure(userId, groupId, tenantId);
      return level ?? 'ro';
    }

    return this._getGroupPermissionViaClosure(userId, groupId, tenantId);
  },

  async canReadGroup(userId: number, groupId: number, isAdmin: boolean, tenantId?: number | null): Promise<boolean> {
    const perm = await this.getGroupPermission(userId, groupId, isAdmin, tenantId);
    return perm !== null;
  },

  async canWriteGroup(userId: number, groupId: number, isAdmin: boolean, tenantId?: number | null): Promise<boolean> {
    const perm = await this.getGroupPermission(userId, groupId, isAdmin, tenantId);
    return perm === 'rw';
  },

  /**
   * Get all group IDs visible to a user.
   * A group is visible if the user has a 'group' permission on it or on any
   * ancestor (descendants inherit), plus the ancestors of granted groups (tree
   * navigation) and the general groups. Agent-scope grants are not considered
   * here. Returns 'all' for admins.
   */
  async getVisibleGroupIds(userId: number, isAdmin: boolean, tenantId?: number | null): Promise<number[] | 'all'> {
    if (isAdmin) return 'all';

    const generalRows = await db('monitor_groups')
      .where({ is_general: true })
      .select('id');
    const generalIds: number[] = generalRows.map((r) => r.id);

    const teamIds = await this.getUserTeamIds(userId, tenantId);
    if (teamIds.length === 0) return generalIds;

    // Groups with direct group permissions → includes descendants
    const groupPerms = await db('team_permissions')
      .whereIn('team_id', teamIds)
      .where('scope', 'group')
      .select('scope_id');
    const permGroupIds: number[] = groupPerms.map((r) => r.scope_id);

    const ids = new Set<number>(generalIds);
    if (permGroupIds.length > 0) {
      // All descendants of those groups (self included, depth 0)
      const descRows = await db('group_closure')
        .whereIn('ancestor_id', permGroupIds)
        .select('descendant_id');
      for (const r of descRows) ids.add(r.descendant_id);

      // Ancestor groups of the granted groups (for tree navigation)
      const ancRows = await db('group_closure')
        .whereIn('descendant_id', permGroupIds)
        .select('ancestor_id');
      for (const r of ancRows) ids.add(r.ancestor_id);
    }

    return [...ids];
  },

  /**
   * Build the full UserPermissions object for the current user.
   * Sent to the client on login/session check so the UI can adapt.
   * Only the teams of `tenantId` count when it is given.
   */
  async getUserPermissions(userId: number, isAdmin: boolean, tenantId?: number): Promise<UserPermissions> {
    if (isAdmin) {
      return { canCreate: true, teams: [], permissions: {}, capabilities: [...ALL_CAPABILITIES] };
    }

    const teamIds = await this.getUserTeamIds(userId, tenantId);
    const canCreate = await this.canCreate(userId, false, tenantId);

    const perms = teamIds.length > 0
      ? await db('team_permissions')
        .whereIn('team_id', teamIds)
        .whereIn('scope', [...KNOWN_SCOPES])
        .select('scope', 'scope_id', 'level')
      : [];

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
   * these gate mutations only.
   *
   * Platform admin → all; member of `tenantId` → all; no tenant or not a
   * member → none. The legacy per-team capability column is ignored (kept; a
   * role→capability matrix may come later): it was not tenant-scoped, so a
   * pinned-capability team in tenant A granted bans/whitelist on Default.
   */
  async getUserCapabilities(
    userId: number,
    isAdmin: boolean,
    tenantId?: number,
  ): Promise<Capability[]> {
    if (isAdmin) return [...ALL_CAPABILITIES];
    if (tenantId == null) return [];
    const membership = await db('user_tenants')
      .where({ user_id: userId, tenant_id: tenantId })
      .first('user_id');
    return membership ? [...ALL_CAPABILITIES] : [];
  },

  // ── Private helpers ──

  /**
   * Get the highest group permission for a user on a group,
   * checking all ancestors via closure table.
   */
  async _getGroupPermissionViaClosure(
    userId: number,
    groupId: number,
    tenantId?: number | null,
  ): Promise<PermissionLevel | null> {
    const q = db('team_permissions')
      .join('team_memberships', 'team_permissions.team_id', 'team_memberships.team_id')
      .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
      .where('team_memberships.user_id', userId)
      .where('team_permissions.scope', 'group')
      .where('group_closure.descendant_id', groupId)
      .select('team_permissions.level');
    scopeTeamsToTenant(q, 'team_permissions.team_id', tenantId);
    const rows = await q;

    if (rows.length === 0) return null;
    return rows.some((r) => r.level === 'rw') ? 'rw' : 'ro';
  },
};
