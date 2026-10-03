// verify-env: BAN_MIN_PREFIX_V4=24 BAN_MIN_PREFIX_V6=64
/**
 * 07 — the prefix floor is env-tunable (BAN_MIN_PREFIX_V4 / _V6), in its own
 * process so the value read by A2 (call time or startup) does not matter.
 * Subnets at the floor: see the owner decision in 06 (400 "not enforced"
 * until D4.1; since D4.1 landed in W3 they are accepted, owner answer 4).
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';

describe('07 ban prefix floor from the environment', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const post = async (body: Record<string, unknown>) => (await h.adminIn(1)).post('/api/bans', body);
  const intersecting = (net: string) => h.db('ip_bans').whereRaw('ip && ?::inet', [net]);

  lotIt('A2', '07.1 below the configured floor is too broad; at the floor it is accepted', async () => {
    const a = await post({ ip: '198.18.0.0', cidrPrefix: 23 });
    assert.equal(a.status, 400);
    assert.match(String(a.json?.error), /too broad/i);
    assert.equal((await intersecting('198.18.0.0/23')).length, 0);
    // Amended by D4.1 (owner answer 4): at the floor the subnet is banned.
    const b = await post({ ip: '198.18.2.0', cidrPrefix: 24 });
    assert.equal(b.status, 201, JSON.stringify(b.json));
    assert.doesNotMatch(String(b.json?.error ?? ''), /too broad/i);
    const c = await post({ ip: '2001:db8:5::', cidrPrefix: 63 });
    assert.equal(c.status, 400);
    assert.match(String(c.json?.error), /too broad/i);
    const d = await post({ ip: '2001:db8:6::', cidrPrefix: 64 });
    assert.equal(d.status, 201, JSON.stringify(d.json));
    assert.doesNotMatch(String(d.json?.error ?? ''), /too broad/i);
  });

  lotIt('D4', '07.1b subnets at the configured floor are stored', async () => {
    assert.equal((await post({ ip: '198.18.3.0', cidrPrefix: 24 })).status, 201);
    assert.equal((await post({ ip: '2001:db8:7::', cidrPrefix: 64 })).status, 201);
  });
});
