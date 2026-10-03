/**
 * 55 — W4-5 rate limits delivered to agents end to end (BROKEN-9,
 * FLEET-AGENT-5, UI-PAGES-IPS-18):
 *   - the WS config frame carries rateLimits: with the global switch
 *     app_config 'rateLimitEnforcement' off (default) [] once per channel,
 *     then nothing; with it on, the enabled policies on every frame;
 *   - the legacy HTTP push follows the same switch;
 *   - PATCH /rate-limit-policies/:id edits a policy (enabled toggle included)
 *     with the create rules and the tenant ownership of the target;
 *   - GET/PUT /rate-limit-policies/enforcement (write: platform admin on Default);
 *   - the agent decodes rateLimits as absent (unchanged) vs [] (clear), and
 *     advertises 'ratelimit' only when its backend enforces limits
 *     (agent/cmd_ws_ratelimit_test.go, run when a Go toolchain is available).
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { startHarness, waitFor, FakeWs } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';

const REPO = path.resolve(__dirname, '..', '..', '..');
const AGENT = path.join(REPO, 'agent');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '');

function goAvailable(): boolean {
  return spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
}

describe('55 rate-limit delivery (W4-5)', () => {
  let h: Harness;
  const fakes: FakeWs[] = [];
  let maxSeq = 55_000;
  const uniqMax = () => ++maxSeq;

  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });
  afterEach(async () => {
    for (const f of fakes.splice(0)) { try { f.close(); } catch { /* ignore */ } }
    // Every check starts from the default switch position.
    await (await h.adminIn(1)).put('/api/rate-limit-policies/enforcement', { enforcement: 'off' });
  });

  const heartbeat = (hostname: string) => ({
    type: 'heartbeat', hostname, agentVersion: '1.0.0',
    osInfo: { platform: 'linux', distro: 'verify', release: '1', arch: 'x64' },
    services: [], firewallBanned: [], firewallName: 'nftables', lanIPs: [], capabilities: ['ratelimit'],
  });

  /** Registers a FakeWs for an approved tenant-B agent. */
  async function connect(): Promise<{ id: number; uuid: string; hostname: string; w: FakeWs }> {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const w = new FakeWs();
    fakes.push(w);
    assert.equal(await obliguardHub.register(d.uuid, 2, 2, '127.0.0.1', w as any), true);
    return { ...d, w };
  }

  /** Sends a heartbeat and returns the config frame it produced. */
  async function beat(c: { hostname: string; w: FakeWs }): Promise<Record<string, unknown>> {
    const before = c.w.sent.filter((m) => m.type === 'config').length;
    c.w.receive(heartbeat(c.hostname));
    return waitFor(() => {
      const configs = c.w.sent.filter((m) => m.type === 'config');
      return configs.length > before ? configs[configs.length - 1] : null;
    }, 5000);
  }

  async function agentPolicy(deviceId: number, over: Record<string, unknown> = {}): Promise<{ id: number; maxValue: number }> {
    const maxValue = uniqMax();
    const r = await (await h.adminIn(2)).post('/api/rate-limit-policies', {
      type: 'rate', scope: 'agent', scopeId: deviceId, maxValue, port: 22, ...over,
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return { id: r.json.data.id, maxValue };
  }

  const maxValues = (frame: Record<string, unknown>) =>
    ((frame.rateLimits ?? []) as Array<{ maxValue: number }>).map((r) => r.maxValue);

  lotIt('W4-5', '55.1 enforcement off (default): [] once per channel, then the field is omitted', async () => {
    const c = await connect();
    const p = await agentPolicy(c.id);

    const enf = await (await h.as('member_b')).get('/api/rate-limit-policies/enforcement');
    assert.equal(enf.status, 200);
    assert.equal(enf.json.data.enforcement, 'off', 'the switch defaults to off');

    const f1 = await beat(c);
    assert.ok('rateLimits' in f1, 'the first frame clears what an earlier session applied');
    assert.deepEqual(f1.rateLimits, []);
    const f2 = await beat(c);
    assert.ok(!('rateLimits' in f2), 'then nothing: the agent keeps its (cleared) state');
    const f3 = await beat(c);
    assert.ok(!('rateLimits' in f3));

    // A new channel (agent restart) gets the clear again.
    const w2 = new FakeWs();
    fakes.push(w2);
    await obliguardHub.register(c.uuid, 2, 2, '127.0.0.1', w2 as any);
    const f4 = await beat({ hostname: c.hostname, w: w2 });
    assert.deepEqual(f4.rateLimits, []);

    // The legacy HTTP push follows the switch: nothing delivered.
    const push = await h.push(2, c.uuid, { hostname: c.hostname });
    assert.equal(push.status, 200);
    assert.ok(!maxValues(push.json).includes(p.maxValue), 'a dormant policy must not reach the HTTP push either');
  });

  lotIt('W4-5', '55.2 enforcement on: enabled policies on every frame; off again: [] once', async () => {
    const c = await connect();
    const on = await agentPolicy(c.id);
    const off = await agentPolicy(c.id, { port: 2222, enabled: false });

    assert.deepEqual((await beat(c)).rateLimits, []);

    const put = await (await h.adminIn(1)).put('/api/rate-limit-policies/enforcement', { enforcement: 'on' });
    assert.equal(put.status, 200);
    assert.equal(put.json.data.enforcement, 'on');
    assert.equal((await h.db('app_config').where({ key: 'rateLimitEnforcement' }).first())?.value, 'on');

    for (let i = 0; i < 2; i++) {
      const f = await beat(c);
      assert.ok(Array.isArray(f.rateLimits), 'the list rides every frame while enforcement is on');
      const values = maxValues(f);
      assert.ok(values.includes(on.maxValue), 'the enabled policy is delivered');
      assert.ok(!values.includes(off.maxValue), 'a disabled policy is never delivered');
      const rule = (f.rateLimits as Array<Record<string, unknown>>).find((r) => r.maxValue === on.maxValue)!;
      assert.deepEqual(rule, { type: 'rate', port: 22, maxValue: on.maxValue, banMultiplier: null, action: 'drop', banTtlSeconds: null });
    }

    const push = await h.push(2, c.uuid, { hostname: c.hostname });
    assert.ok(maxValues(push.json).includes(on.maxValue), 'the HTTP push delivers too');

    await (await h.adminIn(1)).put('/api/rate-limit-policies/enforcement', { enforcement: 'off' });
    const g1 = await beat(c);
    assert.deepEqual(g1.rateLimits, [], 'switching off clears the agents once');
    const g2 = await beat(c);
    assert.ok(!('rateLimits' in g2));
  });

  lotIt('W4-5', '55.3 PATCH edits a policy and toggles enabled (delivery follows)', async () => {
    const c = await connect();
    const p = await agentPolicy(c.id);
    await (await h.adminIn(1)).put('/api/rate-limit-policies/enforcement', { enforcement: 'on' });
    const admin = await h.adminIn(2);

    assert.ok(maxValues(await beat(c)).includes(p.maxValue));

    const r1 = await admin.patch(`/api/rate-limit-policies/${p.id}`, { enabled: false });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.data.enabled, false);
    assert.equal(r1.json.data.maxValue, p.maxValue, 'unsent fields are kept');
    assert.equal((await h.db('rate_limit_policies').where({ id: p.id }).first()).enabled, false);
    const f1 = await beat(c);
    assert.ok(Array.isArray(f1.rateLimits));
    assert.ok(!maxValues(f1).includes(p.maxValue), 'a disabled policy stops being delivered');

    const newMax = uniqMax();
    const r2 = await admin.patch(`/api/rate-limit-policies/${p.id}`, {
      enabled: true, maxValue: newMax, action: 'reject', banMultiplier: 10, banTtlSeconds: 600,
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.data.maxValue, newMax);
    const rule = (await beat(c)).rateLimits as Array<Record<string, unknown>>;
    assert.ok(rule.some((r) => r.maxValue === newMax && r.action === 'reject' && r.banMultiplier === 10 && r.banTtlSeconds === 600));

    // Explicit null clears an optional field.
    const r3 = await admin.patch(`/api/rate-limit-policies/${p.id}`, { banMultiplier: null, port: null });
    assert.equal(r3.status, 200);
    assert.equal(r3.json.data.banMultiplier, null);
    assert.equal(r3.json.data.port, null);

    // Same validation as create; nothing is written on a refusal.
    for (const bad of [
      { maxValue: 1.5 }, { maxValue: 0 }, { maxValue: 'x' }, { port: 70000 }, { type: 'bogus' },
      { action: 'shape' }, { type: 'volume', action: 'reject' }, { banMultiplier: 1 }, { banTtlSeconds: -5 },
      { enabled: 'yes' }, { scope: 'group' },
    ]) {
      const r = await admin.patch(`/api/rate-limit-policies/${p.id}`, bad);
      assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${r.status}`);
    }
    const row = await h.db('rate_limit_policies').where({ id: p.id }).first();
    assert.equal(row.max_value, newMax);
    assert.equal(row.type, 'rate');

    assert.equal((await admin.patch('/api/rate-limit-policies/999999', { enabled: false })).status, 404);
    assert.equal((await admin.patch('/api/rate-limit-policies/abc', { enabled: false })).status, 400);
    // Owner decision 12 (_defaults.txt): the 'user' set (member_b) keeps
    // rate_limit.write since the W7-2 re-gating; the read-only viewer is refused.
    assert.equal((await (await h.as('viewer_b')).patch(`/api/rate-limit-policies/${p.id}`, { enabled: false })).status, 403);

    // The create path validates the same way.
    const bad = await admin.post('/api/rate-limit-policies', { type: 'rate', scope: 'agent', scopeId: c.id, maxValue: 2.5 });
    assert.equal(bad.status, 400);
    for (const scopeId of [true, 'abc', 1.5, -1]) {
      const r = await admin.post('/api/rate-limit-policies', { type: 'rate', scope: 'agent', scopeId, maxValue: 5 });
      assert.equal(r.status, 400, `scopeId ${JSON.stringify(scopeId)} → ${r.status}`);
    }

    // A row stored before these rules (action unfit for its type, limit out of
    // bounds) can still be disabled, but not re-enabled or edited as is.
    const [legacy] = await h.db('rate_limit_policies').insert({
      type: 'rate', scope: 'agent', scope_id: c.id, tenant_id: 2, enabled: true,
      port: 2223, max_value: 5_000_000, action: 'shape',
    }).returning('id');
    const legacyId = typeof legacy === 'object' ? legacy.id : legacy;
    const d1 = await admin.patch(`/api/rate-limit-policies/${legacyId}`, { enabled: false });
    assert.equal(d1.status, 200, JSON.stringify(d1.json));
    assert.equal((await h.db('rate_limit_policies').where({ id: legacyId }).first()).enabled, false);
    assert.equal((await admin.patch(`/api/rate-limit-policies/${legacyId}`, { enabled: true })).status, 400);
    assert.equal((await (await h.adminIn(3)).patch(`/api/rate-limit-policies/${legacyId}`, { enabled: false })).status, 404,
      'the disable shortcut keeps the ownership check');
  });

  lotIt('W4-5', '55.4 tenant ownership on PATCH: foreign target 403, foreign row 403/404', async () => {
    const g2 = await createGroup(h.db, { tenantId: 2 });
    const g3 = await createGroup(h.db, { tenantId: 3 });
    const gDefault = await createGroup(h.db, { tenantId: 1 });
    const def = await h.adminIn(1);
    const b = await h.adminIn(2);
    const cAdmin = await h.adminIn(3);

    // Default retargets its own policy onto a tenant-B group: refused (403).
    const mine = await def.post('/api/rate-limit-policies', { type: 'connection', scope: 'group', scopeId: gDefault, maxValue: uniqMax() });
    assert.equal(mine.status, 201);
    const r1 = await def.patch(`/api/rate-limit-policies/${mine.json.data.id}`, { scopeId: g2 });
    assert.equal(r1.status, 403);
    assert.equal((await h.db('rate_limit_policies').where({ id: mine.json.data.id }).first()).scope_id, gDefault);

    // Tenant B retargets its policy onto a tenant-C group: refused, unchanged.
    const bp = await b.post('/api/rate-limit-policies', { type: 'connection', scope: 'group', scopeId: g2, maxValue: uniqMax() });
    assert.equal(bp.status, 201);
    const r2 = await b.patch(`/api/rate-limit-policies/${bp.json.data.id}`, { scopeId: g3 });
    assert.ok([403, 404].includes(r2.status), `got ${r2.status}`);
    assert.equal((await h.db('rate_limit_policies').where({ id: bp.json.data.id }).first()).scope_id, g2);

    // Another tenant's row: 403 from Default (read-only god view), 404 elsewhere.
    const r3 = await def.patch(`/api/rate-limit-policies/${bp.json.data.id}`, { enabled: false });
    assert.equal(r3.status, 403);
    const r4 = await cAdmin.patch(`/api/rate-limit-policies/${bp.json.data.id}`, { enabled: false });
    assert.equal(r4.status, 404);
    assert.equal((await h.db('rate_limit_policies').where({ id: bp.json.data.id }).first()).enabled, true);

    // Global policies: edited from Default only; a tenant cannot make one global.
    const gp = await def.post('/api/rate-limit-policies', { type: 'connection', scope: 'global', maxValue: uniqMax() });
    assert.equal(gp.status, 201);
    assert.equal((await b.patch(`/api/rate-limit-policies/${gp.json.data.id}`, { enabled: false })).status, 403);
    assert.equal((await b.patch(`/api/rate-limit-policies/${bp.json.data.id}`, { scope: 'global' })).status, 403);
    const ok = await def.patch(`/api/rate-limit-policies/${gp.json.data.id}`, { enabled: false });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.enabled, false);
  });

  lotIt('W4-5', '55.5 the enforcement switch is written by the platform admin on Default only', async () => {
    assert.equal((await (await h.adminIn(2)).put('/api/rate-limit-policies/enforcement', { enforcement: 'on' })).status, 403);
    assert.equal((await (await h.as('default_member')).put('/api/rate-limit-policies/enforcement', { enforcement: 'on' })).status, 403);
    assert.equal((await h.anon().put('/api/rate-limit-policies/enforcement', { enforcement: 'on' })).status, 401);
    for (const bad of [{ enforcement: 'yes' }, { enforcement: true }, {}]) {
      assert.equal((await (await h.adminIn(1)).put('/api/rate-limit-policies/enforcement', bad)).status, 400);
    }
    assert.notEqual((await h.db('app_config').where({ key: 'rateLimitEnforcement' }).first())?.value, 'on');
    assert.equal((await (await h.as('member_c')).get('/api/rate-limit-policies/enforcement')).json.data.enforcement, 'off');

    // Enforcement on with only a disabled policy: an empty list, never the policy.
    const c = await connect();
    await agentPolicy(c.id, { enabled: false });
    await (await h.adminIn(1)).put('/api/rate-limit-policies/enforcement', { enforcement: 'on' });
    assert.deepEqual((await beat(c)).rateLimits, []);
  });

  lotIt('W4-5', '55.6 agent: pointer decoding, capability, Windows not advertised', () => {
    const cmd = read('agent/cmd_ws.go');
    assert.match(cmd, /RateLimits \*\[\]RateLimitRule\s+`json:"rateLimits,omitempty"`/, 'absent must be distinguishable from []');
    assert.doesNotMatch(cmd, /fw\.ApplyRateLimits\(msg\.RateLimits\)/, 'the old unconditional apply cleared limits on every heartbeat');
    assert.match(cmd, /applyRateLimitsFrame\(cfg, fw, msg\.RateLimits\)/);
    assert.match(cmd, /capRateLimit = "ratelimit"/);
    let caps = /Capabilities:\s*(.*)/.exec(cmd)?.[1] ?? '';
    // W14-1 moved the list into heartbeatCapabilities(fw): follow the helper.
    if (/heartbeatCapabilities\(fw\)/.test(caps)) {
      caps = /func heartbeatCapabilities\(fw FirewallManager\) \[\]string \{([\s\S]*?)\n\}/.exec(cmd)?.[1] ?? '';
    }
    assert.match(caps, /rateLimitCapabilities\(fw\)\.\.\./);

    const win = read('agent/firewall_ratelimit_windows.go');
    assert.match(win, /func \(f \*WindowsFirewall\) IsRateLimitSupported\(\) bool\s*\{ return false \}/);
    assert.doesNotMatch(win, /WinDivertOpen|LoadDLL/, 'no WinDivert (owner decision 23)');
  });

  lotIt('W4-5', '55.7 go test of the rate-limit frame handling', (t) => {
    if (!goAvailable()) {
      t.skip('Go toolchain not available');
      return;
    }
    const res = spawnSync('go', ['test', '-count=1', '-run', 'RateLimit', './'], { cwd: AGENT, encoding: 'utf8', timeout: 200_000 });
    assert.equal(res.status, 0, `go test failed:\n${res.stdout}\n${res.stderr}`);
  }, { timeout: 220_000 });
});
