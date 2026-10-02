/**
 * 46c — W3-5 fleet update UI (client side of the W2-1 contract):
 *   - the client API exposes Retry (POST /agent/devices/:id/update/retry) and
 *     the tenant level of the update policy (GET/PATCH /agent/update-policy/tenant);
 *   - "Last seen" is AgentDevice.lastSeenAt (LastSeenPill), never updatedAt;
 *   - UpdateStatusBadge shows the attempt phase / failure reason with Retry on
 *     AgentDetailPage and AdminAgentPage; the Dashboard counts failed updates;
 *     AdminAgentPage lists missing builds and the tenant policy selector;
 *   - the heartbeatMonitoring checkboxes are gone from the agent admin page;
 *   - the client policy resolver (display only) matches the server resolver
 *     on every combination of levels (off absolute, nearest explicit wins);
 *   - the device fields the UI reads are served as it expects: a failed
 *     attempt with its reason, counted in updateFailed, reset by Retry; an
 *     admin edit does not move lastSeenAt.
 */
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice } from '../seed';
import {
  __resetAgentUpdateStateForTest,
  __setServedAgentVersionForTest,
  __setAgentManifestForTest,
} from '../../src/services/agent.service';
import { resolveAgentUpdatePolicy } from '../../src/utils/agentUpdate';
import type { AgentUpdatePolicy } from '@obliview/shared';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const SERVED = '2.0.0';

