import { db } from '../db';
import { deviceAccessVerdict, FOREIGN_DEVICE_READ_ONLY } from '../utils/tenantWriteRules';

export interface DeviceAccessRow {
  id: number;
  uuid: string;
  tenant_id: number;
  status: string;
  device_type: string | null;
}

export type DeviceAccessResult =
  | { ok: true; row: DeviceAccessRow }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Shared device access guard (A5). Reads may cross tenants from the Default
 * tenant (god view); writes follow the operating tenant, with NO platform-admin
 * bypass (an admin switches tenant to edit):
 *   - own tenant → ok;
 *   - Default tenant, read → ok; write → 403 (read-only god view);
 *   - any other tenant → 404 (existence never revealed).
 *
 * Callers: agent.controller (device update/delete/command, bulk variants via
 * filterDeviceIdsByTenant), firewall.controller and mikrotik.controller.
 */
export async function checkDeviceAccess(
  deviceId: unknown,
  tenantId: number,
  mode: 'read' | 'write',
): Promise<DeviceAccessResult> {
  const id = Number(deviceId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'Invalid device ID' };
  const row = await db('agent_devices')
    .where({ id })
    .first('id', 'uuid', 'tenant_id', 'status', 'device_type') as DeviceAccessRow | undefined;
  if (!row) return { ok: false, status: 404, error: 'Device not found' };
  switch (deviceAccessVerdict(row.tenant_id, tenantId, mode)) {
    case 'ok': return { ok: true, row };
    case 'forbidden': return { ok: false, status: 403, error: FOREIGN_DEVICE_READ_ONLY };
    default: return { ok: false, status: 404, error: 'Device not found' };
  }
}
