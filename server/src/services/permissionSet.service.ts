import { db } from '../db';
import { codedError } from '../utils/errorCodes';
import {
  TENANT_CAPABILITIES,
  TENANT_ROLE_ADMIN,
  PROTECTED_PERMISSION_SETS,
  LEGACY_TENANT_ROLE_MEMBER,
  expandCapability,
  expandCapabilities,
  normalizeTenantRole,
} from '@obliview/shared';
import type { TenantCapability, TenantCapabilityInfo } from '@obliview/shared';

// ── Types ───────────────────────────────────────────────────────────────────

interface PermissionSetRow {
  id: number;
  name: string;
  slug: string;
  capabilities: string[] | string;
  is_default: boolean;
  created_at: Date;
}

export interface PermissionSet {
  id: number;
  name: string;
  slug: string;
  capabilities: TenantCapability[];
  isDefault: boolean;
  /** Seeded set (admin / user / viewer): cannot be renamed or deleted. */
  isProtected: boolean;
  /** The admin set: role 'admin' holds every capability, its content is fixed. */
  isAdmin: boolean;
  createdAt: string;
}

/** A tenant role (permission-set slug): lowercase letters, digits, '-' and '_'. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ── Helpers ─────────────────────────────────────────────────────────────────

function isProtectedSlug(slug: string): boolean {
  return (PROTECTED_PERMISSION_SETS as readonly string[]).includes(slug);
}

function parseCaps(raw: unknown): string[] {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { v = []; }
  }
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
}

function rowToPermissionSet(row: PermissionSetRow): PermissionSet {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    capabilities: expandCapabilities(parseCaps(row.capabilities)),
    isDefault: row.is_default,
    isProtected: isProtectedSlug(row.slug),
    isAdmin: row.slug === TENANT_ROLE_ADMIN,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
    throw codedError(400, 'PERMISSION_SET_NAME_INVALID', 'name must be 1-64 characters', { max: 64 });
  }
  return name.trim();
}

function validateSlug(slug: unknown): string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw codedError(400, 'PERMISSION_SET_SLUG_INVALID', 'slug must be 1-64 lowercase letters, digits, "-" or "_"', { max: 64 });
  }
  if (slug === LEGACY_TENANT_ROLE_MEMBER || isProtectedSlug(slug)) {
    throw codedError(409, 'permissionSetSlugReserved', `The slug '${slug}' is reserved`, { slug });
  }
  return slug;
}

/** Catalogue keys (legacy aliases expanded); an unknown key is a 400. */
function validateCapabilities(caps: unknown): TenantCapability[] {
  if (!Array.isArray(caps)) throw codedError(400, 'FIELD_ARRAY', 'capabilities must be an array', { field: 'capabilities' });
  for (const c of caps) {
    if (typeof c !== 'string' || expandCapability(c).length === 0) {
      throw codedError(400, 'unknownCapability', `Unknown capability: ${String(c)}`, { capability: String(c) });
    }
  }
  return expandCapabilities(caps as string[]);
}

function mapUniqueViolation(err: unknown): unknown {
  const pg = err as { code?: string } | null;
  return pg?.code === '23505' ? codedError(409, 'permissionSetSlugTaken', 'A permission set with this slug already exists') : err;
}

// ── Service ─────────────────────────────────────────────────────────────────

class PermissionSetService {
  async getAll(): Promise<PermissionSet[]> {
    const rows = await db<PermissionSetRow>('permission_sets').orderBy('is_default', 'desc').orderBy('id', 'asc');
    return rows.map(rowToPermissionSet);
  }

  async getBySlug(slug: string): Promise<PermissionSet | null> {
    const row = await db<PermissionSetRow>('permission_sets').where({ slug }).first();
    return row ? rowToPermissionSet(row) : null;
  }

  async create(data: { name: unknown; slug: unknown; capabilities: unknown }): Promise<PermissionSet> {
    const name = validateName(data.name);
    const slug = validateSlug(data.slug);
    const capabilities = validateCapabilities(data.capabilities ?? []);
    try {
      const [row] = await db<PermissionSetRow>('permission_sets')
        .insert({
          name,
          slug,
          capabilities: JSON.stringify(capabilities),
          is_default: false,
          created_at: new Date(),
        } as unknown as PermissionSetRow)
        .returning('*');
      if (!row) throw new Error('Failed to create permission set');
      return rowToPermissionSet(row);
    } catch (err) {
      throw mapUniqueViolation(err);
    }
  }

