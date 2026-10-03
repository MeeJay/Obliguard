/**
 * 81 — W10-5 god view on the server (decision 5, Obliance model): the
 * cross-tenant view exists only on the Default tenant. A platform admin
 * standing on a customer tenant reads that tenant only; on Default it reads
 * every tenant, and `?tenants=1,2` (tenant chips) narrows the view. Every
 * list row carries its tenant attribution.
 *
 *   81.1 readTenantsFor / parseTenantIds / resolveReadTenants
 *   81.2 GET /ip-events (+ /:ip, /stats): tenant 2 only from tenant 2;
 *        Default sees all, ?tenants= narrows; rows carry tenant_id + tenant_name
 *   81.3 IP reputation: tenant-2 scope (list, banned list, detail); Default
 *        sees all with attribution; ?tenants= narrows (service)
 *   81.4 whitelist: tenant 3 entries hidden on tenant 2, attributed on Default
 *   81.5 bans: another tenant's local ban is invisible to a platform admin on
 *        tenant 2 (GET /bans/:id, list), visible from Default
 *   81.6 rate-limit policies and service templates follow the same scope
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { D } from '../fixtures';
import { insertBan, insertEvents, nextIp } from '../seed';
import { parseTenantIds, readTenantsFor, resolveReadTenants } from '../../src/middleware/tenant';
import { ipReputationService } from '../../src/services/ipReputation.service';
import { rateLimitPolicyService } from '../../src/services/rateLimitPolicy.service';
import { serviceTemplateService } from '../../src/services/serviceTemplate.service';

const host = (ip: unknown): string => String(ip ?? '').split('/')[0];

describe('81 god view only from Default, tenant attribution on every row (W10-5)', () => {
  let h: Harness;
  let names: Map<number, string>;
  // Events of tenant 2 only, tenant 3 only, and both tenants.
  const ipB = nextIp();
  const ipC = nextIp();
  const ipBC = nextIp();

  before(async () => {
    h = await startHarness();
    const rows = await h.db('tenants').select('id', 'name') as Array<{ id: number; name: string }>;
    names = new Map(rows.map((r) => [Number(r.id), r.name]));
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: 2, ip: ipB, count: 2 });
    await insertEvents(h.db, { deviceId: D.C.id, tenantId: 3, ip: ipC, count: 3 });
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: 2, ip: ipBC, count: 1 });
    await insertEvents(h.db, { deviceId: D.C.id, tenantId: 3, ip: ipBC, count: 4 });
    const now = new Date();
    for (const [ip, failures] of [[ipB, 2], [ipC, 3], [ipBC, 5]] as const) {
      await h.db('ip_reputation').insert({
        ip, total_failures: failures, total_successes: 0, affected_agents_count: 1,
        affected_services: ['ssh'], attempted_usernames: ['root'],
        first_seen: now, last_seen: now, updated_at: now,
      });
    }
  });
  after(async () => { await h.close(); });

  lotIt('W10-5', '81.1 read tenants: all only from Default, chips narrow Default only', () => {
    assert.equal(readTenantsFor(1), 'all');
    assert.equal(readTenantsFor(1, []), 'all');
    assert.deepEqual(readTenantsFor(1, [2, 3, 2]), [2, 3]);
    assert.deepEqual(readTenantsFor(2), [2]);
    assert.deepEqual(readTenantsFor(2, [3]), [2], 'chips never widen a customer tenant');
    assert.deepEqual(readTenantsFor(undefined), []);
    assert.deepEqual(readTenantsFor(0), []);

    assert.deepEqual(parseTenantIds('3, 2,x,0,-1,2,99999999999'), [3, 2]);
    assert.equal(parseTenantIds(''), undefined);
    assert.equal(parseTenantIds(['1']), undefined);

    const req = (tenantId: number, tenants?: string) => ({ tenantId, query: tenants === undefined ? {} : { tenants } }) as any;
    assert.equal(resolveReadTenants(req(1)), 'all');
    assert.deepEqual(resolveReadTenants(req(1, '2')), [2]);
    assert.deepEqual(resolveReadTenants(req(3, '2')), [3]);
  });

  lotIt('W10-5', '81.2 ip-events: tenant scope for a platform admin outside Default, attribution, chips', async () => {
    const list = async (tenant: number, qs: string) => {
      const r = await (await h.adminIn(tenant)).get(`/api/ip-events?${qs}`);
      assert.equal(r.status, 200, r.text);
      return r.json.data as Array<Record<string, unknown>>;
    };

    // Platform admin on tenant 2: tenant 2 rows only, ?tenants= cannot widen it.
    assert.deepEqual(await list(2, `ip=${ipC}`), []);
    assert.deepEqual(await list(2, `ip=${ipC}&tenants=3`), []);
    const own = await list(2, `ip=${ipBC}`);
    assert.equal(own.length, 1);
    assert.equal(Number(own[0].tenant_id), 2);
    assert.equal(own[0].tenant_name, names.get(2));
    const byIp2 = await (await h.adminIn(2)).get(`/api/ip-events/${ipBC}`);
    assert.equal(byIp2.status, 200);
    assert.deepEqual([...new Set((byIp2.json.data as any[]).map((e) => Number(e.tenant_id)))], [2]);
    // Keyset mode is scoped the same way.
    assert.deepEqual(await list(2, `ip=${ipC}&keyset=1`), []);

    // Default: every tenant, each row attributed; chips narrow.
    const all = await list(1, `ip=${ipBC}`);
    assert.equal(all.length, 5);
    for (const e of all) {
      assert.ok([2, 3].includes(Number(e.tenant_id)));
      assert.equal(e.tenant_name, names.get(Number(e.tenant_id)));
    }
    const only3 = await list(1, `ip=${ipBC}&tenants=3`);
    assert.equal(only3.length, 4);
    assert.ok(only3.every((e) => Number(e.tenant_id) === 3));
    assert.deepEqual(await list(1, `ip=${ipB}&tenants=3`), []);
    const keyset = await list(1, `ip=${ipBC}&tenants=2&keyset=1`);
    assert.equal(keyset.length, 1);
    assert.equal(keyset[0].tenant_name, names.get(2));
    const byIp1 = await (await h.adminIn(1)).get(`/api/ip-events/${ipBC}?tenants=2`);
    assert.deepEqual([...new Set((byIp1.json.data as any[]).map((e) => Number(e.tenant_id)))], [2]);

    // Stats: the tenant-3 agent never shows up for tenant 2.
    const stats2 = await (await h.adminIn(2)).get('/api/ip-events/stats');
    assert.equal(stats2.status, 200);
    assert.ok(!(stats2.json.data.byDevice as any[]).some((d) => d.deviceId === D.C.id));
    const stats1 = await (await h.adminIn(1)).get('/api/ip-events/stats?tenants=3');
    assert.ok((stats1.json.data.byDevice as any[]).some((d) => d.deviceId === D.C.id));
    assert.ok(!(stats1.json.data.byDevice as any[]).some((d) => d.deviceId === D.B.id));
  });

  lotIt('W10-5', '81.3 ip-reputation: tenant scope outside Default, attribution, chips', async () => {
    const list = async (tenant: number, search: string, status = '') => {
      const r = await (await h.adminIn(tenant)).get(`/api/ip-reputation?search=${search}${status ? `&status=${status}` : ''}`);
      assert.equal(r.status, 200, r.text);
      return (r.json.data as Array<Record<string, any>>);
    };
    const find = (rows: Array<Record<string, any>>, ip: string) => rows.find((r) => host(r.ip) === ip);

    // Platform admin on tenant 2: tenant-3-only IPs are not listed; totals are tenant 2's own.
    assert.equal(find(await list(2, ipC), ipC), undefined);
    const bc2 = find(await list(2, ipBC), ipBC);
    assert.ok(bc2, 'IP seen by tenant 2 listed');
    assert.equal(bc2.totalFailures, 1);
    assert.equal(bc2.tenantId, 2);
    assert.equal(bc2.tenantName, names.get(2));
    assert.deepEqual(bc2.tenantIds, [2]);

    // Detail of a tenant-3-only IP from tenant 2: no foreign events, zeroed totals.
    const det = await (await h.adminIn(2)).get(`/api/ip-reputation/${ipC}`);
    assert.equal(det.status, 200);
    assert.deepEqual(det.json.data.recentEvents, []);
    assert.equal(det.json.data.reputation.totalFailures, 0);
    assert.deepEqual(det.json.data.reputation.tenantIds, []);

    // Default: every IP, global totals, attribution (null tenantId when shared).
    const c1 = find(await list(1, ipC), ipC)!;
    assert.equal(c1.tenantId, 3);
    assert.equal(c1.tenantName, names.get(3));
    assert.deepEqual(c1.tenantIds, [3]);
    const bc1 = find(await list(1, ipBC), ipBC)!;
    assert.equal(bc1.totalFailures, 5);
    assert.equal(bc1.tenantId, null);
    assert.deepEqual(bc1.tenantIds, [2, 3]);

    // Chips (service: the controller forwards ?tenants= at integration).
    const narrowed = await ipReputationService.list({ tenantId: 1, tenantIds: [3], search: ipBC });
    const n = narrowed.data.find((r) => host(r.ip) === ipBC)!;
    assert.equal(n.totalFailures, 4, 'totals from the chosen tenants');
    assert.deepEqual(n.tenantIds, [3]);
    assert.equal(n.tenantId, 3);
    const none = await ipReputationService.list({ tenantId: 1, tenantIds: [2], search: ipC });
    assert.equal(none.data.find((r) => host(r.ip) === ipC), undefined);
    const ignored = await ipReputationService.list({ tenantId: 2, tenantIds: [3], search: ipC });
    assert.equal(ignored.data.find((r) => host(r.ip) === ipC), undefined, 'chips ignored outside Default');

    // Banned list: a tenant-3 local ban is invisible on tenant 2, owner-attributed on Default.
    const banId = await insertBan(h.db, { ip: ipC, scope: 'tenant', tenantId: 3, originTenantId: 3 });
    assert.equal((await list(2, ipC, 'banned')).find((r) => r.activeBanId === banId), undefined);
    const banned1 = (await list(1, ipC, 'banned')).find((r) => r.activeBanId === banId);
    assert.ok(banned1);
    assert.equal(banned1.tenantId, 3);
    assert.equal(banned1.tenantName, names.get(3));
    // ... and the reputation row is no longer "banned" for tenant 2.
    const st2 = await ipReputationService.getByIp(ipC, 2, true);
    assert.notEqual(st2?.status, 'banned');
    await h.db('ip_bans').where({ id: banId }).update({ is_active: false });
  });

  lotIt('W10-5', '81.4 whitelist: tenant scope outside Default, attribution, chips', async () => {
    const ip = nextIp();
    const created = await (await h.adminIn(3)).post('/api/whitelist', { ip, label: 'w81' });
    assert.equal(created.status, 201, created.text);
    const id = created.json.data.id as number;
    const list = async (tenant: number, qs = '') => {
      const r = await (await h.adminIn(tenant)).get(`/api/whitelist?ip=${ip}${qs}`);
      assert.equal(r.status, 200, r.text);
      return r.json.data as Array<Record<string, any>>;
    };

    assert.equal((await list(2)).find((e) => e.id === id), undefined);
    const row = (await list(1)).find((e) => e.id === id);
    assert.ok(row);
    assert.equal(row.tenantId, 3);
    assert.equal(row.tenantName, names.get(3));
    assert.equal((await list(1, '&tenants=2')).find((e) => e.id === id), undefined);
    assert.ok((await list(1, '&tenants=3')).find((e) => e.id === id));
    assert.equal((await list(2, '&tenants=3')).find((e) => e.id === id), undefined);
  });

  lotIt('W10-5', '81.5 bans: a platform admin on tenant 2 does not see tenant 3 local bans', async () => {
    const ip = nextIp();
    const id = await insertBan(h.db, { ip, scope: 'tenant', tenantId: 3, originTenantId: 3 });
    assert.equal((await (await h.adminIn(2)).get(`/api/bans/${id}`)).status, 404);
    assert.equal((await (await h.adminIn(1)).get(`/api/bans/${id}`)).status, 200);

    const l2 = await (await h.adminIn(2)).get(`/api/bans?search=${ip}&state=all`);
    assert.equal(l2.status, 200);
    assert.equal((l2.json.data as any[]).find((b) => b.id === id), undefined);
    const l1 = await (await h.adminIn(1)).get(`/api/bans?search=${ip}&state=all`);
    const b1 = (l1.json.data as any[]).find((b) => b.id === id);
    assert.ok(b1);
    assert.equal(b1.tenantId, 3);
    assert.equal(b1.tenantName, names.get(3));
    await h.db('ip_bans').where({ id }).update({ is_active: false });
  });

  lotIt('W10-5', '81.6 rate-limit policies and service templates follow the read scope', async () => {
    const maxValue = 81_000 + Math.floor(Math.random() * 900);
    const pol = await (await h.adminIn(3)).post('/api/rate-limit-policies', { type: 'connection', scope: 'tenant', maxValue });
    assert.equal(pol.status, 201, pol.text);
    const polId = pol.json.data.id as number;

    const p2 = await (await h.adminIn(2)).get('/api/rate-limit-policies');
    assert.equal((p2.json.data as any[]).find((p) => p.id === polId), undefined);
    const p2t = await (await h.adminIn(2)).get('/api/rate-limit-policies?scope=tenant');
    assert.equal((p2t.json.data as any[]).find((p) => p.id === polId), undefined);
    const p1 = (await (await h.adminIn(1)).get('/api/rate-limit-policies')).json.data as any[];
    const own = p1.find((p) => p.id === polId);
    assert.equal(own?.tenantId, 3);
    assert.equal(own?.tenantName, names.get(3));
    // Global policies are readable from every tenant (no platform-role gate).
    assert.equal((await (await h.as('member_b')).get('/api/rate-limit-policies?scope=global')).status, 200);
    // Chips (service).
    assert.equal((await rateLimitPolicyService.listAll(1, [2])).find((p) => p.id === polId), undefined);
    assert.ok((await rateLimitPolicyService.listAll(1, [3])).find((p) => p.id === polId));
    assert.equal((await rateLimitPolicyService.listAll(2, [3])).find((p) => p.id === polId), undefined);
    assert.equal((await rateLimitPolicyService.listByScope('tenant', null, 1, true, [2])).find((p) => p.id === polId), undefined);

    const tpl = await (await h.adminIn(3)).post('/api/service-templates', { name: `t81-${maxValue}`, serviceType: 'ssh' });
    assert.equal(tpl.status, 201, tpl.text);
    const tplId = tpl.json.data.id as number;
    const t2 = (await (await h.adminIn(2)).get('/api/service-templates')).json.data as any[];
    assert.equal(t2.find((t) => t.id === tplId), undefined);
    assert.ok(t2.some((t) => t.tenantId === null), 'platform templates stay visible');
    assert.equal((await (await h.adminIn(2)).get(`/api/service-templates/${tplId}`)).status, 404);
    const t1 = ((await (await h.adminIn(1)).get('/api/service-templates')).json.data as any[]).find((t) => t.id === tplId);
    assert.equal(t1?.tenantId, 3);
    assert.equal(t1?.tenantName, names.get(3));
    assert.equal((await serviceTemplateService.list(1, true, [2])).find((t) => t.id === tplId), undefined);
    assert.ok((await serviceTemplateService.list(1, false, [3])).find((t) => t.id === tplId));
    for (const t of await serviceTemplateService.list(1, false, [3])) assert.ok(t.tenantId === null || t.tenantId === 3);
  });
});
