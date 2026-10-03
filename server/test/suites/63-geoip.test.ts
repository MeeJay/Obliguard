/**
 * 63 — W6-3 GeoIP enrichment persisted server-side (ADMIN-FEATURES-14):
 * reputation upserts queue public IPs, a batch writes country / city / ASN
 * back into ip_reputation, private and reserved IPs never reach the
 * provider, and /geo/batch answers from ip_reputation before the provider.
 *
 * The provider is a fake injected with geoipService.setProvider(): no
 * outbound call. Public literals of this suite: 8.8.4.0/24, 9.9.9.0/24,
 * 1.1.1.0/24 (never sent anywhere).
 */
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { nextIp } from '../seed';
import { D } from '../fixtures';
import { geoipService, geoLookupCandidate, providerFromEnv } from '../../src/services/geoip.service';
import type { GeoInfo, GeoProvider } from '../../src/services/geoip.service';
import { ipReputationService } from '../../src/services/ipReputation.service';

class FakeProvider implements GeoProvider {
  readonly name = 'fake';
  readonly maxBatch = 100;
  calls: string[][] = [];
  open = true;
  constructor(private readonly table: Record<string, GeoInfo | null>) {}
  available(): boolean { return this.open; }
  async lookup(ips: string[]): Promise<Map<string, GeoInfo | null>> {
    this.calls.push([...ips]);
    return new Map(ips.map((ip) => [ip, this.table[ip] ?? null]));
  }
  get asked(): string[] { return this.calls.flat(); }
}

const GOOGLE: GeoInfo = { countryCode: 'US', city: 'Mountain View', asn: 'AS15169 Google LLC' };
const QUAD9: GeoInfo = { countryCode: 'CH', city: 'Zurich', asn: 'AS19281 Quad9' };
const CF: GeoInfo = { countryCode: 'AU', city: 'Sydney', asn: 'AS13335 Cloudflare, Inc.' };

