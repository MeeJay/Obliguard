/**
 * 12 — real-time isolation (A6): tenant-scoped Socket.io emits and ban:*
 * payload scoping. Sentinels only, no timed waits.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, waitFor, hostOf } from '../harness';
import type { Harness, RecordedEvent } from '../harness';
import { lotIt } from '../lots';
import { insertEvents, nextIp } from '../seed';
import { banEngine } from '../../src/services/ban.service';
import { SOCKET_EVENTS } from '@obliview/shared';

type Rec = { events: RecordedEvent[] };

describe('12 realtime isolation', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const open = async (username: string): Promise<Rec> => {
    const s = await h.socket(await h.login(username));
    if (!s.ok) throw new Error(`socket for ${username}: ${s.error}`);
    return s;
  };
  const find = (r: Rec, event: string, pred: (p: any) => boolean) =>
    r.events.find((e) => e.event === event && pred(e.args[0]));

  lotIt('A6', '12.1 agent activity reaches its tenant and Default only', async () => {
    const mb = await open('member_b');
    const mc = await open('member_c');
    const dm = await open('default_member');
    await h.push(3, 'dev-c-0001', { events: [h.event(nextIp(), { service: 'custom:verify' })] });
    await waitFor(() => find(dm, 'ip:flow', (p) => p?.deviceId === 3), 3000);
    await waitFor(() => find(mc, SOCKET_EVENTS.AGENT_STATUS_CHANGED, (p) => p?.deviceId === 3), 3000);
    await h.push(2, 'dev-b-0001', { events: [h.event(nextIp(), { service: 'custom:verify' })] });
    const sentinel = await waitFor(() => find(mb, 'ip:flow', (p) => p?.deviceId === 2), 3000);
    const leaked = mb.events.filter((e) => e.seq < sentinel.seq
      && ['ip:flow', 'agent:pushHeartbeat', SOCKET_EVENTS.AGENT_STATUS_CHANGED].includes(e.event)
      && e.args[0]?.deviceId === 3);
    assert.deepEqual(leaked, []);
  });

  lotIt('A6', '12.2 a tenant-local ban is only announced to that tenant and Default', async () => {
    const mb = await open('member_b');
    const mc = await open('member_c');
    const dm = await open('default_member');
    const x = nextIp();
    assert.equal((await (await h.as('member_c')).post('/api/bans', { ip: x })).status, 201);
    await waitFor(() => find(mc, 'ban:created', (p) => hostOf(p?.ip) === x), 3000);
    await waitFor(() => find(dm, 'ban:created', (p) => hostOf(p?.ip) === x), 3000);
    const s = nextIp();
    assert.equal((await (await h.adminIn(1)).post('/api/bans', { ip: s })).status, 201);
    const sentinel = await waitFor(() => find(mb, 'ban:created', (p) => hostOf(p?.ip) === s), 3000);
    assert.ok(!mb.events.some((e) => e.seq < sentinel.seq && e.event === 'ban:created' && hostOf(e.args[0]?.ip) === x));
  });

  lotIt('A6', '12.3 ban payloads never name another tenant', async () => {
    const mb = await open('member_b');
    const mc = await open('member_c');
    const p = nextIp();
    const created = await (await h.as('member_c')).post('/api/bans', { ip: p });
    assert.equal(created.status, 201);
    const pid = created.json.data.id as number;
    assert.equal((await (await h.adminIn(1)).post(`/api/bans/${pid}/promote-global`)).status, 200);
    const ev = await waitFor(() => mb.events.find((e) => e.args[0]?.id === pid), 3000);
    assert.equal(ev.args[0].originTenantId ?? null, null);
    assert.equal(ev.args[0].originTenantName, undefined);
    const e = nextIp();
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: e, service: 'ssh', count: 6 });
    await banEngine.run();
    const auto = await waitFor(() => find(mc, 'ban:auto', (q) => hostOf(q?.ip) === e), 3000);
    assert.equal(auto.args[0].originTenantId ?? null, null);
  });
});
