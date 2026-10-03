import { db } from '../db';
import type { Knex } from 'knex';
import type { PermissionLevel, UserPermissions, Capability, CapabilityKey, TenantCapability } from '@obliview/shared';
import {
  ALL_CAPABILITIES,
  TENANT_CAPABILITY_KEYS,
  TENANT_ROLE_ADMIN,
  expandCapabilities,
  holdsCapability,
  normalizeTenantRole,
  satisfiedCapabilityAliases,
} from '@obliview/shared';

/**
 * Team permission scopes read by the app. Legacy Obliview rows (scope
 * 'monitor') may still exist in team_permissions: they are ignored at read
 * time and dropped on the team's next setPermissions.
 * 'ungrouped' (scope_id UNGROUPED_SCOPE_ID) grants the agents of the team's
 * tenant that sit in no group (Obliance model).
 */
const KNOWN_SCOPES = ['group', 'agent', 'ungrouped'] as const;

/** scope_id stored with a scope 'ungrouped' grant (the scope has no target). */
export const UNGROUPED_SCOPE_ID = 0;

/**
 * How team grants scope agents (RBAC-8, owner default):
 *  - 'restrict_if_granted': a user holding at least one team grant in the
 *    tenant sees and edits only the agents those grants cover; a user with no
 *    grant keeps the whole tenant (the tenant capabilities decide what they
 *    may do);
 *  - 'obliance_strict': no grant = no agent (Obliance getVisibleDeviceIds).
 * Platform admins and tenant role 'admin' always see every agent.
 */
export type TeamScopeMode = 'restrict_if_granted' | 'obliance_strict';
export const TEAM_SCOPE_MODE: TeamScopeMode = 'restrict_if_granted';

/** A user's access to one agent through team grants. */
export type AgentPermission = 'none' | 'ro' | 'rw';

/**
 * The agents a user may reach in a tenant: every agent the tenant scope
 * allows ('all': the Default tenant keeps its god view), or only the granted
 * ones with their level.
 */
export type AgentScope =
  | { all: true }
  | { all: false; levels: Map<number, PermissionLevel> };

