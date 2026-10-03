/**
 * 89 — data layer (W12-1 / D15): migration 040 hot-path indexes and the
 * retention service (services/retention.service.ts).
 *
 * The retention pass is driven directly (retentionService.runOnce, small
 * batches so the batch loop is exercised); the windows come from app_config
 * retention.* through appConfigService (env fallback, bounds).
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup, createKey, insertBan, insertWhitelist, litIp } from '../seed';
import { retentionService } from '../../src/services/retention.service';
import { appConfigService, RETENTION_DEFS } from '../../src/services/appConfig.service';
import { AppError } from '../../src/middleware/errorHandler';

const DAY = 86_400_000;
const daysAgo = (d: number): Date => new Date(Date.now() - d * DAY);

describe('89 retention and hot-path indexes', () => {
  let h: Harness;
  let deviceId = 0;
  let keyId = 0;

  before(async () => {
    h = await startHarness();
    keyId = (await createKey(h.db, 2)).id;
    deviceId = (await createDevice(h.db, { tenantId: 2, keyId })).id;
  });

  after(async () => {
    retentionService.stop();
    await h?.close();
  });

  const insertEvent = async (ip: string, ageDays: number, tenantId = 2, dev: number | null = deviceId): Promise<number> => {
    const [r] = await h.db('ip_events').insert({
      device_id: dev, tenant_id: tenantId, ip, username: 'root', service: 'ssh',
      event_type: 'auth_failure', timestamp: daysAgo(ageDays), raw_log: 'verify-89',
    }).returning('id') as Array<{ id: number }>;
    return r.id;
  };

  const insertReputation = async (ip: string, lastSeenDays: number | null, updatedDays = lastSeenDays ?? 0): Promise<void> => {
    await h.db('ip_reputation').insert({
      ip, total_failures: 42, first_seen: daysAgo(400),
      last_seen: lastSeenDays === null ? null : daysAgo(lastSeenDays),
      updated_at: daysAgo(updatedDays),
    });
  };

  const repExists = async (ip: string): Promise<boolean> =>
    !!(await h.db('ip_reputation').whereRaw('ip = ?::inet', [ip]).first('ip'));

  lotIt('W12-1', '89.1 migration 040: composite indexes valid, low-value indexes dropped, planner uses them', async () => {
    const rows = await h.db.raw(
      `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname LIKE 'idx_ip_%'`,
    ) as { rows: Array<{ name: string; valid: boolean }> };
    const byName = new Map(rows.rows.map((r) => [r.name, r.valid]));
    for (const name of ['idx_ip_events_tenant_ts', 'idx_ip_events_device_ts', 'idx_ip_reputation_last_seen',
      'idx_ip_reputation_total_failures', 'idx_ip_bans_active_banned_at']) {
      assert.equal(byName.get(name), true, `${name} exists and is valid`);
    }
    assert.equal(byName.has('idx_ip_events_event_type'), false, 'idx_ip_events_event_type dropped');
    assert.equal(byName.has('idx_ip_events_device'), false, 'idx_ip_events_device dropped');
    assert.equal(byName.has('idx_ip_events_tenant'), false, 'idx_ip_events_tenant dropped');

    const defs = await h.db.raw(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('idx_ip_bans_active_banned_at', 'idx_ip_reputation_last_seen')`,
    ) as { rows: Array<{ indexname: string; indexdef: string }> };
    const def = (n: string) => defs.rows.find((r) => r.indexname === n)?.indexdef ?? '';
    assert.match(def('idx_ip_bans_active_banned_at'), /\(banned_at DESC\) WHERE is_active/);
    assert.match(def('idx_ip_reputation_last_seen'), /\(last_seen DESC NULLS LAST\)/);

    // EXPLAIN: tenant / device timelines are served by the composites (index
    // order = the ORDER BY, no sort node).
    const other = await createDevice(h.db, { tenantId: 3, keyId: (await createKey(h.db, 3)).id });
    const rowsToInsert: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3000; i++) {
      const t3 = i % 100 === 0; // a rare tenant: a timestamp-index scan + filter would read the whole table
      rowsToInsert.push({
        device_id: t3 ? other.id : deviceId, tenant_id: t3 ? 3 : 2, ip: litIp('198.18', 1 + (i % 200), 1 + (i % 250)),
        service: 'ssh', event_type: 'auth_failure', timestamp: new Date(Date.now() - i * 1000), raw_log: 'verify-89-plan',
      });
    }
    await h.db.batchInsert('ip_events', rowsToInsert, 500);
    await h.db.raw('ANALYZE ip_events');
    const planOf = async (sql: string, bindings: unknown[]): Promise<string> => h.db.transaction(async (trx) => {
      await trx.raw('SET LOCAL enable_seqscan = off');
      const r = await trx.raw(`EXPLAIN (FORMAT JSON) ${sql}`, bindings as any) as { rows: Array<Record<string, unknown>> };
      return JSON.stringify(r.rows[0]);
    });
    const tenantPlan = await planOf('SELECT id FROM ip_events WHERE tenant_id = ? ORDER BY "timestamp" DESC LIMIT 50', [3]);
    assert.match(tenantPlan, /idx_ip_events_tenant_ts/, `tenant timeline plan: ${tenantPlan}`);
    assert.doesNotMatch(tenantPlan, /"Node Type":"Sort"/);
    const devicePlan = await planOf('SELECT id FROM ip_events WHERE device_id = ? ORDER BY "timestamp" DESC LIMIT 50', [other.id]);
    assert.match(devicePlan, /idx_ip_events_device_ts/, `device timeline plan: ${devicePlan}`);
    assert.doesNotMatch(devicePlan, /"Node Type":"Sort"/);
    await h.db('ip_events').where({ raw_log: 'verify-89-plan' }).delete();
  });

  lotIt('W12-1', '89.2 retention settings: defaults, env fallback, bounds, explicit values and reset', async () => {
    const saved = process.env.IP_EVENTS_RETENTION_DAYS;
    try {
      delete process.env.IP_EVENTS_RETENTION_DAYS;
      let view = await appConfigService.getRetentionView();
      assert.equal(view.eventsDays.value, null);
      assert.equal(view.eventsDays.effective, 90);
      assert.equal(view.reputationDays.effective, 180);
      assert.equal(view.banHistoryDays.effective, 365);
      assert.equal(view.auditDays.min, RETENTION_DEFS.auditDays.min);

      process.env.IP_EVENTS_RETENTION_DAYS = '45';
      view = await appConfigService.getRetentionView();
      assert.equal(view.eventsDays.envValue, 45);
      assert.equal(view.eventsDays.effective, 45, 'env fallback when nothing is stored');

      process.env.IP_EVENTS_RETENTION_DAYS = '0';
      assert.equal((await appConfigService.getRetention()).eventsDays, RETENTION_DEFS.eventsDays.min, 'env clamped to the bounds');

      view = await appConfigService.setRetention({ eventsDays: 30, reputationDays: 60 });
      assert.equal(view.eventsDays.value, 30);
      assert.equal(view.eventsDays.effective, 30, 'stored value wins over env');
      assert.equal(view.reputationDays.effective, 60);
      assert.equal((await h.db('app_config').where({ key: 'retention.eventsDays' }).first('value'))?.value, '30');

      for (const bad of [{ eventsDays: 0 }, { eventsDays: 99999 }, { eventsDays: 12.5 }, { eventsDays: '30' }, { bogus: 30 }, { toString: 30 }, JSON.parse('{"__proto__": 30}'), {}, [], null]) {
        await assert.rejects(appConfigService.setRetention(bad), (err: unknown) => err instanceof AppError && err.statusCode === 400, JSON.stringify(bad));
      }
      // A rejected patch writes nothing (validation before any write).
      await assert.rejects(appConfigService.setRetention({ reputationDays: 90, eventsDays: -1 }));
      assert.equal((await appConfigService.getRetention()).reputationDays, 60);

      view = await appConfigService.setRetention({ eventsDays: null, reputationDays: null });
      assert.equal(view.eventsDays.value, null);
      assert.equal(view.reputationDays.effective, 180, 'null resets to the default');
      assert.equal(await h.db('app_config').where({ key: 'retention.reputationDays' }).first(), undefined);
    } finally {
      if (saved === undefined) delete process.env.IP_EVENTS_RETENTION_DAYS;
      else process.env.IP_EVENTS_RETENTION_DAYS = saved;
    }
  });

  lotIt('W12-1', '89.3 old rows are purged in batches, recent ones and protected IPs kept', async () => {
    await appConfigService.setRetention({ eventsDays: 30, reputationDays: 60, banHistoryDays: 90, auditDays: 100 });

    // ip_events: 7 old rows (batch size 3: three batches), 2 recent.
    const oldIp = litIp('192.0.2', 10);
    const oldEvents: number[] = [];
    for (let i = 0; i < 7; i++) oldEvents.push(await insertEvent(oldIp, 31 + i));
    const keptEvents = [await insertEvent(oldIp, 29), await insertEvent(oldIp, 1)];

    // ip_reputation: stale / stale+banned / stale+subnet banned / stale+whitelisted / recent / no last_seen.
    const ip = {
      stale: litIp('192.0.2', 20), banned: litIp('192.0.2', 21), subnet: litIp('198.19', 7, 9),
      legacySubnet: litIp('198.19', 8, 9),
      wl: litIp('192.0.2', 22), recent: litIp('192.0.2', 23), noSeenOld: litIp('192.0.2', 24),
      noSeenNew: litIp('192.0.2', 25), liftedBan: litIp('192.0.2', 26),
    };
    await insertReputation(ip.stale, 61);
    await insertReputation(ip.banned, 200);
    await insertReputation(ip.subnet, 200);
    await insertReputation(ip.legacySubnet, 200);
    await insertReputation(ip.wl, 200);
    await insertReputation(ip.recent, 59);
    await insertReputation(ip.noSeenOld, null, 70);
    await insertReputation(ip.noSeenNew, null, 10);
    await insertReputation(ip.liftedBan, 200);
    await insertBan(h.db, { ip: ip.banned, scope: 'global' });
    await insertBan(h.db, { ip: '198.19.7.0', cidrPrefix: 24, scope: 'global' });
    // Legacy subnet ban: prefix in the inet mask, cidr_prefix NULL.
    const legacyBan = await insertBan(h.db, { ip: '198.19.8.1', scope: 'global' });
    await h.db('ip_bans').where({ id: legacyBan }).update({ ip: h.db.raw(`'198.19.8.0/24'::inet`), cidr_prefix: null });
    await insertBan(h.db, { ip: ip.liftedBan, scope: 'global', isActive: false });
    await insertWhitelist(h.db, { ip: '192.0.2.22/32', scope: 'global' });
    await h.db('ip_reputation_tenant_clears').insert([
      { ip: ip.stale, tenant_id: 2, baseline_failures: 42 },
      { ip: ip.recent, tenant_id: 2, baseline_failures: 42 },
    ]);

    // ip_bans: old lifted / old expired (inactive) go; recent lifted, old active stay.
    const oldLifted = await insertBan(h.db, { ip: litIp('192.0.2', 30), isActive: false, bannedAt: daysAgo(400) });
    await h.db('ip_bans').where({ id: oldLifted }).update({ lifted_at: daysAgo(91) });
    await h.db('ip_ban_exclusions').insert({ ban_id: oldLifted, tenant_id: 2 });
    const oldExpired = await insertBan(h.db, { ip: litIp('192.0.2', 31), isActive: false, bannedAt: daysAgo(400), expiresAt: daysAgo(95) });
    const recentLifted = await insertBan(h.db, { ip: litIp('192.0.2', 32), isActive: false, bannedAt: daysAgo(400) });
    await h.db('ip_bans').where({ id: recentLifted }).update({ lifted_at: daysAgo(89) });
    const oldActive = await insertBan(h.db, { ip: litIp('192.0.2', 33), bannedAt: daysAgo(400) });

    // live alerts: resolved > 30 d go, open incident stays whatever its age.
    const [resolvedOld] = await h.db('live_alerts').insert({
      tenant_id: 2, severity: 'down', title: 'r', message: 'r', incident_kind: 'agent_offline',
      created_at: daysAgo(60), resolved_at: daysAgo(40),
    }).returning('id') as Array<{ id: number }>;
    const [openOld] = await h.db('live_alerts').insert({
      tenant_id: 2, severity: 'down', title: 'o', message: 'o', incident_kind: 'agent_offline',
      device_id: deviceId, stable_key: `agent_offline:${deviceId}:89`, created_at: daysAgo(60),
    }).returning('id') as Array<{ id: number }>;

    // audit_logs: past auditDays go.
    const [auditOld] = await h.db('audit_logs').insert({ action: 'verify.old', tenant_id: 2, created_at: daysAgo(101) }).returning('id') as Array<{ id: number }>;
    const [auditNew] = await h.db('audit_logs').insert({ action: 'verify.new', tenant_id: 2, created_at: daysAgo(99) }).returning('id') as Array<{ id: number }>;

    const res = await retentionService.runOnce({ batchSize: 3 });
    assert.ok(res, 'a pass ran');
    assert.deepEqual(res.failed, []);
    assert.equal(res.config.eventsDays, 30);

    assert.equal(res.events, 7);
    assert.equal(await h.db('ip_events').whereIn('id', oldEvents).first(), undefined, 'old events purged');
    assert.equal((await h.db('ip_events').whereIn('id', keptEvents).count<{ count: string }[]>('* as count'))[0].count, '2');

    assert.equal(await repExists(ip.stale), false, 'stale reputation purged');
    assert.equal(await repExists(ip.noSeenOld), false, 'never-seen row purged on updated_at');
    assert.equal(await repExists(ip.liftedBan), false, 'an inactive ban does not protect');
    assert.equal(await repExists(ip.banned), true, 'banned IP reputation kept');
    assert.equal(await repExists(ip.subnet), true, 'IP inside an active subnet ban kept');
    assert.equal(await repExists(ip.legacySubnet), true, 'IP inside a legacy masked subnet ban kept');
    assert.equal(await repExists(ip.wl), true, 'whitelisted IP reputation kept');
    assert.equal(await repExists(ip.recent), true, 'recent reputation kept');
    assert.equal(await repExists(ip.noSeenNew), true);
    assert.equal(res.reputation, 3);
    const clears = await h.db('ip_reputation_tenant_clears').whereIn('ip', [ip.stale, ip.recent]).pluck('ip');
    assert.deepEqual(clears, [ip.recent], 'the purged IP clear baseline goes with it');

    const bans = await h.db('ip_bans').whereIn('id', [oldLifted, oldExpired, recentLifted, oldActive]).pluck('id');
    assert.deepEqual(bans.sort((a, b) => a - b), [recentLifted, oldActive].sort((a, b) => a - b));
    assert.equal(await h.db('ip_ban_exclusions').where({ ban_id: oldLifted }).first(), undefined);

    assert.equal(await h.db('live_alerts').where({ id: resolvedOld.id }).first(), undefined, 'old resolved alert purged');
    assert.ok(await h.db('live_alerts').where({ id: openOld.id }).first(), 'open incident kept');

    assert.equal(await h.db('audit_logs').where({ id: auditOld.id }).first(), undefined);
    assert.ok(await h.db('audit_logs').where({ id: auditNew.id }).first());

    // Idempotent: a second pass finds nothing more.
    const again = await retentionService.runOnce({ batchSize: 3 });
    assert.ok(again);
    assert.equal(again.events + again.reputation + again.bans + again.audit, 0);
    await appConfigService.setRetention({ eventsDays: null, reputationDays: null, banHistoryDays: null, auditDays: null });
  });

  lotIt('W12-1', '89.4 orphan group/agent references are deleted, live ones kept', async () => {
    const gone = await createGroup(h.db, { tenantId: 2 });
    const live = await createGroup(h.db, { tenantId: 2 });
    const goneDev = await createDevice(h.db, { tenantId: 2, keyId });
    const [team] = await h.db('user_teams').insert({ name: `t89-${Date.now()}`, tenant_id: 2 }).returning('id') as Array<{ id: number }>;
    const [channel] = await h.db('notification_channels').insert({ name: 'c89', type: 'webhook', tenant_id: 2 }).returning('id') as Array<{ id: number }>;

    await h.db('team_permissions').insert([
      { team_id: team.id, scope: 'group', scope_id: gone, level: 'ro' },
      { team_id: team.id, scope: 'group', scope_id: live, level: 'ro' },
      { team_id: team.id, scope: 'agent', scope_id: goneDev.id, level: 'rw' },
      { team_id: team.id, scope: 'agent', scope_id: deviceId, level: 'rw' },
    ]);
    await h.db('notification_bindings').insert([
      { channel_id: channel.id, scope: 'group', scope_id: gone, tenant_id: 2 },
      { channel_id: channel.id, scope: 'agent', scope_id: deviceId, tenant_id: 2 },
      { channel_id: channel.id, scope: 'agent', scope_id: goneDev.id, tenant_id: 2 },
      { channel_id: channel.id, scope: 'global', scope_id: null, tenant_id: 2 },
    ]);
    const wlGone = await insertWhitelist(h.db, { ip: '192.0.2.200/32', scope: 'agent', scopeId: goneDev.id, tenantId: 2 });
    const wlLive = await insertWhitelist(h.db, { ip: '192.0.2.201/32', scope: 'group', scopeId: live, tenantId: 2 });
    const wlTenant = await insertWhitelist(h.db, { ip: '192.0.2.202/32', scope: 'tenant', scopeId: 2, tenantId: 2 });

    await h.db('monitor_groups').where({ id: gone }).delete();
    await h.db('agent_devices').where({ id: goneDev.id }).delete();

    const res = await retentionService.runOnce();
    assert.ok(res);
    assert.deepEqual(res.failed, []);
    assert.ok(res.orphans >= 5, `orphans deleted: ${res.orphans}`);

    const perms = await h.db('team_permissions').where({ team_id: team.id }).select('scope', 'scope_id');
    assert.deepEqual(
      perms.map((p) => `${p.scope}:${p.scope_id}`).sort(),
      [`agent:${deviceId}`, `group:${live}`].sort(),
    );
    const binds = await h.db('notification_bindings').where({ channel_id: channel.id }).select('scope', 'scope_id');
    assert.deepEqual(
      binds.map((b) => `${b.scope}:${b.scope_id ?? ''}`).sort(),
      [`agent:${deviceId}`, 'global:'].sort(),
    );
    const wl = await h.db('ip_whitelist').whereIn('id', [wlGone, wlLive, wlTenant]).pluck('id');
    assert.deepEqual(wl.sort((a, b) => a - b), [wlLive, wlTenant].sort((a, b) => a - b));
  });

  lotIt('W12-1', '89.5 re-entrancy guard: a pass started while one runs is skipped', async () => {
    // Enough old rows for a multi-batch pass, so the first one is still running.
    const ip = litIp('192.0.2', 40);
    const rows = Array.from({ length: 50 }, () => ({
      device_id: deviceId, tenant_id: 2, ip, service: 'ssh', event_type: 'auth_failure',
      timestamp: daysAgo(400), raw_log: 'verify-89-reentry',
    }));
    await h.db('ip_events').insert(rows);

    const first = retentionService.runOnce({ batchSize: 5 });
    assert.equal(retentionService.isRunning(), true);
    const second = await retentionService.runOnce({ batchSize: 5 });
    assert.equal(second, null, 'overlapping pass skipped');
    const done = await first;
    assert.ok(done);
    assert.equal(done.events, 50);
    assert.equal(retentionService.isRunning(), false);

    const third = await retentionService.runOnce();
    assert.ok(third, 'the guard is released after the pass');
  });

  // Route wiring belongs to the integration lot (controller / routes /
  // routePermissions are not W12-1 files): GET / PUT /api/admin/config/retention.
  lotIt('W12-6', '89.6 /api/admin/config/retention: platform admin read and validated write', async () => {
    const admin = await h.adminIn(1);
    const get = await admin.get('/api/admin/config/retention');
    assert.equal(get.status, 200, get.text);
    assert.equal(get.json.data.eventsDays.default, 90);
    assert.equal(typeof get.json.data.auditDays.max, 'number');

    const bad = await admin.put('/api/admin/config/retention', { eventsDays: 0 });
    assert.equal(bad.status, 400, bad.text);
    const ok = await admin.put('/api/admin/config/retention', { eventsDays: 120 });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.data.eventsDays.effective, 120);
    const audit = await h.db('audit_logs').where({ action: 'app_config.updated', target_id: 'retention' }).first();
    assert.ok(audit, 'retention write audited');

    const member = await h.as('member_b');
    assert.equal((await member.get('/api/admin/config/retention')).status, 403);
    assert.equal((await member.put('/api/admin/config/retention', { eventsDays: 60 })).status, 403);
    await admin.put('/api/admin/config/retention', { eventsDays: null });
  });
});
