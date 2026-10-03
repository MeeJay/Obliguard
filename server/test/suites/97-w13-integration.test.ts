/**
 * 97 — W13 integration (W13-5): the pieces of the settings cascade that live
 * outside W13-1's files, the agent wiring of the firewallBackend contract and
 * the W13 translations.
 *
 *   97.1 autoBanEnabled = false (tenant level) stops auto-bans from that
 *        tenant's agents (baseline bans first); their events are still
 *        recorded; tenant 3 is unaffected; an agent override re-enables it;
 *   97.2 notification types resolve through the cascade, tenant level included
 *        (notificationService delegates to agentConfigService);
 *   97.3 device PATCH validates the cascade values before any write: an
 *        out-of-range value is a 400 that leaves status/name untouched;
 *   97.4 firewallBackend contract: the server field (WS config frame and push
 *        response type) is the one the agent decodes and applies;
 *   97.5 every literal i18n key of the W13 client files exists in en and fr
 *        with the same placeholders;
 *   97.6 the workspace level of the cascade is reachable by 'settings'
 *        holders (route gate, sidebar item, server write guard).
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { D } from '../fixtures';
import { createDevice, createUser, insertEvents, nextIp } from '../seed';
import { banEngine } from '../../src/services/ban.service';
import { agentConfigService } from '../../src/services/agentConfig.service';
import { notificationService } from '../../src/services/notification.service';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '');
/** Source without block / line comments (checks target code, not prose). */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');

/** The client files built or rebuilt by W13. */
const W13_CLIENT_FILES = [
  'client/src/components/settings/SettingsPanel.tsx',
  'client/src/components/settings/SettingField.tsx',
  'client/src/components/settings/InheritanceBadge.tsx',
  'client/src/pages/SettingsPage.tsx',
  'client/src/pages/WorkspaceSettingsPage.tsx',
  'client/src/pages/GroupEditPage.tsx',
  'client/src/pages/agentDetail/SettingsTab.tsx',
  'client/src/pages/agentDetail/TimelineTab.tsx',
  'client/src/pages/AgentDetailPage.tsx',
  'client/src/pages/DownloadPage.tsx',
];

const SETTING_KEYS = ['autoBanEnabled', 'notificationTypes'];