describe('63 geoip enrichment (W6-3)', () => {
  let h: Harness;
  let fake: FakeProvider;

  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    ipReputationService.stopGeoBackfill();
    geoipService.setProvider(undefined);
    await h.close();
  });
  beforeEach(() => {
    fake = new FakeProvider({
      '8.8.4.4': GOOGLE, '8.8.4.5': GOOGLE, '8.8.4.6': GOOGLE, '8.8.4.7': GOOGLE,
      '9.9.9.9': QUAD9, '9.9.9.10': QUAD9,
      '1.1.1.1': CF, '1.1.1.2': CF,
    });
    geoipService.setProvider(fake);
  });

  const upsert = (ip: string) => ipReputationService.upsertFromEvents([
    { ip, service: 'ssh', username: 'root', deviceId: D.B.id, eventType: 'auth_failure' },
  ]);
  const geoRow = async (ip: string) => {
    const r = await h.db.raw(
      'SELECT geo_country_code, geo_city, asn FROM ip_reputation WHERE ip = ?::inet',
      [ip],
    );
    return r.rows[0] as { geo_country_code: string | null; geo_city: string | null; asn: string | null } | undefined;
  };
  const reputation = async (ip: string, geo: Partial<{ geo_country_code: string; geo_city: string; asn: string }> = {}) => {
    const now = new Date();
    await h.db('ip_reputation').insert({
      ip, total_failures: 1, total_successes: 0, affected_agents_count: 1,
      affected_services: ['ssh'], attempted_usernames: ['root'],
      first_seen: now, last_seen: now, updated_at: now, ...geo,
    }).onConflict('ip').merge();
  };

  lotIt('W6-3', '63.1 an upsert of a public IP fills country / city / ASN after the batch', async () => {
    await upsert('8.8.4.4');
    assert.deepEqual(await geoRow('8.8.4.4'), { geo_country_code: null, geo_city: null, asn: null }, 'enrichment is asynchronous');
    assert.ok(ipReputationService.geoQueueSize >= 1, 'the IP is queued');

    const written = await ipReputationService.flushGeoEnrichment();
    assert.equal(written, 1);
    assert.deepEqual(await geoRow('8.8.4.4'), { geo_country_code: 'US', geo_city: 'Mountain View', asn: 'AS15169 Google LLC' });
    assert.deepEqual(fake.calls, [['8.8.4.4']]);

    // The API exposes the persisted values.
    const c = await h.as('default_member');
    const r = await c.get('/api/ip-reputation?search=8.8.4.4&limit=10');
    assert.equal(r.status, 200);
    const row = (r.json.data as any[]).find((x) => String(x.ip).startsWith('8.8.4.4'));
    assert.ok(row, 'listed');
    assert.equal(row.geoCountryCode, 'US');
    assert.equal(row.geoCity, 'Mountain View');
    assert.equal(row.asn, 'AS15169 Google LLC');

    // A second activity burst does not look it up again (row already filled).
    await upsert('8.8.4.4');
    await ipReputationService.flushGeoEnrichment();
    assert.equal(fake.calls.length, 1);
  });

  lotIt('W6-3', '63.2 private, reserved and documentation IPs are never looked up', async () => {
    const doc = nextIp();
    const ips = ['10.1.2.3', '192.168.7.7', '172.20.0.9', '127.0.0.1', '100.64.3.3', '169.254.169.254', doc, 'fd00::7', 'fe80::1', '2001:db8::5'];
    for (const ip of ips) await upsert(ip);
    await ipReputationService.ensureExists('10.9.9.9');
    await ipReputationService.markSuspicious('192.168.50.50');
    assert.equal(ipReputationService.geoQueueSize, 0, 'nothing queued');
    await ipReputationService.flushGeoEnrichment();
    assert.deepEqual(fake.asked, []);
    for (const ip of ips) {
      assert.deepEqual(await geoRow(ip), { geo_country_code: null, geo_city: null, asn: null }, ip);
    }

    for (const ip of [...ips, '10.9.9.9', '8.8.8.0/24', 'not-an-ip', '']) assert.equal(geoLookupCandidate(ip), null, ip);
    assert.equal(geoLookupCandidate('8.8.4.4'), '8.8.4.4');
    assert.equal(geoLookupCandidate('::ffff:8.8.4.4'), '8.8.4.4');
    assert.equal(geoLookupCandidate('2606:4700:4700::1111'), '2606:4700:4700::1111');

    // Also through the route.
    const c = await h.as('default_member');
    const r = await c.post('/api/geo/batch', { ips: ['10.1.2.3', '192.168.7.7', doc] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, []);
    assert.deepEqual(fake.asked, []);
  });

  lotIt('W6-3', '63.3 /geo/batch serves ip_reputation without a provider call', async () => {
    await reputation('9.9.9.9', { geo_country_code: 'CH', geo_city: 'Zurich', asn: 'AS19281 Quad9' });
    const c = await h.as('member_b');
    const r = await c.post('/api/geo/batch', { ips: ['9.9.9.9'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, [{ query: '9.9.9.9', countryCode: 'CH' }]);
    assert.deepEqual(fake.calls, []);
  });

  lotIt('W6-3', '63.4 /geo/batch looks up only the missing IPs, caches and persists them', async () => {
    await reputation('9.9.9.10', { geo_country_code: 'CH' });
    await reputation('1.1.1.1'); // row without geo: filled by the route
    const c = await h.as('member_b');
    const r = await c.post('/api/geo/batch', { ips: ['9.9.9.10', '1.1.1.1', '1.1.1.2', '10.0.0.1', 42] });
    assert.equal(r.status, 200);
    const byIp = new Map((r.json.data as Array<{ query: string; countryCode: string }>).map((x) => [x.query, x.countryCode]));
    assert.deepEqual(Object.fromEntries(byIp), { '9.9.9.10': 'CH', '1.1.1.1': 'AU', '1.1.1.2': 'AU' });
    assert.deepEqual(fake.asked.sort(), ['1.1.1.1', '1.1.1.2']);

    // The existing row gets the lookup result; no row is created for 1.1.1.2.
    let row: Awaited<ReturnType<typeof geoRow>>;
    for (let i = 0; i < 50; i++) {
      row = await geoRow('1.1.1.1');
      if (row?.geo_country_code) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.deepEqual(row!, { geo_country_code: 'AU', geo_city: 'Sydney', asn: 'AS13335 Cloudflare, Inc.' });
    assert.equal(await geoRow('1.1.1.2'), undefined);

    // Second call: DB + cache, no new provider call.
    const again = await c.post('/api/geo/batch', { ips: ['1.1.1.1', '1.1.1.2'] });
    assert.equal(again.json.data.length, 2);
    assert.equal(fake.calls.length, 1);
  });

  lotIt('W6-3', '63.5 a rate-limited provider defers: IPs stay queued, then fill', async () => {
    fake.open = false;
    await upsert('8.8.4.5');
    await ipReputationService.flushGeoEnrichment();
    assert.deepEqual(fake.calls, [], 'no call while unavailable');
    assert.equal((await geoRow('8.8.4.5'))?.geo_country_code, null);
    assert.ok(ipReputationService.geoQueueSize >= 1, 'requeued');

    fake.open = true;
    assert.equal(await ipReputationService.flushGeoEnrichment(), 1);
    assert.equal((await geoRow('8.8.4.5'))?.geo_country_code, 'US');
  });

  lotIt('W6-3', '63.6 existing geo is never overwritten; misses are cached, not retried', async () => {
    await reputation('8.8.4.6', { asn: 'AS1 Manual' });
    ipReputationService.enqueueGeo(['8.8.4.6']);
    await ipReputationService.flushGeoEnrichment();
    assert.deepEqual(fake.calls, [], 'row already has geo: no lookup');
    assert.deepEqual(await geoRow('8.8.4.6'), { geo_country_code: null, geo_city: null, asn: 'AS1 Manual' });

    const written = await ipReputationService.persistGeo(new Map([['8.8.4.7', GOOGLE]]));
    assert.equal(written, 0, 'no row for 8.8.4.7');

    // 8.8.8.9 is unknown to the fake: looked up once, then a cached miss.
    await upsert('8.8.8.9');
    await ipReputationService.flushGeoEnrichment();
    assert.deepEqual(fake.calls, [['8.8.8.9']]);
    await upsert('8.8.8.9');
    assert.equal(ipReputationService.geoQueueSize, 0, 'known miss not requeued');
    await ipReputationService.flushGeoEnrichment();
    assert.equal(fake.calls.length, 1);
  });

  lotIt('W6-3', '63.7 backfill queues existing rows without geo', async () => {
    await reputation('9.9.9.11');
    fake = new FakeProvider({ '9.9.9.11': QUAD9 });
    geoipService.setProvider(fake);
    const queued = await ipReputationService.backfillGeo();
    assert.ok(queued >= 1);
    await ipReputationService.flushGeoEnrichment();
    assert.equal((await geoRow('9.9.9.11'))?.geo_country_code, 'CH');
  });

  lotIt('W6-3', '63.7b backfill pages past rows that can never resolve (private, CIDR)', async () => {
    // 600 more recent private rows + a CIDR row would fill a single 500-row
    // page every pass and starve the older public row.
    const old = new Date(Date.now() - 86_400_000);
    const recent = new Date();
    const rows = Array.from({ length: 600 }, (_, i) => ({
      ip: `10.63.${Math.floor(i / 250)}.${(i % 250) + 1}`, total_failures: 1, total_successes: 0,
      affected_agents_count: 1, affected_services: ['ssh'], attempted_usernames: ['root'],
      first_seen: recent, last_seen: recent, updated_at: recent,
    }));
    rows.push({ ...rows[0], ip: '9.9.8.0/24' });
    await h.db('ip_reputation').insert(rows).onConflict('ip').ignore();
    await reputation('9.9.9.12');
    await h.db('ip_reputation').where({ ip: '9.9.9.12' }).update({ last_seen: old });

    fake = new FakeProvider({ '9.9.9.12': QUAD9 });
    geoipService.setProvider(fake);
    await ipReputationService.backfillGeo();
    for (let i = 0; i < 5 && ipReputationService.geoQueueSize > 0; i++) await ipReputationService.flushGeoEnrichment();
    assert.equal((await geoRow('9.9.9.12'))?.geo_country_code, 'CH');
    assert.ok(fake.asked.every((ip) => !ip.startsWith('10.') && !ip.startsWith('9.9.8.')), 'no private / CIDR lookup');
    await h.db('ip_reputation').whereRaw("ip <<= '10.63.0.0/16'::inet OR ip = '9.9.8.0/24'::inet").delete();
  });

  lotIt('W6-3', '63.8 provider selection from the environment', async () => {
    assert.equal(providerFromEnv({ GEOIP_PROVIDER: 'none' }), null);
    assert.equal(providerFromEnv({ GEOIP_PROVIDER: 'mmdb' }), null, 'mmdb without a path never falls back to a third party');
    assert.equal(providerFromEnv({})?.name, 'ip-api');
    assert.equal(providerFromEnv({ GEOIP_PROVIDER: 'ip-api', GEOIP_DB_PATH: '/x.mmdb' })?.name, 'ip-api');
    const mmdb = providerFromEnv({ GEOIP_DB_PATH: '/nonexistent/obliguard-verify.mmdb' }) as GeoProvider & { ready: Promise<void> };
    assert.equal(mmdb.name, 'mmdb');
    await mmdb.ready;
    assert.equal(mmdb.available(), false, 'unreadable mmdb: disabled');
    // Installed as the service provider, a broken mmdb turns GeoIP off and
    // drops anything queued before it finished opening.
    geoipService.setProvider(mmdb);
    assert.equal(geoipService.isEnabled(), false, 'broken mmdb: service disabled');
    await upsert('8.8.4.4');
    assert.equal(ipReputationService.geoQueueSize, 0, 'broken mmdb: nothing queued');

    geoipService.setProvider(null);
    assert.equal(geoipService.isEnabled(), false);
    await upsert('8.8.4.4');
    assert.equal(ipReputationService.geoQueueSize, 0, 'disabled: nothing queued');
  });

  lotIt('W6-3', '63.9 no outbound network call during the suite', async () => {
    assert.deepEqual(h.blockedNetwork, []);
  });
});
