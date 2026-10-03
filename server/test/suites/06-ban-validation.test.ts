/**
 * 06 — manual ban target validation: prefix floor (/16 IPv4, /48 IPv6),
 * strict parsing, protected addresses. One network per assertion.
 *
 * Owner decision (wave 1): manual subnet bans were refused with a 400 "not
 * enforced by the agents yet" until D4.1 (owner answer 4). D4.1 landed in
 * wave W3 (agents enforce CIDR natively), so per owner answer 4 the [A2]
 * at-floor checks now assert 201 at the floor and still never "too broad".
 * The [D4] halves check the stored row.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { nextIp } from '../seed';

const TOO_BROAD = /too broad/i;

describe('06 ban validation', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const countAll = async () => Number((await h.db('ip_bans').count<{ c: string }[]>({ c: '*' }))[0].c);
  const intersecting = (net: string) => h.db('ip_bans').whereRaw('ip && ?::inet', [net]);
  const post = async (body: Record<string, unknown>) => (await h.adminIn(1)).post('/api/bans', body);

  lotIt('A2', '06.1 a /15 is refused as too broad, in both notations', async () => {
    const a = await post({ ip: '198.18.0.0', cidrPrefix: 15 });
    assert.equal(a.status, 400);
    assert.match(String(a.json?.error), TOO_BROAD);
    const b = await post({ ip: '198.18.0.0/15' });
    assert.equal(b.status, 400);
    assert.match(String(b.json?.error), TOO_BROAD);
    assert.equal((await intersecting('198.18.0.0/15')).length, 0);
  });

  lotIt('A2', '06.2 a /16 IPv4 is at the floor: accepted, never "too broad"', async () => {
    // Amended by D4.1 (owner answer 4): subnets at the floor are now banned.
    const r = await post({ ip: '198.19.0.0', cidrPrefix: 16 });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.doesNotMatch(String(r.json?.error ?? ''), TOO_BROAD);
    // Leave no row behind so 06.2b stays independent.
    await intersecting('198.19.0.0/16').del();
  });

  lotIt('D4', '06.2b a /16 IPv4 subnet ban is stored', async () => {
    // Independent of 06.2: always posts (06.2 deletes the row it creates).
    const r = await post({ ip: '198.19.0.0', cidrPrefix: 16 });
    assert.equal(r.status, 201);
    const rows = await h.db('ip_bans').whereRaw("host(ip) = '198.19.0.0' AND (masklen(ip) = 16 OR cidr_prefix = 16)");
    assert.equal(rows.length, 1);
  });

  lotIt('A2', '06.3 IPv6: /47 is too broad, /48 is at the floor (accepted)', async () => {
    const a = await post({ ip: '2001:db8:10::', cidrPrefix: 47 });
    assert.equal(a.status, 400);
    assert.match(String(a.json?.error), TOO_BROAD);
    assert.equal((await intersecting('2001:db8:10::/47')).length, 0);
    // Amended by D4.1 (owner answer 4): the /48 floor is now banned.
    const b = await post({ ip: '2001:db8:1::', cidrPrefix: 48 });
    assert.equal(b.status, 201, JSON.stringify(b.json));
    assert.doesNotMatch(String(b.json?.error ?? ''), TOO_BROAD);
  });

  lotIt('D4', '06.3b a /48 IPv6 subnet ban is stored', async () => {
    const r = await post({ ip: '2001:db8:2::', cidrPrefix: 48 });
    assert.equal(r.status, 201);
    assert.equal((await h.db('ip_bans').whereRaw("host(ip) = '2001:db8:2::'")).length, 1);
  });

  lotIt('A2', '06.4 strict parsing of ban targets', async () => {
    for (const ip of ['example.com', 'localhost', '1.2.3', '256.1.1.1', '1.2.3.4-1.2.3.9', '1.2.3.4/abc', '1.2.3.4/33', '', '0x01020304', '1.2.3.4 5.6.7.8', '2001:db8::zz']) {
      const before = await countAll();
      const r = await post({ ip });
      assert.equal(r.status, 400, `'${ip}' answered ${r.status}`);
      assert.equal(await countAll(), before, `'${ip}' created a row`);
    }
  });

  lotIt('A2', '06.5 protected addresses are refused', async () => {
    for (const ip of ['127.0.0.1', '127.9.9.9', '::1', '0.0.0.0', '::', '0.0.0.0/0', '::/0', '::ffff:127.0.0.1']) {
      const before = await countAll();
      const r = await post({ ip });
      assert.equal(r.status, 400, `'${ip}' answered ${r.status}`);
      assert.equal(await countAll(), before, `'${ip}' created a row`);
    }
  });

  lotIt('A2', '06.6 the server own interface address is protected', async (t) => {
    const addr = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!addr) { t.skip('no non-internal IPv4 interface'); return; }
    const net24 = addr.split('.').slice(0, 3).join('.') + '.0';
    const before = await countAll();
    assert.equal((await post({ ip: addr })).status, 400);
    assert.equal((await post({ ip: net24, cidrPrefix: 24 })).status, 400);
    assert.equal(await countAll(), before);
  });

  lotIt('A2', '06.7 /8 refused for a member; bulk ban refuses every unsafe entry', async () => {
    const r = await (await h.as('member_b')).post('/api/bans', { ip: '192.0.0.0', cidrPrefix: 8 });
    assert.equal(r.status, 400);
    assert.match(String(r.json?.error), TOO_BROAD);
    assert.equal((await intersecting('192.0.0.0/8')).length, 0);
    const before = await countAll();
    const b = await (await h.adminIn(1)).post('/api/bans/bulk-ban', { ips: ['127.0.0.1', '192.0.0.0/8', 'example.com'] });
    assert.equal(b.status, 200);
    assert.equal(b.json?.created, 0);
    assert.equal(b.json?.invalid, 3);
    assert.equal(await countAll(), before);
  });

  it('06.8 control: a valid host ban is accepted [BASELINE]', async () => {
    const ip = nextIp();
    assert.equal((await post({ ip })).status, 201);
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [ip])).length, 1);
  });
});
