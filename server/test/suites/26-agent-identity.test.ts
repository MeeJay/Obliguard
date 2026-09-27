/**
 * 26 — A5 pure helpers: agentIdentity (key/uuid formats, device ↔ key binding
 * rule) and tenantWriteRules (operating-tenant device access, whitelist delete
 * matrix). No database, no harness.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { lotIt } from '../lots';
import {
  agentKeyMayActForDevice, agentKeyMayRebindDevice, isAgentApiKeyFormat, isDeviceUuidFormat,
} from '../../src/utils/agentIdentity';
import { deviceAccessVerdict, whitelistDeleteVerdict } from '../../src/utils/tenantWriteRules';

const A = 2;
const B = 3;
const DEF = 1;
const C = 4;

describe('26 agent identity + tenant write rules (pure)', () => {
  lotIt('A5', '26.1 agentKeyMayActForDevice', () => {
    const key = { id: 10, tenant_id: A };
    assert.equal(agentKeyMayActForDevice(key, { tenant_id: A, api_key_id: 10, device_type: 'agent' }), true);
    assert.equal(agentKeyMayActForDevice(key, { tenant_id: A, api_key_id: null, device_type: null }), true);
    assert.equal(agentKeyMayActForDevice(key, { tenant_id: B, api_key_id: 10, device_type: 'agent' }), false);
    assert.equal(agentKeyMayActForDevice(key, { tenant_id: A, api_key_id: 11, device_type: 'agent' }), false);
    assert.equal(agentKeyMayActForDevice(key, { tenant_id: A, api_key_id: 10, device_type: 'mikrotik' }), false);
    // numeric strings from the driver compare by value
    assert.equal(agentKeyMayActForDevice(key, { tenant_id: String(A) as unknown as number, api_key_id: '10' as unknown as number, device_type: 'agent' }), true);
  });

  lotIt('A5', '26.2 agentKeyMayRebindDevice', () => {
    const key = { id: 10, tenant_id: A };
    assert.equal(agentKeyMayRebindDevice(key, { tenant_id: A, device_type: 'agent' }), true);
    assert.equal(agentKeyMayRebindDevice(key, { tenant_id: A, device_type: 'mikrotik' }), false);
    assert.equal(agentKeyMayRebindDevice(key, { tenant_id: B, device_type: 'agent' }), false);
  });

  lotIt('A5', '26.3 key and uuid formats', () => {
    assert.equal(isAgentApiKeyFormat('aaaaaaaa-0000-4000-8000-000000000001'), true);
    assert.equal(isAgentApiKeyFormat('abc'), false);
    assert.equal(isAgentApiKeyFormat('{aaaaaaaa-0000-4000-8000-000000000001}'), false);
    assert.equal(isAgentApiKeyFormat('aaaaaaaa-0000-4000-8000-0000000000011'), false);
    assert.equal(isAgentApiKeyFormat(undefined), false);
    assert.equal(isAgentApiKeyFormat(['aaaaaaaa-0000-4000-8000-000000000001']), false);
    assert.equal(isDeviceUuidFormat('4c4c4544-0042-3510-8052-b4c04f4d4e32'), true);
    assert.equal(isDeviceUuidFormat('0123456789abcdef0123456789abcdef'), true);
    assert.equal(isDeviceUuidFormat('../x'), false);
    assert.equal(isDeviceUuidFormat(''), false);
    assert.equal(isDeviceUuidFormat('a'.repeat(65)), false);
    assert.equal(isDeviceUuidFormat('a'.repeat(64)), true);
    assert.equal(isDeviceUuidFormat(null), false);
  });

  lotIt('A5', '26.4 deviceAccessVerdict', () => {
    assert.equal(deviceAccessVerdict(B, B, 'read'), 'ok');
    assert.equal(deviceAccessVerdict(B, B, 'write'), 'ok');
    assert.equal(deviceAccessVerdict(B, DEF, 'read'), 'ok');
    assert.equal(deviceAccessVerdict(B, DEF, 'write'), 'forbidden');
    assert.equal(deviceAccessVerdict(B, C, 'read'), 'not-found');
    assert.equal(deviceAccessVerdict(B, C, 'write'), 'not-found');
  });

  lotIt('A5', '26.5 whitelistDeleteVerdict matrix', () => {
    const g = { scope: 'global', tenant_id: null };
    assert.equal(whitelistDeleteVerdict(g, null, DEF), 'ok');
    assert.equal(whitelistDeleteVerdict(g, null, B), 'forbidden-global');
    const lb = { scope: 'tenant', tenant_id: B };
    assert.equal(whitelistDeleteVerdict(lb, null, B), 'ok');
    assert.equal(whitelistDeleteVerdict(lb, null, DEF), 'forbidden-foreign');
    assert.equal(whitelistDeleteVerdict(lb, null, A), 'not-found');
    // an agent row created by B, targeting A's device
    const pa = { scope: 'agent', tenant_id: B };
    assert.equal(whitelistDeleteVerdict(pa, A, A), 'ok');
    assert.equal(whitelistDeleteVerdict(pa, A, B), 'ok');
    assert.equal(whitelistDeleteVerdict(pa, A, DEF), 'forbidden-foreign');
    assert.equal(whitelistDeleteVerdict(pa, A, C), 'not-found');
    // legacy local row without owner = Default
    assert.equal(whitelistDeleteVerdict({ scope: 'group', tenant_id: null }, null, DEF), 'ok');
  });
});
