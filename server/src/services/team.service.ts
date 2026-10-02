import { db } from '../db';
import type { UserTeam, TeamPermission } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { TEAM_PERMISSION_SCOPES } from '../validators/team.schema';

type TeamPermissionScope = typeof TEAM_PERMISSION_SCOPES[number];

interface TeamRow {
  id: number;
  name: string;
  description: string | null;
  can_create: boolean;
  tenant_id: number;
  tenant_name?: string; // populated by JOIN when fetching all tenants
  created_at: Date;
  updated_at: Date;
}

interface PermissionRow {
  id: number;
  team_id: number;
  scope: 'group' | 'agent';
  scope_id: number;
  level: 'ro' | 'rw';
}

function rowToTeam(row: TeamRow): UserTeam {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    canCreate: row.can_create,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The tenant a team belongs to (404 when the team does not exist). */
async function resolveTeamTenantId(teamId: number): Promise<number> {
  const team = await db('user_teams').where({ id: teamId }).select('tenant_id').first() as { tenant_id: number } | undefined;
  if (!team) throw new AppError(404, 'Team not found');
  return team.tenant_id;
}

/**
 * Team grants are tenant-bound: every group / agent a team is granted must
 * belong to the team's own tenant (the Default tenant included: no bypass).
 */
async function assertScopesInTenant(
  perms: Array<{ scope: TeamPermissionScope; scopeId: number }>,
  tenantId: number,
): Promise<void> {
  const groupIds = [...new Set(perms.filter((p) => p.scope === 'group').map((p) => p.scopeId))];
  const agentIds = [...new Set(perms.filter((p) => p.scope === 'agent').map((p) => p.scopeId))];
  if (groupIds.length > 0) {
    const rows = await db('monitor_groups').whereIn('id', groupIds).where({ tenant_id: tenantId }).select('id');
    if (rows.length !== groupIds.length) throw new AppError(400, 'Group not found in the team tenant');
  }
  if (agentIds.length > 0) {
    const rows = await db('agent_devices').whereIn('id', agentIds).where({ tenant_id: tenantId }).select('id');
    if (rows.length !== agentIds.length) throw new AppError(400, 'Agent not found in the team tenant');
  }
}

function rowToPermission(row: PermissionRow): TeamPermission {
  return {
    id: row.id,
    teamId: row.team_id,
    scope: row.scope,
    scopeId: row.scope_id,
    level: row.level,
  };
}

export const teamService = {
  /**
   * Returns teams scoped to a tenant.
   * If tenantId is null (platform admin cross-tenant view), returns ALL teams across
   * all tenants, joined with tenant name.
   */
  async getAll(tenantId: number | null): Promise<UserTeam[]> {
    const query = db('user_teams')
      .join('tenants', 'user_teams.tenant_id', 'tenants.id')
      .select('user_teams.*', 'tenants.name as tenant_name')
      .orderBy('user_teams.name');
    if (tenantId !== null && !isMasterTenant(tenantId)) {
      query.where('user_teams.tenant_id', tenantId);
    }
    const rows = await query;
    return rows.map(rowToTeam);
  },

  async getById(id: number): Promise<UserTeam | null> {
    const row = await db<TeamRow>('user_teams').where({ id }).first();
    return row ? rowToTeam(row) : null;
  },

  async create(data: { name: string; description?: string | null; canCreate?: boolean }, tenantId: number): Promise<UserTeam> {
    const [row] = await db<TeamRow>('user_teams')
      .insert({
        name: data.name,
        description: data.description ?? null,
        can_create: data.canCreate ?? false,
        tenant_id: tenantId,
      })
      .returning('*');
    return rowToTeam(row);
  },

  async update(
    id: number,
    data: { name?: string; description?: string | null; canCreate?: boolean },
  ): Promise<UserTeam | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.canCreate !== undefined) updateData.can_create = data.canCreate;

    const [row] = await db<TeamRow>('user_teams')
      .where({ id })
      .update(updateData)
      .returning('*');
    return row ? rowToTeam(row) : null;
  },

  async delete(id: number): Promise<boolean> {
    const count = await db('user_teams').where({ id }).del();
    return count > 0;
  },

  // ── Members ──

  async getMembers(teamId: number): Promise<number[]> {
    const rows = await db('team_memberships')
      .where({ team_id: teamId })
      .select('user_id');
    return rows.map((r) => r.user_id);
  },

  async setMembers(teamId: number, userIds: number[]): Promise<void> {
    await db.transaction(async (trx) => {
      await trx('team_memberships').where({ team_id: teamId }).del();
      if (userIds.length > 0) {
        await trx('team_memberships').insert(
          userIds.map((uid) => ({ team_id: teamId, user_id: uid })),
        );
      }
    });
  },

  async getUserTeams(userId: number): Promise<UserTeam[]> {
    const rows = await db<TeamRow>('user_teams')
      .join('team_memberships', 'user_teams.id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .select('user_teams.*')
      .orderBy('user_teams.name');
    return rows.map(rowToTeam);
  },

  // ── Permissions ──

  /**
   * A team's grants. Legacy Obliview rows (scope 'monitor') are ignored here
   * and dropped on the team's next setPermissions.
   */
  async getPermissions(teamId: number): Promise<TeamPermission[]> {
    const rows = await db<PermissionRow>('team_permissions')
      .where({ team_id: teamId })
      .whereIn('scope', [...TEAM_PERMISSION_SCOPES])
      .orderBy('scope')
      .orderBy('scope_id');
    return rows.map(rowToPermission);
  },

  /**
   * Replace every grant of a team (legacy 'monitor' rows included). Each
   * scopeId must belong to the team's tenant (400 otherwise); duplicates are
   * merged, the highest level wins.
   */
  async setPermissions(
    teamId: number,
    permissions: Array<{ scope: TeamPermissionScope; scopeId: number; level: 'ro' | 'rw' }>,
  ): Promise<TeamPermission[]> {
    const tenantId = await resolveTeamTenantId(teamId);

    const merged = new Map<string, { scope: TeamPermissionScope; scopeId: number; level: 'ro' | 'rw' }>();
    for (const p of permissions) {
      const key = `${p.scope}:${p.scopeId}`;
      const existing = merged.get(key);
      if (!existing || (existing.level === 'ro' && p.level === 'rw')) merged.set(key, { ...p });
    }
    const list = [...merged.values()];
    await assertScopesInTenant(list, tenantId);

    return db.transaction(async (trx) => {
      await trx('team_permissions').where({ team_id: teamId }).del();
      if (list.length > 0) {
        await trx('team_permissions').insert(
          list.map((p) => ({
            team_id: teamId,
            scope: p.scope,
            scope_id: p.scopeId,
            level: p.level,
          })),
        );
      }
      const rows = await trx<PermissionRow>('team_permissions')
        .where({ team_id: teamId })
        .orderBy('scope')
        .orderBy('scope_id');
      return rows.map(rowToPermission);
    });
  },

  /** Upsert one grant; the scopeId must belong to the team's tenant (400 otherwise). */
  async addPermission(
    teamId: number,
    scope: TeamPermissionScope,
    scopeId: number,
    level: 'ro' | 'rw',
  ): Promise<TeamPermission> {
    const tenantId = await resolveTeamTenantId(teamId);
    await assertScopesInTenant([{ scope, scopeId }], tenantId);
    const [row] = await db<PermissionRow>('team_permissions')
      .insert({ team_id: teamId, scope, scope_id: scopeId, level })
      .onConflict(['team_id', 'scope', 'scope_id'])
      .merge({ level })
      .returning('*');
    return rowToPermission(row);
  },

  /** Remove one grant of a team (a permission id of another team is not found). */
  async removePermission(teamId: number, permissionId: number): Promise<boolean> {
    const count = await db('team_permissions').where({ id: permissionId, team_id: teamId }).del();
    return count > 0;
  },
};
