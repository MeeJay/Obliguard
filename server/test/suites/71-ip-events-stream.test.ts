/**
 * 71 — Live Events stream (W8-3): every stored agent flush goes out as ONE
 * batched `ip:events` frame (full rows with their ids, newest first, at most
 * IP_EVENTS_FRAME_CAP) to the agent's tenant feed, the Default feed and the
 * agent's watchers; team-restricted sockets only hear their granted agents;
 * `agent:watch` needs read access to the agent; GET /ip-events offers keyset
 * paging (?keyset=1 / ?before=<id>, limit+1 → hasMore).
 * Sentinels only, no timed waits.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, waitFor } from '../harness';
import type { Harness, RecordedEvent } from '../harness';
import { lotIt } from '../lots';
import { D, G, U } from '../fixtures';
import { createDevice, createUser, nextIp } from '../seed';
import { emitAgentActivity, ipFeedRoom, agentWatchRoom } from '../../src/utils/socketRooms';
import { agentService } from '../../src/services/agent.service';
import { AGENT_WATCH_MAX, IP_EVENTS_FRAME_CAP, SOCKET_EVENTS, CLIENT_SOCKET_EVENTS } from '@obliview/shared';
import type { AgentWatchAck, IpEventsFrame } from '@obliview/shared';

type Rec = { events: RecordedEvent[]; socket: any };

const IP_EVENTS = SOCKET_EVENTS.IP_EVENTS;
const SERVICE = 'custom:verify';

describe('71 ip:events stream, agent watch rooms, keyset paging (W8-3)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const open = async (username: string): Promise<Rec> => {
    const s = await h.socket(await h.login(username));
    if (!s.ok) throw new Error(`socket for ${username}: ${s.error}`);
    return s as Rec;
  };
  const frames = (r: Rec, deviceId: number): Array<RecordedEvent & { args: [IpEventsFrame] }> =>
    r.events.filter((e) => e.event === IP_EVENTS
      && (e.args[0] as IpEventsFrame)?.events?.some((ev) => ev.deviceId === deviceId)) as any;
  const watch = (r: Rec, deviceId: unknown, event: string = CLIENT_SOCKET_EVENTS.AGENT_WATCH): Promise<AgentWatchAck> =>
    r.socket.timeout(3000).emitWithAck(event, { deviceId });

  let seq = 0;
  async function restrictedUser(grantGroupId: number): Promise<{ id: number; username: string }> {
    const u = await createUser(h.db, { tenants: [2] });
    const [t] = await h.db('user_teams')
      .insert({ name: `t71-${Date.now()}-${++seq}`, tenant_id: 2, can_create: false })
      .returning('id') as Array<{ id: number }>;
    await h.db('team_memberships').insert({ team_id: t.id, user_id: u.id });
    await h.db('team_permissions').insert({ team_id: t.id, scope: 'group', scope_id: grantGroupId, level: 'ro' });
    return u;
  }

  // Runs first: no socket is connected yet, so every target room is empty.
  lotIt('W8-3', '71.1 nothing is built nor sent when no socket listens to the agent', async () => {
    let built = 0;
    const sent = emitAgentActivity(h.io, 2, D.B.id, IP_EVENTS, () => { built++; return { events: [], dropped: 0 }; });
    assert.equal(sent, false);
    assert.equal(built, 0);
  });

  lotIt('W8-3', '71.2 a tenant-2 socket receives ip:events for its agents only; Default receives every tenant', async () => {
    const mb = await open('member_b');
    const dm = await open('default_member');
    assert.ok((await h.roomsOf(U.member_b)).includes(ipFeedRoom(2)), 'member_b joins the tenant-2 feed');

    const ipC = nextIp();
    assert.equal((await h.push(3, D.C.uuid, { events: [h.event(ipC, { service: SERVICE })] })).status, 200);
    const seenC = await waitFor(() => frames(dm, D.C.id)[0], 3000);
    const rowC = seenC.args[0].events.find((e) => e.deviceId === D.C.id)!;
    assert.equal(rowC.ip.split('/')[0], ipC);
    assert.equal(rowC.tenantId, 3);
    assert.equal(rowC.service, SERVICE);
    assert.equal(rowC.eventType, 'auth_failure');
    assert.ok(Number.isSafeInteger(rowC.id) && rowC.id > 0, 'stream row carries the ip_events id');
    const stored = await h.db('ip_events').where({ id: rowC.id }).first('device_id', 'tenant_id');
    assert.equal(Number(stored?.device_id), D.C.id);
    assert.equal(seenC.args[0].dropped, 0);

    // Sentinel: tenant B's own agent reaches member_b after tenant C's push.
    await h.push(2, D.B.uuid, { events: [h.event(nextIp(), { service: SERVICE })] });
    const sentinel = await waitFor(() => frames(mb, D.B.id)[0], 3000);
    const leaked = mb.events.filter((e) => e.seq < sentinel.seq
      && (e.event === IP_EVENTS || e.event === SOCKET_EVENTS.IP_FLOW)
      && JSON.stringify(e.args[0]).includes(`"deviceId":${D.C.id}`));
    assert.deepEqual(leaked, []);
    for (const ev of sentinel.args[0].events) assert.equal(ev.tenantId, 2);
  });

  lotIt('W8-3', '71.3 one frame per flush: newest first, capped, the rest counted in dropped', async () => {
    const mc = await open('member_c');
    const ip = nextIp();
    const n = IP_EVENTS_FRAME_CAP + 5;
    const events = Array.from({ length: n }, () => h.event(ip, { service: SERVICE }));
    assert.equal((await h.push(3, D.C.uuid, { events })).status, 200);
    const f = await waitFor(() => mc.events.find((e) => e.event === IP_EVENTS
      && (e.args[0] as IpEventsFrame).events.some((ev) => ev.ip.split('/')[0] === ip)), 3000);
    const frame = f.args[0] as IpEventsFrame;
    assert.equal(frame.events.length, IP_EVENTS_FRAME_CAP);
    assert.equal(frame.dropped, 5);
    const ids = frame.events.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest (highest id) first');
    const maxStored = await h.db('ip_events').where({ device_id: D.C.id }).max('id as m').first();
    assert.equal(ids[0], Number(maxStored?.m));
    // One flush = one frame for this address.
    const sameFlush = mc.events.filter((e) => e.event === IP_EVENTS
      && (e.args[0] as IpEventsFrame).events.some((ev) => ev.ip.split('/')[0] === ip));
    assert.equal(sameFlush.length, 1);
  });

  lotIt('W8-3', '71.4 a team-restricted socket hears its granted agents only (watch rooms, no tenant feed)', async () => {
    const u = await restrictedUser(G.B); // grants group B: agent D.B, not D.B_EVAL (group B_EVAL)
    const r = await open(u.username);
    const rooms = await h.roomsOf(u.id);
    assert.ok(!rooms.includes(ipFeedRoom(2)), 'restricted socket stays out of the tenant feed');
    assert.ok(rooms.includes(agentWatchRoom(D.B.id)), 'granted agent watch room joined');

    await h.push(2, D.B_EVAL.uuid, { events: [h.event(nextIp(), { service: SERVICE })] });
    await h.push(2, D.B.uuid, { events: [h.event(nextIp(), { service: SERVICE })] });
    const sentinel = await waitFor(() => frames(r, D.B.id)[0], 3000);
    const leaked = r.events.filter((e) => e.seq < sentinel.seq
      && (e.event === IP_EVENTS || e.event === SOCKET_EVENTS.IP_FLOW)
      && JSON.stringify(e.args[0]).includes(`"deviceId":${D.B_EVAL.id}`));
    assert.deepEqual(leaked, []);

    // An explicit unwatch never drops a room the team scope granted.
    assert.deepEqual(await watch(r, D.B.id, CLIENT_SOCKET_EVENTS.AGENT_UNWATCH), { ok: true, on: false, deviceId: D.B.id });
    assert.ok((await h.roomsOf(u.id)).includes(agentWatchRoom(D.B.id)));
  });

  lotIt('W8-3', '71.5 agent:watch requires read access to the agent (tenant + team scope)', async () => {
    // Team-restricted: the hidden agent answers not_found, the granted one joins.
    const u = await restrictedUser(G.B);
    const r = await open(u.username);
    assert.deepEqual(await watch(r, D.B_EVAL.id), { ok: false, code: 'not_found' });
    assert.ok(!(await h.roomsOf(u.id)).includes(agentWatchRoom(D.B_EVAL.id)));
    const okGranted = await watch(r, D.B.id);
    assert.equal(okGranted.ok, true);

    // Another tenant's agent: not_found (existence never revealed); junk: invalid.
    const mb = await open('member_b');
    assert.deepEqual(await watch(mb, D.C.id), { ok: false, code: 'not_found' });
    assert.deepEqual(await watch(mb, 'abc'), { ok: false, code: 'invalid' });
    assert.deepEqual(await watch(mb, 999_999), { ok: false, code: 'not_found' });
    assert.ok(!(await h.roomsOf(U.member_b)).includes(agentWatchRoom(D.C.id)));

    // Readable agent of the own tenant: joins, with the TTL.
    const ack = await watch(mb, D.B_EVAL.id);
    assert.equal(ack.ok, true);
    assert.ok(ack.ok && ack.on === true && (ack.ttlSeconds ?? 0) > 0);
    assert.ok((await h.roomsOf(U.member_b)).includes(agentWatchRoom(D.B_EVAL.id)));

    // The Default god view may watch any agent of any tenant.
    const dm = await open('default_member');
    assert.equal((await watch(dm, D.C.id)).ok, true);
  });

  lotIt('W8-3', `71.6 at most ${AGENT_WATCH_MAX} watched agents per socket; unwatch frees a slot`, async () => {
    const dm = await open('default_member');
    const ids: number[] = [];
    for (let i = 0; i <= AGENT_WATCH_MAX; i++) {
      ids.push((await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: null })).id);
    }
    for (const id of ids.slice(0, AGENT_WATCH_MAX)) assert.equal((await watch(dm, id)).ok, true, `watch ${id}`);
    // Renewing a watched agent never counts twice.
    assert.equal((await watch(dm, ids[0])).ok, true);
    assert.deepEqual(await watch(dm, ids[AGENT_WATCH_MAX]), { ok: false, code: 'too_many' });
    assert.equal((await watch(dm, ids[0], CLIENT_SOCKET_EVENTS.AGENT_UNWATCH)).ok, true);
    assert.equal((await watch(dm, ids[AGENT_WATCH_MAX])).ok, true);
  });

  lotIt('W8-3', '71.7 keyset paging: newest first by id, limit+1 tells hasMore, before= continues', async () => {
    const dev = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: G.B });
    const ip = nextIp();
    const now = Date.now();
    const inserted = await h.db('ip_events').insert(Array.from({ length: 5 }, (_, i) => ({
      device_id: dev.id, ip, username: 'root', service: SERVICE, event_type: 'auth_failure',
      timestamp: new Date(now - i * 1000), tenant_id: 2,
    }))).returning('id') as Array<{ id: number | string }>;
    const all = inserted.map((r) => Number(r.id)).sort((a, b) => b - a);

    const c = await h.as('member_b');
    const p1 = await c.get(`/api/ip-events?keyset=1&limit=2&deviceId=${dev.id}`);
    assert.equal(p1.status, 200, p1.text);
    assert.deepEqual(p1.json.data.map((r: { id: unknown }) => Number(r.id)), all.slice(0, 2));
    assert.equal(p1.json.hasMore, true);
    assert.equal(p1.json.total, undefined, 'no count in keyset mode');
    const p2 = await c.get(`/api/ip-events?before=${p1.json.nextBefore}&limit=2&deviceId=${dev.id}`);
    assert.deepEqual(p2.json.data.map((r: { id: unknown }) => Number(r.id)), all.slice(2, 4));
    assert.equal(p2.json.hasMore, true);
    const p3 = await c.get(`/api/ip-events?before=${p2.json.nextBefore}&limit=2&deviceId=${dev.id}`);
    assert.deepEqual(p3.json.data.map((r: { id: unknown }) => Number(r.id)), all.slice(4));
    assert.equal(p3.json.hasMore, false);
    assert.equal(p3.json.nextBefore, null);

    // Page mode is unchanged (total + page).
    const pm = await c.get(`/api/ip-events?page=1&pageSize=2&deviceId=${dev.id}`);
    assert.equal(pm.json.total, 5);
    assert.equal(pm.json.page, 1);

    assert.equal((await c.get('/api/ip-events?before=12abc')).status, 400);
    assert.equal((await c.get('/api/ip-events?before=0')).status, 400);
  });

  lotIt('W8-3', '71.8 GET /ip-events follows the team scope (hidden agents are left out)', async () => {
    const hidden = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: G.B_EVAL });
    const shown = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: G.B });
    const ip = nextIp();
    await h.db('ip_events').insert([hidden.id, shown.id].map((device_id) => ({
      device_id, ip, username: 'root', service: SERVICE, event_type: 'auth_failure', timestamp: new Date(), tenant_id: 2,
    })));
    const u = await restrictedUser(G.B);
    const c = await h.login(u.username);
    for (const q of [`ip=${ip}`, `ip=${ip}&keyset=1`]) {
      const r = await c.get(`/api/ip-events?${q}`);
      assert.equal(r.status, 200, r.text);
      const devices = new Set((r.json.data as Array<{ device_id: number }>).map((e) => Number(e.device_id)));
      assert.deepEqual([...devices], [shown.id], q);
    }
    const byIp = await c.get(`/api/ip-events/${ip}`);
    assert.deepEqual([...new Set((byIp.json.data as Array<{ device_id: number }>).map((e) => Number(e.device_id)))], [shown.id]);
    // An unrestricted member of the tenant sees both.
    const all = await (await h.as('member_b')).get(`/api/ip-events?ip=${ip}`);
    assert.equal(all.json.data.length, 2);
  });

  lotIt('W8-3', '71.9 the WS events flush (processEventsFlush) streams ip:events to the same audience', async () => {
    const mb = await open('member_b');
    const mc = await open('member_c');
    const ip = nextIp();
    await agentService.processEventsFlush(D.B.id, 2, [h.event(ip, { service: SERVICE }) as any]);
    const f = await waitFor(() => mb.events.find((e) => e.event === IP_EVENTS
      && (e.args[0] as IpEventsFrame).events.some((ev) => ev.ip.split('/')[0] === ip)), 3000);
    const row = (f.args[0] as IpEventsFrame).events.find((ev) => ev.ip.split('/')[0] === ip)!;
    assert.equal(row.deviceId, D.B.id);
    assert.equal(row.tenantId, 2);
    const stored = await h.db('ip_events').where({ id: row.id }).first('device_id');
    assert.equal(Number(stored?.device_id), D.B.id);

    // Sentinel on tenant C: member_c never heard tenant B's flush.
    await agentService.processEventsFlush(D.C.id, 3, [h.event(nextIp(), { service: SERVICE }) as any]);
    const sentinel = await waitFor(() => frames(mc, D.C.id)[0], 3000);
    const leaked = mc.events.filter((e) => e.seq < sentinel.seq
      && JSON.stringify(e.args[0]).includes(ip));
    assert.deepEqual(leaked, []);
  });
});
