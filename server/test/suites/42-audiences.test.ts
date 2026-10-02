/**
 * 42 — realtime audiences (W1-3): agent activity, presence transitions, ban
 * exclusions and group events reach the owning tenant and Default only; a
 * MikroTik full sync follows the router's tenant (A3).
 * Sentinels only, no timed waits.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, waitFor, hostOf } from '../harness';
import type { Harness, RecordedEvent } from '../harness';
import { lotIt } from '../lots';
import { nextIp, insertBan, createMikrotikDevice } from '../seed';
import { setBanServiceIO } from '../../src/services/ban.service';
import { markAgentOffline } from '../../src/services/agent.service';
import { mikrotikBanSync } from '../../src/services/mikrotik/mikrotikBanSync.service';
import { RouterOSClient } from '../../src/services/mikrotik/routerosClient';
import { SOCKET_EVENTS } from '@obliview/shared';

type Rec = { events: RecordedEvent[] };

describe('42 realtime audiences', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
    // index.ts wires the ban service's io (W1-3); the shared harness mirror may lag.
    setBanServiceIO(h.io);
  });
  after(async () => { await h.close(); });

  const open = async (username: string): Promise<Rec> => {
    const s = await h.socket(await h.login(username));
    if (!s.ok) throw new Error(`socket for ${username}: ${s.error}`);
    return s;
  };
  const find = (r: Rec, event: string, pred: (p: any) => boolean) =>
    r.events.find((e) => e.event === event && pred(e.args[0]));
  const count = (r: Rec, event: string, pred: (p: any) => boolean) =>
    r.events.filter((e) => e.event === event && pred(e.args[0])).length;

  lotIt('W1-3', '42.1 another tenant never receives agent:pushHeartbeat / ip:flow; Default receives both', async () => {
    const mb = await open('member_b');
    const dm = await open('default_member');
    await h.push(3, 'dev-c-0001', { events: [h.event(nextIp(), { service: 'custom:verify' })] });
    await waitFor(() => find(dm, 'ip:flow', (p) => p?.deviceId === 3), 3000);
    await waitFor(() => find(dm, 'agent:pushHeartbeat', (p) => p?.deviceId === 3), 3000);
    // Sentinel: tenant B's own agent reaches member_b after tenant C's push.
    await h.push(2, 'dev-b-0001', { events: [h.event(nextIp(), { service: 'custom:verify' })] });
    const sentinel = await waitFor(() => find(mb, 'agent:pushHeartbeat', (p) => p?.deviceId === 2), 3000);
    await waitFor(() => find(mb, 'ip:flow', (p) => p?.deviceId === 2), 3000);
    const leaked = mb.events.filter((e) => e.seq < sentinel.seq
      && ['ip:flow', 'agent:pushHeartbeat', SOCKET_EVENTS.AGENT_STATUS_CHANGED].includes(e.event)
      && e.args[0]?.deviceId === 3);
    assert.deepEqual(leaked, []);
  });

  lotIt('W1-3', '42.2 AGENT_STATUS_CHANGED up is emitted on the transition only, not on every heartbeat', async () => {
    const mc = await open('member_c');
    markAgentOffline(3);
    for (let i = 0; i < 3; i++) {
      assert.equal((await h.push(3, 'dev-c-0001')).status, 200);
    }
    await waitFor(() => count(mc, 'agent:pushHeartbeat', (p) => p?.deviceId === 3) >= 3, 3000);
    const ups = count(mc, SOCKET_EVENTS.AGENT_STATUS_CHANGED, (p) => p?.deviceId === 3 && p?.status === 'up');
    assert.equal(ups, 1);
  });

  lotIt('W1-3', '42.3 a tenant exclusion is announced to that tenant and Default only', async () => {
    const mb = await open('member_b');
    const mc = await open('member_c');
    const dm = await open('default_member');
    const g = nextIp();
    const created = await (await h.adminIn(1)).post('/api/bans', { ip: g });
    assert.equal(created.status, 201);
    const banId = created.json.data.id as number;
    // A global ban reaches every tenant, without naming the origin.
    const seen = await waitFor(() => find(mb, 'ban:created', (p) => hostOf(p?.ip) === g), 3000);
    assert.equal(seen.args[0].originTenantId ?? null, null);
    assert.equal((await (await h.as('member_c')).del(`/api/bans/${banId}`)).status, 200);
    await waitFor(() => find(mc, 'ban:excluded', (p) => p?.banId === banId), 3000);
    await waitFor(() => find(dm, 'ban:excluded', (p) => p?.banId === banId), 3000);
    // Sentinel: a tenant-B ban reaches member_b after the exclusion.
    const s = nextIp();
    assert.equal((await (await h.as('member_b')).post('/api/bans', { ip: s })).status, 201);
    const sentinel = await waitFor(() => find(mb, 'ban:created', (p) => hostOf(p?.ip) === s), 3000);
    assert.ok(!mb.events.some((e) => e.seq < sentinel.seq && e.event === 'ban:excluded'));
    // The tenant-B ban itself never reaches tenant C.
    const s2 = nextIp();
    assert.equal((await (await h.as('member_c')).post('/api/bans', { ip: s2 })).status, 201);
    const sentinelC = await waitFor(() => find(mc, 'ban:created', (p) => hostOf(p?.ip) === s2), 3000);
    assert.ok(!mc.events.some((e) => e.seq < sentinelC.seq && e.event === 'ban:created' && hostOf(e.args[0]?.ip) === s));
  });

  lotIt('W1-3', '42.4 group events reach the owning tenant and Default only', async () => {
    const mb = await open('member_b');
    const mc = await open('member_c');
    const dm = await open('default_member');
    const name = `w13-group-c-${Date.now()}`;
    const r = await (await h.adminIn(3)).post('/api/groups', { name, kind: 'agent' });
    assert.equal(r.status, 201);
    await waitFor(() => find(mc, 'group:created', (p) => p?.group?.name === name), 3000);
    await waitFor(() => find(dm, 'group:created', (p) => p?.group?.name === name), 3000);
    const nameB = `w13-group-b-${Date.now()}`;
    assert.equal((await (await h.adminIn(2)).post('/api/groups', { name: nameB, kind: 'agent' })).status, 201);
    const sentinel = await waitFor(() => find(mb, 'group:created', (p) => p?.group?.name === nameB), 3000);
    assert.ok(!mb.events.some((e) => e.seq < sentinel.seq && e.event === 'group:created' && e.args[0]?.group?.name === name));
  });

  lotIt('W1-3', '42.5 MikroTik fullSync follows the router tenant and never removes operator entries', async () => {
    const wanted = nextIp();     // global ban
    const excluded = nextIp();   // global ban excluded by tenant C
    const otherTenant = nextIp(); // tenant B local ban
    const stale = nextIp();      // tagged entry, no active ban
    const operator = nextIp();   // untagged operator entry, no ban
    await insertBan(h.db, { ip: wanted, scope: 'global', originTenantId: 1 });
    const exId = await insertBan(h.db, { ip: excluded, scope: 'global', originTenantId: 1 });
    await h.db('ip_ban_exclusions').insert({ ban_id: exId, tenant_id: 3 });
    await insertBan(h.db, { ip: otherTenant, scope: 'tenant', tenantId: 2, originTenantId: 2 });

    const listed = [
      { id: '*1', address: stale, comment: 'Obliguard auto-ban' },
      { id: '*2', address: operator, comment: 'office VPN' },
    ];
    const calls: Array<{ action: string; arg: string }> = [];
    const proto = RouterOSClient.prototype as any;
    const saved: Record<string, unknown> = {};
    for (const k of ['connect', 'login', 'banIP', 'unbanIP', 'getBannedIPs', 'sendCommand', 'close']) saved[k] = proto[k];
    proto.connect = async () => { /* spy */ };
    proto.login = async () => { /* spy */ };
    proto.close = () => { /* spy */ };
    proto.banIP = async (ip: string) => { calls.push({ action: 'ban', arg: ip }); };
    proto.unbanIP = async (ip: string) => { calls.push({ action: 'unban', arg: ip }); };
    proto.getBannedIPs = async () => listed.map((e) => e.address);
    proto.sendCommand = async (words: string[]) => {
      if (words[0] === '/ip/firewall/address-list/print') {
        return [...listed.map((e) => ['!re', `=.id=${e.id}`, `=address=${e.address}`, `=comment=${e.comment}`]), ['!done']];
      }
      if (words[0] === '/ip/firewall/address-list/remove') calls.push({ action: 'remove', arg: words[1] });
      return [['!done']];
    };
    try {
      const dev = await createMikrotikDevice(h.db, { tenantId: 3, keyId: 3, host: 'mt-w13.verify.invalid' });
      const res = await mikrotikBanSync.fullSync(dev.id);
      assert.equal(res.error, undefined);
    } finally {
      for (const [k, fn] of Object.entries(saved)) proto[k] = fn;
    }
    const added = calls.filter((c) => c.action === 'ban').map((c) => c.arg);
    assert.ok(added.includes(wanted));
    assert.ok(!added.includes(excluded), 'excluded global ban added');
    assert.ok(!added.includes(otherTenant), 'another tenant ban added');
    assert.deepEqual(calls.filter((c) => c.action === 'remove').map((c) => c.arg), ['=.id=*1']);
    assert.equal(calls.filter((c) => c.action === 'unban').length, 0);
  });
});
