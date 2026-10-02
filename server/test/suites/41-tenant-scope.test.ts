/**
 * 41 — W1-2 ownership of group/agent scope ids (rate-limit policies, local
 * template assignments, whitelist ?ip= lookup) and the tenants sequence fix.
 *
 * Writes on a group/agent of another tenant are refused: 403 from the Default
 * tenant (read-only god view), 403|404 from any other tenant.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup, insertWhitelist, nextIp } from '../seed';

describe('41 tenant scope (W1-2)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const policyRows = (maxValue: number) => h.db('rate_limit_policies').where({ max_value: maxValue });
  let maxSeq = 41_000;
  const uniqMax = () => ++maxSeq;

  lotIt('W1-2', '41.1 a rate-limit policy on another tenant group is refused', async () => {
    const g2 = await createGroup(h.db, { tenantId: 2 });
    const g3 = await createGroup(h.db, { tenantId: 3 });

    const m1 = uniqMax();
    const r1 = await (await h.adminIn(1)).post('/api/rate-limit-policies', { type: 'connection', scope: 'group', scopeId: g2, maxValue: m1 });
    assert.equal(r1.status, 403);
    assert.equal((await policyRows(m1)).length, 0);

    const m2 = uniqMax();
    const r2 = await (await h.adminIn(2)).post('/api/rate-limit-policies', { type: 'connection', scope: 'group', scopeId: g3, maxValue: m2 });
    assert.ok([403, 404].includes(r2.status), `got ${r2.status}`);
    assert.equal((await policyRows(m2)).length, 0);

    const m3 = uniqMax();
    const r3 = await (await h.adminIn(2)).post('/api/rate-limit-policies', { type: 'connection', scope: 'agent', scopeId: 999_999, maxValue: m3 });
    assert.equal(r3.status, 404);
    assert.equal((await policyRows(m3)).length, 0);

    // Own group: created and stamped with the operating tenant.
    const m4 = uniqMax();
    const r4 = await (await h.adminIn(2)).post('/api/rate-limit-policies', { type: 'connection', scope: 'group', scopeId: g2, maxValue: m4 });
    assert.equal(r4.status, 201);
    const rows = await policyRows(m4);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, 2);

    // Global policies only from Default.
    const m5 = uniqMax();
    const r5 = await (await h.adminIn(2)).post('/api/rate-limit-policies', { type: 'connection', scope: 'global', maxValue: m5 });
    assert.equal(r5.status, 403);
    assert.equal((await policyRows(m5)).length, 0);
  });

  lotIt('W1-2', '41.2 rate-limit lists and delivery follow the target tenant', async () => {
    const g3 = await createGroup(h.db, { tenantId: 3 });
    const mPoison = uniqMax();
    const mForeign = uniqMax();
    const [poison] = await h.db('rate_limit_policies').insert({
      type: 'connection', scope: 'agent', scope_id: 2, tenant_id: 3, max_value: mPoison, enabled: true,
    }).returning('id') as Array<{ id: number }>;
    const [foreign] = await h.db('rate_limit_policies').insert({
      type: 'connection', scope: 'group', scope_id: g3, tenant_id: 3, max_value: mForeign, enabled: true,
    }).returning('id') as Array<{ id: number }>;

    const list = await (await h.adminIn(2)).get('/api/rate-limit-policies');
    assert.equal(list.status, 200);
    const ids = ((list.json?.data ?? []) as Array<{ id: number }>).map((p) => p.id);
    assert.ok(!ids.includes(foreign.id), 'a tenant-C group policy must not be listed to tenant B');

    const all = await (await h.adminIn(1)).get('/api/rate-limit-policies');
    const allIds = ((all.json?.data ?? []) as Array<{ id: number }>).map((p) => p.id);
    assert.ok(allIds.includes(foreign.id), 'Default keeps the god view');

    const push = await h.push(2, 'dev-b-0001');
    assert.equal(push.status, 200);
    const rules = (Array.isArray(push.json?.rateLimits) ? push.json.rateLimits : []) as Array<{ maxValue: number }>;
    assert.ok(!rules.some((r) => r.maxValue === mPoison), 'a policy planted by another tenant on this agent is not delivered');

    // The victim tenant may remove the planted row; the planting tenant row stays otherwise.
    assert.equal((await (await h.adminIn(2)).del(`/api/rate-limit-policies/${poison.id}`)).status, 200);
    assert.equal(await h.db('rate_limit_policies').where({ id: poison.id }).first(), undefined);
    const r = await (await h.adminIn(1)).del(`/api/rate-limit-policies/${foreign.id}`);
    assert.equal(r.status, 403);
    assert.ok(await h.db('rate_limit_policies').where({ id: foreign.id }).first());
  });

  lotIt('W1-2', '41.3 a template assignment on a foreign agent is refused', async () => {
    const ssh = await h.db('service_templates')
      .where({ service_type: 'ssh', is_builtin: true })
      .whereNull('owner_scope')
      .first('id') as { id: number };
    const dev2 = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const dev3 = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    const asg = (deviceId: number) => h.db('service_template_assignments')
      .where({ template_id: ssh.id, scope: 'agent', scope_id: deviceId });

    const r1 = await (await h.adminIn(1)).put(`/api/service-templates/${ssh.id}/assign/agent/${dev2.id}`, { enabledOverride: true });
    assert.equal(r1.status, 403);
    assert.equal((await asg(dev2.id)).length, 0);

    const r2 = await (await h.adminIn(2)).put(`/api/service-templates/${ssh.id}/assign/agent/${dev3.id}`, { enabledOverride: true });
    assert.ok([403, 404].includes(r2.status), `got ${r2.status}`);
    assert.equal((await asg(dev3.id)).length, 0);

    // Local template owned by a foreign group: refused, nothing created.
    const g3 = await createGroup(h.db, { tenantId: 3 });
    const name = `w12-local-${g3}`;
    const r3 = await (await h.adminIn(2)).post('/api/service-templates', { name, serviceType: 'ssh', ownerScope: 'group', ownerScopeId: g3 });
    assert.ok([403, 404].includes(r3.status), `got ${r3.status}`);
    assert.equal((await h.db('service_templates').where({ name })).length, 0);

    // Own agent: accepted.
    const r4 = await (await h.adminIn(2)).put(`/api/service-templates/${ssh.id}/assign/agent/${dev2.id}`, { enabledOverride: true });
    assert.equal(r4.status, 200);
    assert.equal((await asg(dev2.id)).length, 1);

    // A shared template only lists assignments on the caller's own targets.
    const seen = (r: { json?: { data?: { assignments?: Array<{ scope: string; scopeId: number }> } } }) =>
      (r.json?.data?.assignments ?? []).some((a) => a.scope === 'agent' && a.scopeId === dev2.id);
    assert.ok(seen(await (await h.adminIn(2)).get(`/api/service-templates/${ssh.id}`)));
    assert.ok(!seen(await (await h.adminIn(3)).get(`/api/service-templates/${ssh.id}`)), 'tenant C must not see tenant B assignments');
    assert.ok(seen(await (await h.adminIn(1)).get(`/api/service-templates/${ssh.id}`)), 'Default keeps the god view');

    // Deleting an assignment on a foreign agent is refused too.
    const r5 = await (await h.adminIn(1)).del(`/api/service-templates/${ssh.id}/assign/agent/${dev2.id}`);
    assert.equal(r5.status, 403);
    assert.equal((await asg(dev2.id)).length, 1);
  });

  lotIt('W1-2', '41.4 whitelist ?ip= finds a covering range, with its creator name', async () => {
    const mb = await h.as('member_b');
    const c = await mb.post('/api/whitelist', { ip: '10.0.0.0/8', label: 'w12-range' });
    assert.equal(c.status, 201);
    const other = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'tenant', tenantId: 2 });
    const foreign = await insertWhitelist(h.db, { ip: '10.1.0.0/16', scope: 'tenant', tenantId: 3 });

    const r = await mb.get('/api/whitelist?ip=10.1.2.3');
    assert.equal(r.status, 200);
    const data = (r.json?.data ?? []) as Array<{ id: number; ip: string; createdByUsername?: string | null }>;
    const hit = data.find((e) => e.id === c.json.data.id);
    assert.ok(hit, '10.0.0.0/8 must cover 10.1.2.3');
    assert.equal(hit.createdByUsername, 'member_b');
    assert.ok(!data.some((e) => e.id === other), 'non-covering entries are filtered out');
    assert.ok(!data.some((e) => e.id === foreign), 'another tenant entry is not visible');

    assert.equal((await mb.get('/api/whitelist?ip=not-an-ip')).status, 400);
    // Host bits set: a 400 on create, counted as invalid (never a 500) in bulk.
    assert.equal((await mb.post('/api/whitelist', { ip: '10.0.0.1/8' })).status, 400);
    const bulk = await mb.post('/api/bans/bulk-whitelist', { ips: ['10.0.0.1/8', 'nope'] });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.json?.created, 0);
    assert.equal(bulk.json?.invalid, 2);

    // Paging is bounded.
    const p = await mb.get('/api/whitelist?pageSize=1&page=1');
    assert.equal(p.status, 200);
    assert.ok((p.json?.data ?? []).length <= 1);
    assert.ok(Number(p.json?.total) >= 2);
    const huge = await mb.get('/api/whitelist?pageSize=999999');
    assert.equal(huge.json?.pageSize, 1000);
  });

  lotIt('W1-2', '41.5 the first tenant of a fresh install is created (sequence fix)', async () => {
    const admin = await h.adminIn(1);
    // Put the sequence back in its fresh-install state (001 seeds id 1 explicitly).
    await h.db.raw("SELECT setval(pg_get_serial_sequence('tenants','id'), 1, false)");
    const before = await admin.post('/api/tenants', { name: 'W12 Before', slug: 'w12-before' });
    assert.equal(before.status, 409, 'a key collision is a 409, never a 500');
    assert.equal(await h.db('tenants').where({ slug: 'w12-before' }).first(), undefined);

    const mig = await import('../../src/db/migrations/030_fix_tenants_sequence');
    await mig.up(h.db);
    const r = await admin.post('/api/tenants', { name: 'W12 First', slug: 'w12-first' });
    assert.equal(r.status, 201);
    const row = await h.db('tenants').where({ slug: 'w12-first' }).first();
    assert.ok(row && row.id > 3);
  });

  lotIt('W1-2', '41.6 a duplicate tenant slug is a 409', async () => {
    const admin = await h.adminIn(1);
    const r = await admin.post('/api/tenants', { name: 'Dup', slug: 'tenant-b' });
    assert.equal(r.status, 409);
    assert.equal((await h.db('tenants').where({ slug: 'tenant-b' })).length, 1);
    const created = await admin.post('/api/tenants', { name: 'W12 Dup', slug: 'w12-dup' });
    assert.equal(created.status, 201);
    const u = await admin.put(`/api/tenants/${created.json.data.id}`, { slug: 'tenant-c' });
    assert.equal(u.status, 409);
    assert.equal((await h.db('tenants').where({ id: created.json.data.id }).first())?.slug, 'w12-dup');
  });
});
