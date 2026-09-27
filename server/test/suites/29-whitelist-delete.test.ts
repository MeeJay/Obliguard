/**
 * 29 — A5 whitelist delete follows the operating tenant or the target's
 * tenant (no platform-admin bypass), and list entries carry canDelete.
 *
 *   G  global
 *   LB tenant B, scope tenant
 *   PA created by tenant B, scope agent on a tenant-C device (C = the victim)
 *   DA created from Default (tenant_id 1), scope group on a tenant-B group
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { insertWhitelist, createDevice, createGroup, nextIp } from '../seed';

describe('29 whitelist delete (A5)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const exists = async (id: number) => !!(await h.db('ip_whitelist').where({ id }).first());

  lotIt('A5', '29.1 delete matrix', async () => {
    const devC = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    const grpB = await createGroup(h.db, { tenantId: 2 });
    const G = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'global' });
    const LB = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'tenant', tenantId: 2 });
    const PA = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'agent', scopeId: devC.id, tenantId: 2 });
    const DA = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'group', scopeId: grpB, tenantId: 1 });

    const mb = await h.as('member_b');
    assert.equal((await mb.del(`/api/whitelist/${G}`)).status, 403);
    assert.equal((await (await h.adminIn(2)).del(`/api/whitelist/${G}`)).status, 403);
    assert.ok(await exists(G));

    const dm = await h.as('default_member');
    assert.equal((await dm.del(`/api/whitelist/${LB}`)).status, 403);
    assert.equal((await (await h.adminIn(1)).del(`/api/whitelist/${LB}`)).status, 403);
    assert.equal((await (await h.as('member_c')).del(`/api/whitelist/${LB}`)).status, 404);
    assert.ok(await exists(LB));

    // canDelete as tenant B
    const list = await mb.get('/api/whitelist');
    assert.equal(list.status, 200);
    const byId = new Map<number, { canDelete?: boolean }>((list.json?.data ?? []).map((e: any) => [e.id, e]));
    assert.equal(byId.get(G)?.canDelete, false);
    assert.equal(byId.get(LB)?.canDelete, true);
    if (byId.has(DA)) assert.equal(byId.get(DA)?.canDelete, true);

    assert.equal((await mb.del(`/api/whitelist/${LB}`)).status, 200);
    assert.equal(await exists(LB), false);
    assert.equal((await (await h.as('member_c')).del(`/api/whitelist/${PA}`)).status, 200);
    assert.equal(await exists(PA), false);
    assert.equal((await mb.del(`/api/whitelist/${DA}`)).status, 200);
    assert.equal(await exists(DA), false);
    assert.equal((await dm.del(`/api/whitelist/${G}`)).status, 200);
    assert.equal(await exists(G), false);
  });
});
