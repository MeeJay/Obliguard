/**
 * 78 — W9 integration (W9-5): the followups wired across the W9 lots.
 *   - the Policies hub embeds the templates / network-limits pages without
 *     URL clashes (the hub owns ?tab=, the templates editor ?templateTab=),
 *     and the IP Reputation > Remote link targets an existing hub tab;
 *   - the 'remote' ban type (W9-1) is filterable (GET /api/bans?type=remote)
 *     and labelled in the Bans tab and the IP drawer;
 *   - the client API declares the provenance fields (enforce, status,
 *     listEnforce, enforced) instead of page-local widenings;
 *   - every server-side RouterOS connection pins the API-SSL certificate per
 *     router (deviceId), not per host:port;
 *   - every literal i18n key of the W9 pages exists in en and fr with the
 *     same {{placeholders}}.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { nextIp } from '../seed';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '');

type Tree = Record<string, unknown>;

const locale = (lang: string): Tree =>
  JSON.parse(read(`client/src/i18n/locales/${lang}/translation.json`).replace(/^﻿/, '')) as Tree;

function lookup(tree: Tree, key: string): unknown {
  let cur: unknown = tree;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Tree)[part];
  }
  return cur;
}

/** Literal keys passed to t('…') (comments stripped). */
function literalKeys(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const keys = new Set<string>();
  for (const m of code.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  return [...keys];
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');

const dirFiles = (dir: string) => fs.readdirSync(path.join(REPO, dir))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => `${dir}/${f}`);

/** The client files built or rebuilt by W9 (policies hub, templates, NetMap, provenance). */
const W9_CLIENT_FILES = [
  'client/src/pages/PoliciesPage.tsx',
  'client/src/pages/RateLimitPage.tsx',
  'client/src/pages/SettingsPage.tsx',
  'client/src/components/settings/RemoteBlocklistsSection.tsx',
  'client/src/components/layout/Sidebar.tsx',
  'client/src/pages/ServiceTemplatesPage.tsx',
  ...dirFiles('client/src/components/serviceTemplates'),
  'client/src/pages/NetMapPage.tsx',
  ...dirFiles('client/src/netmap'),
  ...dirFiles('client/src/netmap3d'),
  'client/src/pages/ipReputation/RemoteTab.tsx',
  'client/src/pages/ipReputation/BansTab.tsx',
  'client/src/components/ip/IpDetailDrawer.tsx',
  'client/src/components/mikrotik/MikroTikPanel.tsx',
  'client/src/components/mikrotik/AddMikroTikModal.tsx',
];

/** Keys built at runtime (`bans.type.${t}`, `serviceTemplates.parser.re2.${code}`). */
const DYNAMIC_KEYS = [
  'bans.type.remote',
  ...['lookahead', 'lookbehind', 'backreference', 'namedBackreference', 'atomicGroup', 'conditional',
    'recursion', 'repeatCount', 'unbalanced', 'escape', 'group'].map((c) => `serviceTemplates.parser.re2.${c}`),
];

describe('78 W9 integration (W9-5)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  lotIt('W9-5', '78.1 the Policies hub embeds its pages without URL clashes', () => {
    const hub = read('client/src/pages/PoliciesPage.tsx');
    assert.match(hub, /<ServiceTemplatesPage embedded \/>/);
    assert.match(hub, /<RateLimitPage embedded \/>/);
    assert.match(hub, /<RemoteBlocklistsSection\b/);
    const tabs = /const POLICY_TABS = \[([^\]]*)\]/.exec(hub);
    assert.ok(tabs, 'POLICY_TABS declared');
    const ids = [...tabs[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);

    // The templates editor keeps its own parameter when embedded.
    const templates = read('client/src/pages/ServiceTemplatesPage.tsx');
    assert.match(templates, /param: embedded \? 'templateTab' : 'tab'/);
    // The network-limits page reads no tab parameter of its own.
    assert.doesNotMatch(read('client/src/pages/RateLimitPage.tsx'), /useTabParam|searchParams\.get\('tab'\)/);

    // IP Reputation > Remote links to an existing hub tab.
    const remote = read('client/src/pages/ipReputation/RemoteTab.tsx');
    const link = /POLICIES_BLOCKLISTS = '\/policies\?tab=(\w+)'/.exec(remote);
    assert.ok(link, 'RemoteTab links to the Policies hub');
    assert.ok(ids.includes(link[1]), `tab '${link[1]}' exists in POLICY_TABS (${ids.join(', ')})`);
  });

  lotIt('W9-5', '78.2 remote bans are filterable and labelled', async () => {
    const ip = nextIp();
    const [row] = await h.db('ip_bans').insert({
      ip: h.db.raw('?::inet', [ip]),
      scope: 'global',
      ban_type: 'remote',
      origin_ref: 'blocklist:987654',
      reason: 'w95 remote',
      is_active: true,
    }).returning('id');
    const id = typeof row === 'object' ? row.id : row;
    try {
      const def = await h.adminIn(1);
      const remote = await def.get('/api/bans?type=remote&pageSize=1000');
      assert.equal(remote.status, 200);
      const hit = remote.json.data.find((b: any) => b.id === id);
      assert.ok(hit, 'the remote ban is listed under type=remote');
      assert.equal(hit.originRef, 'blocklist:987654');
      assert.ok(remote.json.data.every((b: any) => b.banType === 'remote'), 'type=remote filters');
      const manual = await def.get('/api/bans?type=manual&pageSize=1000');
      assert.ok(!manual.json.data.some((b: any) => b.id === id), 'not listed under type=manual');
    } finally {
      await h.db('ip_bans').where({ id }).delete();
    }

    const bans = read('client/src/pages/ipReputation/BansTab.tsx');
    assert.match(bans, /const TYPES: readonly TypeFilter\[\] = \[[^\]]*'remote'/);
    assert.match(bans, /\n {2}remote: '/, 'TYPE_BADGE has a remote entry');
    const drawer = read('client/src/components/ip/IpDetailDrawer.tsx');
    const pill = drawer.slice(drawer.indexOf('export function BanTypePill'));
    assert.match(pill.slice(0, 1500), /ipReputation\.banType\.remote/);
    assert.match(pill.slice(0, 1500), /ipReputation\.banType\.external/);
  });

  lotIt('W9-5', '78.3 the client API declares the provenance fields', () => {
    const api = read('client/src/api/remoteBlocklist.api.ts');
    const block = (name: string) => api.slice(api.indexOf(`export interface ${name}`), api.indexOf('}', api.indexOf(`export interface ${name}`)));
    assert.match(block('RemoteBlocklist '), /\benforce: boolean;/);
    for (const f of ['status: string;', 'listEnforce: boolean;', 'enforced: boolean;']) {
      assert.ok(block('RemoteBlockedIp').includes(f), `RemoteBlockedIp.${f}`);
    }
    assert.match(block('RemoteBlocklistStats'), /\benforced: number;/);
    assert.match(api, /update: \(id: number, data: \{[^}]*enforce\?: boolean/);
    assert.match(api, /create: \(data: \{[^}]*enforce\?: boolean/);
    // No page-local widening left.
    assert.doesNotMatch(read('client/src/pages/ipReputation/RemoteTab.tsx'), /& \{\s*\n?\s*(\/\*\*[^*]*\*\/\s*)?enforce\?: boolean/);
    assert.doesNotMatch(read('client/src/components/settings/RemoteBlocklistsSection.tsx'), /enforce\?: boolean/);
  });

  lotIt('W9-5', '78.4 every RouterOS connection pins the certificate per router', () => {
    const files = [
      'server/src/controllers/mikrotik.controller.ts',
      ...dirFiles('server/src/services/mikrotik'),
    ];
    let calls = 0;
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/createRouterOSClient\(\{/g)) {
        calls++;
        const args = src.slice(m.index!, src.indexOf('})', m.index!));
        assert.match(args, /\bdeviceId\b/, `${f}: createRouterOSClient without deviceId`);
      }
    }
    assert.ok(calls >= 5, `expected the RouterOS call sites, found ${calls}`);
  });

  lotIt('W9-5', '78.5 every W9 i18n key exists in en and fr with the same placeholders', () => {
    const en = locale('en');
    const fr = locale('fr');
    const keys = new Set<string>(DYNAMIC_KEYS);
    for (const f of W9_CLIENT_FILES) for (const k of literalKeys(read(f))) keys.add(k);
    assert.ok(keys.size > 600, `expected the W9 pages to use many keys, found ${keys.size}`);
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
