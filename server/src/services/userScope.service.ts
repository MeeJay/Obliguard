import type { Request } from 'express';
import { MASTER_TENANT_ID, TENANT_ROLE_ADMIN, TENANT_ROLE_DEFAULT, expandCapabilities, normalizeTenantRole } from '@obliview/shared';
import { db } from '../db';
import { codedError, type ErrorCode } from '../utils/errorCodes';

// ── Scope of `users.manage` (port of Obliance userScope.service) ────────────
//
// /api/users, /api/teams and the tenant members endpoints are gated by the
// tenant capability `users.manage`. Password, 2FA, activation and deletion
// act on the GLOBAL account, so a holder that is not a platform admin may
// only act on an account it fully dominates:
//   - never a platform admin (users.role = 'admin');
//   - never an SSO account (og_, foreign_source set): managed in Obligate;
//   - a member of the caller's operating tenant;
//   - in EVERY tenant the account belongs to:
//       · a tenant administrator (user_tenants.role = 'admin') only if the
//         caller is tenant administrator there too;
//       · otherwise the caller holds `users.manage` there AND every
//         capability of the account's permission set there (taking over an
//         account must never widen the caller's rights).
// Platform admins (session role 'admin') may target anyone.

export type ScopeActor = { userId: number; isPlatformAdmin: boolean; tenantId: number };
export type ManagedTarget = {
  id: number; username: string; role: string; is_active: boolean; foreign_source: string | null;
};
export type TenantAssignment = { tenantId: number; role: string };

export function actorFromReq(req: Request, tenantId?: number): ScopeActor {
  return {
    userId: Number(req.session.userId),
    isPlatformAdmin: req.session.role === 'admin',
    tenantId: Number(tenantId ?? req.tenantId ?? req.session.currentTenantId),
  };
}

/** The legacy tenant role 'member' (and an empty role) is the 'user' permission set. */
export function normaliseTenantRole(role: unknown): string {
  const r = String(role ?? '').trim();
  return r === '' ? TENANT_ROLE_DEFAULT : normalizeTenantRole(r);
}

type Caps = { all: true } | { all: false; set: Set<string> };

/** Capabilities of a tenant role; null for an unknown slug (it grants nothing). */
async function capsOfRole(role: string): Promise<Caps | null> {
  if (role === TENANT_ROLE_ADMIN) return { all: true };
  const row = await db('permission_sets').where({ slug: role }).first('capabilities') as { capabilities: unknown } | undefined;
  if (!row) return null;
  let raw: unknown = row.capabilities;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  const keys = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
  // Alias keys stored in a set are expanded (permission.service getRoleCapabilities).
  return { all: false, set: new Set<string>(expandCapabilities(keys)) };
}

async function membershipRole(userId: number, tenantId: number): Promise<string | null> {
  const row = await db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('role') as { role: string } | undefined;
  return row ? normaliseTenantRole(row.role) : null;
}

/** Why an account cannot be managed: catalogue code + English text. */
interface Refusal { code: ErrorCode; message: string }

const MORE_PERMISSIONS: Refusal = { code: 'USER_HAS_MORE_PERMISSIONS', message: 'This user has permissions you do not hold' };

/**
 * Can `actor` (not a platform admin) manage an account whose role in
 * `tenantId` is `targetRole`? Returns the refusal (code + text), or null when allowed.
 */
async function refusalFor(actor: ScopeActor, tenantId: number, targetRole: string): Promise<Refusal | null> {
  const callerRole = await membershipRole(actor.userId, tenantId);
  if (callerRole === TENANT_ROLE_ADMIN) return null; // tenant admin: every capability there
  if (targetRole === TENANT_ROLE_ADMIN) {
    return { code: 'TENANT_ADMIN_MANAGE_REQUIRES_ADMIN', message: "Only an administrator of each of this user's tenants can manage a tenant administrator" };
  }
  const callerCaps = callerRole ? await capsOfRole(callerRole) : null;
  if (callerCaps?.all) return null;
  if (!callerCaps || !callerCaps.set.has('users.manage')) {
    return { code: 'USER_MANAGE_FOREIGN_TENANT', message: 'This user also belongs to a tenant where you cannot manage users' };
  }
  const targetCaps = await capsOfRole(targetRole);
  if (targetCaps?.all) return MORE_PERMISSIONS;
  for (const cap of targetCaps?.set ?? []) {
    if (!callerCaps.set.has(cap)) return MORE_PERMISSIONS;
  }
  return null;
}

