/**
 * 72 — W8-4 dashboard on the Obliance model: IPS snapshots, series, deltas,
 * breakdowns and group cards.
 *
 *   72.1 a snapshot run is idempotent (twice = same rows), backfills the
 *        flows and records the gauges of the current bucket only
 *   72.2 /dashboard/timeseries and /hourly are tenant-scoped: snapshot rows
 *        of another tenant never leak, the last point is live
 *   72.3 a team-restricted caller gets series over its own agents only
 *   72.4 the summary carries day-over-day deltas (snapshot of 24 h ago,
 *        previous 24 h of events)
 *   72.5 /dashboard/breakdown: top services / countries / bans per agent,
 *        tenant-scoped
 *   72.6 /dashboard/groups: real per-group counts (non-empty), tenant-scoped,
 *        Default sees every tenant's groups tagged with their tenant
 *   72.7 client: the dashboard is built from the dashboard components and
 *        refreshes on ban / agent status events
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { T } from '../fixtures';
import { createDevice, createGroup, insertBan, insertEvents, nextIp } from '../seed';
import { ipsSnapshotService } from '../../src/services/ipsSnapshot.service';
import { dashboardService } from '../../src/services/dashboard.service';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Snapshot rows of a tenant, without the write timestamp. */
async function rows(h: Harness, table: string, tenantId: number): Promise<unknown[]> {
  const r = await h.db(table).where('tenant_id', tenantId).orderBy('bucket')
    .select(h.db.raw('bucket::text AS bucket'), 'events', 'failures', 'unique_ips', 'auto_bans', 'manual_bans',
      'active_bans', 'agents_total', 'agents_connected');
  return r as unknown[];
}

async function todayKey(h: Harness): Promise<string> {
  const r = await h.db.raw("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d") as { rows: Array<{ d: string }> };
  return r.rows[0].d;
}