  /**
   * Protected sets keep their name and slug; the admin set's content is
   * fixed (role 'admin' holds everything whatever the row says). Renaming a
   * custom set's slug moves the memberships holding it along.
   */
  async update(id: number, data: { name?: unknown; slug?: unknown; capabilities?: unknown }): Promise<PermissionSet> {
    const existing = await db<PermissionSetRow>('permission_sets').where({ id }).first();
    if (!existing) throw codedError(404, 'PERMISSION_SET_NOT_FOUND', 'Permission set not found');
    const prot = isProtectedSlug(existing.slug);

    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) {
      const name = validateName(data.name);
      if (name !== existing.name) {
        if (prot) throw codedError(400, 'permissionSetProtected', 'A built-in permission set cannot be renamed');
        updates.name = name;
      }
    }
    let newSlug: string | null = null;
    if (data.slug !== undefined && data.slug !== existing.slug) {
      if (prot) throw codedError(400, 'permissionSetProtected', 'A built-in permission set cannot be renamed');
      newSlug = validateSlug(data.slug);
      updates.slug = newSlug;
    }
    if (data.capabilities !== undefined) {
      const caps = validateCapabilities(data.capabilities);
      if (existing.slug === TENANT_ROLE_ADMIN) {
        const current = expandCapabilities(parseCaps(existing.capabilities));
        if (JSON.stringify(current) !== JSON.stringify(caps)) {
          throw codedError(400, 'permissionSetProtected', 'The admin permission set always holds every capability');
        }
      } else {
        updates.capabilities = JSON.stringify(caps);
      }
    }
    if (Object.keys(updates).length === 0) return rowToPermissionSet(existing);

    try {
      const row = await db.transaction(async (trx) => {
        const [r] = await trx<PermissionSetRow>('permission_sets').where({ id }).update(updates).returning('*');
        if (newSlug) await trx('user_tenants').where({ role: existing.slug }).update({ role: newSlug });
        return r;
      });
      if (!row) throw codedError(404, 'PERMISSION_SET_NOT_FOUND', 'Permission set not found');
      return rowToPermissionSet(row);
    } catch (err) {
      throw mapUniqueViolation(err);
    }
  }

  /** Built-in sets cannot be deleted; a set still held by a membership is a 409. */
  async delete(id: number): Promise<void> {
    const existing = await db<PermissionSetRow>('permission_sets').where({ id }).first();
    if (!existing) throw codedError(404, 'PERMISSION_SET_NOT_FOUND', 'Permission set not found');
    if (isProtectedSlug(existing.slug)) {
      throw codedError(400, 'permissionSetProtected', 'A built-in permission set cannot be deleted');
    }
    const inUse = await db('user_tenants').where({ role: existing.slug }).count<{ count: string }[]>('* as count');
    const n = Number(inUse[0]?.count ?? 0);
    if (n > 0) {
      throw codedError(409, 'permissionSetInUse', `This permission set is the role of ${n} tenant membership(s)`, { count: Number(n) });
    }
    await db('permission_sets').where({ id }).del();
  }

  getAvailableCapabilities(): readonly TenantCapabilityInfo[] {
    return TENANT_CAPABILITIES;
  }

  /**
   * Validate a tenant role for a write (membership create / update): 'admin'
   * or the slug of an existing permission set; the legacy 'member' is stored
   * as 'user'. Anything else is a 400.
   */
  async resolveRole(raw: unknown): Promise<string> {
    if (typeof raw !== 'string' || !raw) {
      throw codedError(400, 'invalidTenantRole', 'role must be the slug of a permission set');
    }
    const role = normalizeTenantRole(raw);
    if (role === TENANT_ROLE_ADMIN) return role;
    if (!SLUG_RE.test(role) || !(await db('permission_sets').where({ slug: role }).first('id'))) {
      throw codedError(400, 'invalidTenantRole', `Unknown role '${raw}': it must be the slug of a permission set`);
    }
    return role;
  }

  /** Whether a role slug is known ('admin' or an existing permission set). */
  async roleExists(role: string): Promise<boolean> {
    const r = normalizeTenantRole(role);
    if (r === TENANT_ROLE_ADMIN) return true;
    return !!(await db('permission_sets').where({ slug: r }).first('id'));
  }
}

export const permissionSetService = new PermissionSetService();