describe('97 W13 integration', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  afterEach(async () => {
    await h.db('settings').whereIn('key', SETTING_KEYS).del();
    agentConfigService.invalidate();
  });
  after(async () => { await h.close(); });

  const tenantAdmin = async (tenant: number) => h.login((await createUser(h.db, { tenants: [tenant], tenantRole: 'admin' })).username);
  const banRows = (ip: string) => h.db('ip_bans').whereRaw('host(ip) = ?', [ip]);

  lotIt('W13-5', '97.1 autoBanEnabled off at tenant level: no auto-ban, events still recorded; other tenants unaffected', async () => {
    // Baseline: with the default (on), the burst bans.
    const base = nextIp();
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: 2, ip: base, count: 8 });
    await banEngine.run();
    assert.equal((await banRows(base).where({ is_active: true })).length, 1, 'baseline: the burst auto-bans');

    const b = await tenantAdmin(2);
    assert.equal((await b.put('/api/settings/tenant/2', { key: 'autoBanEnabled', value: false })).status, 200);

    const quiet = nextIp();
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: 2, ip: quiet, count: 8 });
    await banEngine.run();
    assert.equal((await banRows(quiet)).length, 0, 'no auto-ban from a tenant whose autoBanEnabled is off');
    const counted = await h.db('ip_events').where({ device_id: D.B.id }).whereRaw('host(ip) = ?', [quiet]).count<{ count: string }[]>('id as count');
    assert.equal(Number(counted[0].count), 8, 'the events stay recorded and counted');

    // Tenant 3 keeps the default (on).
    const off = await agentConfigService.autoBanDisabledIds([
      { id: D.B.id, tenantId: 2, groupId: D.B.groupId },
      { id: D.C.id, tenantId: 3, groupId: D.C.groupId },
    ]);
    assert.deepEqual([...off], [D.B.id], 'tenant 2 setting does not reach tenant 3');

    // An agent-level override re-enables it below the tenant.
    assert.equal((await b.put(`/api/settings/agent/${D.B.id}`, { key: 'autoBanEnabled', value: true })).status, 200);
    const again = nextIp();
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: 2, ip: again, count: 8 });
    await banEngine.run();
    assert.equal((await banRows(again).where({ is_active: true })).length, 1, 'agent level beats tenant level');

    const src = code('server/src/services/ban.service.ts');
    assert.match(src, /agentConfigService\.autoBanDisabledIds\(/);
    assert.match(src, /const evaluated = observed\.filter\(\(\{ dev \}\) => !autoBanOff\.has\(dev\.id\)\)/);
  });

  lotIt('W13-5', '97.2 notification types: tenant level honoured by the notification service', async () => {
    const b = await tenantAdmin(2);
    assert.equal((await b.put('/api/settings/tenant/2', { key: 'notificationTypes', value: { threat: false } })).status, 200);
    const typesB = await notificationService.resolveNotificationTypesForDevice(D.B.id);
    assert.deepEqual(typesB, { global: true, down: true, up: true, threat: false, attack: true });
    const typesC = await notificationService.resolveNotificationTypesForDevice(D.C.id);
    assert.equal(typesC.threat, true, 'tenant 2 setting does not reach tenant 3');
    // Agent level still wins, field by field.
    assert.equal((await b.put(`/api/settings/agent/${D.B.id}`, { key: 'notificationTypes', value: { threat: true, up: false } })).status, 200);
    assert.deepEqual(await notificationService.resolveNotificationTypesForDevice(D.B.id),
      { global: true, down: true, up: false, threat: true, attack: true });
    assert.match(code('server/src/services/notification.service.ts'),
      /agentConfigService\.resolveNotificationTypesForDevice\(deviceId\)/);
  });

  lotIt('W13-5', '97.3 device PATCH: invalid cascade value is a 400 before any write', async () => {
    const b = await tenantAdmin(2);
    const dev = await createDevice(h.db, { tenantId: 2, keyId: 2, hostname: 'h97-3' });
    const r = await b.patch(`/api/agent/devices/${dev.id}`, { status: 'suspended', name: 'renamed-97', maxMissedPushes: 10_000 });
    assert.equal(r.status, 400);
    const row = await h.db('agent_devices').where({ id: dev.id }).first('status', 'name');
    assert.equal(row.status, 'approved', 'the suspension is not applied');
    assert.notEqual(row.name, 'renamed-97');
    const bad = await b.patch(`/api/agent/devices/${dev.id}`, { checkIntervalSeconds: 1 });
    assert.equal(bad.status, 400);
    const ok = await b.patch(`/api/agent/devices/${dev.id}`, { status: 'suspended' });
    assert.equal(ok.status, 200);
  });

  lotIt('W13-5', '97.4 firewallBackend contract: server field = agent field, wired into the config worker', () => {
    const hub = code('server/src/services/obliguardHub.service.ts');
    assert.match(hub, /firewallBackend/);
    assert.match(code('shared/src/types.ts'), /firewallBackend\?: WindowsFirewallBackend;/);
    const ws = code('agent/cmd_ws.go');
    assert.match(ws, /FirewallBackend \*string\s+`json:"firewallBackend,omitempty"`/);
    assert.match(ws, /applyAgentConfigFrame\(cfg, fw, msg\.FirewallBackend\)/);
    // The values the server may send are the ones the agent normalizes.
    const defaults = read('shared/src/settingsDefaults.ts');
    const m = /WINDOWS_FIREWALL_BACKENDS = \[([^\]]+)\]/.exec(defaults);
    assert.ok(m, 'WINDOWS_FIREWALL_BACKENDS declared');
    const fw = read('agent/firewall.go');
    for (const v of m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)) {
      assert.ok(fw.includes(`"${v}"`), `agent knows backend value ${v}`);
    }
  });

  lotIt('W13-5', '97.5 every W13 i18n key exists in en and fr with the same placeholders', () => {
    const en = locale('en');
    const fr = locale('fr');
    const keys = new Set<string>();
    for (const f of W13_CLIENT_FILES) {
      for (const mt of code(f).matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(mt[1]);
    }
    // Keys built at runtime from the shared definitions.
    const defs = read('shared/src/settingsDefaults.ts');
    for (const k of ['checkIntervalSeconds', 'maxMissedPushes', 'autoBanEnabled', 'evaluateOnly', 'windowsFirewallBackend', 'notificationTypes', 'updatePolicy']) {
      assert.ok(defs.includes(`'${k}'`), `${k} is a setting key`);
      keys.add(`settings.defs.${k}.label`);
      keys.add(`settings.defs.${k}.description`);
    }
    for (const u of ['seconds', 'check-ins']) keys.add(`settings.units.${u}`);
    for (const v of ['auto', 'wfp', 'netsh']) keys.add(`settings.options.windowsFirewallBackend.${v}`);
    for (const v of ['auto', 'manual', 'off']) keys.add(`settings.options.updatePolicy.${v}`);
    for (const s of ['step1', 'step2', 'step3', 'step4', 'step5']) keys.add(`download.${s}`);
    keys.add('nav.workspaceSettings');
    assert.ok(keys.size > 150, `expected many W13 keys, found ${keys.size}`);
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

  lotIt('W13-5', '97.6 workspace settings: route gated by settings, sidebar item, server write guard', async () => {
    const app = code('client/src/App.tsx');
    assert.match(app, /<ProtectedRoute requiredCapabilities=\{\['settings'\]\} \/>\}>\s*<Route path="\/settings\/workspace" element=\{<WorkspaceSettingsPage \/>\} \/>/);
    const sidebar = code('client/src/components/layout/Sidebar.tsx');
    assert.match(sidebar, /const canTenantSettings = useCan\('settings'\)/);
    assert.match(sidebar, /path: '\/settings\/workspace'[^\n]*visible: canTenantSettings && !isPlatformAdmin/);
    const page = code('client/src/pages/WorkspaceSettingsPage.tsx');
    assert.match(page, /<SettingsPanel[\s\S]*?level="tenant"[\s\S]*?scopeId=\{null\}/);

    // A tenant admin holds 'settings' and writes its own tenant level; a
    // plain member (no 'settings') reads it but cannot write.
    const admin = await tenantAdmin(2);
    assert.equal((await admin.put('/api/settings/tenant/2', { key: 'autoBanEnabled', value: true })).status, 200);
    const member = await h.login((await createUser(h.db, { tenants: [2], tenantRole: 'user' })).username);
    assert.equal((await member.get('/api/settings/tenant/resolved')).status, 200);
    assert.equal((await member.put('/api/settings/tenant/2', { key: 'autoBanEnabled', value: false })).status, 403);
  });
});