/** The client helper module, transpiled and evaluated (it only has type imports). */
function loadClientAgentUpdate(): Record<string, any> {
  const src = read('client/src/utils/agentUpdate.ts');
  assert.doesNotMatch(src, /^import (?!type )/m, 'client/src/utils/agentUpdate.ts must keep type-only imports');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod: { exports: Record<string, any> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', js)(mod.exports, mod, () => ({}));
  return mod.exports;
}

describe('46c fleet update UI (W3-5)', () => {
  lotIt('W3-5', '46c.1 client API: retryUpdate, tenant update policy, no heartbeatMonitoring', () => {
    const api = read('client/src/api/agent.api.ts');
    assert.match(api, /async retryUpdate\(id: number\)/);
    assert.match(api, /apiClient\.post<.*?>\(`\/agent\/devices\/\$\{id\}\/update\/retry`\)/, 'retry posts to /agent/devices/:id/update/retry');
    assert.match(api, /async getTenantUpdatePolicy\(\)/);
    assert.match(api, /apiClient\.get<.*?>\('\/agent\/update-policy\/tenant'\)/);
    assert.match(api, /async setTenantUpdatePolicy\(/);
    assert.match(api, /apiClient\.patch<.*?>\('\/agent\/update-policy\/tenant', \{ updatePolicy \}\)/);
    assert.match(api, /missingBuilds\?: string\[\]/, 'GET /agent/version carries missingBuilds');
    assert.doesNotMatch(api, /heartbeatMonitoring/);
    assert.doesNotMatch(read('client/src/pages/AdminAgentPage.tsx'), /heartbeatMonitoring/, 'heartbeat checkboxes removed');
  });

  lotIt('W3-5', '46c.2 last seen comes from lastSeenAt (LastSeenPill), never from updatedAt', () => {
    const pill = read('client/src/components/agent/LastSeenPill.tsx');
    assert.match(pill, /export function LastSeenPill\(/);
    assert.match(pill, /setInterval\(/, 'the relative time ticks on its own');

    const detail = read('client/src/pages/AgentDetailPage.tsx');
    assert.doesNotMatch(detail, /Last seen:\s*\{new Date\(device\.updatedAt\)/, 'header no longer shows updatedAt as last seen');
    assert.match(detail, /<LastSeenPill lastSeenAt=\{device\.lastSeenAt\}/);

    const admin = read('client/src/pages/AdminAgentPage.tsx');
    assert.match(admin, /<LastSeenPill lastSeenAt=\{device\.lastSeenAt\}/, 'Last seen column in the agent table');

    const dash = read('client/src/pages/DashboardPage.tsx');
    assert.doesNotMatch(dash, /lastSeenAt \?\? device\.updatedAt/, 'dashboard cards no longer fall back to updatedAt');
  });

  lotIt('W3-5', '46c.3 update state badge with Retry on detail and admin pages; failed count on the dashboard', () => {
    const badge = read('client/src/components/agent/UpdateStatusBadge.tsx');
    assert.match(badge, /export function UpdateStatusBadge\(/);
    assert.match(badge, /agentApi\.retryUpdate\(device\.id\)/);
    assert.match(badge, /failed && canRetry/, 'Retry only on a failed attempt and when allowed');
    assert.match(badge, /agents\.update\.failedWithReason/);
    assert.match(badge, /lastError/);

    for (const page of ['client/src/pages/AgentDetailPage.tsx', 'client/src/pages/AdminAgentPage.tsx']) {
      const src = read(page);
      assert.match(src, /<UpdateStatusBadge\b/, `${page} renders the update badge`);
      assert.match(src, /canRetry=\{[^}]*\}/, `${page} gates Retry`);
    }
    const admin = read('client/src/pages/AdminAgentPage.tsx');
    assert.match(admin, /missingBuilds/, 'missing builds banner');
    assert.match(admin, /agentApi\.setTenantUpdatePolicy\(/, 'tenant policy selector');
    assert.match(admin, /isAdmin \? \(\s*<select/, 'selector for platform admins, read-only otherwise');

    const dash = read('client/src/pages/DashboardPage.tsx');
    assert.match(dash, /updateFailed/);
    assert.match(dash, /to="\/manage\/agents"/);
  });

  lotIt('W3-5', '46c.4 client policy resolver mirrors the server one (off absolute, nearest explicit wins)', () => {
    const client = loadClientAgentUpdate();
    const values: Array<AgentUpdatePolicy | null> = [null, 'auto', 'manual', 'off'];
    const chains: Array<Array<{ groupId: number; policy: AgentUpdatePolicy }>> = [
      [],
      [{ groupId: 1, policy: 'auto' }],
      [{ groupId: 1, policy: 'manual' }, { groupId: 2, policy: 'off' }],
      [{ groupId: 1, policy: 'off' }, { groupId: 2, policy: 'auto' }],
      [{ groupId: 1, policy: 'auto' }, { groupId: 2, policy: 'manual' }],
    ];
    let n = 0;
    for (const device of values) {
      for (const chain of chains) {
        for (const tenant of values) {
          for (const global of values) {
            const server = resolveAgentUpdatePolicy(device, chain.map((c) => ({ ...c, tenantId: 2 })) as any, tenant, global);
            const view = client.resolveUpdatePolicyView(device, chain, tenant, global);
            assert.deepEqual(
              { policy: view.policy, source: view.source, sourceGroupId: view.sourceGroupId },
              { policy: server.policy, source: server.source, sourceGroupId: server.sourceGroupId },
              `device=${device} chain=${JSON.stringify(chain)} tenant=${tenant} global=${global}`,
            );
            n++;
          }
        }
      }
    }
    assert.equal(n, 320);

    // Settled / superseded attempts are not shown; a failed one is.
    const at = { targetVersion: '2.0.0', attempts: 3, lastError: 'timeout', updatedAt: new Date().toISOString() };
    assert.equal(client.visibleUpdateAttempt({ agentVersion: '1.0.0', update: { ...at, phase: 'failed' } })?.phase, 'failed');
    assert.equal(client.visibleUpdateAttempt({ agentVersion: '2.0.0', update: { ...at, phase: 'failed' } }), null);
    assert.equal(client.visibleUpdateAttempt({ agentVersion: '1.0.0', update: { ...at, phase: 'succeeded' } }), null);
    assert.equal(client.visibleUpdateAttempt({ agentVersion: '1.0.0', update: null }), null);
    assert.equal(client.agentBuildLabel('obliguard-agent-linux-arm64'), 'linux-arm64');
    assert.equal(client.agentBuildLabel('obliguard-agent.msi'), 'windows (MSI)');
  });
});

describe('46c fleet update UI: served fields (W3-5)', () => {
  let h: Harness;

  before(async () => { h = await startHarness(); });
  after(async () => {
    __resetAgentUpdateStateForTest();
    await h.close();
  });
  beforeEach(() => {
    __resetAgentUpdateStateForTest();
    __setServedAgentVersionForTest(SERVED);
    __setAgentManifestForTest(null);
  });

  lotIt('W3-5', '46c.5 a failed attempt is served with its reason, counted, and reset by Retry; edits keep lastSeenAt', async () => {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2, version: '1.0.0' });
    const seen = new Date(Date.now() - 3 * 3600_000);
    await h.db('agent_devices').where({ id: d.id }).update({ last_seen_at: seen });
    await h.db('agent_update_attempts').insert({
      device_id: d.id, target_version: SERVED, offered_count: 3, phase: 'failed', last_error: 'timeout',
      last_offered_at: new Date(Date.now() - 20 * 60_000), finished_at: new Date(),
    });

    const mb = await h.as('member_b');
    const one = await mb.get(`/api/agent/devices/${d.id}`);
    assert.equal(one.status, 200, one.text);
    const u = one.json.data.update;
    assert.equal(u.phase, 'failed');
    assert.equal(u.lastError, 'timeout');
    assert.equal(u.attempts, 3);
    assert.equal(u.targetVersion, SERVED);
    assert.ok(!Number.isNaN(Date.parse(u.updatedAt)), 'updatedAt is a date');
    assert.equal(Date.parse(one.json.data.lastSeenAt), seen.getTime());

    const list = await mb.get('/api/agent/devices');
    const row = (list.json.data as Array<{ id: number; update?: { phase: string } }>).find((r) => r.id === d.id);
    assert.equal(row?.update?.phase, 'failed', 'the list carries the attempt too (agent table badge)');

    const dist = await mb.get('/api/agent/devices/versions');
    assert.ok(dist.json.data.updateFailed >= 1, 'dashboard / strip failed counter');
    assert.ok(Array.isArray(dist.json.data.missingBuilds));
    const ver = await mb.get('/api/agent/version');
    assert.ok(Array.isArray(ver.json.missingBuilds), 'banner source');

    // An admin edit (rename) must not look like contact.
    const admin = await h.adminIn(2);
    assert.equal((await admin.patch(`/api/agent/devices/${d.id}`, { name: 'renamed-46c' })).status, 200);
    const after = await mb.get(`/api/agent/devices/${d.id}`);
    assert.equal(Date.parse(after.json.data.lastSeenAt), seen.getTime(), 'lastSeenAt unchanged by an admin edit');

    // Retry (the badge button): attempt back to 'offered', reason cleared.
    const r = await mb.post(`/api/agent/devices/${d.id}/update/retry`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.update.phase, 'offered');
    assert.equal(r.json.data.update.lastError, null);
    assert.equal(r.json.data.update.attempts, 0);
  });
});
