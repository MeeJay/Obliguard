import { db } from '../db';

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
  capabilities: string[];
  isDefault: boolean;
  createdAt: string;
}

export interface CapabilityInfo {
  key: string;
  label: string;
}

// ── Available capabilities for Obliguard ────────────────────────────────────

const AVAILABLE_CAPABILITIES: CapabilityInfo[] = [
  { key: 'monitoring',         label: 'View monitors, groups, events' },
  { key: 'groups.manage',      label: 'Create, edit, delete groups' },
  { key: 'agents.manage',      label: 'Manage agent devices' },
  { key: 'bans',               label: 'Create, lift bans' },
  { key: 'whitelist',          label: 'Manage whitelists' },
  { key: 'service.templates',  label: 'Manage service templates' },
  { key: 'ip.labels',          label: 'Manage IP labels' },
  { key: 'settings',           label: 'App settings' },
  { key: 'users.manage',       label: 'Manage users and teams' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function rowToPermissionSet(row: PermissionSetRow): PermissionSet {
  const caps = typeof row.capabilities === 'string'
    ? JSON.parse(row.capabilities) as string[]
    : row.capabilities;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    capabilities: caps,
    isDefault: row.is_default,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

class PermissionSetService {
  async getAll(): Promise<PermissionSet[]> {
    const rows = await db<PermissionSetRow>('permission_sets').orderBy('is_default', 'desc').orderBy('name', 'asc');
    return rows.map(rowToPermissionSet);
  }

  async getBySlug(slug: string): Promise<PermissionSet | null> {
    const row = await db<PermissionSetRow>('permission_sets').where({ slug }).first();
    return row ? rowToPermissionSet(row) : null;
  }

  async create(data: { name: string; slug: string; capabilities: string[] }): Promise<PermissionSet> {
    const [row] = await db<PermissionSetRow>('permission_sets')
      .insert({
        name: data.name,
        slug: data.slug,
        capabilities: JSON.stringify(data.capabilities),
        is_default: false,
        created_at: new Date(),
      } as unknown as PermissionSetRow)
      .returning('*');
    if (!row) throw new Error('Failed to create permission set');
    return rowToPermissionSet(row);
  }

  async update(id: number, data: { name?: string; slug?: string; capabilities?: string[] }): Promise<PermissionSet> {
    const existing = await db<PermissionSetRow>('permission_sets').where({ id }).first();
    if (!existing) throw new Error('Permission set not found');

    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.slug !== undefined) updates.slug = data.slug;
    if (data.capabilities !== undefined) updates.capabilities = JSON.stringify(data.capabilities);

    const [row] = await db<PermissionSetRow>('permission_sets')
      .where({ id })
      .update(updates)
      .returning('*');
    if (!row) throw new Error('Failed to update permission set');
    return rowToPermissionSet(row);
  }

  async delete(id: number): Promise<void> {
    const existing = await db<PermissionSetRow>('permission_sets').where({ id }).first();
    if (!existing) throw new Error('Permission set not found');
    if (existing.is_default) throw new Error('Cannot delete a default permission set');
    await db('permission_sets').where({ id }).del();
  }

  getAvailableCapabilities(): CapabilityInfo[] {
    return AVAILABLE_CAPABILITIES;
  }
}

export const permissionSetService = new PermissionSetService();
