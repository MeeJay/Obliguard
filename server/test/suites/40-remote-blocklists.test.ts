/**
 * 40 — W1-1 remote blocklists lockdown: writes reserved to the platform admin
 * on Default (owner decision 6), tenant-filtered reads, SSRF guard on create,
 * update and before every fetch, whitelisted update fields (a URL change
 * drops the stored key), imported entries validated like every ban target,
 * and the obli.tools push (BROKEN-8: no more 42703, local detections only,
 * last push advances only on success).
 *
 * Outbound fetches are stubbed in-test on top of the harness network guard;
 * list URLs use 2001:db8:40::/48 literals (no DNS needed).
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, hostOf } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { insertBan, insertWhitelist, nextIp, litIp } from '../seed';

const OK_URL = (n: number, path = 'list.txt') => `https://[${litIp('2001:db8', 0x40, n)}]/${path}`;
const PUSH_URL = 'https://guard.obli.tools/';

type FetchStub = (url: string, init: RequestInit | undefined) => Response | null;

describe('40 remote blocklists (W1-1)', () => {
  let h: Harness;
  let stub: FetchStub | null = null;
  let harnessFetch: typeof fetch;
  before(async () => {
    h = await startHarness();
    // In-test stub layered on the harness guard: a stub answer wins, anything
    // else goes through the guard (and is recorded as blocked).
    harnessFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      const r = stub?.(String(url), init) ?? null;
      if (r) return r;
      return harnessFetch(input, init);
    }) as typeof fetch;
  });
  after(async () => {
    globalThis.fetch = harnessFetch;
    await h.close();
  });

  const listCount = async () => Number((await h.db('remote_blocklists').count<{ c: string }[]>({ c: '*' }))[0].c);
  const listRow = (id: number) => h.db('remote_blocklists').where({ id }).first();

  async function insertList(o: { tenantId?: number | null; url?: string; apiKey?: string | null; name?: string; sourceType?: string } = {}): Promise<number> {
    const [r] = await h.db('remote_blocklists').insert({
      name: o.name ?? `verify-${Math.random().toString(36).slice(2, 8)}`,
      source_type: o.sourceType ?? 'url',
      url: o.url ?? 'https://blocklist.verify.invalid/list.txt',
      api_key: o.apiKey === undefined ? 'secret-key' : o.apiKey,
      enabled: false,
      tenant_id: o.tenantId === undefined ? 1 : o.tenantId,
    }).returning('id') as Array<{ id: number }>;
    return r.id;
  }

  async function insertRemoteIp(listId: number, ip: string): Promise<number> {
    const [r] = await h.db('remote_blocked_ips').insert({
      blocklist_id: listId, ip: h.db.raw('?::inet', [ip]), reason: 'verify',
    }).returning('id') as Array<{ id: number }>;
    return r.id;
  }

  async function writesAllRefused(c: Client): Promise<void> {
    const id = await insertList();
    const ipId = await insertRemoteIp(id, nextIp());
    const snap = await listRow(id);
    const before = await listCount();
    const calls: Array<[string, Promise<{ status: number }>]> = [
      ['POST /', c.post('/api/remote-blocklists', { name: 'verify', sourceType: 'url', url: OK_URL(1) })],
      ['PUT /:id', c.put(`/api/remote-blocklists/${id}`, { name: 'hijacked', url: OK_URL(2), enabled: true })],
      ['DELETE /:id', c.del(`/api/remote-blocklists/${id}`)],
      ['POST /:id/sync', c.post(`/api/remote-blocklists/${id}/sync`)],
      ['PUT /ips/:id/toggle', c.put(`/api/remote-blocklists/ips/${ipId}/toggle`, { enabled: false })],
      ['POST /ips/:id/toggle', c.post(`/api/remote-blocklists/ips/${ipId}/toggle`, { enabled: false })],
      ['POST /push-now', c.post('/api/remote-blocklists/push-now')],
    ];
    for (const [name, p] of calls) assert.equal((await p).status, 403, name);
    assert.equal(await listCount(), before);
    assert.deepEqual(await listRow(id), snap);
    assert.equal((await h.db('remote_blocked_ips').where({ id: ipId }).first()).enabled, true);
  }

  lotIt('W1-1', '40.1 tenant members (any tenant, Default included) get 403 on every write route', async () => {
    await writesAllRefused(await h.as('member_b'));
    await writesAllRefused(await h.as('default_member'));
  });

  lotIt('W1-1', '40.2 a platform admin operating a non-Default tenant gets 403 on every write route', async () => {
    await writesAllRefused(await h.adminIn(2));
  });

  lotIt('W1-1', '40.3 the platform admin on Default creates a list; the key is never echoed', async () => {
    const before = await listCount();
    const r = await (await h.adminIn(1)).post('/api/remote-blocklists', {
      name: 'verify-create', sourceType: 'url', url: OK_URL(3), apiKey: 'k-create', syncInterval: 900,
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(await listCount(), before + 1);
    assert.equal(r.json.data.hasApiKey, true);
    assert.ok(!r.text.includes('k-create'));
    const row = await listRow(r.json.data.id);
    assert.equal(row.url, OK_URL(3));
    assert.equal(row.api_key, 'k-create');
    assert.equal(row.sync_interval, 900);
    assert.equal(row.tenant_id, 1);
  });

  lotIt('W1-1', '40.4 private, loopback, metadata, non-HTTP and unresolvable URLs are refused 400', async () => {
    const admin = await h.adminIn(1);
    const before = await listCount();
    for (const url of [
      'http://127.0.0.1/list.txt',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/list.txt',
      'http://172.16.5.4/list.txt',
      'http://192.168.1.1/list.txt',
      'http://100.64.0.1/list.txt',
      'http://0.0.0.0/list.txt',
      'http://2130706433/list.txt',
      'http://localhost:5432/',
      'http://[::1]/list.txt',
      'http://[::ffff:127.0.0.1]/list.txt',
      'http://[fd00::1]/list.txt',
      'http://[fe80::1]/list.txt',
      'file:///etc/passwd',
      'ftp://example.invalid/list.txt',
      'https://blocklist.verify.invalid/list.txt',
      'not a url',
    ]) {
      const r = await admin.post('/api/remote-blocklists', { name: 'verify-ssrf', sourceType: 'url', url });
      assert.equal(r.status, 400, `${url}: ${r.status} ${r.text}`);
    }
    assert.equal(await listCount(), before);
    assert.deepEqual(h.blockedNetwork, []);
  });

  lotIt('W1-1', '40.5 update: whitelisted fields only, a URL change drops the stored key, private URLs refused', async () => {
    const admin = await h.adminIn(1);
    const created = await admin.post('/api/remote-blocklists', { name: 'verify-upd', sourceType: 'url', url: OK_URL(5), apiKey: 'k1' });
    assert.equal(created.status, 201, created.text);
    const id = created.json.data.id as number;

    // Non-whitelisted (snake_case / internal) fields are ignored.
    let r = await admin.put(`/api/remote-blocklists/${id}`, { name: 'verify-upd2', tenant_id: 3, api_key: 'evil', last_sync_count: 99, source_type: 'oblitools' });
    assert.equal(r.status, 200, r.text);
    let row = await listRow(id);
    assert.equal(row.name, 'verify-upd2');
    assert.equal(row.tenant_id, 1);
    assert.equal(row.api_key, 'k1');
    assert.equal(row.last_sync_count, 0);
    assert.equal(row.source_type, 'url');

    // Same URL resubmitted: key kept.
    r = await admin.put(`/api/remote-blocklists/${id}`, { url: OK_URL(5), enabled: true });
    assert.equal(r.status, 200, r.text);
    assert.equal((await listRow(id)).api_key, 'k1');

    // A private URL is refused and nothing changes.
    r = await admin.put(`/api/remote-blocklists/${id}`, { url: 'http://169.254.169.254/latest/' });
    assert.equal(r.status, 400);
    row = await listRow(id);
    assert.equal(row.url, OK_URL(5));
    assert.equal(row.api_key, 'k1');

    // New URL without a key: the key is dropped.
    r = await admin.put(`/api/remote-blocklists/${id}`, { url: OK_URL(6) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.hasApiKey, false);
    row = await listRow(id);
    assert.equal(row.url, OK_URL(6));
    assert.equal(row.api_key, null);

    // New URL with a new key: the new key is stored.
    r = await admin.put(`/api/remote-blocklists/${id}`, { url: OK_URL(7), apiKey: 'k2' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await listRow(id)).api_key, 'k2');

    // Bad types are 400, unknown ids 404.
    assert.equal((await admin.put(`/api/remote-blocklists/${id}`, { enabled: 'yes' })).status, 400);
    assert.equal((await admin.put(`/api/remote-blocklists/${id}`, { syncInterval: 1 })).status, 400);
    assert.equal((await admin.put('/api/remote-blocklists/999999', { name: 'x' })).status, 404);
  });

  lotIt('W1-1', '40.6 reads are tenant-filtered: instance lists for everyone (URL query redacted off Default), a legacy tenant list only for its tenant and Default', async () => {
    const inst = await insertList({ tenantId: 1, name: 'verify-inst', url: 'https://blocklist.verify.invalid/list.txt?token=verify-url-secret' });
    const legacyC = await insertList({ tenantId: 3, name: 'verify-legacy-c' });
    const ipInst = nextIp();
    const ipC = nextIp();
    await insertRemoteIp(inst, ipInst);
    await insertRemoteIp(legacyC, ipC);

    const ids = async (c: Client) => {
      const r = await c.get('/api/remote-blocklists');
      assert.equal(r.status, 200);
      return new Set((r.json.data as Array<{ id: number }>).map((x) => x.id));
    };
    const ips = async (c: Client) => {
      const r = await c.get('/api/remote-blocklists/ips?limit=1000');
      assert.equal(r.status, 200);
      return new Set((r.json.data as Array<{ ip: string }>).map((x) => hostOf(x.ip)));
    };

    const mb = await h.as('member_b');
    const mc = await h.as('member_c');
    const adm = await h.adminIn(1);
    assert.ok((await ids(mb)).has(inst));
    assert.ok(!(await ids(mb)).has(legacyC));
    assert.ok((await ids(mc)).has(legacyC));
    assert.ok((await ids(adm)).has(legacyC));
    assert.ok((await ips(mb)).has(ipInst));
    assert.ok(!(await ips(mb)).has(ipC));
    assert.ok((await ips(mc)).has(ipC));
    assert.ok((await ips(adm)).has(ipC));
    assert.equal((await mb.get('/api/remote-blocklists/stats')).status, 200);

    // A token in the list URL is readable only on Default.
    const mbList = await mb.get('/api/remote-blocklists');
    assert.ok(!mbList.text.includes('verify-url-secret'), mbList.text);
    const mbInst = (mbList.json.data as Array<{ id: number; url: string }>).find((x) => x.id === inst);
    assert.equal(mbInst?.url, 'https://blocklist.verify.invalid/list.txt');
    assert.ok((await adm.get('/api/remote-blocklists')).text.includes('verify-url-secret'));

    // Paging garbage never 500s and is capped.
    for (const qs of ['limit=abc&offset=-5', 'limit=999999999', 'limit[]=1&offset[x]=2', 'blocklistId=abc&enabled=maybe']) {
      assert.equal((await mb.get(`/api/remote-blocklists/ips?${qs}`)).status, 200, qs);
    }
  });

  lotIt('W1-1', '40.7 sync re-checks the URL before fetching, refuses redirects and validates every entry', async () => {
    const admin = await h.adminIn(1);

    // A legacy row already pointing at an internal target: no request leaves.
    const legacy = await insertList({ url: 'http://169.254.169.254/latest/meta-data/' });
    let seen = 0;
    stub = () => { seen++; return null; };
    try {
      const r = await admin.post(`/api/remote-blocklists/${legacy}/sync`);
      assert.equal(r.status, 400, r.text);
      assert.equal(seen, 0);
    } finally { stub = null; }

    // A 3xx is an error, never followed.
    const redir = await insertList({ url: OK_URL(8), apiKey: null });
    let redirectMode: unknown;
    stub = (url, init) => {
      if (url !== OK_URL(8)) return null;
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/list.txt' } });
    };
    try {
      const r = await admin.post(`/api/remote-blocklists/${redir}/sync`);
      assert.equal(r.status, 502, r.text);
      assert.equal(redirectMode, 'manual');
    } finally { stub = null; }

    // Entries: only valid, bannable targets are kept.
    const good4 = nextIp();
    const good6 = litIp('2001:db8', 0x41, 1);
    const list = await insertList({ url: OK_URL(9), apiKey: null });
    stub = (url) => url === OK_URL(9)
      ? new Response([
        '# comment', '; comment', '',
        good4, `${good6},csv,columns`, good4,
        '127.0.0.1', '169.254.169.254', '0.0.0.0/0', '10.0.0.0/8', '2001:db8::/32',
        'garbage', '999.1.1.1', '224.0.0.1',
      ].join('\n'), { status: 200 })
      : null;
    try {
      const r = await admin.post(`/api/remote-blocklists/${list}/sync`);
      assert.equal(r.status, 200, r.text);
    } finally { stub = null; }
    const stored = (await h.db('remote_blocked_ips').where({ blocklist_id: list }).select(h.db.raw('host(ip) as ip')) as Array<{ ip: string }>)
      .map((x) => x.ip).sort();
    assert.deepEqual(stored, [good4, good6].sort());
    assert.equal((await listRow(list)).last_sync_count, 2);
    assert.deepEqual(h.blockedNetwork, []);
  });

  lotIt('W1-1', '40.8 push-now contributes local detections only, never throws 42703, advances only on success', async () => {
    const setCfg = async (key: string, value: string | null) => {
      if (value === null) await h.db('app_config').where({ key }).del();
      else await h.db('app_config').insert({ key, value }).onConflict('key').merge({ value });
    };
    const lastPush = async () => (await h.db('app_config').where({ key: 'oblitools_last_push_at' }).first('value'))?.value ?? null;
    await setCfg('oblitools_push_enabled', 'true');
    await setCfg('oblitools_api_key', 'verify-oblitools-key');
    await setCfg('oblitools_instance_name', 'verify');
    await setCfg('oblitools_last_push_at', null);

    const local = nextIp();
    await insertBan(h.db, { ip: local, banType: 'auto', originTenantId: 2 });
    const pulled = nextIp();
    const pulledId = await insertBan(h.db, { ip: pulled, banType: 'auto' });
    await h.db('ip_bans').where({ id: pulledId }).update({ reason: 'obli.tools: shared ban (3 reports)' });
    const mikrotik = nextIp();
    const mtId = await insertBan(h.db, { ip: mikrotik, banType: 'auto', originTenantId: 2 });
    await h.db('ip_bans').where({ id: mtId }).update({ reason: 'MikroTik import: detected in "x" address-list' });
    const external = nextIp();
    const extId = await insertBan(h.db, { ip: external, banType: 'external' });
    await h.db('ip_bans').where({ id: extId }).update({ origin_app: 'oblihub' });
    const manual = nextIp();
    await insertBan(h.db, { ip: manual, banType: 'manual', originTenantId: 1 });
    const fromList = nextIp();
    await insertBan(h.db, { ip: fromList, banType: 'auto' });
    await insertRemoteIp(await insertList(), fromList);

    const recent = new Date(Date.now() - 1000);
    const rep = async (ip: string, service: string | null) => {
      await h.db('ip_reputation').insert({ ip: h.db.raw('?::inet', [ip]), total_failures: 3, first_seen: recent, last_seen: recent, updated_at: recent });
      if (service) {
        await h.db('ip_events').insert({ ip: h.db.raw('?::inet', [ip]), username: 'root', service, event_type: 'auth_failure', timestamp: recent, raw_log: 'verify', tenant_id: 2 });
      }
    };
    const suspicious = nextIp();
    await rep(suspicious, 'ssh');
    const injected = nextIp();
    await rep(injected, 'oblitools_shared');
    const whitelisted = nextIp();
    await rep(whitelisted, 'ssh');
    await insertWhitelist(h.db, { ip: `${whitelisted}/32`, scope: 'global' });

    const admin = await h.adminIn(1);
    let body: any = null;
    let auth: string | null = null;
    stub = (url, init) => {
      if (!url.startsWith(PUSH_URL)) return null;
      body = JSON.parse(String(init?.body));
      auth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ accepted: 2, new: 2 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    let r;
    try {
      r = await admin.post('/api/remote-blocklists/push-now');
    } finally { stub = null; }
    assert.equal(r.status, 200, r.text);
    assert.ok(!/42703|does not exist/.test(r.text), r.text);
    assert.ok(body, 'no push request was sent');
    assert.equal(auth, 'Bearer verify-oblitools-key');
    assert.equal(body.instance, 'verify');
    const byIp = new Map<string, string>((body.ips as Array<{ ip: string; status: string }>).map((x) => [x.ip, x.status]));
    assert.equal(byIp.get(local), 'banned');
    assert.equal(byIp.get(suspicious), 'suspicious');
    for (const ip of [pulled, mikrotik, external, manual, fromList, injected, whitelisted]) {
      assert.ok(!byIp.has(ip), `${ip} must not be contributed`);
    }
    const after1 = await lastPush();
    assert.ok(after1, 'oblitools_last_push_at not set');

    // An upstream failure is surfaced (502) and the cursor does not move.
    await new Promise((res) => setTimeout(res, 20));
    await insertBan(h.db, { ip: nextIp(), banType: 'auto', originTenantId: 2 });
    stub = (url) => url.startsWith(PUSH_URL) ? new Response('boom', { status: 500 }) : null;
    try {
      r = await admin.post('/api/remote-blocklists/push-now');
    } finally { stub = null; }
    assert.equal(r.status, 502, r.text);
    assert.match(r.json.message, /HTTP 500/);
    assert.equal(await lastPush(), after1);
    assert.deepEqual(h.blockedNetwork, []);
  });
});
