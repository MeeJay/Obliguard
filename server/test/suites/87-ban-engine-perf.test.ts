/**
 * 87 — ban engine cycle performance (W11-3 / D17): one evaluation cycle runs
 * a constant number of queries (one ancestry query, a batched template
 * resolver, one grouped aggregate per template window, batched ban
 * creation and attack marking), with the same bans as the per-agent
 * reference evaluation.
 *
 * Scenario: 50 agents over a group tree of tenant 2 (P > C1, C2), an
 * evaluate-only tree (E > EC) and a tenant 3 group Q; built-in SSH, FTP and
 * MySQL templates opted in at P (FTP threshold 3, MySQL window 120 s), SSH
 * at Q plus a group-owned Nginx template of Q, a track-mode local template
 * of C2, an agent-level unbind and an agent-level threshold override.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, sleep, waitFor, hostOf } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup, insertBan, insertEvents, insertWhitelist, litIp, nextIp } from '../seed';
import { banEngine, banService } from '../../src/services/ban.service';
import { SOCKET_EVENTS } from '@obliview/shared';
import { serviceTemplateService } from '../../src/services/serviceTemplate.service';
import { notificationService } from '../../src/services/notification.service';
import { ensureInfraFresh } from '../../src/utils/protectedIps';
import { parseIpOrCidr } from '../../src/utils/ipValidation';

/** Constant query budget of a cycle that creates no ban (spec: e.g. 20). */
const STEADY_BUDGET = 20;
/**
 * Budget of a cycle that creates bans: the steady budget (batched creation
 * and attack marking included) plus the fire-and-forget MikroTik push each
 * new ban starts (a router lookup, a geo lookup at most).
 */
const createBudget = (bans: number) => STEADY_BUDGET + 2 * bans;

const WATERMARK_SQL = `ip_events.timestamp > COALESCE((
  SELECT max(lb.lifted_at) FROM ip_bans lb
   WHERE lb.ip = ip_events.ip AND lb.scope = 'global' AND lb.lifted_at IS NOT NULL
     AND lb.lift_reason IS DISTINCT FROM 'remote_sync'
), '-infinity'::timestamptz)`;