export const userScope = {
  /** Write access (password / 2FA reset, edit, enable/disable, delete,
   *  tenant access). Throws 400 / 403 / 404 (AppError). */
  async assertManageableTarget(actor: ScopeActor, targetId: number): Promise<ManagedTarget> {
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw codedError(400, 'USER_ID_INVALID', 'Invalid user id');
    const target = await db('users').where({ id: targetId })
      .first('id', 'username', 'role', 'is_active', 'foreign_source') as ManagedTarget | undefined;
    if (!target) throw codedError(404, 'USER_NOT_FOUND', 'User not found');
    if (actor.isPlatformAdmin) return target;
    const rows = await db('user_tenants').where({ user_id: targetId }).select('tenant_id', 'role') as Array<{ tenant_id: number; role: string }>;
    // Outside the operating tenant the account does not exist for this caller.
    if (!rows.some((r) => Number(r.tenant_id) === actor.tenantId)) throw codedError(404, 'USER_NOT_FOUND', 'User not found');
    if (target.role === 'admin') {
      throw codedError(403, 'ADMIN_PLATFORM_ONLY', 'Only a platform administrator can manage an administrator account');
    }
    if (target.foreign_source) {
      throw codedError(403, 'SSO_USER_MANAGED', 'SSO accounts are managed in Obligate');
    }
    for (const r of rows) {
      const refusal = await refusalFor(actor, Number(r.tenant_id), normaliseTenantRole(r.role));
      if (refusal) throw codedError(403, refusal.code, refusal.message);
    }
    return target;
  },

  /** Read access (GET /users/:id, /:id/tenants, /:id/teams): the same
   *  population as GET /users — every account from the master tenant or for
   *  a platform admin, members of the operating tenant otherwise. 404 outside. */
  async assertReadableTarget(actor: ScopeActor, targetId: number): Promise<void> {
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw codedError(400, 'USER_ID_INVALID', 'Invalid user id');
    if (actor.isPlatformAdmin || actor.tenantId === MASTER_TENANT_ID) return;
    const member = await db('user_tenants').where({ user_id: targetId, tenant_id: actor.tenantId }).first('user_id');
    if (!member) throw codedError(404, 'USER_NOT_FOUND', 'User not found');
  },

  /**
   * May `actor` (not a platform admin) give the role `role` in its operating
   * tenant? A tenant admin may grant any role; any other holder of
   * users.manage only a set whose capabilities it holds itself (never
   * 'admin'). 400 for an unknown role, 403 otherwise.
   */
  async assertGrantableRole(actor: ScopeActor, role: string): Promise<void> {
    if (actor.isPlatformAdmin) return;
    if (role === TENANT_ROLE_ADMIN) {
      if ((await membershipRole(actor.userId, actor.tenantId)) !== TENANT_ROLE_ADMIN) {
        throw codedError(403, 'TENANT_ADMIN_GRANT_REQUIRES_ADMIN', 'Only a tenant administrator can grant the tenant administrator role');
      }
      return;
    }
    if (!(await capsOfRole(role))) throw codedError(400, 'invalidTenantRole', `Unknown role '${role}': it must be the slug of a permission set`);
    const refusal = await refusalFor(actor, actor.tenantId, role);
    if (refusal) throw codedError(403, 'ROLE_EXCEEDS_OWN_PERMISSIONS', 'You can only grant a role whose permissions you hold');
  },

  /**
   * One membership row of the operating tenant changes (`nextRole` = the new
   * role, null = removal), for a caller that is not a platform admin: never
   * one's own, only an account it dominates, only a role it may grant.
   * Returns the target and its current role in that tenant.
   */
  async assertMembershipChange(actor: ScopeActor, targetId: number, nextRole: string | null): Promise<{ target: ManagedTarget; currentRole: string | null }> {
    if (targetId === actor.userId && !actor.isPlatformAdmin) throw codedError(403, 'CANNOT_CHANGE_OWN_ACCESS', 'You cannot change your own tenant access');
    const target = await this.assertManageableTarget(actor, targetId);
    if (nextRole !== null) await this.assertGrantableRole(actor, nextRole);
    return { target, currentRole: await membershipRole(targetId, actor.tenantId) };
  },

  /**
   * Resolves PUT /users/:id/tenants into the full list of memberships to
   * store. Platform admin: the list as sent ('member' read as 'user').
   * Other managers: only the OPERATING tenant's row may change (add a role,
   * change it, or remove it); every other membership is kept as it is —
   * absent from the list or repeated unchanged, never altered.
   */
  async resolveTenantAssignments(actor: ScopeActor, targetId: number, assignments: unknown): Promise<TenantAssignment[]> {
    if (!Array.isArray(assignments)) throw codedError(400, 'TENANT_ASSIGNMENTS_INVALID', 'assignments must be an array of { tenantId, role }');
    const wanted: TenantAssignment[] = [];
    const seen = new Set<number>();
    for (const a of assignments as Array<{ tenantId?: unknown; role?: unknown } | null>) {
      const tenantId = a?.tenantId;
      if (typeof tenantId !== 'number' || !Number.isSafeInteger(tenantId) || tenantId <= 0) throw codedError(400, 'TENANT_ASSIGNMENTS_INVALID', 'Invalid tenant id');
      if (typeof a?.role !== 'string' || !a.role) throw codedError(400, 'TENANT_ASSIGNMENTS_INVALID', 'assignments must be an array of { tenantId, role }');
      if (seen.has(tenantId)) throw codedError(400, 'TENANT_ASSIGNMENT_DUPLICATE', 'Duplicate tenantId in assignments');
      seen.add(tenantId);
      wanted.push({ tenantId, role: normaliseTenantRole(a.role) });
    }
    if (actor.isPlatformAdmin) return wanted;

    // Scope first (404 outside the operating tenant): the other memberships
    // of an account the caller cannot manage are never compared, nor named.
    const next = wanted.find((w) => w.tenantId === actor.tenantId) ?? null;
    await this.assertMembershipChange(actor, targetId, next ? next.role : null);

    const current = (await db('user_tenants').where({ user_id: targetId }).select('tenant_id', 'role') as Array<{ tenant_id: number; role: string }>)
      .map((r) => ({ tenantId: Number(r.tenant_id), role: normaliseTenantRole(r.role) }));
    const kept = current.filter((r) => r.tenantId !== actor.tenantId);
    for (const w of wanted) {
      if (w.tenantId === actor.tenantId) continue;
      const same = kept.find((k) => k.tenantId === w.tenantId);
      if (!same || same.role !== w.role) throw codedError(403, 'TENANT_ACCESS_CURRENT_ONLY', 'You can only change access to the current tenant');
    }
    return next ? [...kept, next] : kept;
  },
};
