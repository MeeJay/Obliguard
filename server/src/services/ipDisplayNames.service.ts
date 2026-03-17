import { db } from '../db';

export interface IpDisplayName {
  ip: string;
  label: string;
  tenantId: number | null;
}

export const ipDisplayNamesService = {
  /**
   * Returns all labels visible to the caller:
   *   - Global labels (tenant_id IS NULL)
   *   - The caller's tenant labels (tenant_id = tenantId), which override globals
   */
  async list(tenantId?: number): Promise<IpDisplayName[]> {
    const rows = await db('ip_display_names')
      .where(function () {
        this.whereNull('tenant_id');
        if (tenantId) this.orWhere('tenant_id', tenantId);
      })
      .select('ip', 'label', 'tenant_id as tenantId')
      .orderBy('ip');

    // Tenant label overrides global for the same IP
    const map = new Map<string, IpDisplayName>();
    for (const row of rows as IpDisplayName[]) {
      const existing = map.get(row.ip);
      if (!existing || row.tenantId !== null) {
        // tenant-scoped entry wins over global
        map.set(row.ip, row);
      }
    }
    return Array.from(map.values());
  },

  /**
   * Upsert a label for an IP.
   * Passing label = '' (empty string) deletes the entry instead.
   */
  async upsert(
    ip: string,
    label: string,
    tenantId: number | null,
    userId?: number,
  ): Promise<void> {
    if (!label.trim()) {
      await ipDisplayNamesService.delete(ip, tenantId);
      return;
    }
    await db('ip_display_names')
      .insert({
        ip,
        label: label.trim(),
        tenant_id: tenantId ?? null,
        created_by: userId ?? null,
        updated_at: new Date(),
      })
      .onConflict(['ip', 'tenant_id'])
      .merge(['label', 'updated_at']);
  },

  async delete(ip: string, tenantId: number | null): Promise<void> {
    const q = db('ip_display_names').where('ip', ip);
    if (tenantId !== null) {
      q.where('tenant_id', tenantId);
    } else {
      q.whereNull('tenant_id');
    }
    await q.delete();
  },
};
