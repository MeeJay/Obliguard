import type { User } from '@obliview/shared';
import { TENANT_ROLE_ADMIN } from '@obliview/shared';
import { db } from '../db';
import { codedError } from '../utils/errorCodes';
import { invalidateUserState } from '../middleware/sessionUserGuard';
import { logger } from '../utils/logger';
import { userService } from './user.service';
import { userSessionsService } from './userSessions.service';
import { permissionSetService } from './permissionSet.service';
import { tenantService } from './tenant.service';
import { userScope, normaliseTenantRole, type ScopeActor } from './userScope.service';
import type { CreateUserInput, UpdateUserInput } from '../validators/user.schema';

// ── Create / update / delete an account, change a tenant membership ────────
//
// Slim port of Obliance userAdmin.service: ONE implementation for every
// route that manages accounts (users.controller, tenant members endpoints).
//  - Scope (userScope): a manager that is not a platform admin only acts on
//    an account it dominates, in its operating tenant, never on a platform
//    admin or an SSO (og_) account, and only grants a role it may grant.
//  - Only a platform admin creates an administrator or changes a platform
//    role; the last active platform administrator is never demoted,
//    disabled or deleted; one's own account is never deleted.
//  - Last tenant administrator (per tenant): a manager that is not a
//    platform admin never leaves a tenant without an active administrator.
//  - A demoted, disabled or deleted account loses its sessions at once
//    (sessions cache the platform role); a membership change drops the
//    tenant-access cache and the live sockets (rooms are re-joined).

async function otherActivePlatformAdmins(exceptId: number): Promise<number> {
  const row = await db('users').where({ role: 'admin', is_active: true }).whereNot({ id: exceptId })
    .count('* as n').first() as { n: string | number } | undefined;
  return Number(row?.n ?? 0);
}

