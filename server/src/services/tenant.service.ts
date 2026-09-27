import { db } from '../db';
import { MASTER_TENANT_ID } from '@obliview/shared';
import type { Tenant, TenantWithRole } from '@obliview/shared';

interface TenantRow {
  id: number;
  name: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  email: string | null;
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const tenantService = {
  async getAll(): Promise<Tenant[]> {
    const rows = await db('tenants').select<TenantRow[]>('*').orderBy('id');
    return rows.map(rowToTenant);
  },

  async getById(id: number): Promise<Tenant | null> {
    const row = await db('tenants').where({ id }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  /** True when a tenant with this id exists (rejects non-positive / unsafe ids). */
  async exists(id: number): Promise<boolean> {
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    return !!(await db('tenants').where({ id }).first('id'));
  },

  async getBySlug(slug: string): Promise<Tenant | null> {
    const row = await db('tenants').where({ slug }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  async create(data: { name: string; slug: string }): Promise<Tenant> {
    const [row] = await db('tenants')
      .insert({ name: data.name, slug: data.slug })
      .returning('*');
    return rowToTenant(row as TenantRow);
  },

  async update(id: number, data: { name?: string; slug?: string }): Promise<Tenant | null> {
    const [row] = await db('tenants')
      .where({ id })
      .update({ ...data, updated_at: db.fn.now() })
      .returning('*');
    return row ? rowToTenant(row as TenantRow) : null;
  },

  async delete(id: number): Promise<void> {
    await db('tenants').where({ id }).delete();
  },

  /** Returns the first tenant accessible by userId (lowest id). */
  async getFirstTenantForUser(userId: number): Promise<Tenant | null> {
    const row = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .first<TenantRow & { role: string }>('tenants.*');
    return row ? rowToTenant(row) : null;
  },

  /** The user's favourite workspace id (opened at sign-in), or null if none set. */
  async getPreferredTenant(userId: number): Promise<number | null> {
    const row = await db('users').where({ id: userId }).first<{ preferred_tenant_id: number | null } | undefined>('preferred_tenant_id');
    return row?.preferred_tenant_id ?? null;
  },

  /** Set (or clear, with null) the user's favourite workspace. The caller validates access. */
  async setPreferredTenant(userId: number, tenantId: number | null): Promise<void> {
    await db('users').where({ id: userId }).update({ preferred_tenant_id: tenantId, updated_at: db.fn.now() });
  },

  /**
   * Tenant a fresh session lands on (password login, 2FA verify, SSO callback
   * fallback, /auth/me repair):
   *   1. the user's favourite workspace, when it is still usable (platform admin:
   *      the tenant exists; anyone else: still a member);
   *   2. else the first membership (lowest id);
   *   3. else Default for platform admins — they have implicit access to every
   *      tenant and may have no user_tenants row (bootstrap admin from
   *      ensureDefaultAdmin, SSO platform admins);
   *   4. else null: a non-admin without membership must never be placed on the
   *      god-view tenant; the session tenant stays unset (no tenant access).
   * Same access predicate as middleware/tenant canUseTenant (uncached here).
   */
  async resolveLoginTenant(userId: number, role: string | null | undefined): Promise<number | null> {
    const preferred = await tenantService.getPreferredTenant(userId);
    if (preferred !== null) {
      const usable = role === 'admin' ? await tenantService.exists(preferred) : await tenantService.userHasAccess(userId, preferred);
      if (usable) return preferred;
    }
    const first = await tenantService.getFirstTenantForUser(userId);
    if (first) return first.id;
    return role === 'admin' ? MASTER_TENANT_ID : null;
  },

  /** Returns all tenants accessible by userId, with tenant-level role. */
  async getTenantsForUser(userId: number): Promise<TenantWithRole[]> {
    const rows = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .select<(TenantRow & { role: string })[]>('tenants.*', 'user_tenants.role');
    return rows.map((r) => ({ ...rowToTenant(r), role: r.role as 'admin' | 'member' }));
  },

  /** Check if user has access to a specific tenant. */
  async userHasAccess(userId: number, tenantId: number): Promise<boolean> {
    const row = await db('user_tenants')
      .where({ user_id: userId, tenant_id: tenantId })
      .first('user_id');
    return !!row;
  },

  async getMembers(tenantId: number): Promise<(UserRow & { tenantRole: string })[]> {
    return db('users')
      .join('user_tenants', 'users.id', 'user_tenants.user_id')
      .where('user_tenants.tenant_id', tenantId)
      .select<(UserRow & { tenantRole: string })[]>(
        'users.id',
        'users.username',
        'users.display_name',
        'users.role',
        'users.is_active',
        'users.email',
        db.raw('user_tenants.role as "tenantRole"'),
      )
      .orderBy('users.username');
  },

  async addUser(tenantId: number, userId: number, role: 'admin' | 'member'): Promise<void> {
    await db('user_tenants')
      .insert({ tenant_id: tenantId, user_id: userId, role })
      .onConflict(['user_id', 'tenant_id'])
      .merge({ role });
  },

  async removeUser(tenantId: number, userId: number): Promise<void> {
    await db('user_tenants').where({ tenant_id: tenantId, user_id: userId }).delete();
  },

  async updateUserRole(tenantId: number, userId: number, role: 'admin' | 'member'): Promise<void> {
    await db('user_tenants')
      .where({ tenant_id: tenantId, user_id: userId })
      .update({ role });
  },
};
