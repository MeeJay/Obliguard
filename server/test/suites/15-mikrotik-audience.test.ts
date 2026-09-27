/**
 * 15 — MikroTik ban audience (A3): global bans reach every router; tenant
 * bans and tenant exclusions only that tenant's routers. RouterOSClient is
 * spied (no socket is ever opened).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, waitFor } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createMikrotikDevice, nextIp } from '../seed';
import { RouterOSClient } from '../../src/services/mikrotik/routerosClient';

const MT_B = 'mt-b.verify.invalid';
const MT_C = 'mt-c.verify.invalid';

interface Call { host: string; action: 'ban' | 'unban'; ip: string }

describe('15 MikroTik audience', () => {
  let h: Harness;
  const calls: Call[] = [];
  const proto = RouterOSClient.prototype as any;
  const saved: Record<string, unknown> = {};

  before(async () => {
    h = await startHarness();
    for (const m of ['connect', 'login', 'banIP', 'unbanIP', 'close']) saved[m] = proto[m];
    proto.connect = async function () { /* spy: no socket */ };
    proto.login = async function () { /* spy */ };
    proto.banIP = async function (this: any, ip: string) { calls.push({ host: this.config.host, action: 'ban', ip }); };
    proto.unbanIP = async function (this: any, ip: string) { calls.push({ host: this.config.host, action: 'unban', ip }); };
    proto.close = function () { /* spy */ };
    await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: MT_B });
    await createMikrotikDevice(h.db, { tenantId: 3, keyId: 3, host: MT_C });
  });
  after(async () => {
    for (const [m, fn] of Object.entries(saved)) proto[m] = fn;
    await h.close();
  });

  const has = (host: string, action: Call['action'], ip: string) => calls.some((c) => c.host === host && c.action === action && c.ip === ip);
  const both = (action: Call['action'], ip: string) => waitFor(() => has(MT_B, action, ip) && has(MT_C, action, ip), 3000);

  it('15.1 a global ban reaches every router [BASELINE]', async () => {
    const g = nextIp();
    assert.equal((await (await h.adminIn(1)).post('/api/bans', { ip: g })).status, 201);
    await both('ban', g);
  });

  lotIt('A3', '15.2 a tenant-local ban reaches only that tenant routers', async () => {
    const l = nextIp();
    assert.equal((await (await h.as('member_b')).post('/api/bans', { ip: l })).status, 201);
    await waitFor(() => has(MT_B, 'ban', l), 3000);
    const s = nextIp();
    assert.equal((await (await h.adminIn(1)).post('/api/bans', { ip: s })).status, 201);
    await both('ban', s);
    assert.ok(!has(MT_C, 'ban', l));
  });

  lotIt('A3', '15.3 a tenant exclusion unbans only that tenant routers', async () => {
    const hIp = nextIp();
    const r = await (await h.adminIn(1)).post('/api/bans', { ip: hIp });
    assert.equal(r.status, 201);
    await both('ban', hIp);
    assert.equal((await (await h.as('member_c')).del(`/api/bans/${r.json.data.id}`)).status, 200);
    await waitFor(() => has(MT_C, 'unban', hIp), 3000);
    const s2 = nextIp();
    assert.equal((await (await h.adminIn(1)).post('/api/bans', { ip: s2 })).status, 201);
    await both('ban', s2);
    assert.ok(!has(MT_B, 'unban', hIp));
  });
});
