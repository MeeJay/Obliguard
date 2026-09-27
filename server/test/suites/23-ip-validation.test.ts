/**
 * 23 — A2 pure helpers: ipValidation (strict parsing, floors, reserved
 * ranges, overlap), protectedIps (BAN_PROTECTED_IPS, origins, interfaces,
 * DNS fallback) and pagination. No database, no harness.
 */
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import dns from 'dns';
import { lotIt } from '../lots';
import { logger } from '../../src/utils/logger';
import {
  parseBanTarget, parseIpOrCidr, banPrefixFloor, cidrOverlaps, cidrContains,
  RESERVED_OR_PROTECTED_MESSAGE, banTargetRawFromRow,
} from '../../src/utils/ipValidation';
import {
  findProtectedConflict, checkBanTarget, __resetProtectedCacheForTests,
} from '../../src/utils/protectedIps';
import { parsePaging, parseLimitOffset } from '../../src/utils/pagination';

type LookupFn = (...args: any[]) => Promise<unknown>;

describe('23 ip validation (pure)', () => {
  const savedEnv = { ...process.env };
  const dnsP = dns.promises as unknown as { lookup: LookupFn };
  const originalLookup = dnsP.lookup;
  let lookupImpl: LookupFn = async (host: string) => {
    const e = new Error(`blocked ${host}`) as NodeJS.ErrnoException;
    e.code = 'ENOTFOUND';
    throw e;
  };

  before(() => {
    logger.level = 'silent';
    dnsP.lookup = (...args: any[]) => lookupImpl(...args);
  });
  after(() => {
    dnsP.lookup = originalLookup;
    process.env = savedEnv;
  });
  beforeEach(() => {
    process.env = { ...savedEnv, APP_URL: '', CLIENT_ORIGIN: '', SSO_ALLOWED_HOSTS: '', BAN_PROTECTED_IPS: '' };
    delete process.env.BAN_MIN_PREFIX_V4;
    delete process.env.BAN_MIN_PREFIX_V6;
    __resetProtectedCacheForTests({ dns: true });
  });

  const ok = (raw: unknown, allowCidr = true) => {
    const r = parseBanTarget(raw, { allowCidr });
    assert.ok(r.ok, `${String(raw)} should be ok, got ${JSON.stringify(r)}`);
    return r.target;
  };
  const code = (raw: unknown, allowCidr = true) => {
    const r = parseBanTarget(raw, { allowCidr });
    return r.ok ? 'ok' : r.code;
  };

  lotIt('A2', '23.1 single addresses are canonical', () => {
    const a = ok('1.2.3.4');
    assert.equal(a.address, '1.2.3.4');
    assert.equal(a.prefix, 32);
    assert.equal(a.isNetwork, false);
    assert.equal(ok('  1.2.3.4  ').address, '1.2.3.4');
    for (const m of ['::ffff:1.2.3.4', '::FFFF:102:304']) {
      const t = ok(m);
      assert.equal(t.address, '1.2.3.4', m);
      assert.equal(t.family, 4, m);
    }
    assert.equal(ok('2001:DB8:0:0:0:0:0:1').address, '2001:db8::1');
    assert.equal(ok('2001:db8:0:0:1:0:0:1').address, '2001:db8::1:0:0:1');
    assert.equal(ok('2001:0db8:0000:0001:0000:0000:0000:0001').address, '2001:db8:0:1::1');
  });

  lotIt('A2', '23.2 subnets: masked, and refused where not allowed', () => {
    const t = ok('1.2.3.4/24');
    assert.equal(t.address, '1.2.3.0');
    assert.equal(t.prefix, 24);
    assert.equal(t.cidr, '1.2.3.0/24');
    assert.equal(t.isNetwork, true);
    assert.equal(code('1.2.3.4/24', false), 'cidr_not_allowed');
    const h = ok('1.2.3.4/32', false);
    assert.equal(h.isNetwork, false);
    assert.equal(h.cidr, '1.2.3.4');
  });

  lotIt('A2', '23.3 prefix floors and env tuning', () => {
    assert.equal(code('10.0.0.0/15'), 'too_broad');
    assert.equal(code('10.0.0.0/16'), 'ok');
    assert.equal(code('2001:db8::/47'), 'too_broad');
    assert.equal(code('2001:db8::/48'), 'ok');
    process.env.BAN_MIN_PREFIX_V4 = '20';
    assert.equal(code('10.0.0.0/19'), 'too_broad');
    assert.match((parseBanTarget('10.0.0.0/19', { allowCidr: true }) as { message: string }).message, /\/20 for IPv4/);
    assert.deepEqual(banPrefixFloor({ BAN_MIN_PREFIX_V4: 'abc' }), { v4: 16, v6: 48 });
    assert.deepEqual(banPrefixFloor({ BAN_MIN_PREFIX_V4: '4' }), { v4: 8, v6: 48 });
    assert.deepEqual(banPrefixFloor({ BAN_MIN_PREFIX_V6: '200' }), { v4: 16, v6: 128 });
  });

  lotIt('A2', '23.4 strict syntax', () => {
    const bad: unknown[] = [
      'example.com', '1.2.3.4-1.2.3.9', '1.2.3', '01.2.3.4', '1.2.3.256',
      '1.2.3.4/33', '1.2.3.4/', '1.2.3.4/024', '1.2.3.4/24/1',
      'fe80::1%eth0', '', 42, null, '1'.repeat(65), '::ffff:1.2.3.4/80',
      '0x01020304', '1.2.3.4 5.6.7.8',
    ];
    for (const b of bad) assert.equal(code(b), 'invalid', `${String(b)}`);
    assert.equal(parseIpOrCidr('::ffff:1.2.3.4/120')?.address, '1.2.3.0');
  });

  lotIt('A2', '23.5 reserved ranges share the protected message', () => {
    for (const r of ['0.0.0.0', '::', '127.0.0.1', '127.1.0.0/16', '::1', '169.254.1.1', '224.0.0.1', '255.255.255.255', 'fe80::1', 'fe80::/48', 'ff02::1']) {
      const res = parseBanTarget(r, { allowCidr: true });
      assert.equal(res.ok, false, r);
      if (!res.ok) {
        assert.equal(res.code, 'reserved', r);
        assert.equal(res.message, RESERVED_OR_PROTECTED_MESSAGE, r);
      }
    }
    assert.equal(code('0.0.0.0/0'), 'too_broad');
    assert.equal(code('203.0.113.5'), 'ok');
  });

  lotIt('A2', '23.6 overlap and containment', () => {
    assert.equal(cidrOverlaps('10.0.0.0/8', '10.1.2.3'), true);
    assert.equal(cidrOverlaps('10.0.0.0/8', '11.0.0.1'), false);
    assert.equal(cidrOverlaps('10.0.0.0/8', '::1'), false);
    assert.equal(cidrContains('1.2.3.0/24', '1.2.3.0/25'), true);
    assert.equal(cidrContains('1.2.3.0/25', '1.2.3.0/24'), false);
    assert.equal(banTargetRawFromRow('1.2.3.0', 24), '1.2.3.0/24');
    assert.equal(banTargetRawFromRow('1.2.3.0/24', null), '1.2.3.0/24');
    assert.equal(banTargetRawFromRow('1.2.3.4', null), '1.2.3.4');
  });

  lotIt('A2', '23.7 BAN_PROTECTED_IPS and configured origins', async () => {
    const warns: unknown[] = [];
    const savedWarn = logger.warn;
    (logger as any).warn = (...a: unknown[]) => { warns.push(a); };
    try {
      process.env.BAN_PROTECTED_IPS = '203.0.113.7,bogus,0.0.0.0/4';
      assert.ok(await findProtectedConflict(parseIpOrCidr('203.0.113.0/24')!));
      assert.ok(await findProtectedConflict(parseIpOrCidr('203.0.113.7')!));
      assert.equal(await findProtectedConflict(parseIpOrCidr('203.0.113.8')!), null);
      assert.ok(warns.some((w) => JSON.stringify(w).includes('BAN_PROTECTED_IPS')), 'bad entries are warned about');
      const c = await checkBanTarget('203.0.113.7');
      assert.equal(c.ok, false);
      if (!c.ok) {
        assert.equal(c.code, 'protected');
        assert.equal(c.message, RESERVED_OR_PROTECTED_MESSAGE);
      }
    } finally {
      (logger as any).warn = savedWarn;
    }

    process.env.BAN_PROTECTED_IPS = '';
    process.env.APP_URL = 'https://198.51.100.10';
    __resetProtectedCacheForTests();
    assert.ok(await findProtectedConflict(parseIpOrCidr('198.51.100.10')!, { includeInterfaces: false }));
    assert.equal(await findProtectedConflict(parseIpOrCidr('198.51.100.11')!), null);
  });

  lotIt('A2', '23.8 interface addresses (global only) and DNS fallback', async (t) => {
    const addr = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (addr) {
      const p = parseIpOrCidr(addr)!;
      assert.ok(await findProtectedConflict(p));
      assert.equal(await findProtectedConflict(p, { includeInterfaces: false }), null);
    } else {
      t.diagnostic('no non-internal IPv4 interface: interface half skipped');
    }

    const saved = lookupImpl;
    try {
      process.env.APP_URL = 'https://guard.verify.invalid';
      lookupImpl = async () => [{ address: '198.51.100.44', family: 4 }];
      __resetProtectedCacheForTests({ dns: true });
      assert.ok(await findProtectedConflict(parseIpOrCidr('198.51.100.44')!, { includeInterfaces: false }));
      lookupImpl = async () => { throw new Error('dns down'); };
      __resetProtectedCacheForTests();
      assert.ok(await findProtectedConflict(parseIpOrCidr('198.51.100.44')!, { includeInterfaces: false }),
        'the last known addresses are kept when a lookup fails');
    } finally {
      lookupImpl = saved;
    }
  });

  lotIt('A2', '23.9 pagination parsing', () => {
    assert.deepEqual(parsePaging({}, { defaultSize: 25 }), { page: 1, pageSize: 25, offset: 0 });
    assert.equal(parsePaging({ pageSize: 'abc' }, { defaultSize: 25 }).pageSize, 25);
    assert.equal(parsePaging({ pageSize: '100000' }, { defaultSize: 25 }).pageSize, 1000);
    assert.equal(parsePaging({ page: '-5' }, { defaultSize: 25 }).page, 1);
    assert.equal(parsePaging({ page: ['1', '2'] }, { defaultSize: 25 }).page, 1);
    assert.deepEqual(parsePaging({ page: '3', pageSize: '10' }, { defaultSize: 25 }), { page: 3, pageSize: 10, offset: 20 });
    assert.deepEqual(parseLimitOffset({ limit: '0', offset: '-3' }, { defaultLimit: 50 }), { limit: 50, offset: 0 });
  });
});
