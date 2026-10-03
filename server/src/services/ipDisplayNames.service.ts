import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';

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
        if (isMasterTenant(tenantId)) {
          this.orWhereNotNull('tenant_id');
        } else if (tenantId) {
          this.orWhere('tenant_id', tenantId);
        }
      })
      .select('ip', 'label', 'tenant_id as tenantId')
      .orderBy('ip');

    // One label per IP. A tenant sees its own label over the global one. The
    // Default tenant (god view) writes global labels, so it prefers the global
    // label, then its own legacy row, then the lowest other tenant id
    // (deterministic instead of whichever row came last).
    const master = isMasterTenant(tenantId);
    const rank = (r: IpDisplayName): number => {
      if (master) return r.tenantId === null ? 0 : isMasterTenant(r.tenantId) ? 1 : 2 + r.tenantId;
      return r.tenantId === null ? 1 : 0;
    };
    const map = new Map<string, IpDisplayName>();
    for (const row of rows as IpDisplayName[]) {
      const existing = map.get(row.ip);
      if (!existing || rank(row) < rank(existing)) map.set(row.ip, row);
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
