/**
 * 48 — W2-4 IPS read API: GET /ip-events/stats is a real route (not an IP
 * lookup), /ip-events/:ip compares inet values, list paging is bounded,
 * ip-reputation sorts on a whitelist, /dashboard/summary is tenant-scoped.
 *
 * Literal block of this suite: 198.18.48.0/24 (reputation sort rows).
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, hostOf } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { insertBan, insertEvents, nextIp, litIp } from '../seed';
import { D, T } from '../fixtures';

describe('48 read api (W2-4)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const reputation = async (ip: string, failures: number, lastSeen: Date, country: string | null = null) => {
    await h.db('ip_reputation').insert({
      ip, total_failures: failures, total_successes: 0, affected_agents_count: 1,
      affected_services: ['ssh'], attempted_usernames: ['root'],
      first_seen: lastSeen, last_seen: lastSeen, updated_at: new Date(), geo_country_code: country,
    }).onConflict('ip').merge();
  };

  lotIt('W2-4', '48.1 /ip-events/stats returns counters, not an IP lookup', async () => {
    const ip = nextIp();
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: T.B, ip, count: 4, ageSec: 1 });
    const r = await (await h.as('member_b')).get('/api/ip-events/stats');
    assert.equal(r.status, 200, r.text);
    const s = r.json.data;
    assert.ok(!Array.isArray(s), 'stats must not be an event list');
    assert.equal(typeof s.today, 'number');
    assert.equal(typeof s.last24h, 'number');
    const [{ n }] = await h.db('ip_events')
      .where({ tenant_id: T.B })
      .whereRaw("timestamp >= NOW() - INTERVAL '24 hours'")
      .count<Array<{ n: string }>>({ n: '*' });
    assert.equal(s.last24h, Number(n));
    assert.ok(s.today >= 4);
    const mine = (s.byDevice as Array<{ deviceId: number; count: number }>).find((x) => x.deviceId === D.B.id);
    assert.ok(mine && mine.count >= 4, 'byDevice counts the B agent');
    assert.ok(!(s.byDevice as Array<{ deviceId: number }>).some((x) => x.deviceId === D.C.id), 'no tenant C device');
  });

  lotIt('W2-4', '48.2 /ip-events/:ip finds the inserted events (inet equality)', async () => {
    const ip = nextIp();
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: T.B, ip, count: 3 });
    await insertEvents(h.db, { deviceId: D.C.id, tenantId: T.C, ip, count: 2 });
    const b = await (await h.as('member_b')).get(`/api/ip-events/${ip}`);
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.data.length, 3);
    assert.ok((b.json.data as any[]).every((e) => hostOf(e.ip) === ip && e.device_id === D.B.id));
    const d = await (await h.as('default_member')).get(`/api/ip-events/${ip}`);
    assert.equal(d.json.data.length, 5, 'Default sees every tenant');
    const bad = await (await h.as('member_b')).get('/api/ip-events/not-an-ip');
    assert.equal(bad.status, 400);
    const rows = await h.db('ip_events').whereRaw('ip = ?::inet', [ip]);
    assert.equal(rows.length, 5);

    // The list filter: an exact IP and a CIDR use inet operators, text a substring.
    const list = await (await h.as('member_b')).get(`/api/ip-events?ip=${encodeURIComponent(ip)}`);
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 3);
    assert.equal(list.json.totalCapped, false);
    const net = ip.split('.').slice(0, 3).join('.');
    const cidr = await (await h.as('member_b')).get(`/api/ip-events?ip=${encodeURIComponent(`${net}.0/24`)}`);
    assert.ok((cidr.json.data as any[]).some((e) => hostOf(e.ip) === ip));
    assert.ok((cidr.json.data as any[]).every((e) => hostOf(e.ip).startsWith(`${net}.`)));
    const text = await (await h.as('member_b')).get(`/api/ip-events?ip=${encodeURIComponent(`${net}.`)}`);
    assert.equal(text.status, 200);
    assert.ok((text.json.data as any[]).some((e) => hostOf(e.ip) === ip));
    // LIKE metacharacters are literal: '%' / '_' match no address.
    for (const meta of ['%', '_', '\\']) {
      const m = await (await h.as('member_b')).get(`/api/ip-events?ip=${encodeURIComponent(meta)}`);
      assert.equal(m.status, 200, m.text);
      assert.equal(m.json.total, 0, `ip=${meta} is a literal`);
    }
  });

  lotIt('W2-4', '48.3 pageSize=999999 is clamped, page=NaN is page 1, bad dates are 400', async () => {
    const c = await h.as('default_member');
    const ev = await c.get('/api/ip-events?pageSize=999999');
    assert.equal(ev.status, 200);
    assert.equal(ev.json.pageSize, 500);
    assert.ok(ev.json.data.length <= 500);
    const nan = await c.get('/api/ip-events?page=NaN&pageSize=abc');
    assert.equal(nan.status, 200);
    assert.equal(nan.json.page, 1);
    assert.equal(nan.json.pageSize, 50);
    const neg = await c.get('/api/ip-events?page=-3');
    assert.equal(neg.json.page, 1);
    const badFrom = await c.get('/api/ip-events?from=yesterday-ish');
    assert.equal(badFrom.status, 400);
    const badTo = await c.get('/api/ip-events?to=2026-13-45T99:00:00Z');
    assert.equal(badTo.status, 400);
    const badDev = await c.get('/api/ip-events?deviceId=1%20OR%201=1');
    assert.equal(badDev.status, 400);

    const rep = await c.get('/api/ip-reputation?pageSize=999999');
    assert.equal(rep.status, 200);
    assert.equal(rep.json.limit, 500);
    const repLimit = await c.get('/api/ip-reputation?limit=999999&offset=-5');
    assert.equal(repLimit.status, 200);
    assert.equal(repLimit.json.limit, 500);
    assert.equal(repLimit.json.offset, 0);
    const repNan = await c.get('/api/ip-reputation?page=NaN');
    assert.equal(repNan.status, 200);
    assert.equal(repNan.json.offset, 0);
  });

  lotIt('W2-4', '48.4 sortBy=failures orders by total_failures; an unknown key falls back', async () => {
    const now = Date.now();
    // failures / last_seen are deliberately in opposite orders.
    const rows = [
      { ip: litIp('198.18', 48, 1), failures: 7,  seen: new Date(now - 1_000), cc: 'FR' },
      { ip: litIp('198.18', 48, 2), failures: 50, seen: new Date(now - 3_000), cc: 'DE' },
      { ip: litIp('198.18', 48, 3), failures: 20, seen: new Date(now - 2_000), cc: null },
    ];
    for (const r of rows) await reputation(r.ip, r.failures, r.seen, r.cc);
    const c = await h.as('default_member');
    const search = encodeURIComponent('198.18.48.0/24');
    const ips = (res: { json: any }) => (res.json.data as any[]).map((x) => hostOf(x.ip));

    const desc = await c.get(`/api/ip-reputation?search=${search}&sortBy=failures&sortOrder=desc`);
    assert.equal(desc.status, 200, desc.text);
    assert.deepEqual(ips(desc), [rows[1].ip, rows[2].ip, rows[0].ip]);
    assert.deepEqual((desc.json.data as any[]).map((x) => x.totalFailures), [50, 20, 7]);
    const asc = await c.get(`/api/ip-reputation?search=${search}&sortBy=failures&sortOrder=asc`);
    assert.deepEqual(ips(asc), [rows[0].ip, rows[2].ip, rows[1].ip]);
    // NULLS LAST in both directions.
    const country = await c.get(`/api/ip-reputation?search=${search}&sortBy=country&sortOrder=asc`);
    assert.deepEqual(ips(country), [rows[1].ip, rows[0].ip, rows[2].ip]);

    // Default order (lastSeen desc) and the fallback for a hostile key / order.
    const def = await c.get(`/api/ip-reputation?search=${search}`);
    assert.deepEqual(ips(def), [rows[0].ip, rows[2].ip, rows[1].ip]);
    const hostile = await c.get(`/api/ip-reputation?search=${search}&sortBy=${encodeURIComponent("'; drop table ip_reputation; --")}&sortOrder=sideways`);
    assert.equal(hostile.status, 200, hostile.text);
    assert.deepEqual(ips(hostile), ips(def));
    const still = await h.db('ip_reputation').whereRaw('ip <<= ?::inet', ['198.18.48.0/24']);
    assert.equal(still.length, 3);

    // An exact IP search is an inet equality (one row, not a prefix match).
    const exact = await c.get(`/api/ip-reputation?search=${encodeURIComponent(rows[0].ip)}`);
    assert.deepEqual(ips(exact), [rows[0].ip]);
  });

  lotIt('W2-4', '48.5 a restricted tenant is sorted on its own failure counts', async () => {
    const a = nextIp();
    const b = nextIp();
    // Globally a > b, but tenant B saw more of b.
    await reputation(a, 100, new Date());
    await reputation(b, 3, new Date());
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: T.B, ip: a, count: 1 });
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: T.B, ip: b, count: 3 });
    const r = await (await h.as('member_b')).get('/api/ip-reputation?sortBy=failures&sortOrder=desc&limit=500');
    assert.equal(r.status, 200, r.text);
    const order = (r.json.data as any[]).map((x) => hostOf(x.ip)).filter((ip) => ip === a || ip === b);
    assert.deepEqual(order, [b, a]);
    const shown = (r.json.data as any[]).filter((x) => hostOf(x.ip) === a)[0];
    assert.equal(shown.totalFailures, 1);
  });

  lotIt('W2-4', '48.6 /dashboard/summary is tenant-scoped and counts global bans', async () => {
    const cIp = nextIp();
    await insertEvents(h.db, { deviceId: D.C.id, tenantId: T.C, ip: cIp, count: 30, ageSec: 1 });
    await reputation(cIp, 1_000_000, new Date());
    const bIp = nextIp();
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: T.B, ip: bIp, count: 2, ageSec: 1 });

    const mb = await h.as('member_b');
    const s1 = await mb.get('/api/dashboard/summary');
    assert.equal(s1.status, 200, s1.text);
    const sum = s1.json.data;
    const [{ n }] = await h.db('ip_events')
      .where({ tenant_id: T.B })
      .whereRaw('timestamp >= CURRENT_DATE')
      .count<Array<{ n: string }>>({ n: '*' });
    assert.equal(sum.eventsToday, Number(n), 'only tenant B events');
    assert.ok(!(sum.topIps as any[]).some((x) => x.ip === cIp), 'no tenant C IP in top IPs');
    assert.ok((sum.topIps as any[]).length <= 5);
    assert.ok(!(sum.perAgent as any[]).some((x) => x.deviceId === D.C.id), 'no tenant C agent');
    assert.ok((sum.perAgent as any[]).some((x) => x.deviceId === D.B.id && x.events24h >= 2));
    // Fixture: B has two approved agents, one in an evaluate-only group (pending excluded).
    assert.equal(sum.agentsTotal, 2);
    assert.equal(sum.agentsEvaluateOnly, 1);
    for (const k of ['activeBans', 'eventsToday', 'failuresToday', 'uniqueIpsToday', 'agentsConnected', 'agentsOutdated']) {
      assert.equal(typeof sum[k], 'number', k);
    }

    // A tenant C local ban is not B's; a global ban is.
    await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: T.C, banType: 'manual' });
    const s2 = (await mb.get('/api/dashboard/summary')).json.data;
    assert.equal(s2.activeBans, sum.activeBans);
    await insertBan(h.db, { ip: nextIp(), scope: 'global', banType: 'auto' });
    const s3 = (await mb.get('/api/dashboard/summary')).json.data;
    assert.equal(s3.activeBans, sum.activeBans + 1);
    assert.equal(s3.bansToday.auto, s2.bansToday.auto + 1);
    const excludedSql = 'EXISTS (SELECT 1 FROM ip_ban_exclusions x WHERE x.ban_id = ip_bans.id AND x.tenant_id = ?)';
    const active = await h.db('ip_bans').where({ is_active: true })
      .where((w) => { w.where('scope', 'global').orWhere('tenant_id', T.B); })
      .whereRaw(`NOT ${excludedSql}`, [T.B])
      .count<Array<{ n: string }>>({ n: '*' });
    assert.equal(s3.activeBans, Number(active[0].n));

    // A global ban B excluded (cross-tenant override) is not enforced on B: not counted.
    const exId = await insertBan(h.db, { ip: nextIp(), scope: 'global', banType: 'auto' });
    await h.db('ip_ban_exclusions').insert({ ban_id: exId, tenant_id: T.B });
    const s4 = (await mb.get('/api/dashboard/summary')).json.data;
    assert.equal(s4.activeBans, s3.activeBans, 'excluded global ban not counted');
    assert.equal(s4.bansToday.auto, s3.bansToday.auto);

    // Default aggregates the whole install.
    const d = (await (await h.as('default_member')).get('/api/dashboard/summary')).json.data;
    assert.equal(d.topIps[0].ip, cIp);
    assert.ok(d.eventsToday >= Number(n) + 30);
    assert.ok((d.perAgent as any[]).some((x) => x.deviceId === D.C.id && x.events24h >= 30));
  });
});
