/**
 * Agent identity rules (A5). Pure: no db import, so they can be unit-tested
 * and imported anywhere without cycles.
 */

/** agent_api_keys.key is a PostgreSQL uuid column. */
export const AGENT_API_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * agent_devices.uuid is varchar(64). Fits the canonical UUIDs produced by
 * agent/machine_uuid.go and the randomUUID of MikroTik rows.
 */
export const DEVICE_UUID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

export function isAgentApiKeyFormat(v: unknown): v is string {
  return typeof v === 'string' && AGENT_API_KEY_RE.test(v);
}

export function isDeviceUuidFormat(v: unknown): v is string {
  return typeof v === 'string' && DEVICE_UUID_RE.test(v);
}

export interface AgentKeyRef { id: number; tenant_id: number }

export interface DeviceBindingRow {
  id: number;
  tenant_id: number;
  api_key_id: number | null;
  device_type: string | null;
  status: string;
}

/**
 * May this API key act for this device? Same rule as Obliance
 * remoteSessionSecurity.agentKeyMayActForDevice, plus the MikroTik guard:
 *   1. a key of another tenant never acts for the device;
 *   2. a MikroTik row is never an agent channel;
 *   3. a device bound to another key refuses this one;
 *   4. otherwise (same tenant, bound to this key or unbound) it may.
 */
export function agentKeyMayActForDevice(
  key: AgentKeyRef,
  device: Pick<DeviceBindingRow, 'tenant_id' | 'api_key_id' | 'device_type'>,
): boolean {
  if (Number(device.tenant_id) !== Number(key.tenant_id)) return false;
  if (device.device_type === 'mikrotik') return false;
  if (device.api_key_id != null && Number(device.api_key_id) !== Number(key.id)) return false;
  return true;
}

/**
 * AGENT_KEY_BINDING=tenant only: any key of the device's own tenant may take
 * the binding over (never a MikroTik row, never across tenants).
 */
export function agentKeyMayRebindDevice(
  key: AgentKeyRef,
  device: Pick<DeviceBindingRow, 'tenant_id' | 'device_type'>,
): boolean {
  return Number(device.tenant_id) === Number(key.tenant_id) && device.device_type !== 'mikrotik';
}