function higherLevel(a: PermissionLevel | undefined, b: PermissionLevel): PermissionLevel {
  return a === 'rw' || b === 'rw' ? 'rw' : 'ro';
}

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
    // Tenant admins bypass team scope (W7-6, same rule as agents): callers
    // bind the group to the operating tenant themselves.
    if (await this.bypassesTeamScope(userId, false, tenantId)) return 'rw';

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
    // Tenant admins see every group of the tenant (lists are tenant-filtered).
    if (await this.bypassesTeamScope(userId, false, tenantId)) return 'all';

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
      return {
        canCreate: true,
        teams: [],
        permissions: {},
        capabilities: [...TENANT_CAPABILITY_KEYS, ...ALL_CAPABILITIES],
        tenantRole: TENANT_ROLE_ADMIN,
        tenantCapabilities: [...TENANT_CAPABILITY_KEYS],
      };
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

    // Tenant role → tenant capabilities; `capabilities` adds the legacy
    // aliases they satisfy (client code still checks e.g. 'monitor_rw').
    const tenantRole = tenantId == null ? null : await this.getTenantRole(userId, tenantId);
    const tenantCapabilities = tenantRole == null ? [] : await this.getRoleCapabilities(tenantRole);
    const capabilities: CapabilityKey[] = [...tenantCapabilities, ...satisfiedCapabilityAliases(tenantCapabilities)];

    return { canCreate, teams: teamIds, permissions, capabilities, tenantRole, tenantCapabilities };
  },

  /**
   * The user's role in a tenant (user_tenants.role; the legacy 'member' is
   * read as 'user'), or null without membership. The platform role is not
   * considered here: callers check it first.
   */
  async getTenantRole(userId: number, tenantId: number): Promise<string | null> {
    const row = await db('user_tenants')
      .where({ user_id: userId, tenant_id: tenantId })
      .first('role') as { role: string } | undefined;
    return row ? normalizeTenantRole(row.role) : null;
  },

  /**
   * Tenant capabilities of a role (Obliance listUserTenantCapabilities):
   * 'admin' ⇒ the whole catalogue; otherwise the permission set whose slug is
   * the role (alias keys stored in a set are expanded, unknown keys ignored);
   * a role without a set ⇒ none (fail closed).
   */
  async getRoleCapabilities(role: string): Promise<TenantCapability[]> {
    const slug = normalizeTenantRole(role);
    if (slug === TENANT_ROLE_ADMIN) return [...TENANT_CAPABILITY_KEYS];
    const row = await db('permission_sets').where({ slug }).first('capabilities') as { capabilities: unknown } | undefined;
    if (!row) return [];
    let caps: unknown = row.capabilities;
    if (typeof caps === 'string') {
      try { caps = JSON.parse(caps); } catch { caps = []; }
    }
    return Array.isArray(caps) ? expandCapabilities(caps.filter((c): c is string => typeof c === 'string')) : [];
  },

  /**
   * Tenant capabilities a user effectively holds in a tenant.
   *
   * Platform admin ⇒ all. Otherwise they derive from the TENANT ROLE
   * (user_tenants.role = permission-set slug, W6-1): Obligate transmits only
   * that role per tenant, never a capability list, and the per-team
   * capability column is ignored (it was not tenant-scoped). No tenant or not
   * a member ⇒ none. Viewing tenant data needs membership only (requireTenant);
   * platform-only actions stay behind requireRole('admin').
   */
  async getTenantCapabilities(userId: number, isAdmin: boolean, tenantId?: number | null): Promise<TenantCapability[]> {
    if (isAdmin) return [...TENANT_CAPABILITY_KEYS];
    if (tenantId == null) return [];
    const role = await this.getTenantRole(userId, tenantId);
    return role == null ? [] : this.getRoleCapabilities(role);
  },

  /**
   * Legacy (alias) capabilities a user holds in a tenant: an alias is held
   * when every tenant capability it stands for is (CAPABILITY_ALIASES).
   * Platform admin ⇒ all; no tenant or not a member ⇒ none.
   */
  async getUserCapabilities(
    userId: number,
    isAdmin: boolean,
    tenantId?: number,
  ): Promise<Capability[]> {
    if (isAdmin) return [...ALL_CAPABILITIES];
    return satisfiedCapabilityAliases(await this.getTenantCapabilities(userId, false, tenantId));
  },

  /**
   * Whether a user holds a capability in a tenant: a tenant capability, or a
   * legacy alias (all of its set needed). Platform admin ⇒ true; unknown key ⇒ false.
   */
  async hasCapability(userId: number, isAdmin: boolean, tenantId: number | null | undefined, key: CapabilityKey): Promise<boolean> {
    if (isAdmin) return true;
    return holdsCapability(await this.getTenantCapabilities(userId, false, tenantId), key);
  },

  // ── Agent scope through teams (RBAC-8, Obliance getVisibleDeviceIds / getDevicePermission) ──

  /**
   * Whether team grants are bypassed for this user in the tenant: platform
   * admin, or tenant role 'admin'. Without a tenant nothing is bypassed.
   */
  async bypassesTeamScope(userId: number, isAdmin: boolean, tenantId: number | null | undefined): Promise<boolean> {
    if (isAdmin) return true;
    if (tenantId == null) return false;
    return (await this.getTenantRole(userId, tenantId)) === TENANT_ROLE_ADMIN;
  },

  /**
   * The agent scope of a user in a tenant (see TEAM_SCOPE_MODE). Granted
   * agents are always agents OF `tenantId`: grants never reach another
   * tenant, the Default tenant included (its god view is for users without
   * grants). `onlyDeviceId` restricts the computation to one agent.
   */
  async getAgentScope(
    userId: number,
    tenantId: number | null | undefined,
    isAdmin = false,
    onlyDeviceId?: number,
  ): Promise<AgentScope> {
    if (await this.bypassesTeamScope(userId, isAdmin, tenantId)) return { all: true };
    if (tenantId == null) return { all: false, levels: new Map() };

    const teamIds = await this.getUserTeamIds(userId, tenantId);
    const grants = teamIds.length === 0 ? [] : await db('team_permissions')
      .whereIn('team_id', teamIds)
      .whereIn('scope', ['group', 'agent', 'ungrouped'])
      .select('scope', 'scope_id', 'level') as Array<{ scope: string; scope_id: number; level: PermissionLevel }>;

    if (grants.length === 0) {
      return TEAM_SCOPE_MODE === 'restrict_if_granted' ? { all: true } : { all: false, levels: new Map() };
    }

    const levels = new Map<number, PermissionLevel>();
    const add = (id: number, level: PermissionLevel) => levels.set(Number(id), higherLevel(levels.get(Number(id)), level));
    const inScope = (q: Knex.QueryBuilder) => {
      q.where('d.tenant_id', tenantId);
      if (onlyDeviceId !== undefined) q.where('d.id', onlyDeviceId);
      return q;
    };

    // Group grants: the group and its whole subtree (group_closure, depth 0 included).
    const groupIds = [...new Set(grants.filter((g) => g.scope === 'group').map((g) => g.scope_id))];
    if (groupIds.length > 0) {
      const rows = await inScope(
        db('agent_devices as d')
          .join('group_closure as gc', 'gc.descendant_id', 'd.group_id')
          .join('team_permissions as tp', 'tp.scope_id', 'gc.ancestor_id')
          .where('tp.scope', 'group')
          .whereIn('tp.team_id', teamIds)
          .select('d.id', 'tp.level'),
      ) as Array<{ id: number; level: PermissionLevel }>;
      for (const r of rows) add(r.id, r.level);
    }

    // Direct agent grants.
    const agentIds = [...new Set(grants.filter((g) => g.scope === 'agent').map((g) => g.scope_id))];
    if (agentIds.length > 0) {
      const ids = new Set((await inScope(db('agent_devices as d').whereIn('d.id', agentIds).select('d.id')) as Array<{ id: number }>)
        .map((r) => Number(r.id)));
      for (const g of grants) if (g.scope === 'agent' && ids.has(Number(g.scope_id))) add(g.scope_id, g.level);
    }

    // 'ungrouped': the tenant's agents that sit in no group.
    const ungrouped = grants.filter((g) => g.scope === 'ungrouped');
    if (ungrouped.length > 0) {
      const level: PermissionLevel = ungrouped.some((g) => g.level === 'rw') ? 'rw' : 'ro';
      const rows = await inScope(db('agent_devices as d').whereNull('d.group_id').select('d.id')) as Array<{ id: number }>;
      for (const r of rows) add(r.id, level);
    }

    return { all: false, levels };
  },

  /**
   * Agent ids a user may see in a tenant, or 'all' (no team restriction: the
   * tenant scope alone applies, the Default tenant keeping its god view).
   */
  async getVisibleAgentIds(userId: number, tenantId: number | null | undefined, isAdmin = false): Promise<number[] | 'all'> {
    const scope = await this.getAgentScope(userId, tenantId, isAdmin);
    return scope.all ? 'all' : [...scope.levels.keys()];
  },

  /** Agent ids a user may write in a tenant, or 'all' (no team restriction). */
  async getWritableAgentIds(userId: number, tenantId: number | null | undefined, isAdmin = false): Promise<number[] | 'all'> {
    const scope = await this.getAgentScope(userId, tenantId, isAdmin);
    if (scope.all) return 'all';
    return [...scope.levels.entries()].filter(([, l]) => l === 'rw').map(([id]) => id);
  },

  /**
   * A user's team-level access to one agent while operating `tenantId`:
   * 'rw' without team restriction, else the highest granted level, 'none'
   * when no grant covers it. The tenant rule (deviceAccessVerdict) is the
   * caller's: this only applies team grants.
   */
  async getAgentPermission(
    userId: number,
    tenantId: number | null | undefined,
    deviceId: number,
    isAdmin = false,
  ): Promise<AgentPermission> {
    const scope = await this.getAgentScope(userId, tenantId, isAdmin, deviceId);
    if (scope.all) return 'rw';
    return scope.levels.get(Number(deviceId)) ?? 'none';
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
