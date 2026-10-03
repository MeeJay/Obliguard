/**
 * 57 — W4 integration (W4-6): the followups of the W4 lots applied at
 * integration time.
 *   - events whose IP is not a literal address (older agents) are dropped one
 *     by one instead of failing the whole ip_events batch (legacy push and
 *     the WS events flush); ::ffff:a.b.c.d is folded to IPv4;
 *   - a failed rate-limit resolution omits rateLimits from the push response
 *     (absent = the agent keeps its limits) instead of sending [] (clear);
 *   - force_2fa: the socket of an account without a factor joins only its
 *     own user room, never tenant / general rooms;
 *   - source checks: the client re-syncs the session on 403
 *     twoFactorSetupRequired, the agent validates Event Log addresses, exempts
 *     the protected addresses from iptables/ufw rate limiting and starts the
 *     uninstall script in its own process group.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createUser } from '../seed';
import { agentService, normalizeEventIp } from '../../src/services/agent.service';
import { rateLimitPolicyService } from '../../src/services/rateLimitPolicy.service';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '');

describe('57 W4 integration (W4-6)', () => {
  let h: Harness;

  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const ipsOf = async (deviceId: number): Promise<string[]> =>
    ((await h.db('ip_events').where({ device_id: deviceId }).select('ip')) as Array<{ ip: string }>)
      .map((r) => String(r.ip)).sort();

  lotIt('W4-6', '57.1 normalizeEventIp keeps literal addresses only', () => {
    assert.equal(normalizeEventIp('198.51.100.7'), '198.51.100.7');
    assert.equal(normalizeEventIp(' ::ffff:198.51.100.7 '), '198.51.100.7');
    assert.equal(normalizeEventIp('[2001:DB8::1]'), '2001:db8::1');
    for (const bad of ['not-an-ip', '-', '', '198.51.100.0/24', 'host.example.com', '999.1.1.1', null, 42]) {
      assert.equal(normalizeEventIp(bad), null, `accepted ${String(bad)}`);
    }
  });

  lotIt('W4-6', '57.2 legacy push: one bad event IP does not drop the batch', async () => {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const svc = { service: 'custom:verify' };
    const r = await h.push(2, d.uuid, {
      events: [
        h.event('not-an-ip', svc),
        h.event('::ffff:198.51.100.21', svc),
        h.event('198.51.100.22', svc),
        h.event('198.51.100.0/24', svc),
      ],
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(await ipsOf(d.id), ['198.51.100.21', '198.51.100.22']);
  });

  lotIt('W4-6', '57.3 WS events flush: one bad event IP does not drop the batch', async () => {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const ev = (ip: string) => h.event(ip, { service: 'custom:verify' }) as any;
    await agentService.processEventsFlush(d.id, 2, [ev('bogus'), ev('198.51.100.31'), ev('::ffff:198.51.100.32')]);
    assert.deepEqual(await ipsOf(d.id), ['198.51.100.31', '198.51.100.32']);
  });

  lotIt('W4-6', '57.4 push: rateLimits omitted when the resolution fails', async () => {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const ok = await h.push(2, d.uuid);
    assert.equal(ok.status, 200, ok.text);
    assert.ok(Array.isArray(ok.json?.rateLimits), 'a resolved list (here []) is sent');

    const orig = rateLimitPolicyService.resolveForAgent;
    rateLimitPolicyService.resolveForAgent = (async () => { throw new Error('verify: transient failure'); }) as typeof orig;
    try {
      const failed = await h.push(2, d.uuid);
      assert.equal(failed.status, 200, failed.text);
      assert.ok(!('rateLimits' in (failed.json ?? {})), 'absent field: the agent keeps its limits');
    } finally {
      rateLimitPolicyService.resolveForAgent = orig;
    }
  });

  lotIt('W4-6', '57.5 force_2fa: the socket joins no tenant room until a factor exists', async () => {
    await h.db('app_config').insert({ key: 'force_2fa', value: 'true' }).onConflict('key').merge({ value: 'true' });
    try {
      const u = await createUser(h.db, { tenants: [2] });
      const c = await h.login(u.username);
      assert.equal((await h.socket(c)).ok, true);
      const rooms = await h.roomsOf(u.id);
      assert.ok(rooms.includes(`user:${u.id}`), `rooms: ${rooms.join(',')}`);
      for (const r of rooms) {
        assert.ok(r === `user:${u.id}` || !/^(tenant:|general$|role:)/.test(r), `must not join ${r}`);
      }
    } finally {
      await h.db('app_config').where({ key: 'force_2fa' }).update({ value: 'false' });
    }
    // Without the flag the same kind of account joins its tenant rooms.
    const v = await createUser(h.db, { tenants: [2] });
    assert.equal((await h.socket(await h.login(v.username))).ok, true);
    const rooms = await h.roomsOf(v.id);
    for (const r of ['tenant:2', 'general']) assert.ok(rooms.includes(r), `missing ${r}: ${rooms.join(',')}`);
  });

  lotIt('W4-6', '57.6 source checks: client resync, agent address and process-group handling', () => {
    const client = read('client/src/api/client.ts');
    assert.equal((client.match(/twoFactorSetupRequired/g) ?? []).length >= 2, true, 'axios interceptor and tenantFetch');
    assert.match(read('client/src/store/authStore.ts'), /reason === 'twoFactorSetupRequired' && s\.requires2faSetup/);

    assert.match(read('agent/eventlog_windows.go'), /if ip = cleanIP\(ip\); ip == "" \{/);
    const ipt = read('agent/firewall_iptables.go');
    assert.match(ipt, /"-A", iptRLChain, "-s", addr, "-j", "RETURN"/);
    assert.match(read('agent/firewall_ufw.go'), /func \(f \*UFWFirewall\) SetRateLimitExempt/);
    assert.match(ipt, /func \(f \*IptablesFirewall\) SetRateLimitExempt/);

    const un = read('agent/uninstall.go');
    assert.equal((un.match(/detachCmd\(cmd\)/g) ?? []).length, 3, 'linux, darwin, freebsd');
    assert.match(read('agent/detach_unix.go'), /Setpgid = true/);
    assert.doesNotMatch(read('agent/firewall_wfp_windows.go'), /winRL|winDivertDLLPath/);
    assert.match(read('agent/push.go'), /RateLimits \*\[\]RateLimitRule/);
  });
});
