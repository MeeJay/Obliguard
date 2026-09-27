/**
 * 30 — C17 pure helpers (utils/agentUpdate.ts): the Go-compatible version
 * comparison, the policy resolution ('off' absolute, nearest wins otherwise,
 * default 'manual'), request liveness, the advertisement predicate, served
 * version validation, agent root candidates and the import sanitiser.
 * No database, no harness.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { lotIt } from '../lots';
import {
  AGENT_UPDATE_REQUEST_TTL_MS,
  agentRootCandidates,
  isAgentUpdatePolicy,
  isStrictlyNewerAgentVersion,
  isUpdateRequestLive,
  isValidServedAgentVersion,
  parseAgentSemver,
  resolveAgentUpdatePolicy,
  sanitizeImportedAgentGroupConfig,
  shouldAdvertiseUpdate,
  type GroupPolicyEntry,
} from '../../src/utils/agentUpdate';

describe('30 agent update helpers (pure)', () => {
  lotIt('C17', '30.1 isStrictlyNewerAgentVersion mirrors Go isStrictlyNewer', () => {
    const cases: Array<[string, string, boolean]> = [
      ['1.8.47', '1.8.46', true],
      ['1.8.46', '1.8.46', false],
      ['1.8.45', '1.8.46', false],
      ['1.10.0', '1.9.9', true],
      ['v2.0.0', '1.9.9', true],
      ['1.8.46', 'dev', true],
      ['garbage', '1.0.0', false],
      ['1.8.46.1', '1.8.45', false], // SplitN + Atoi: 1.8.0
      ['1.8.46-rc1', '1.8.45', false], // Atoi('46-rc1') = 0
      ['2.0.0', '', true],
    ];
    for (const [remote, current, expected] of cases) {
      assert.equal(isStrictlyNewerAgentVersion(remote, current), expected, `${remote} vs ${current}`);
    }
    assert.deepEqual(parseAgentSemver('v1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseAgentSemver('1.2'), [0, 0, 0]);
    assert.deepEqual(parseAgentSemver(null), [0, 0, 0]);
  });

  lotIt('C17', '30.2 resolveAgentUpdatePolicy: off is absolute, otherwise nearest wins, default manual', () => {
    const g = (groupId: number, policy: 'auto' | 'manual' | 'off'): GroupPolicyEntry => ({ groupId, tenantId: 2, policy });
    const r = (...a: Parameters<typeof resolveAgentUpdatePolicy>) => resolveAgentUpdatePolicy(...a);
    assert.deepEqual(r(null, [], null), { policy: 'manual', source: 'default', sourceGroupId: null });
    assert.deepEqual(r(null, [], undefined), { policy: 'manual', source: 'default', sourceGroupId: null });
    assert.deepEqual(r(null, [], 'auto'), { policy: 'auto', source: 'global', sourceGroupId: null });
    assert.deepEqual(r('manual', [g(1, 'auto')], 'auto'), { policy: 'manual', source: 'agent', sourceGroupId: null });
    assert.deepEqual(r(null, [g(10, 'auto'), g(11, 'manual')], null), { policy: 'auto', source: 'group', sourceGroupId: 10 });
    assert.deepEqual(r('auto', [g(10, 'manual'), g(11, 'off')], 'auto'), { policy: 'off', source: 'group', sourceGroupId: 11 });
    assert.deepEqual(r('auto', [g(10, 'off'), g(11, 'off')], 'auto'), { policy: 'off', source: 'group', sourceGroupId: 11 }, 'farthest off is reported');
    assert.deepEqual(r('auto', [], 'off'), { policy: 'off', source: 'global', sourceGroupId: null });
    assert.deepEqual(r('off', [], 'auto'), { policy: 'off', source: 'agent', sourceGroupId: null });
    assert.deepEqual(r('auto', [g(10, 'manual')], 'manual'), { policy: 'auto', source: 'agent', sourceGroupId: null });
  });

  lotIt('C17', '30.3 isUpdateRequestLive: pinned version, served known, 24 h TTL', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    const at = new Date(now - 60_000).toISOString();
    assert.equal(isUpdateRequestLive({ requestedAt: at, requestedVersion: '2.0.0', served: '2.0.0', now }), true);
    assert.equal(isUpdateRequestLive({ requestedAt: new Date(now - 60_000), requestedVersion: '2.0.0', served: '2.0.0', now }), true);
    assert.equal(isUpdateRequestLive({ requestedAt: at, requestedVersion: '2.0.0', served: '2.0.1', now }), false, 'superseded');
    assert.equal(isUpdateRequestLive({ requestedAt: at, requestedVersion: '2.0.0', served: null, now }), false, 'served unknown');
    assert.equal(isUpdateRequestLive({ requestedAt: null, requestedVersion: '2.0.0', served: '2.0.0', now }), false);
    assert.equal(isUpdateRequestLive({ requestedAt: at, requestedVersion: null, served: '2.0.0', now }), false);
    const old = new Date(now - AGENT_UPDATE_REQUEST_TTL_MS).toISOString();
    assert.equal(isUpdateRequestLive({ requestedAt: old, requestedVersion: '2.0.0', served: '2.0.0', now }), false, 'expired');
  });

  lotIt('C17', '30.4 shouldAdvertiseUpdate', () => {
    const base = { served: '2.0.0', reported: '1.0.0', policy: 'auto' as const, requestLive: false, deviceType: 'agent', status: 'approved' };
    assert.equal(shouldAdvertiseUpdate(base), true);
    assert.equal(shouldAdvertiseUpdate({ ...base, policy: 'manual' }), false);
    assert.equal(shouldAdvertiseUpdate({ ...base, policy: 'manual', requestLive: true }), true);
    assert.equal(shouldAdvertiseUpdate({ ...base, policy: 'off', requestLive: true }), false);
    assert.equal(shouldAdvertiseUpdate({ ...base, deviceType: 'mikrotik' }), false);
    assert.equal(shouldAdvertiseUpdate({ ...base, status: 'pending' }), false);
    assert.equal(shouldAdvertiseUpdate({ ...base, served: null }), false);
    assert.equal(shouldAdvertiseUpdate({ ...base, reported: '' }), false);
    assert.equal(shouldAdvertiseUpdate({ ...base, reported: '2.0.0' }), false);
  });

  lotIt('C17', '30.5 served version validation, policy guard, agent root candidates', () => {
    assert.equal(isValidServedAgentVersion('1.8.46'), true);
    assert.equal(isValidServedAgentVersion('v1.8.46-rc.1'), true);
    assert.equal(isValidServedAgentVersion('garbage'), false);
    assert.equal(isValidServedAgentVersion('1.8'), false);
    assert.equal(isValidServedAgentVersion(`1.0.0-${'a'.repeat(59)}`), false, '65 characters');
    assert.equal(isAgentUpdatePolicy('auto'), true);
    assert.equal(isAgentUpdatePolicy('off'), true);
    assert.equal(isAgentUpdatePolicy('yes'), false);
    assert.equal(isAgentUpdatePolicy(null), false);
    const dist = agentRootCandidates(path.resolve('/a/server/dist/src/services'));
    assert.deepEqual(dist, [path.resolve('/a/agent'), path.resolve('/a/server/agent')]);
    assert.equal(agentRootCandidates(path.resolve('/a/server/src/services'))[1], path.resolve('/a/agent'));
  });

  lotIt('C17', '30.6 sanitizeImportedAgentGroupConfig never imports auto-update', () => {
    assert.deepEqual(sanitizeImportedAgentGroupConfig({ updatePolicy: 'auto', pushIntervalSeconds: 60, evil: 1 }), { pushIntervalSeconds: 60 });
    assert.deepEqual(sanitizeImportedAgentGroupConfig({ updatePolicy: 'off' }), { updatePolicy: 'off' });
    assert.deepEqual(sanitizeImportedAgentGroupConfig({ updatePolicy: 'manual', maxMissedPushes: 3 }), { updatePolicy: 'manual', maxMissedPushes: 3 });
    assert.deepEqual(sanitizeImportedAgentGroupConfig({ updatePolicy: 'bogus' }), {});
    assert.equal(sanitizeImportedAgentGroupConfig('str'), null);
    assert.equal(sanitizeImportedAgentGroupConfig([]), null);
    assert.equal(sanitizeImportedAgentGroupConfig(null), null);
  });
});
