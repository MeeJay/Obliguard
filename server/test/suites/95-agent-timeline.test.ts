/**
 * 95 — W13-2 per-agent activity timeline (DATA-REALTIME-20, Obliance
 * changeEvent.service pattern): GET /api/agent/devices/:id/timeline.
 *
 *   95.1 one agent's history mixes every kind, newest first: bans reaching
 *        it (its own, its group's, a global ban on an address that attacked
 *        it; an unrelated global ban and another agent's ban are absent), a
 *        lifted ban, an attack burst (5 min bucket at or above the
 *        threshold), an update attempt, an offline / online incident,
 *        enrolment and approval, a firewall rule change (audit row); the
 *        audit-backed kinds are dropped without audit.read
 *   95.2 a foreign agent answers 404 (another tenant, a team restriction
 *        aside); the Default god view reads it
 *   95.3 caps: window > 30 days, limit > 500, from >= to and an unknown
 *        kind answer 400; the row cap sets truncated and keeps the newest;
 *        ?kinds= narrows the served kinds
 *   95.4 client: Timeline tab registered on AgentDetailPage (the W11-1
 *        Activity tab merged into it, ?tab=activity lands on it)
 *   95.5 ban audience edges: global CIDR bans (v4 and v6) covering an
 *        attacker are listed, a global ban the tenant excluded and another
 *        tenant's tenant ban are not; a global ban's author is shown to the
 *        Default god view only; audit rows carry their request origin
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { ADMIN_B } from '../fixtures';
import { createDevice, createGroup, createUser, litIp, nextIp } from '../seed';
import { ATTACK_BURST_MIN_FAILURES } from '../../src/services/agentTimeline.service';

const REPO = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

interface TimelineEvent { id: string; kind: string; at: string; actor: string | null; payload: Record<string, any> }
interface Timeline {
  formatVersion: number; deviceId: number; from: string; to: string; order: string;
  kinds: string[]; limit: number; truncated: boolean; count: number; events: TimelineEvent[];
}

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

describe('95 agent timeline (W13-2)', () => {
  let h: Harness;
  let dev: { id: number };
  let other: { id: number };
  let foreign: { id: number };
  let groupId: number;
  const ips = { own: '', group: '', global: '', unrelated: '', otherAgent: '', lifted: '' };

  before(async () => {
    h = await startHarness();
    const row = await h.db('users').where({ username: ADMIN_B.username }).first('id') as { id: number } | undefined;
    if (!row) {
      await createUser(h.db, { username: ADMIN_B.username, tenants: [ADMIN_B.tenant], tenantRole: ADMIN_B.tenantRole });
    } else {
      await h.db('user_tenants').where({ user_id: row.id, tenant_id: ADMIN_B.tenant }).update({ role: ADMIN_B.tenantRole });
    }

    groupId = await createGroup(h.db, { tenantId: 2 });
    dev = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId });
    other = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    foreign = await createDevice(h.db, { tenantId: 1, keyId: 1 });
    await h.db('agent_devices').where({ id: dev.id }).update({ created_at: ago(300 * MIN), approved_at: ago(290 * MIN) });

    for (const k of Object.keys(ips) as Array<keyof typeof ips>) ips[k] = nextIp();
    const ban = (o: Record<string, unknown>) => h.db('ip_bans').insert({ ban_type: 'manual', is_active: true, ...o });
    await ban({ ip: ips.own, scope: 'agent', scope_id: dev.id, tenant_id: 2, banned_at: ago(200 * MIN), reason: 'own agent ban' });
    await ban({ ip: ips.group, scope: 'group', scope_id: groupId, tenant_id: 2, banned_at: ago(190 * MIN) });
    await ban({ ip: ips.global, scope: 'global', ban_type: 'auto', banned_at: ago(100 * MIN) });
    await ban({ ip: ips.unrelated, scope: 'global', ban_type: 'auto', banned_at: ago(99 * MIN) });
    await ban({ ip: ips.otherAgent, scope: 'agent', scope_id: other.id, tenant_id: 2, banned_at: ago(98 * MIN) });
    await ban({
      ip: ips.lifted, scope: 'agent', scope_id: dev.id, tenant_id: 2, banned_at: ago(180 * MIN),
      is_active: false, lifted_at: ago(170 * MIN), lift_reason: 'lift',
    });

    // Attack burst: the global ban's address, enough failures in one 5 min bucket.
    const bucketStart = Math.floor((Date.now() - 120 * MIN) / 300_000) * 300_000;
    const events = Array.from({ length: ATTACK_BURST_MIN_FAILURES + 2 }, (_, i) => ({
      device_id: dev.id, tenant_id: 2, ip: ips.global, service: 'ssh', event_type: 'auth_failure',
      username: 'root', timestamp: new Date(bucketStart + 1000 + i * 1000),
    }));
    await h.db('ip_events').insert(events);
    // Below the threshold: no burst.
    await h.db('ip_events').insert({
      device_id: dev.id, tenant_id: 2, ip: ips.global, service: 'ssh', event_type: 'auth_failure', timestamp: ago(30 * MIN),
    });

    await h.db('agent_update_attempts').insert({
      device_id: dev.id, target_version: '9.9.9', phase: 'failed', offered_count: 3, last_error: 'no_progress',
      created_at: ago(80 * MIN), updated_at: ago(60 * MIN), finished_at: ago(60 * MIN),
    });
    await h.db('live_alerts').insert({
      tenant_id: 2, severity: 'down', title: 'Agent offline', message: 'x', stable_key: `agent_offline:device:${dev.id}`,
      incident_kind: 'agent_offline', device_id: dev.id, created_at: ago(50 * MIN), resolved_at: ago(40 * MIN),
    });
    await h.db('audit_logs').insert({
      tenant_id: 2, user_id: null, username: 'admin_b', action: 'firewall.rule_added', target_type: 'agent',
      target_id: String(dev.id), device_id: dev.id, details: JSON.stringify({ rule: { localPort: '22' } }), created_at: ago(20 * MIN),
    });
    await h.db('audit_logs').insert({
      tenant_id: 2, username: 'admin_b', action: 'bans.created', device_id: dev.id, created_at: ago(19 * MIN),
    });
  });
  after(async () => { await h.close(); });

  const timeline = async (who: string | number, id: number, query = ''): Promise<{ status: number; text: string; data: Timeline }> => {
    const c = typeof who === 'number' ? await h.adminIn(who) : await h.as(who);
    const r = await c.get(`/api/agent/devices/${id}/timeline${query}`);
    return { status: r.status, text: r.text, data: r.json?.data as Timeline };
  };

  lotIt('W13-2', '95.1 mixed kinds, newest first; bans by delivery audience; audit kinds need audit.read', async () => {
    const r = await timeline(ADMIN_B.username, dev.id);
    assert.equal(r.status, 200, r.text);
    const t = r.data;
    assert.equal(t.formatVersion, 1);
    assert.equal(t.order, 'desc');
    assert.equal(t.truncated, false);
    assert.equal(t.count, t.events.length);

    const kinds = new Set(t.events.map((e) => e.kind));
    for (const k of ['ban_applied', 'ban_lifted', 'attack_burst', 'agent_update', 'offline', 'online', 'approval', 'firewall_change']) {
      assert.ok(kinds.has(k), `kind ${k} present (got ${[...kinds].join(',')})`);
      assert.ok(t.kinds.includes(k), `kind ${k} served`);
    }
    const times = t.events.map((e) => Date.parse(e.at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
    assert.equal(new Set(t.events.map((e) => e.id)).size, t.events.length, 'unique ids');

    const banned = t.events.filter((e) => e.kind === 'ban_applied').map((e) => e.payload.target);
    assert.ok(banned.includes(ips.own), 'agent-scoped ban');
    assert.ok(banned.includes(ips.group), 'ban of its group');
    assert.ok(banned.includes(ips.global), 'global ban of an address that attacked it');
    assert.ok(!banned.includes(ips.unrelated), 'unrelated global ban absent');
    assert.ok(!banned.includes(ips.otherAgent), "another agent's ban absent");
    const lifted = t.events.find((e) => e.kind === 'ban_lifted');
    assert.equal(lifted?.payload.target, ips.lifted);
    assert.equal(lifted?.payload.liftReason, 'lift');

    const bursts = t.events.filter((e) => e.kind === 'attack_burst');
    assert.equal(bursts.length, 1, 'one bucket above the threshold');
    assert.equal(bursts[0].payload.failures, ATTACK_BURST_MIN_FAILURES + 2);
    assert.equal(bursts[0].payload.topIp, ips.global);

    const upd = t.events.find((e) => e.kind === 'agent_update' && e.payload.targetVersion === '9.9.9');
    assert.equal(upd?.payload.phase, 'failed');
    assert.ok(t.events.some((e) => e.kind === 'approval' && e.payload.step === 'enrolled'));
    assert.ok(t.events.some((e) => e.kind === 'approval' && e.payload.step === 'approved'));
    const fw = t.events.find((e) => e.kind === 'firewall_change');
    assert.equal(fw?.payload.action, 'firewall.rule_added');
    assert.equal(fw?.actor, 'admin_b');
    assert.ok(!t.events.some((e) => e.payload.action === 'bans.created'), 'ban audit rows are owned by the ban kinds');

    // Without audit.read: no audit rows, the audit-only kinds are not served.
    const m = await timeline('member_b', dev.id);
    assert.equal(m.status, 200, m.text);
    assert.ok(!m.data.kinds.includes('firewall_change') && !m.data.kinds.includes('config_change'));
    assert.ok(m.data.events.every((e) => !e.id.startsWith('audit_logs:')), 'no audit rows');
    assert.ok(m.data.events.some((e) => e.kind === 'ban_applied'));
    assert.ok(m.data.events.some((e) => e.kind === 'approval' && e.payload.step === 'approved'));
  });

  lotIt('W13-2', '95.2 a foreign agent answers 404; the Default god view reads it', async () => {
    assert.equal((await timeline(ADMIN_B.username, foreign.id)).status, 404, 'tenant 1 agent from tenant 2');
    assert.equal((await timeline('member_c', dev.id)).status, 404, 'tenant 2 agent from tenant 3');
    assert.equal((await timeline(ADMIN_B.username, 2147483000)).status, 404, 'unknown agent');
    assert.equal((await timeline(ADMIN_B.username, 0)).status, 400, 'invalid id');
    const god = await timeline(1, dev.id);
    assert.equal(god.status, 200, god.text);
    assert.ok(god.data.events.some((e) => e.kind === 'firewall_change'));
  });

  lotIt('W13-2', '95.3 window and limit caps, truncated flag, kinds filter', async () => {
    const to = new Date();
    const q = (from: Date, extra = '') => `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}${extra}`;
    assert.equal((await timeline(ADMIN_B.username, dev.id, q(new Date(to.getTime() - 31 * 24 * 60 * MIN)))).status, 400, 'window > 30 days');
    const ok30 = await timeline(ADMIN_B.username, dev.id, q(new Date(to.getTime() - 30 * 24 * 60 * MIN)));
    assert.equal(ok30.status, 200, ok30.text);
    assert.equal((await timeline(ADMIN_B.username, dev.id, q(new Date(to.getTime() - MIN), '&limit=501'))).status, 400, 'limit > 500');
    assert.equal((await timeline(ADMIN_B.username, dev.id, q(new Date(to.getTime() + MIN)))).status, 400, 'from after to');
    assert.equal((await timeline(ADMIN_B.username, dev.id, '?kinds=nope')).status, 400, 'unknown kind');
    assert.equal((await timeline(ADMIN_B.username, dev.id, '?from=yesterday')).status, 400, 'bad date');

    const full = ok30.data;
    assert.ok(full.events.length > 3);
    const cut = await timeline(ADMIN_B.username, dev.id, q(new Date(to.getTime() - 30 * 24 * 60 * MIN), '&limit=3'));
    assert.equal(cut.status, 200, cut.text);
    assert.equal(cut.data.truncated, true);
    assert.equal(cut.data.count, 3);
    assert.deepEqual(cut.data.events.map((e) => e.id), full.events.slice(0, 3).map((e) => e.id), 'the newest rows are kept');

    const bans = await timeline(ADMIN_B.username, dev.id, '?kinds=ban_applied,ban_lifted');
    assert.equal(bans.status, 200, bans.text);
    assert.deepEqual(bans.data.kinds, ['ban_applied', 'ban_lifted']);
    assert.ok(bans.data.events.length > 0 && bans.data.events.every((e) => e.kind.startsWith('ban_')));
    // A kind the caller may not read is dropped, not refused.
    const m = await timeline('member_b', dev.id, '?kinds=firewall_change,online');
    assert.equal(m.status, 200, m.text);
    assert.deepEqual(m.data.kinds, ['online']);
  });

  lotIt('W13-2', '95.4 client: Timeline tab on AgentDetailPage absorbs the Activity tab', () => {
    const page = read('client/src/pages/AgentDetailPage.tsx');
    assert.match(page, /from '\.\/agentDetail\/TimelineTab'/);
    assert.match(page, /TIMELINE_TAB_ID/);
    assert.doesNotMatch(page, /<ActivityTab\b/, 'no separate Activity tab');
    assert.match(page, /activity: TIMELINE_TAB_ID/, '?tab=activity bookmarks land on Timeline');
    const tab = read('client/src/pages/agentDetail/TimelineTab.tsx');
    assert.match(tab, /\/agent\/devices\/\$\{[^}]+\}\/timeline/);
    assert.match(tab, /audit-log\?device=/, 'link to the full audit log');
    for (const call of tab.match(/\bt\('agentDetail\.[^)]*\)/g) ?? []) {
      assert.match(call, /defaultValue/, call);
    }
  });

  lotIt('W13-2', '95.5 ban audience edges, global ban author, audit request origin', async () => {
    const author = await h.db('users').where({ username: ADMIN_B.username }).first('id') as { id: number };
    const attackerV4 = litIp('198.18', 95, 77);
    const attackerV6 = litIp('2001:db8', 0x95, 7);
    const excludedIp = litIp('198.18', 97, 5);
    const foreignTenantIp = litIp('198.18', 98, 1);
    const evt = (ip: string) => ({
      device_id: dev.id, tenant_id: 2, ip, service: 'ssh', event_type: 'auth_failure', timestamp: ago(15 * MIN),
    });
    await h.db('ip_events').insert([evt(attackerV4), evt(attackerV6), evt(excludedIp)]);

    const ban = async (o: Record<string, unknown>): Promise<number> => {
      const [row] = await h.db('ip_bans').insert({ ban_type: 'manual', is_active: true, banned_at: ago(10 * MIN), ...o }).returning('id');
      return typeof row === 'object' ? (row as { id: number }).id : Number(row);
    };
    await ban({ ip: '198.18.95.0', cidr_prefix: 24, scope: 'global', banned_by_user_id: author.id });
    await ban({ ip: '2001:db8:95::', cidr_prefix: 48, scope: 'global' });
    await ban({ ip: '198.18.96.0', cidr_prefix: 24, scope: 'global' }); // no attacker inside
    const excluded = await ban({ ip: excludedIp, scope: 'global' });
    await h.db('ip_ban_exclusions').insert({ ban_id: excluded, tenant_id: 2 });
    await ban({ ip: foreignTenantIp, scope: 'tenant', tenant_id: 3 });
    await h.db('audit_logs').insert({
      tenant_id: 2, username: 'admin_b', action: 'agent.updated', device_id: dev.id, created_at: ago(5 * MIN),
      ip_address: '192.0.2.44', user_agent: 'verify-95',
    });

    const r = await timeline(ADMIN_B.username, dev.id, '?kinds=ban_applied,config_change');
    assert.equal(r.status, 200, r.text);
    const targets = r.data.events.filter((e) => e.kind === 'ban_applied').map((e) => e.payload.target);
    assert.ok(targets.includes('198.18.95.0/24'), `v4 CIDR global ban covering an attacker (${targets.join(',')})`);
    assert.ok(targets.includes('2001:db8:95::/48'), `v6 CIDR global ban covering an attacker (${targets.join(',')})`);
    assert.ok(!targets.includes('198.18.96.0/24'), 'global CIDR ban without attacker absent');
    assert.ok(!targets.includes(excludedIp), 'global ban excluded by the tenant absent');
    assert.ok(!targets.includes(foreignTenantIp), "another tenant's tenant ban absent");
    const cidrBan = r.data.events.find((e) => e.payload.target === '198.18.95.0/24');
    assert.equal(cidrBan?.actor, null, 'global ban author hidden outside Default');
    const cfg = r.data.events.find((e) => e.kind === 'config_change' && e.payload.action === 'agent.updated');
    assert.equal(cfg?.payload.ipAddress, '192.0.2.44');
    assert.equal(cfg?.payload.userAgent, 'verify-95');

    const god = await timeline(1, dev.id, '?kinds=ban_applied');
    assert.equal(god.status, 200, god.text);
    assert.equal(
      god.data.events.find((e) => e.payload.target === '198.18.95.0/24')?.actor, ADMIN_B.username,
      'author shown to the Default god view',
    );
  });
});
