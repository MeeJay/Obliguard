/**
 * 09 — agent update policy (C17): auto / manual / off, precedence, "Update
 * now", anonymous /api/agent/version, WS config frames.
 *
 * Owner decisions (wave 1): default policy 'manual' at deployment (09.0,
 * which runs FIRST on the fresh clone, before any reset() — reset() sets
 * 'auto'); 'off' is ABSOLUTE at any level;
 * nearest-wins between auto/manual; "Update now" (device or group) is open to
 * members of the operating tenant holding monitor_rw; group and global
 * policies stay platform-admin only, the global one from Default only.
 *
 * All checks go through adapters.updatePolicy, filled by C17.
 */
import { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, FakeWs } from '../harness';
import type { Harness, Res } from '../harness';
import { adapterIt } from '../lots';
import { adapters } from '../adapters';
import type { UpdatePolicyAdapter } from '../adapters';
import { createDevice } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';

const RELEASE = '99.0.0';
/** Past C17's 10-min per-device offer throttle. */
const PAST_THROTTLE_MS = 11 * 60_000;
const ok2xx = (r: Res) => r.status >= 200 && r.status < 300;

describe('09 update policy', () => {
  let h: Harness;
  const sockets: FakeWs[] = [];
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  // 09.0 must observe the migrated default: the first test skips reset().
  let pristine = true;
  beforeEach(async () => {
    const a = adapters.updatePolicy;
    if (!a) return;
    if (pristine) pristine = false;
    else await a.reset();
    a.setReleasedVersion(RELEASE);
  });
  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.close();
  });

  const advertised = async (keyTenant: 1 | 2 | 3, uuid: string) => (await h.push(keyTenant, uuid)).json?.latestVersion === RELEASE;
  const heartbeat = { type: 'heartbeat', hostname: 'host-b', agentVersion: '1.0.0', services: [], firewallBanned: [], firewallName: 'verify', lanIPs: [] };
  const configFrames = (ws: FakeWs) => ws.sent.filter((f) => f?.type === 'config');
  const waitFrames = async (ws: FakeWs, n: number) => {
    const deadline = Date.now() + 3000;
    while (configFrames(ws).length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  };

  adapterIt('C17', adapters.updatePolicy, '09.0 default policy after migration is manual: nothing advertised to the fleet', async () => {
    // Fresh clone, no reset(), only a released version newer than every agent.
    assert.equal(await advertised(2, 'dev-b-0001'), false, 'push advertised the release under the default policy');
    assert.equal(await advertised(3, 'dev-c-0001'), false, 'push advertised the release under the default policy');
    const r = await h.anon().get('/api/agent/version');
    assert.ok(r.status !== 200 || r.json?.version !== RELEASE, 'anonymous /api/agent/version advertised the release');
  });

  adapterIt('C17', adapters.updatePolicy, '09.1 global auto advertises the release', async (a: UpdatePolicyAdapter) => {
    assert.ok(ok2xx(await a.setGlobal(await h.adminIn(1), 'auto')));
    assert.equal(await advertised(2, 'dev-b-0001'), true);
  });

  adapterIt('C17', adapters.updatePolicy, '09.2 global off / manual advertise nothing', async (a: UpdatePolicyAdapter) => {
    const admin = await h.adminIn(1);
    assert.ok(ok2xx(await a.setGlobal(admin, 'off')));
    assert.equal(await advertised(2, 'dev-b-0001'), false);
    assert.ok(ok2xx(await a.setGlobal(admin, 'manual')));
    assert.equal(await advertised(2, 'dev-b-0001'), false);
  });

  adapterIt('C17', adapters.updatePolicy, '09.3 precedence: off is absolute, otherwise nearest wins', async (a: UpdatePolicyAdapter) => {
    assert.ok(ok2xx(await a.setGlobal(await h.adminIn(1), 'auto')));
    const b = await h.adminIn(2);
    assert.ok(ok2xx(await a.setGroup(b, 2, 'off')));
    assert.equal(await advertised(2, 'dev-b-0001'), false);
    assert.equal(await advertised(3, 'dev-c-0001'), true);
    assert.ok(ok2xx(await a.setDevice(b, 2, 'auto')));
    assert.equal(await advertised(2, 'dev-b-0001'), false, "device 'auto' must not override group 'off'");
    assert.ok(ok2xx(await a.setGroup(b, 2, 'manual')));
    assert.equal(await advertised(2, 'dev-b-0001'), true, "device 'auto' overrides group 'manual'");
  });

  adapterIt('C17', adapters.updatePolicy, '09.4a update now on a device is one-shot', async (a: UpdatePolicyAdapter) => {
    assert.ok(ok2xx(await a.setGlobal(await h.adminIn(1), 'manual')));
    assert.ok(ok2xx(await a.updateNow(await h.adminIn(2), 2)));
    assert.equal(await advertised(2, 'dev-b-0001'), true);
    // "One-shot" per push: the next offer waits for the 10-min per-device
    // throttle (the request itself allows up to 3 offers, see suite 31).
    assert.equal(await advertised(2, 'dev-b-0001'), false);
    assert.equal(await advertised(2, 'dev-b-eval-0001'), false);
  });

  adapterIt('C17', adapters.updatePolicy, '09.4b update now on a group targets that group only', async (a: UpdatePolicyAdapter) => {
    assert.ok(ok2xx(await a.setGlobal(await h.adminIn(1), 'manual')));
    assert.ok(ok2xx(await a.updateNowGroup(await h.adminIn(2), 2)));
    assert.equal(await advertised(2, 'dev-b-0001'), true);
    assert.equal(await advertised(2, 'dev-b-eval-0001'), false);
  });

  adapterIt('C17', adapters.updatePolicy, '09.5 the WS heartbeat path applies the policy', async (a: UpdatePolicyAdapter) => {
    const admin = await h.adminIn(1);
    assert.ok(ok2xx(await a.setGlobal(admin, 'off')));
    const ws = new FakeWs();
    sockets.push(ws);
    await obliguardHub.register('dev-b-0001', 2, 2, '127.0.0.1', ws as any);
    ws.receive(heartbeat);
    await waitFrames(ws, 1);
    assert.ok(configFrames(ws).length >= 1);
    assert.equal(configFrames(ws)[0].latestVersion, undefined);
    assert.ok(ok2xx(await a.setGlobal(admin, 'auto')));
    const n = configFrames(ws).length;
    ws.receive(heartbeat);
    await waitFrames(ws, n + 1);
    assert.equal(configFrames(ws).at(-1)?.latestVersion, RELEASE);
  });

  adapterIt('C17', adapters.updatePolicy, '09.6 authorisation of policy writes and update now', async (a: UpdatePolicyAdapter) => {
    const mb = await h.as('member_b');
    const dm = await h.as('default_member');
    assert.ok(ok2xx(await a.setGlobal(await h.adminIn(1), 'off')));
    // Tenant members (monitor_rw) may request an update on their own agent,
    // but global 'off' is absolute.
    await a.updateNow(mb, 2);
    assert.equal(await advertised(2, 'dev-b-0001'), false);
    await a.setDevice(mb, 2, 'auto');
    assert.equal(await advertised(2, 'dev-b-0001'), false);
    // Group and global policies are platform-admin only.
    assert.equal((await a.setGroup(mb, 2, 'auto')).status, 403);
    assert.equal((await a.setGlobal(mb, 'auto')).status, 403);
    // Foreign devices / groups.
    assert.ok([403, 404].includes((await a.updateNow(mb, 3)).status));
    assert.ok([403, 404].includes((await a.updateNowGroup(mb, 3)).status));
    // God view is read-only; global only from Default.
    assert.equal((await a.setGlobal(dm, 'auto')).status, 403);
    assert.ok([403, 404].includes((await a.updateNow(dm, 2)).status));
    assert.equal((await a.setGlobal(await h.adminIn(2), 'auto')).status, 403);
    assert.equal(await advertised(3, 'dev-c-0001'), false);
  });

  adapterIt('C17', adapters.updatePolicy, '09.6b update now is open to operating-tenant members holding monitor_rw', async (a: UpdatePolicyAdapter) => {
    // member_b's 'member' membership of tenant 2 grants monitor_rw
    // (permission.service getUserCapabilities).
    const mb = await h.as('member_b');
    assert.ok(ok2xx(await a.setGlobal(await h.adminIn(1), 'manual')));
    const r1 = await a.updateNow(mb, 2);
    assert.ok(ok2xx(r1), `updateNow by member_b answered ${r1.status}`);
    assert.equal(await advertised(2, 'dev-b-0001'), true);
    assert.equal(await advertised(2, 'dev-b-0001'), false, 'update now is one-shot');
    // Second half: past the first offer's 10-min throttle (not reset by a re-click).
    a.advanceClock?.(PAST_THROTTLE_MS);
    const r2 = await a.updateNowGroup(mb, 2);
    assert.ok(ok2xx(r2), `updateNowGroup by member_b answered ${r2.status}`);
    assert.equal(await advertised(2, 'dev-b-0001'), true);
    assert.equal(await advertised(2, 'dev-b-eval-0001'), false);
  });

  adapterIt('C17', adapters.updatePolicy, '09.7 device commands are allow-listed', async () => {
    const t = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const r = await (await h.adminIn(2)).post(`/api/agent/devices/${t.id}/command`, { command: 'reboot' });
    assert.equal(r.status, 400);
    assert.equal((await h.db('agent_devices').where({ id: t.id }).first()).pending_command, null);
  });

  adapterIt('C17', adapters.updatePolicy, '09.8 version distribution is tenant-scoped (god view for Default)', async (a: UpdatePolicyAdapter) => {
    const rb = await a.versionDistribution(await h.as('member_b'));
    if (rb.status !== 403) {
      assert.equal(rb.status, 200);
      const versions = (rb.json.data as Array<{ version: string }>).map((x) => x.version);
      assert.ok(versions.every((v) => v === '1.0.0'), versions.join(','));
    }
    const rd = await a.versionDistribution(await h.as('default_member'));
    if (rd.status !== 403) {
      assert.equal(rd.status, 200);
      assert.ok((rd.json.data as Array<{ version: string }>).some((x) => x.version === '0.9.0'));
    }
  });

  adapterIt('C17', adapters.updatePolicy, '09.9 anonymous /api/agent/version never advertises past a non-auto policy', async (a: UpdatePolicyAdapter) => {
    const notAdvertised = async () => {
      const r = await h.anon().get('/api/agent/version');
      return r.status !== 200 || r.json?.version !== RELEASE;
    };
    const admin = await h.adminIn(1);
    assert.ok(ok2xx(await a.setGlobal(admin, 'manual')));
    assert.ok(await notAdvertised(), "global 'manual'");
    assert.ok(ok2xx(await a.setGlobal(admin, 'off')));
    assert.ok(await notAdvertised(), "global 'off'");
    assert.ok(ok2xx(await a.setGlobal(admin, 'auto')));
    assert.ok(ok2xx(await a.setGroup(await h.adminIn(2), 2, 'off')));
    assert.ok(await notAdvertised(), "group 'off'");
    assert.ok(ok2xx(await a.setGroup(await h.adminIn(2), 2, null)));
    assert.ok(ok2xx(await a.setDevice(await h.adminIn(3), 3, 'manual')));
    assert.ok(await notAdvertised(), "device 'manual'");
  });

  adapterIt('C17', adapters.updatePolicy, '09.10 update now survives the WS drain frame', async (a: UpdatePolicyAdapter) => {
    assert.ok(ok2xx(await a.setGlobal(await h.adminIn(1), 'manual')));
    assert.ok(ok2xx(await a.updateNow(await h.adminIn(2), 2)));
    const ws = new FakeWs();
    sockets.push(ws);
    await obliguardHub.register('dev-b-0001', 2, 2, '127.0.0.1', ws as any);
    ws.receive(heartbeat);
    await waitFrames(ws, 2);
    const frames = configFrames(ws);
    assert.ok(frames.some((f) => f.latestVersion === RELEASE));
    for (const f of frames.filter((x) => x.command === 'update')) assert.equal(f.latestVersion, RELEASE);
    const n = frames.length;
    ws.receive(heartbeat);
    await waitFrames(ws, n + 1);
    assert.equal(configFrames(ws).at(-1)?.latestVersion, undefined);
  });
});