/** Active tenant administrators of `tenantId` other than `exceptId`. */
async function otherActiveTenantAdmins(tenantId: number, exceptId: number): Promise<number> {
  const row = await db('user_tenants')
    .join('users', 'users.id', 'user_tenants.user_id')
    .where('user_tenants.tenant_id', tenantId)
    .where('user_tenants.role', TENANT_ROLE_ADMIN)
    .where('users.is_active', true)
    .whereNot('users.id', exceptId)
    .count('* as n').first() as { n: string | number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * The account `userId` stops being an active administrator of the tenants
 * listed (`leaving`): refused for a manager that is not a platform admin when
 * one of them would be left without any (platform admins may, e.g. to hand a
 * tenant over through Obligate).
 */
async function assertTenantsKeepAnAdmin(actor: ScopeActor, userId: number, leaving: number[]): Promise<void> {
  if (actor.isPlatformAdmin) return;
  for (const tenantId of leaving) {
    if ((await otherActiveTenantAdmins(tenantId, userId)) === 0) {
      throw codedError(400, 'LAST_TENANT_ADMIN', 'Cannot remove the last administrator of this tenant');
    }
  }
}

/** Tenants where `userId` is an administrator today. */
async function adminTenantsOf(userId: number): Promise<number[]> {
  const rows = await db('user_tenants').where({ user_id: userId, role: TENANT_ROLE_ADMIN }).select('tenant_id') as Array<{ tenant_id: number }>;
  return rows.map((r) => Number(r.tenant_id));
}

/**
 * New local account. A manager that is not a platform admin creates it as a
 * member of its operating tenant (`tenantRole`, default 'user', must be a
 * role it may grant); a platform admin adds that membership only when
 * `tenantRole` is given.
 */
export async function createUserAccount(
  actor: ScopeActor,
  data: CreateUserInput & { tenantRole?: string },
): Promise<User> {
  if (data.role === 'admin' && !actor.isPlatformAdmin) {
    throw codedError(403, 'ADMIN_PLATFORM_ONLY', 'Only a platform administrator can create an administrator account');
  }
  let tenantRole: string | null = null;
  if (data.tenantRole !== undefined || !actor.isPlatformAdmin) {
    if (!Number.isSafeInteger(actor.tenantId) || actor.tenantId <= 0) throw codedError(400, 'NO_TENANT_SELECTED', 'No tenant selected');
    tenantRole = await permissionSetService.resolveRole(normaliseTenantRole(data.tenantRole));
    await userScope.assertGrantableRole(actor, tenantRole);
  }
  if (await db('users').where({ username: data.username }).first('id')) {
    throw codedError(409, 'USERNAME_TAKEN', 'Username already exists');
  }

  const user = await userService.create({
    username: data.username,
    password: data.password,
    displayName: data.displayName ?? null,
    role: data.role ?? 'user',
  });
  if (tenantRole !== null) {
    try {
      await db('user_tenants').insert({ user_id: user.id, tenant_id: actor.tenantId, role: tenantRole });
    } catch (err) {
      // Never leave an orphan account the caller can no longer see.
      await userService.delete(user.id).catch(() => undefined);
      throw err;
    }
  }
  logger.info({ targetUserId: user.id, byUserId: actor.userId, tenantId: tenantRole !== null ? actor.tenantId : null, tenantRole }, 'User created');
  return user;
}

/** Edit (username, display name, platform role, active). */
export async function updateUserAccount(actor: ScopeActor, targetId: number, data: UpdateUserInput): Promise<User> {
  const scoped = await userScope.assertManageableTarget(actor, targetId);

  // The edit form always sends the current role: only a CHANGE is refused.
  if (data.role !== undefined && data.role !== scoped.role && !actor.isPlatformAdmin) {
    throw codedError(403, 'USER_ROLE_PLATFORM_ONLY', 'Only a platform administrator can change a user role');
  }
  if (!actor.isPlatformAdmin && targetId === actor.userId && data.isActive === false) {
    throw codedError(400, 'CANNOT_DISABLE_SELF', 'You cannot disable your own account');
  }
  // SSO accounts (platform admin only reaches here): role / activation and
  // username come from Obligate.
  if (scoped.foreign_source === 'obligate' && (data.role !== undefined || data.isActive !== undefined)) {
    throw codedError(400, 'SSO_USER_MANAGED', 'Cannot modify SSO user — manage from Obligate');
  }
  if (data.username !== undefined && scoped.foreign_source && data.username !== scoped.username) {
    throw codedError(400, 'SSO_USER_MANAGED', 'Cannot change username of an SSO user');
  }

  // The last active platform administrator is never demoted nor disabled.
  if ((data.role === 'user' || data.isActive === false) && scoped.role === 'admin' && scoped.is_active) {
    if ((await otherActivePlatformAdmins(targetId)) === 0) throw codedError(400, 'LAST_PLATFORM_ADMIN', 'Cannot remove the last active admin');
  }
  if (data.isActive === false && scoped.is_active) {
    await assertTenantsKeepAnAdmin(actor, targetId, await adminTenantsOf(targetId));
  }

  const user = await userService.update(targetId, data);
  if (!user) throw codedError(404, 'USER_NOT_FOUND', 'User not found');
  // Sessions cache userId + role: a demoted or disabled account must not
  // keep its current sessions (or sockets) with the old privileges.
  const demoted = scoped.role === 'admin' && user.role !== 'admin';
  if (demoted || (scoped.is_active && !user.isActive)) {
    await userSessionsService.destroyForUser(targetId);
  } else {
    invalidateUserState(targetId); // e.g. re-enabled: don't keep serving a cached "disabled"
  }
  if (data.role !== undefined && data.role !== scoped.role) {
    logger.warn({ targetUserId: targetId, byUserId: actor.userId, before: scoped.role, after: user.role }, 'User platform role changed');
  }
  return user;
}

/** Deletion (never one's own account, never the last platform administrator). */
export async function deleteUserAccount(actor: ScopeActor, targetId: number): Promise<void> {
  if (targetId === actor.userId) throw codedError(400, 'CANNOT_DELETE_SELF', 'Cannot delete your own account');
  const scoped = await userScope.assertManageableTarget(actor, targetId);
  // An active SSO account is managed in Obligate; a disabled one (e.g.
  // deleted in Obligate: sso-user-sync disables it) may be removed.
  if (scoped.foreign_source === 'obligate' && scoped.is_active) {
    throw codedError(400, 'SSO_USER_MANAGED', 'Cannot delete an active SSO user — manage from Obligate');
  }
  if (scoped.role === 'admin' && (await otherActivePlatformAdmins(targetId)) === 0) {
    throw codedError(400, 'LAST_PLATFORM_ADMIN', 'Cannot delete the last admin');
  }
  if (scoped.is_active) await assertTenantsKeepAnAdmin(actor, targetId, await adminTenantsOf(targetId));

  const deleted = await userService.delete(targetId);
  if (!deleted) throw codedError(404, 'USER_NOT_FOUND', 'User not found');
  await userSessionsService.destroyForUser(targetId);
  logger.info({ targetUserId: targetId, byUserId: actor.userId }, 'User deleted');
}

/**
 * Replace every tenant membership of an account (PUT /users/:id/tenants).
 * Platform admin: the list as sent, each tenant must exist (404) and each
 * role be 'admin' or a permission set (400). Other managers: only the
 * operating tenant's row (userScope.resolveTenantAssignments).
 */
export async function setUserTenants(actor: ScopeActor, targetId: number, assignments: unknown): Promise<void> {
  const resolved = await userScope.resolveTenantAssignments(actor, targetId, assignments);
  const ids = resolved.map((a) => a.tenantId);
  if (ids.length && (await db('tenants').whereIn('id', ids).pluck('id')).length !== ids.length) {
    throw codedError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
  }
  const rows: { tenantId: number; role: string }[] = [];
  for (const a of resolved) rows.push({ tenantId: a.tenantId, role: await permissionSetService.resolveRole(a.role) });

  const before = await adminTenantsOf(targetId);
  const after = new Set(rows.filter((r) => r.role === TENANT_ROLE_ADMIN).map((r) => r.tenantId));
  await assertTenantsKeepAnAdmin(actor, targetId, before.filter((t) => !after.has(t)));

  await userService.setUserTenantAssignments(targetId, rows);
  // Dropped memberships answer 403 at once; live sockets rejoin their rooms.
  userSessionsService.onMembershipChanged(targetId);
}

/**
 * One membership row of `actor.tenantId` changed by a manager that is NOT a
 * platform admin (tenant members endpoints; platform admins keep their
 * direct path): `role` = the new role, null = removal. Only an account of
 * that tenant the caller dominates (an account outside it is not found:
 * bringing an existing account into a tenant stays a platform operation),
 * never itself, granting only a role it may grant, never removing the
 * tenant's last administrator.
 */
export async function setTenantMembership(actor: ScopeActor, targetId: number, role: string | null): Promise<void> {
  if (actor.isPlatformAdmin) throw new Error('setTenantMembership is the delegated (non platform admin) path');
  const tenantId = actor.tenantId;
  const { currentRole } = await userScope.assertMembershipChange(actor, targetId, role);
  if (currentRole === TENANT_ROLE_ADMIN && role !== TENANT_ROLE_ADMIN) {
    await assertTenantsKeepAnAdmin(actor, targetId, [tenantId]);
  }
  if (role === null) await tenantService.removeUser(tenantId, targetId);
  else await tenantService.addUser(tenantId, targetId, role);
  userSessionsService.onMembershipChanged(targetId);
}
