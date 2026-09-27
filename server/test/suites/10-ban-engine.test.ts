/**
 * 10 — BanEngine invariants: auto-bans are global, opt-in templates,
 * evaluate-only groups, thresholds.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, hostOf } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { insertBan, insertEvents, insertWhitelist, nextIp } from '../seed';
import { banEngine } from '../../src/services/ban.service';

describe('10 ban engine', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const active = (ip: string) => h.db('ip_bans').whereRaw('host(ip) = ?', [ip]).where({ is_active: true });
  let e1 = '';

  it('10.1 threshold exceeded: exactly one global auto-ban [BASELINE]', async () => {
    e1 = nextIp();
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: e1, service: 'ssh', count: 6 });
    await banEngine.run();
    let rows = await active(e1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, 'global');
    assert.equal(rows[0].ban_type, 'auto');
    assert.equal(rows[0].tenant_id, null);
    assert.equal(rows[0].origin_tenant_id, 2);
    await banEngine.run();
    rows = await active(e1);
    assert.equal(rows.length, 1);
  });

  it('10.2 no ban: evaluate-only group, template not opted in, below threshold [BASELINE]', async () => {
    const a = nextIp(); const b = nextIp(); const c = nextIp();
    await insertEvents(h.db, { deviceId: 4, tenantId: 2, ip: a, count: 6 });
    await banEngine.run();
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [a])).length, 0);
    await insertEvents(h.db, { deviceId: 3, tenantId: 3, ip: b, count: 6 });
    await banEngine.run();
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [b])).length, 0);
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: c, count: 4 });
    await banEngine.run();
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [c])).length, 0);
  });

  it('10.3 an evaluate-only agent enforces nothing [BASELINE]', async () => {
    const x = nextIp();
    await insertBan(h.db, { ip: x, scope: 'global', originTenantId: 1 });
    const r = await h.push(2, 'dev-b-eval-0001', { firewallBanned: [x] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.banList.add, []);
    assert.ok((r.json.banList.remove as string[]).map(hostOf).includes(x));
  });

  it('10.4 service configs are opt-in [BASELINE]', async () => {
    const c = await h.push(3, 'dev-c-0001');
    for (const [k, v] of Object.entries(c.json.services as Record<string, { enabled: boolean }>)) {
      assert.equal(v.enabled, false, `dev-c service ${k}`);
    }
    const b = await h.push(2, 'dev-b-0001');
    assert.equal(b.json.services.ssh.enabled, true);
  });

  lotIt('D4', '10.5 the engine honours the whitelist; one active global row per address', async () => {
    const e5 = nextIp();
    await insertWhitelist(h.db, { ip: `${e5}/32`, scope: 'global' });
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: e5, count: 6 });
    await banEngine.run();
    assert.equal((await active(e5)).length, 0);
    assert.ok(e1, '10.1 must have run');
    await assert.rejects(
      insertBan(h.db, { ip: e1, scope: 'global', banType: 'auto', originTenantId: 2 }),
      (err: any) => err?.code === '23505',
    );
  });
});