describe('72 dashboard (W8-4)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  lotIt('W8-4', '72.1 a snapshot run twice is idempotent; gauges only on the current bucket', async () => {
    const dev = await createDevice(h.db, { tenantId: T.B, keyId: 2 });
    const ip = nextIp();
    await insertEvents(h.db, { deviceId: dev.id, tenantId: T.B, ip, count: 4, ageSec: 5 });
    // Two days ago: backfilled from ip_events, no gauge.
    await insertEvents(h.db, { deviceId: dev.id, tenantId: T.B, ip: nextIp(), count: 3, ageSec: 2 * 24 * 3600 + 60 });

    assert.equal(await ipsSnapshotService.runAll({ backfill: true }), true);
    const daily1 = await rows(h, 'ips_daily_snapshot', T.B);
    const hourly1 = await rows(h, 'ips_hourly_snapshot', T.B);
    assert.ok(daily1.length >= 31, `30 days backfilled + today (got ${daily1.length})`);
    assert.ok(hourly1.length >= 49, `48 hours backfilled + current (got ${hourly1.length})`);

    assert.equal(await ipsSnapshotService.runAll({ backfill: true }), true);
    assert.deepEqual(await rows(h, 'ips_daily_snapshot', T.B), daily1, 'daily rows unchanged by a second run');
    assert.deepEqual(await rows(h, 'ips_hourly_snapshot', T.B), hourly1, 'hourly rows unchanged by a second run');
    await ipsSnapshotService.runAll();
    assert.deepEqual(await rows(h, 'ips_daily_snapshot', T.B), daily1, 'an hourly run keeps them too');

    const today = await todayKey(h);
    const t = await h.db('ips_daily_snapshot').where({ tenant_id: T.B }).whereRaw('bucket = CURRENT_DATE').first();
    const [{ n }] = await h.db('ip_events').where({ tenant_id: T.B, event_type: 'auth_failure' })
      .whereRaw('timestamp >= CURRENT_DATE').count<Array<{ n: string }>>({ n: '*' });
    assert.equal(t.failures, Number(n), `today's failures of tenant B (${today})`);
    assert.notEqual(t.agents_total, null, 'gauges recorded on the current bucket');
    assert.ok(t.agents_total >= 1);
    const old = await h.db('ips_daily_snapshot').where({ tenant_id: T.B }).whereRaw('bucket = CURRENT_DATE - 2').first();
    assert.ok(old.failures >= 3, 'two days ago backfilled from ip_events');
    assert.equal(old.agents_total, null, 'no gauge for a backfilled bucket');

    // A past bucket never decreases (retention purge / wipe keep history).
    await h.db('ip_events').where({ device_id: dev.id }).whereRaw('timestamp < CURRENT_DATE - 1').del();
    await ipsSnapshotService.runAll({ backfill: true });
    const kept = await h.db('ips_daily_snapshot').where({ tenant_id: T.B }).whereRaw('bucket = CURRENT_DATE - 2').first();
    assert.equal(kept.failures, old.failures);

    // The Default row is the whole install.
    const d = await h.db('ips_daily_snapshot').where({ tenant_id: T.DEFAULT }).whereRaw('bucket = CURRENT_DATE').first();
    assert.ok(d.failures >= t.failures);
  });

  lotIt('W8-4', '72.2 timeseries / hourly are tenant-scoped, the last point is live', async () => {
    await ipsSnapshotService.runAll({ backfill: true });
    // Distinctive past rows: only the owner tenant may see them.
    await h.db('ips_daily_snapshot').where({ tenant_id: T.C }).whereRaw('bucket = CURRENT_DATE - 3').update({ events: 987654 });
    await h.db('ips_daily_snapshot').where({ tenant_id: T.B }).whereRaw('bucket = CURRENT_DATE - 3').update({ events: 123456 });

    const mb = await h.as('member_b');
    const r = await mb.get('/api/dashboard/timeseries?days=7');
    assert.equal(r.status, 200, r.text);
    const pts = r.json.data as Array<{ bucket: string; events: number; failures: number; agentsTotal: number | null }>;
    assert.equal(pts.length, 7);
    assert.ok(pts.some((p) => p.events === 123456), 'own snapshot row');
    assert.ok(!pts.some((p) => p.events === 987654), 'no tenant C row');
    assert.equal(pts[pts.length - 1].bucket, await todayKey(h));
    assert.deepEqual(pts.map((p) => p.bucket), [...pts.map((p) => p.bucket)].sort(), 'oldest first');

    // Live point: a new event shows up without a snapshot run.
    const dev = await createDevice(h.db, { tenantId: T.B, keyId: 2 });
    const before = pts[pts.length - 1].failures;
    await insertEvents(h.db, { deviceId: dev.id, tenantId: T.B, ip: nextIp(), count: 2, ageSec: 1 });
    const after = (await mb.get('/api/dashboard/timeseries?days=7')).json.data as typeof pts;
    assert.equal(after[after.length - 1].failures, before + 2);
    assert.notEqual(after[after.length - 1].agentsTotal, null);

    const c = (await (await h.as('member_c')).get('/api/dashboard/timeseries?days=7')).json.data as typeof pts;
    assert.ok(c.some((p) => p.events === 987654));
    assert.ok(!c.some((p) => p.events === 123456));

    const hr = await mb.get('/api/dashboard/hourly?hours=24');
    assert.equal(hr.status, 200, hr.text);
    const hp = hr.json.data as Array<{ bucket: string; failures: number }>;
    assert.ok(hp.length >= 2 && hp.length <= 24);
    assert.ok(!Number.isNaN(Date.parse(hp[hp.length - 1].bucket)));
    // Clamped parameters, never a 500.
    assert.equal((await mb.get('/api/dashboard/timeseries?days=abc')).status, 200);
    assert.equal(((await mb.get('/api/dashboard/hourly?hours=100000')).json.data as unknown[]).length <= 168, true);
  });

  lotIt('W8-4', '72.3 a team-restricted caller gets series over its own agents', async () => {
    const a = await createDevice(h.db, { tenantId: T.B, keyId: 2 });
    const b = await createDevice(h.db, { tenantId: T.B, keyId: 2 });
    await insertEvents(h.db, { deviceId: a.id, tenantId: T.B, ip: nextIp(), count: 3, ageSec: 1 });
    await insertEvents(h.db, { deviceId: b.id, tenantId: T.B, ip: nextIp(), count: 11, ageSec: 1 });
    const [{ n }] = await h.db('ip_events').where({ device_id: a.id, event_type: 'auth_failure' })
      .whereRaw('timestamp >= CURRENT_DATE').count<Array<{ n: string }>>({ n: '*' });
    const pts = await dashboardService.getSeries(T.B, 'daily', 3, [a.id]);
    const last = pts[pts.length - 1];
    assert.equal(last.failures, Number(n));
    assert.equal(last.agentsTotal, 1);
    assert.equal(pts[0].agentsTotal, null, 'no tenant-wide gauge for a restricted caller');
    const breakdown = await dashboardService.getBreakdown(T.B, 24, [a.id]);
    const total = breakdown.topServices.reduce((sum, x) => sum + x.count, 0);
    assert.equal(total, 3, 'breakdown limited to the visible agents');
    const summary = await dashboardService.getSummary(T.B, [a.id]);
    assert.equal(summary.deltas.agentsConnected, null);
  });

  lotIt('W8-4', '72.4 the summary carries day-over-day deltas', async () => {
    await ipsSnapshotService.runAll();
    const mb = await h.as('member_b');
    const s0 = (await mb.get('/api/dashboard/summary')).json.data;
    assert.equal(typeof s0.deltas, 'object');
    assert.equal(typeof s0.deltas.failures24h, 'number');
    assert.equal(typeof s0.deltas.uniqueIps24h, 'number');

    // 24 h ago: a reference gauge row.
    await h.db('ips_hourly_snapshot').insert({
      tenant_id: T.B, bucket: h.db.raw("date_trunc('hour', NOW()) - INTERVAL '24 hours'"),
      active_bans: 0, agents_total: 0, agents_connected: 0,
    }).onConflict(['tenant_id', 'bucket']).merge(['active_bans', 'agents_total', 'agents_connected']);
    await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: T.B, banType: 'manual' });
    const s1 = (await mb.get('/api/dashboard/summary')).json.data;
    assert.equal(s1.deltas.activeBans, s1.activeBans, 'active bans vs the 24 h-old snapshot');
    assert.equal(s1.deltas.agentsConnected, s1.agentsConnected);

    // Failures of the 24 h before count against the current window.
    const dev = await createDevice(h.db, { tenantId: T.B, keyId: 2 });
    await insertEvents(h.db, { deviceId: dev.id, tenantId: T.B, ip: nextIp(), count: 5, ageSec: 30 * 3600 });
    const s2 = (await mb.get('/api/dashboard/summary')).json.data;
    assert.equal(s2.deltas.failures24h, s1.deltas.failures24h - 5);
    assert.equal(s2.failures24h, s1.failures24h);
  });

  lotIt('W8-4', '72.5 breakdown: top services, countries and bans per agent, tenant-scoped', async () => {
    const dev = await createDevice(h.db, { tenantId: T.B, keyId: 2, hostname: 'w84-breakdown' });
    const ip = nextIp();
    await insertEvents(h.db, { deviceId: dev.id, tenantId: T.B, ip, service: 'w84svc', count: 6, ageSec: 1 });
    await insertBan(h.db, { ip, scope: 'tenant', tenantId: T.B, banType: 'auto' });
    const devC = await createDevice(h.db, { tenantId: T.C, keyId: 3 });
    await insertEvents(h.db, { deviceId: devC.id, tenantId: T.C, ip: nextIp(), service: 'w84only-c', count: 50, ageSec: 1 });

    const r = await (await h.as('member_b')).get('/api/dashboard/breakdown?hours=24');
    assert.equal(r.status, 200, r.text);
    const b = r.json.data;
    assert.equal(b.hours, 24);
    assert.ok(b.topServices.some((s: any) => s.key === 'w84svc' && s.count >= 6 && s.uniqueIps >= 1));
    assert.ok(!b.topServices.some((s: any) => s.key === 'w84only-c'), 'no tenant C service');
    assert.ok(b.topCountries.length >= 1);
    assert.ok(b.bansPerAgent.some((x: any) => x.deviceId === dev.id && x.count >= 1 && x.label === 'w84-breakdown'));
    assert.ok(!b.bansPerAgent.some((x: any) => x.deviceId === devC.id));
  });

  lotIt('W8-4', '72.6 groups stats are real, non-empty and tenant-scoped', async () => {
    const g = await createGroup(h.db, { tenantId: T.B, name: 'w84-group' });
    const child = await createGroup(h.db, { tenantId: T.B, name: 'w84-child', evaluateOnly: false });
    await h.db('monitor_groups').where({ id: child }).update({ parent_id: g });
    await h.db('group_closure').insert({ ancestor_id: g, descendant_id: child, depth: 1 });
    await h.db('monitor_groups').where({ id: g }).update({ evaluate_only: true });
    const d1 = await createDevice(h.db, { tenantId: T.B, keyId: 2, groupId: g });
    await createDevice(h.db, { tenantId: T.B, keyId: 2, groupId: g });
    await createDevice(h.db, { tenantId: T.B, keyId: 2, groupId: g, status: 'pending' });
    const ip = nextIp();
    await insertEvents(h.db, { deviceId: d1.id, tenantId: T.B, ip, count: 4, ageSec: 1 });
    await insertBan(h.db, { ip, scope: 'tenant', tenantId: T.B, banType: 'manual' });
    const gc = await createGroup(h.db, { tenantId: T.C, name: 'w84-group-c' });

    const r = await (await h.adminIn(T.B)).get('/api/dashboard/groups');
    assert.equal(r.status, 200, r.text);
    const list = r.json.data as any[];
    assert.ok(list.length > 0);
    const row = list.find((x) => x.groupId === g);
    assert.ok(row, 'the group is listed');
    assert.equal(row.agents, 2, 'approved agents only');
    assert.equal(row.events24h, 4);
    assert.equal(row.failures24h, 4);
    assert.equal(row.bans24h, 1);
    assert.equal(row.evaluateOnly, true);
    assert.equal(row.tenantId, null, 'no tenant tag outside Default');
    const c = list.find((x) => x.groupId === child);
    assert.equal(c.parentId, g);
    assert.equal(c.evaluateOnly, true, 'evaluate-only inherited from the parent');
    assert.ok(!list.some((x) => x.groupId === gc), 'no tenant C group');

    const all = (await (await h.adminIn(T.DEFAULT)).get('/api/dashboard/groups')).json.data as any[];
    assert.equal(all.find((x) => x.groupId === g)?.tenantId, T.B);
    assert.equal(all.find((x) => x.groupId === gc)?.tenantId, T.C);
    assert.equal(typeof all.find((x) => x.groupId === gc)?.tenantName, 'string');

    // A plain member sees only the groups its teams grant (none here) and the
    // agents of no visible group in the null row.
    const m = await (await h.as('member_b')).get('/api/dashboard/groups');
    assert.equal(m.status, 200, m.text);
    assert.ok((m.json.data as any[]).every((x) => x.groupId !== gc));
  });

  lotIt('W8-4', '72.7 client dashboard: components, typed API, socket refresh', () => {
    for (const f of ['Sparkline', 'HeroCard', 'ActivityChart', 'BreakdownCard', 'GroupCard']) {
      assert.ok(fs.existsSync(path.join(ROOT, `client/src/components/dashboard/${f}.tsx`)), `${f}.tsx`);
    }
    const api = read('client/src/api/dashboard.api.ts');
    for (const p of ['/dashboard/timeseries', '/dashboard/hourly', '/dashboard/breakdown', '/dashboard/groups']) {
      assert.ok(api.includes(p), `dashboardApi calls ${p}`);
    }
    const page = read('client/src/pages/DashboardPage.tsx');
    assert.match(page, /useSocketRefresh\(/);
    assert.match(page, /SOCKET_EVENTS\.BAN_CREATED|ban:created/);
    assert.match(page, /AGENT_STATUS_CHANGED/);
    assert.match(page, /\/ip-reputation\?tab=bans/);
    assert.match(page, /\/live-events\?period=24h/);
    assert.match(page, /agentsEvaluateOnly/, 'evaluate-only agents visible (C20)');
    assert.doesNotMatch(page, /window\.(?:confirm|prompt|alert)\b/);
  });
});
