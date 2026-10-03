/**
 * 73 — W8 integration (W8-5): the followups wired across the W8 lots.
 *   - the IP Reputation hub offers the four lazy tabs (Activity from W8-1,
 *     Bans / Whitelist / Remote from W8-2);
 *   - POST /api/whitelist/bulk-delete is mounted (W8-2 handler) and the
 *     Activity bulk Lift uses the server batch (POST /api/bans/bulk-lift);
 *   - whitelist writes emit WHITELIST_CHANGED (ids only) to the owning tenant
 *     plus Default, global entries to everyone;
 *   - the W8 pages and the ban service use the shared SOCKET_EVENTS constants;
 *   - every literal i18n key of the W8 pages exists in en and fr with the
 *     same {{placeholders}}.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness, waitFor } from '../harness';
import type { Harness, RecordedEvent } from '../harness';
import { lotIt } from '../lots';
import { nextIp } from '../seed';
import { SOCKET_EVENTS } from '@obliview/shared';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '');

type Tree = Record<string, unknown>;
type Rec = { events: RecordedEvent[] };

const locale = (lang: string): Tree =>
  JSON.parse(read(`client/src/i18n/locales/${lang}/translation.json`).replace(/^\uFEFF/, '')) as Tree;

function lookup(tree: Tree, key: string): unknown {
  let cur: unknown = tree;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Tree)[part];
  }
  return cur;
}

/** Literal keys passed to t('…') or held in `key: '…'` table fields (comments stripped). */
function literalKeys(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const keys = new Set<string>();
  for (const m of code.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  return [...keys];
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');

/** The client files rebuilt by W8 (hub, tabs, drawer, live events, dashboard). */
const W8_CLIENT_FILES = [
  'client/src/pages/IPReputationPage.tsx',
  'client/src/pages/ipReputation/ActivityTab.tsx',
  'client/src/pages/ipReputation/BansTab.tsx',
  'client/src/pages/ipReputation/WhitelistTab.tsx',
  'client/src/pages/ipReputation/RemoteTab.tsx',
  'client/src/components/ip/IpDetailDrawer.tsx',
  'client/src/pages/LiveEventsPage.tsx',
  'client/src/pages/DashboardPage.tsx',
  ...fs.readdirSync(path.join(REPO, 'client/src/components/dashboard'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `client/src/components/dashboard/${f}`),
];

/** Keys built at runtime (`bans.state.${s}`, `bans.type.${t}`, `liveEvents.eventType.${t}`). */
const DYNAMIC_KEYS = [
  'bans.state.active', 'bans.state.expired', 'bans.state.lifted',
  'bans.type.auto', 'bans.type.manual', 'bans.type.external',
  'liveEvents.eventType.auth_failure', 'liveEvents.eventType.auth_success', 'liveEvents.eventType.port_scan',
];

describe('73 W8 integration (W8-5)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const open = async (username: string): Promise<Rec> => {
    const s = await h.socket(await h.login(username));
    if (!s.ok) throw new Error(`socket for ${username}: ${s.error}`);
    return s;
  };
  const find = (r: Rec, pred: (p: any) => boolean) =>
    r.events.find((e) => e.event === SOCKET_EVENTS.WHITELIST_CHANGED && pred(e.args[0]));

  lotIt('W8-5', '73.1 the hub offers the four lazy tabs and the Activity bulk Lift is one server batch', () => {
    const hub = read('client/src/pages/IPReputationPage.tsx');
    for (const tab of ['Activity', 'Bans', 'Whitelist', 'Remote']) {
      assert.match(hub, new RegExp(`lazy\\(\\(\\) => import\\('\\./ipReputation/${tab}Tab'\\)\\)`), `${tab} tab wired lazily`);
    }
    const activity = read('client/src/pages/ipReputation/ActivityTab.tsx');
    assert.match(activity, /bansApi\.bulkLift\(/, 'Activity bulk Lift uses POST /bans/bulk-lift');
    assert.doesNotMatch(activity, /runBulk\([^)]*ipReputationApi\.lift\(/, 'no per-row DELETE loop for the bulk Lift');
  });

  lotIt('W8-5', '73.2 POST /api/whitelist/bulk-delete is mounted and follows the delete rule', async () => {
    const b = await h.adminIn(2);
    const own = await b.post('/api/whitelist', { ip: nextIp(), label: 'w85-own' });
    assert.equal(own.status, 201);
    const def = await h.adminIn(1);
    const global = await def.post('/api/whitelist', { ip: nextIp(), label: 'w85-global' });
    assert.equal(global.status, 201);
    assert.equal(global.json.data.scope, 'global');

    const res = await b.post('/api/whitelist/bulk-delete', { ids: [own.json.data.id, global.json.data.id] });
    assert.equal(res.status, 200);
    assert.equal(res.json.deleted, 1);
    assert.equal(res.json.forbidden, 1, 'a global entry stays locked outside Default');
    assert.equal(await h.db('ip_whitelist').where({ id: own.json.data.id }).first(), undefined);
    assert.ok(await h.db('ip_whitelist').where({ id: global.json.data.id }).first());

    const bad = await b.post('/api/whitelist/bulk-delete', { ids: [] });
    assert.equal(bad.status, 400);
    await def.del(`/api/whitelist/${global.json.data.id}`);
  });

  lotIt('W8-5', '73.3 WHITELIST_CHANGED reaches the owning tenant and Default only; global entries reach everyone', async () => {
    const mb = await open('member_b');
    const mc = await open('member_c');
    const dm = await open('default_member');

    // A tenant-2 entry: member_b and Default are told, member_c is not.
    const b = await h.adminIn(2);
    const local = await b.post('/api/whitelist', { ip: nextIp(), label: 'w85-local' });
    assert.equal(local.status, 201);
    const localId = local.json.data.id as number;
    const seen = await waitFor(() => find(mb, (p) => p?.action === 'created' && p?.ids?.includes(localId)), 3000);
    assert.equal(seen.args[0].tenantId, 2);
    assert.equal(seen.args[0].ip, undefined, 'refresh hint only: no address in the payload');
    await waitFor(() => find(dm, (p) => p?.ids?.includes(localId)), 3000);

    // Sentinel: a tenant-3 entry reaches member_c; nothing about tenant 2 came before it.
    const c = await h.adminIn(3);
    const sentinel = await c.post('/api/whitelist', { ip: nextIp(), label: 'w85-sentinel' });
    assert.equal(sentinel.status, 201);
    const sid = sentinel.json.data.id as number;
    const s = await waitFor(() => find(mc, (p) => p?.ids?.includes(sid)), 3000);
    assert.ok(!mc.events.some((e) => e.seq < s.seq && e.event === SOCKET_EVENTS.WHITELIST_CHANGED && e.args[0]?.tenantId === 2));

    // Delete: same audience.
    assert.equal((await b.del(`/api/whitelist/${localId}`)).status, 200);
    await waitFor(() => find(mb, (p) => p?.action === 'deleted' && p?.ids?.includes(localId)), 3000);

    // A global entry (from Default) reaches every tenant.
    const def = await h.adminIn(1);
    const global = await def.post('/api/whitelist', { ip: nextIp(), label: 'w85-global-evt' });
    assert.equal(global.status, 201);
    const gid = global.json.data.id as number;
    const g = await waitFor(() => find(mc, (p) => p?.ids?.includes(gid)), 3000);
    assert.equal(g.args[0].tenantId, null);
    await waitFor(() => find(mb, (p) => p?.ids?.includes(gid)), 3000);
    await def.del(`/api/whitelist/${gid}`);
    await c.del(`/api/whitelist/${sid}`);
  });

  lotIt('W8-5', '73.4 W8 pages and the ban service use the shared SOCKET_EVENTS constants', () => {
    for (const f of [...W8_CLIENT_FILES, 'client/src/pages/ipReputation/listParams.ts']) {
      assert.doesNotMatch(read(f), /'(ban:[A-Za-z]+|whitelist:changed)'/, `${f}: literal socket event name`);
    }
    for (const f of ['server/src/services/ban.service.ts', 'server/src/services/whitelist.service.ts', 'server/src/controllers/groups.controller.ts']) {
      assert.doesNotMatch(read(f), /'(ban|group|whitelist):[A-Za-z]+'/, `${f}: literal socket event name`);
    }
    assert.match(read('server/src/services/whitelist.service.ts'), /SOCKET_EVENTS\.WHITELIST_CHANGED/);
  });

  lotIt('W8-5', '73.5 every W8 i18n key exists in en and fr with the same placeholders', () => {
    const en = locale('en');
    const fr = locale('fr');
    const keys = new Set<string>(DYNAMIC_KEYS);
    for (const f of W8_CLIENT_FILES) for (const k of literalKeys(read(f))) keys.add(k);
    assert.ok(keys.size > 300, `expected the W8 pages to use many keys, found ${keys.size}`);
    const missing: string[] = [];
    for (const key of keys) {
      const e = lookup(en, key);
      const r = lookup(fr, key);
      if (typeof e !== 'string') { missing.push(`en:${key}`); continue; }
      if (typeof r !== 'string') { missing.push(`fr:${key}`); continue; }
      if (placeholders(e) !== placeholders(r)) missing.push(`placeholders differ: ${key}`);
    }
    assert.deepEqual(missing, []);
  });
});
