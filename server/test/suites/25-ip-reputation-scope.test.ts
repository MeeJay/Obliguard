/**
 * 25 — A2 IP reputation scoping: one row per IP (LATERAL ban / whitelist
 * joins), customer tenants see neither other tenants' local bans nor their
 * local whitelist entries, and their per-IP totals come from their own
 * ip_events only. Default keeps the global view.
 *
 * Literal block of this suite: 192.0.2.77 (C-local whitelist).
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, hostOf } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { insertBan, insertWhitelist, nextIp } from '../seed';
import { D } from '../fixtures';
import { mikrotikBanSync } from '../../src/services/mikrotik/mikrotikBanSync.service';

interface EvOpts { deviceId: number; tenantId: number; ip: string; count: number; username?: string; service?: string }

describe('25 ip reputation scope (A2)', () => {
  let h: Harness;
  const savedPush = mikrotikBanSync.pushBanToAll;
  before(async () => {
    h = await startHarness();
    (mikrotikBanSync as any).pushBanToAll = async () => { /* no router in this suite */ };
  });
  after(async () => {
    (mikrotikBanSync as any).pushBanToAll = savedPush;
    await h.close();
  });

  const events = async (o: EvOpts) => {
    const ts = new Date(Date.now() - 60_000);
    await h.db('ip_events').insert(Array.from({ length: o.count }, () => ({
      device_id: o.deviceId, tenant_id: o.tenantId, ip: o.ip, username: o.username ?? 'root',
      service: o.service ?? 'ssh', event_type: 'auth_failure', timestamp: ts, raw_log: 'verify', track_only: false,
    })));
  };
  const reputation = async (ip: string, o: { failures: number; usernames: string[]; services: string[]; agents: number }) => {
    const now = new Date();
    await h.db('ip_reputation').insert({
      ip, total_failures: o.failures, total_successes: 0, affected_agents_count: o.agents,
      affected_services: o.services, attempted_usernames: o.usernames,
      first_seen: now, last_seen: now, updated_at: now,
    }).onConflict('ip').merge();
  };
  const list = async (who: string, status: string, ip: string) => {
    const c = await h.as(who);
    const st = status === 'all' ? '' : `status=${status}&`;
    const r = await c.get(`/api/ip-reputation?${st}search=${encodeURIComponent(ip)}&limit=100`);
    assert.equal(r.status, 200, `${who} list ${status}`);
    return { rows: (r.json.data as any[]).filter((x) => hostOf(x.ip) === ip), total: Number(r.json.total) };
  };

  lotIt('A2', '25.1 an IP banned locally by two tenants is listed once', async () => {
    const ip = nextIp();
    await reputation(ip, { failures: 4, usernames: ['root'], services: ['ssh'], agents: 2 });
    await events({ deviceId: D.B.id, tenantId: 2, ip, count: 2 });
    await events({ deviceId: D.C.id, tenantId: 3, ip, count: 2 });
    assert.equal((await (await h.as('member_b')).post('/api/bans', { ip })).status, 201);
    assert.equal((await (await h.as('member_c')).post('/api/bans', { ip })).status, 201);
    const all = await list('default_member', 'all', ip);
    assert.equal(all.rows.length, 1);
    assert.equal(all.total, 1);
    assert.equal(all.rows[0].status, 'banned');
    const banned = await list('default_member', 'banned', ip);
    assert.equal(banned.rows.length, 2);
    assert.equal(new Set(banned.rows.map((r) => r.activeBanId)).size, 2);
    const active = await h.db('ip_bans').whereRaw('host(ip) = ?', [ip]).where({ is_active: true });
    assert.equal(active.length, 2);
  });

  lotIt('A2', '25.2 a customer tenant never sees another tenant local ban', async () => {
    const ip = nextIp();
    await reputation(ip, { failures: 2, usernames: ['root'], services: ['ssh'], agents: 1 });
    await events({ deviceId: D.C.id, tenantId: 3, ip, count: 2 });
    const bBan = await insertBan(h.db, { ip, scope: 'tenant', tenantId: 2, originTenantId: 2 });

    const cBanned = await list('member_c', 'banned', ip);
    assert.ok(!cBanned.rows.some((r) => r.activeBanId === bBan));
    const cAll = await list('member_c', 'all', ip);
    assert.equal(cAll.rows.length, 1);
    assert.notEqual(cAll.rows[0].status, 'banned');
    assert.equal(cAll.rows[0].activeBanId, null);
    const detail = await (await h.as('member_c')).get(`/api/ip-reputation/${encodeURIComponent(ip)}`);
    assert.equal(detail.status, 200);
    assert.notEqual(detail.json.data.reputation.status, 'banned');
    const dBanned = await list('default_member', 'banned', ip);
    assert.ok(dBanned.rows.some((r) => r.activeBanId === bBan));

    // A global ban made by Default: listed for C, without its author.
    const g = nextIp();
    const gr = await (await h.as('default_member')).post('/api/bans', { ip: g });
    assert.equal(gr.status, 201);
    const cg = await list('member_c', 'banned', g);
    assert.equal(cg.rows.length, 1);
    assert.equal(cg.rows[0].bannedByUserId, null);
    const dg = await list('default_member', 'banned', g);
    assert.notEqual(dg.rows[0].bannedByUserId, null);
  });

  lotIt('A2', '25.3 customer totals come from the tenant own events', async () => {
    const ip = nextIp();
    await events({ deviceId: D.B.id, tenantId: 2, ip, count: 3, username: 'alice', service: 'ssh' });
    await events({ deviceId: D.C.id, tenantId: 3, ip, count: 2, username: 'carol', service: 'rdp' });
    await reputation(ip, { failures: 5, usernames: ['alice', 'carol'], services: ['ssh', 'rdp'], agents: 2 });

    const detail = await (await h.as('member_c')).get(`/api/ip-reputation/${encodeURIComponent(ip)}`);
    assert.equal(detail.status, 200);
    const rep = detail.json.data.reputation;
    assert.deepEqual(rep.attemptedUsernames, ['carol']);
    assert.deepEqual(rep.affectedServices, ['rdp']);
    assert.equal(rep.affectedAgentsCount, 1);
    assert.equal(rep.totalFailures, 2);
    assert.ok(detail.json.data.recentEvents.every((e: any) => e.username !== 'alice'));

    const row = (await list('member_c', 'all', ip)).rows[0];
    assert.deepEqual(row.attemptedUsernames, ['carol']);
    assert.deepEqual(row.affectedServices, ['rdp']);
    assert.equal(row.affectedAgentsCount, 1);
    assert.equal(row.totalFailures, 2);

    const dRow = (await list('default_member', 'all', ip)).rows[0];
    assert.equal(dRow.totalFailures, 5);
    assert.deepEqual([...dRow.attemptedUsernames].sort(), ['alice', 'carol']);
  });

  lotIt('A2', '25.4 another tenant local whitelist entry is not reflected', async () => {
    const ip = '192.0.2.77';
    await reputation(ip, { failures: 2, usernames: ['root'], services: ['ssh'], agents: 2 });
    await events({ deviceId: D.B.id, tenantId: 2, ip, count: 1 });
    await events({ deviceId: D.C.id, tenantId: 3, ip, count: 1 });
    await insertWhitelist(h.db, { ip: '192.0.2.77/32', scope: 'tenant', tenantId: 3 });

    const bRow = (await list('member_b', 'all', ip)).rows[0];
    assert.ok(bRow);
    assert.notEqual(bRow.status, 'whitelisted');
    const bDetail = await (await h.as('member_b')).get(`/api/ip-reputation/${ip}`);
    assert.notEqual(bDetail.json.data.reputation.status, 'whitelisted');
    const cRow = (await list('member_c', 'all', ip)).rows[0];
    assert.equal(cRow.status, 'whitelisted');
    const cDetail = await (await h.as('member_c')).get(`/api/ip-reputation/${ip}`);
    assert.equal(cDetail.json.data.reputation.status, 'whitelisted');
  });
});