describe('87 ban engine cycle performance', () => {
  let h: Harness;
  const tpl: Record<'ssh' | 'ftp' | 'mysql', number> = { ssh: 0, ftp: 0, mysql: 0 };
  let c1: Array<{ id: number }> = [];
  let c2: Array<{ id: number }> = [];
  let ec: Array<{ id: number }> = [];
  let q: Array<{ id: number }> = [];
  const ip = {} as Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N', string>;

  /** Queries issued on the server pool while `fn` runs (infra cache refreshed first: 60 s TTL). */
  const countQueries = async (fn: () => Promise<unknown>): Promise<number> => {
    await ensureInfraFresh();
    let n = 0;
    const onQuery = () => { n++; };
    h.db.on('query', onQuery);
    try { await fn(); } finally { h.db.removeListener('query', onQuery); }
    return n;
  };

  /** Notifications are stubbed: recorded (device, ip), never sent. */
  const sent: Array<{ deviceId: number; label: string; ip: string }> = [];
  const origSend = notificationService.sendForAgent;

  before(async () => {
    h = await startHarness();
    notificationService.sendForAgent = (async (deviceId: number, label: string, _n: string, _p: string, _v?: string[], _t?: string, details?: { ip?: string }) => {
      sent.push({ deviceId, label, ip: String(details?.ip ?? '') });
    }) as typeof origSend;

    for (const t of ['ssh', 'ftp', 'mysql'] as const) {
      const row = await h.db('service_templates').where({ service_type: t, is_builtin: true }).whereNull('owner_scope').first('id');
      assert.ok(row, `built-in ${t}`);
      tpl[t] = row.id;
    }

    const P = await createGroup(h.db, { tenantId: 2 });
    const C1 = await createGroup(h.db, { tenantId: 2 });
    const C2 = await createGroup(h.db, { tenantId: 2 });
    const E = await createGroup(h.db, { tenantId: 2, evaluateOnly: true });
    const EC = await createGroup(h.db, { tenantId: 2 });
    const Q = await createGroup(h.db, { tenantId: 3 });
    await h.db('group_closure').insert([
      { ancestor_id: P, descendant_id: C1, depth: 1 },
      { ancestor_id: P, descendant_id: C2, depth: 1 },
      { ancestor_id: E, descendant_id: EC, depth: 1 },
    ]);
    await h.db('service_template_assignments').insert([
      { template_id: tpl.ssh, scope: 'group', scope_id: P, enabled_override: true },
      { template_id: tpl.ftp, scope: 'group', scope_id: P, enabled_override: true, threshold_override: 3 },
      { template_id: tpl.mysql, scope: 'group', scope_id: P, enabled_override: true, window_seconds_override: 120 },
      { template_id: tpl.ssh, scope: 'group', scope_id: E, enabled_override: true },
      { template_id: tpl.ssh, scope: 'group', scope_id: Q, enabled_override: true },
    ]);
    await h.db('service_templates').insert([
      { name: 'Q local web', service_type: 'nginx', is_builtin: false, threshold: 4, window_seconds: 300, enabled: true, mode: 'ban', tenant_id: 3, owner_scope: 'group', owner_scope_id: Q },
      { name: 'C2 mail watch', service_type: 'mail', is_builtin: false, threshold: 2, window_seconds: 300, enabled: true, mode: 'track', tenant_id: 2, owner_scope: 'group', owner_scope_id: C2 },
    ]);

    const make = async (n: number, tenantId: 2 | 3, groupId: number) => {
      const out: Array<{ id: number }> = [];
      for (let i = 0; i < n; i++) out.push(await createDevice(h.db, { tenantId, keyId: tenantId, groupId }));
      return out;
    };
    c1 = await make(20, 2, C1);
    c2 = await make(20, 2, C2);
    ec = await make(5, 2, EC);
    q = await make(5, 3, Q);
    // Agent-level overrides: c1[1] unbinds SSH, c1[2] bans SSH at 2 failures.
    await h.db('service_template_assignments').insert([
      { template_id: tpl.ssh, scope: 'agent', scope_id: c1[1].id, enabled_override: false },
      { template_id: tpl.ssh, scope: 'agent', scope_id: c1[2].id, threshold_override: 2 },
    ]);

    // Warm-up cycle (protected set, infra cache, burst sweep).
    await banEngine.run();

    for (const k of Object.keys({ A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 0, N: 0 }) as Array<keyof typeof ip>) {
      ip[k] = nextIp();
    }
    const ev = (deviceId: number, tenantId: number, addr: string, service: string, count: number, ageSec?: number) =>
      insertEvents(h.db, { deviceId, tenantId, ip: addr, service, count, ageSec });
    await ev(c1[0].id, 2, ip.A, 'ssh', 6);                                   // banned (SSH 5)
    await ev(c2[3].id, 2, ip.B, 'ftp', 3);                                   // banned (FTP override 3)
    for (const d of [...c1.slice(3, 8), ...c2.slice(0, 5)]) await ev(d.id, 2, ip.C, 'ssh', 4); // per-agent threshold: no ban
    await ev(c1[2].id, 2, ip.D, 'ssh', 3);                                   // banned (agent override 2)
    await ev(c1[1].id, 2, ip.E, 'ssh', 6);                                   // agent unbind: no ban
    await ev(ec[0].id, 2, ip.F, 'ssh', 6);                                   // evaluate-only ancestor: no ban
    await ev(q[0].id, 3, ip.G, 'nginx', 4);                                  // banned (group-owned template, tenant 3)
    await ev(c2[4].id, 2, ip.H, 'mysql', 6, 200);                            // outside the 120 s window: no ban
    await ev(c2[5].id, 2, ip.I, 'mysql', 5);                                 // banned (MySQL in window)
    await ev(c1[9].id, 2, ip.J, 'ssh', 6);                                   // banned once (two tenants)
    await ev(q[1].id, 3, ip.J, 'ssh', 6);
    await ev(c1[10].id, 2, ip.K, 'ssh', 6);                                  // globally whitelisted: no ban
    await insertWhitelist(h.db, { ip: `${ip.K}/32`, scope: 'global' });
    await ev(c1[11].id, 2, ip.L, 'ssh', 6);                                  // already banned: no new row
    await insertBan(h.db, { ip: ip.L, scope: 'global', originTenantId: 1 });
    await ev(c1[12].id, 2, ip.M, 'ssh', 6, 120);                             // failures older than its Lift: no ban
    await h.db('ip_bans').insert({ ip: ip.M, scope: 'global', ban_type: 'manual', is_active: false, lifted_at: new Date(Date.now() - 60_000), lift_reason: 'lift', reason: 'verify' });
    await ev(c2[6].id, 2, ip.N, 'mail', 5);                                  // track-mode template: no ban
  });

  after(async () => {
    notificationService.sendForAgent = origSend;
    await h.close();
  });

  /**
   * Reference: the per-agent evaluation (ancestry, resolve and aggregate per
   * agent and per template), minus the addresses already banned or
   * whitelisted. Address → first origin tenant.
   */
  const referenceCandidates = async (): Promise<Set<string>> => {
    const devices = await h.db('agent_devices').where({ status: 'approved' }).select('id', 'group_id', 'evaluate_only');
    const evalOnly = new Set(await h.db('monitor_groups').where('evaluate_only', true).pluck('id'));
    const out = new Set<string>();
    for (const dev of devices) {
      const groupIds = dev.group_id
        ? (await h.db('group_closure').where('descendant_id', dev.group_id).orderBy('depth', 'asc').pluck('ancestor_id')) as number[]
        : [];
      if (dev.evaluate_only || groupIds.some((g) => evalOnly.has(g))) continue;
      const resolved = await serviceTemplateService.resolveForAgent(dev.id, groupIds);
      for (const cfg of resolved.filter((c) => c.enabled && c.mode === 'ban')) {
        const rows = await h.db('ip_events')
          .select(h.db.raw('host(ip) AS addr'))
          .where('device_id', dev.id)
          .where('service', cfg.serviceType)
          .where('event_type', 'auth_failure')
          .where('track_only', false)
          .where('timestamp', '>=', new Date(Date.now() - cfg.windowSeconds * 1000))
          .whereRaw(WATERMARK_SQL)
          .groupBy('ip')
          .havingRaw('count(id) >= ?', [cfg.threshold]) as Array<{ addr: string }>;
        for (const r of rows) out.add(r.addr);
      }
    }
    return out;
  };

  lotIt('W11-3', '87.1 the batched resolver returns the per-agent resolution for every agent', async () => {
    const devices = await h.db('agent_devices').where({ status: 'approved' }).select('id', 'group_id');
    const scopes: Array<{ deviceId: number; groupIds: number[] }> = [];
    for (const d of devices) {
      const groupIds = d.group_id
        ? (await h.db('group_closure').where('descendant_id', d.group_id).orderBy('depth', 'asc').pluck('ancestor_id')) as number[]
        : [];
      scopes.push({ deviceId: d.id, groupIds });
    }
    assert.ok(scopes.length >= 50);
    const batched = await serviceTemplateService.resolveForAgents(scopes);
    assert.equal(batched.size, scopes.length);
    for (const s of scopes) {
      assert.deepEqual(batched.get(s.deviceId), await serviceTemplateService.getResolvedForDevice(s.deviceId), `device ${s.deviceId}`);
    }
    const sshOf = (id: number) => batched.get(id)!.find((c) => c.templateId === tpl.ssh)!;
    assert.equal(sshOf(c1[0].id).enabled, true, 'inherited from P');
    assert.equal(sshOf(c1[1].id).enabled, false, 'agent unbind');
    assert.equal(sshOf(c1[2].id).threshold, 2, 'agent threshold override');
    assert.ok(batched.get(q[0].id)!.some((c) => c.serviceType === 'nginx' && c.templateOwnerScope === 'group' && c.enabled));
    assert.ok(!batched.get(c1[0].id)!.some((c) => c.templateOwnerScope === 'group'), 'group-owned templates stay in their group');
  });

  lotIt('W11-3', '87.2 one cycle over 50 agents: bounded queries, same bans as the per-agent reference', async () => {
    const reference = await referenceCandidates();
    const maxId = Number((await h.db('ip_bans').max('id as m').first())?.m ?? 0);

    const queries = await countQueries(() => banEngine.run());

    const created = await h.db('ip_bans').where('id', '>', maxId)
      .select(h.db.raw('host(ip) AS addr'), 'scope', 'ban_type', 'is_active', 'origin_tenant_id', 'reason') as Array<{
        addr: string; scope: string; ban_type: string; is_active: boolean; origin_tenant_id: number; reason: string;
      }>;
    const createdSet = new Set(created.map((r) => r.addr));
    assert.equal(createdSet.size, created.length, 'one row per address');
    for (const r of created) {
      assert.equal(r.scope, 'global');
      assert.equal(r.ban_type, 'auto');
      assert.equal(r.is_active, true);
    }

    // Identical to the reference, minus the banned and whitelisted addresses.
    const expectedSet = new Set([...reference].filter((a) => a !== ip.L && a !== ip.K));
    assert.deepEqual([...createdSet].sort(), [...expectedSet].sort());
    assert.deepEqual([...createdSet].sort(), [ip.A, ip.B, ip.D, ip.G, ip.I, ip.J].sort());

    const byAddr = new Map(created.map((r) => [r.addr, r]));
    assert.equal(byAddr.get(ip.A)!.reason, 'Auto-ban: 6 ssh auth failures');
    assert.equal(byAddr.get(ip.A)!.origin_tenant_id, 2);
    assert.equal(byAddr.get(ip.B)!.reason, 'Auto-ban: 3 ftp auth failures');
    assert.equal(byAddr.get(ip.D)!.reason, 'Auto-ban: 3 ssh auth failures');
    assert.equal(byAddr.get(ip.G)!.reason, 'Auto-ban: 4 nginx auth failures');
    assert.equal(byAddr.get(ip.G)!.origin_tenant_id, 3);
    assert.equal(byAddr.get(ip.I)!.reason, 'Auto-ban: 5 mysql auth failures');
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [ip.L]).where('is_active', true)).length, 1);

    // Reputation rows, attack marking and one notification per (agent, ban).
    const rep = await h.db('ip_reputation').whereRaw('host(ip) = ANY(?::text[])', [[...createdSet]]).count('* as n').first();
    assert.equal(Number(rep?.n), createdSet.size);
    const attacked = new Set(sent.map((s) => `${s.deviceId}|${s.ip}`));
    for (const [d, a] of [[c1[0].id, ip.A], [c2[3].id, ip.B], [c1[2].id, ip.D], [q[0].id, ip.G], [c2[5].id, ip.I]] as const) {
      assert.ok(attacked.has(`${d}|${a}`), `attack notification ${d} ${a}`);
      const row = await h.db('agent_devices').where({ id: d }).first('last_attack_at', 'name', 'hostname');
      assert.ok(row?.last_attack_at, `last_attack_at of ${d}`);
      assert.equal(sent.find((s) => s.deviceId === d && s.ip === a)!.label, row!.name ?? row!.hostname);
    }
    assert.equal(sent.length, attacked.size, 'one notification per agent and ban');

    const budget = createBudget(created.length);
    assert.ok(queries <= budget, `cycle creating ${created.length} bans ran ${queries} queries (budget ${budget})`);
  });

  lotIt('W11-3', '87.3 a steady cycle stays within a fixed budget whatever the number of agents', async () => {
    await sleep(300); // fire-and-forget work of 87.2 (MikroTik push, geo queue)
    const banned = Number((await h.db('ip_bans').where('is_active', true).count('* as n').first())?.n);
    const q50 = await countQueries(() => banEngine.run());
    assert.ok(q50 <= STEADY_BUDGET, `steady cycle over 50 agents ran ${q50} queries (budget ${STEADY_BUDGET})`);

    // 50 more agents in the same groups, each with failures below threshold
    // and one more address over it on an already-banned IP.
    const C1 = (await h.db('agent_devices').where({ id: c1[0].id }).first('group_id')).group_id as number;
    for (let i = 0; i < 50; i++) {
      const d = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: C1 });
      await insertEvents(h.db, { deviceId: d.id, tenantId: 2, ip: ip.C, count: 4 });
      if (i === 0) await insertEvents(h.db, { deviceId: d.id, tenantId: 2, ip: ip.A, count: 6 });
    }
    const q100 = await countQueries(() => banEngine.run());
    assert.ok(q100 <= q50, `100 agents ran ${q100} queries, 50 agents ${q50}`);
    assert.equal(Number((await h.db('ip_bans').where('is_active', true).count('* as n').first())?.n), banned, 'no new ban');
  });

  lotIt('W11-3', '87.4 batched bans keep the ban:auto payloads and the lift watermark', async () => {
    const open = async (username: string) => {
      const s = await h.socket(await h.login(username));
      if (!s.ok) throw new Error(`socket for ${username}: ${s.error}`);
      return s;
    };
    const mc = await open('member_c');
    const dm = await open('default_member');
    const autoOf = (r: { events: Array<{ event: string; args: any[] }> }, addr: string) =>
      r.events.find((e) => e.event === SOCKET_EVENTS.BAN_AUTO && hostOf(e.args[0]?.ip) === addr);

    const z1 = nextIp();
    const z2 = nextIp();
    await insertEvents(h.db, { deviceId: c1[13].id, tenantId: 2, ip: z1, count: 6, ageSec: 60 });
    await insertEvents(h.db, { deviceId: q[2].id, tenantId: 3, ip: z2, service: 'nginx', count: 4, ageSec: 60 });
    await banEngine.run();
    const rows = await h.db('ip_bans').whereRaw('host(ip) = ANY(?::text[])', [[z1, z2]]).where('is_active', true)
      .select('id', h.db.raw('host(ip) AS addr')) as Array<{ id: number; addr: string }>;
    assert.equal(rows.length, 2);
    for (const [addr, origin, service, failureCount] of [[z1, 2, 'ssh', 6], [z2, 3, 'nginx', 4]] as const) {
      const id = rows.find((r) => r.addr === addr)!.id;
      const pub = (await waitFor(() => autoOf(mc, addr), 3000)).args[0];
      assert.deepEqual({ ...pub, ip: hostOf(pub.ip) }, { id, ip: addr, service, failureCount, originTenantId: null });
      const def = (await waitFor(() => autoOf(dm, addr), 3000)).args[0];
      assert.equal(def.originTenantId, origin, 'Default learns the origin tenant');
      assert.equal(mc.events.filter((e) => e.event === SOCKET_EVENTS.BAN_AUTO && hostOf(e.args[0]?.ip) === addr).length, 1, 'one ban:auto per ban');
    }

    // Lifted: the failures that caused the ban do not re-mint it; fresh ones do.
    const first = rows.find((r) => r.addr === z1)!;
    await banService.deactivateBans([first.id], 'lift');
    await banEngine.run();
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [z1]).where('is_active', true)).length, 0);
    await insertEvents(h.db, { deviceId: c1[13].id, tenantId: 2, ip: z1, count: 6, ageSec: -2 });
    await banEngine.run();
    const again = await h.db('ip_bans').whereRaw('host(ip) = ?', [z1]).where('is_active', true);
    assert.equal(again.length, 1);
    assert.notEqual(again[0].id, first.id);
  });

  lotIt('W11-3', '87.5 batched creation maps IPv6 rows back and replaces an expired covering ban', async () => {
    // IPv6 written in full in the events: the inserted row (canonical inet)
    // must still be matched back to its candidate (emit, attack marking).
    const v6 = litIp('2001:db8', 0x87, 0x15);
    const v6Long = '2001:0db8:0087:0000:0000:0000:0000:0015';
    // An expired global ban still flagged active holds the unique key.
    const stale = nextIp();
    const staleId = await insertBan(h.db, { ip: stale, scope: 'global', expiresAt: new Date(Date.now() - 60_000) });
    await insertEvents(h.db, { deviceId: c1[14].id, tenantId: 2, ip: v6Long, count: 6, ageSec: 60 });
    await insertEvents(h.db, { deviceId: c1[15].id, tenantId: 2, ip: stale, count: 6, ageSec: 60 });
    const before = sent.length;
    await banEngine.run();

    const v6Ban = await h.db('ip_bans').whereRaw('ip = ?::inet', [v6]).where('is_active', true);
    assert.equal(v6Ban.length, 1, 'IPv6 auto-ban');
    assert.equal(v6Ban[0].ban_type, 'auto');
    const old = await h.db('ip_bans').where({ id: staleId }).first('is_active', 'lift_reason');
    assert.equal(old.is_active, false, 'expired covering ban deactivated');
    assert.equal(old.lift_reason, 'expiry');
    const fresh = await h.db('ip_bans').whereRaw('ip = ?::inet', [stale]).where('is_active', true);
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0].id, staleId);
    assert.equal(fresh[0].ban_type, 'auto');
    const news = sent.slice(before);
    assert.ok(news.some((x) => x.deviceId === c1[14].id && parseIpOrCidr(x.ip)?.address === parseIpOrCidr(v6)?.address), 'IPv6 attack notification');
    assert.ok(news.some((x) => x.deviceId === c1[15].id && x.ip === stale), 'attack notification after expiry');
  });
});
