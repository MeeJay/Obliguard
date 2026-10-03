/**
 * 103 — W14 integration (W14-5).
 *
 *   103.1 command frame contract: the server's 'command' frame, command
 *         types, ack statuses, capability and resync payload / result keys
 *         match the Go agent (cmd_ws.go);
 *   103.2 a legacy agent (no 'cmdqueue') whose config frame carrying the
 *         uninstall is not written gets it back in the queue
 *         (pending_command restored, uninstall_commanded_at cleared);
 *   103.3 routePermissions entries for every W14 route (commands, exports);
 *   103.4 every literal i18n key of the W14 client files exists in en and fr
 *         with the same placeholders; commands.type / commands.status are
 *         objects only;
 *   103.5 one socket event for command updates (SOCKET_EVENTS), one CSV
 *         export helper (utils/download.ts), config.json written 0600.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { AGENT_COMMAND_CAPABILITY, AGENT_COMMAND_SOCKET_EVENT, AGENT_COMMAND_TYPES, SOCKET_EVENTS } from '@obliview/shared';
import { startHarness, FakeWs, waitFor } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import { agentCommandService } from '../../src/services/agentCommand.service';

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

/** Go struct body by type name (fields with their json tags). */
function goStruct(src: string, name: string): string {
  const m = new RegExp(`type ${name} struct \\{([\\s\\S]*?)\\n\\}`).exec(src);
  assert.ok(m, `Go struct ${name}`);
  return m[1];
}
const jsonTags = (body: string) => [...body.matchAll(/`json:"([^",]+)/g)].map((m) => m[1]);

/** The client files built or touched by W14. */
const W14_CLIENT_FILES = [
  'client/src/pages/agentDetail/CommandsTab.tsx',
  'client/src/pages/AgentDetailPage.tsx',
  'client/src/components/layout/Header.tsx',
  'client/src/components/layout/Sidebar.tsx',
  'client/src/components/layout/AppLayout.tsx',
  'client/src/components/layout/TenantSwitcher.tsx',
  'client/src/pages/ipReputation/ActivityTab.tsx',
  'client/src/pages/ipReputation/BansTab.tsx',
  'client/src/pages/ipReputation/WhitelistTab.tsx',
  'client/src/pages/LiveEventsPage.tsx',
];

describe('103 W14 integration (W14-5)', () => {
  let h: Harness;
  const sockets: FakeWs[] = [];

  before(async () => { h = await startHarness(); });
  after(async () => {
    for (const ws of sockets) ws.close();
    await h.close();
  });

  lotIt('W14-5', '103.1 command frame contract: server and agent agree', () => {
    const go = read('agent/cmd_ws.go');
    const hub = code('server/src/services/obliguardHub.service.ts');
    const svc = code('server/src/services/agentCommand.service.ts');

    // Server → agent: { type: 'command', id, command, payload }.
    assert.match(hub, /\{ type: 'command', id: String\(row\.id\), command: row\.type, payload \}/);
    assert.deepEqual(jsonTags(goStruct(go, 'cmdCommandMsg')), ['type', 'id', 'command', 'payload']);
    assert.match(go, /case "command":/, 'agent dispatches command frames');

    // Command names: every queued type is handled by the agent (and only those).
    const sw = /\n\tswitch msg\.Command \{([\s\S]*?)\n\tdefault:/.exec(go);
    assert.ok(sw, 'agent switch on msg.Command');
    const handled = [...sw[1].matchAll(/^\tcase "([a-z_]+)":$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(handled, [...AGENT_COMMAND_TYPES].sort(), 'agent switch == AGENT_COMMAND_TYPES');

    // Agent → server: { type: 'command_ack', id, status, result }.
    assert.deepEqual(jsonTags(goStruct(go, 'cmdAckMsg')), ['type', 'id', 'status', 'result']);
    assert.match(hub, /case 'command_ack':/);
    for (const [goConst, status] of [['cmdAckAcked', 'acked'], ['cmdAckSucceeded', 'succeeded'], ['cmdAckFailed', 'failed']]) {
      assert.match(go, new RegExp(`${goConst}\\s*=\\s*"${status}"`), `agent ack status ${status}`);
      assert.ok(svc.includes(`'${status}'`), `server accepts ack status ${status}`);
    }

    // Capability advertised by the agent == the one the server tests.
    assert.match(go, new RegExp(`capCmdQueue = "${AGENT_COMMAND_CAPABILITY}"`));

    // firewall_resync: payload { bans } and result counters read by the client.
    assert.deepEqual(jsonTags(goStruct(go, 'firewallResyncPayload')), ['bans']);
    assert.match(hub, /return \{ \.\.\.base, bans \};/);
    const resultKeys = /map\[string\]any\{"desired": r\.Desired, "added": r\.Added, "removed": r\.Removed/.test(go);
    assert.ok(resultKeys, 'agent resync result carries desired / added / removed');
    const tab = code('client/src/pages/agentDetail/CommandsTab.tsx');
    for (const k of ['desired', 'added', 'removed']) assert.ok(tab.includes(`r.${k}`), `client reads result.${k}`);
  });

  lotIt('W14-5', '103.2 legacy uninstall whose config frame is not written goes back to the queue', async () => {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const ws = new FakeWs();
    sockets.push(ws);
    assert.equal(await obliguardHub.register(d.uuid, 2, 2, '127.0.0.1', ws as any), true);

    const cmd = await agentCommandService.enqueue({ deviceId: d.id, tenantId: 2, type: 'uninstall' });
    assert.equal((await h.db('agent_devices').where({ id: d.id }).first()).pending_command, 'uninstall');

    // Every write fails from now on (socket half-dead): the config frame that
    // carries the claimed uninstall is never written.
    let attempts = 0;
    ws.send = () => { attempts++; throw new Error('write failed'); };
    ws.receive({
      type: 'heartbeat', hostname: d.hostname, agentVersion: '1.0.0',
      osInfo: { platform: 'linux', distro: 'v', release: '1', arch: 'amd64' },
      services: [], firewallBanned: [], firewallName: 'verify', lanIPs: [],
    });
    await waitFor(() => attempts > 0, 5000);
    const dev = await waitFor(async () => {
      const row = await h.db('agent_devices').where({ id: d.id }).first();
      return row.pending_command === 'uninstall' ? row : null;
    }, 5000);
    assert.equal(dev.uninstall_commanded_at, null, 'the cleanup job will not delete the agent');
    const row = await h.db('agent_commands').where({ id: cmd.id }).first();
    assert.equal(row.status, 'queued');
    assert.equal(row.legacy, false);
    assert.equal(row.sent_at, null);

    // Next contact on a healthy channel: delivered in the config frame.
    const ws2 = new FakeWs();
    sockets.push(ws2);
    ws.close();
    assert.equal(await obliguardHub.register(d.uuid, 2, 2, '127.0.0.1', ws2 as any), true);
    await waitFor(() => ws2.sent.some((f) => f?.type === 'config' && f?.command === 'uninstall'), 5000);
  });

  lotIt('W14-5', '103.3 routePermissions entries for every W14 route', () => {
    const rp = read('server/src/middleware/routePermissions.ts');
    for (const [method, url] of [
      ['POST', '/api/agent/devices/:id/commands'],
      ['GET', '/api/agent/devices/:id/commands'],
      ['GET', '/api/bans/export'],
      ['GET', '/api/whitelist/export'],
      ['GET', '/api/ip-reputation/export'],
      ['GET', '/api/ip-events/export'],
    ]) {
      assert.ok(rp.includes(`route('${method}', '${url}',`), `${method} ${url}`);
    }
    assert.match(rp, /route\('POST', '\/api\/agent\/devices\/:id\/commands', \['agents\.manage', 'agents\.update', 'agents\.delete'\], \{ byBody: true/);
  });

  lotIt('W14-5', '103.4 every W14 i18n key exists in en and fr with the same placeholders', () => {
    const en = locale('en');
    const fr = locale('fr');
    const keys = new Set<string>(['agentDetail.tabs.commands']);
    for (const f of W14_CLIENT_FILES) {
      for (const mt of code(f).matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(mt[1]);
    }
    for (const type of AGENT_COMMAND_TYPES) keys.add(`commands.type.${type}`);
    for (const s of ['legacy', 'queued', 'sent', 'acked', 'succeeded', 'failed', 'expired']) keys.add(`commands.status.${s}`);
    for (const k of ['csvExport.button', 'csvExport.failed', 'csvExport.truncated', 'header.openMenu']) {
      assert.ok(keys.has(k), `${k} is used by a W14 file`);
    }
    const missing: string[] = [];
    for (const key of keys) {
      const e = lookup(en, key);
      const r = lookup(fr, key);
      if (typeof e !== 'string') { missing.push(`en:${key}`); continue; }
      if (typeof r !== 'string') { missing.push(`fr:${key}`); continue; }
      if (placeholders(e) !== placeholders(r)) missing.push(`placeholders differ: ${key}`);
    }
    assert.deepEqual(missing, []);
    for (const lang of [en, fr]) {
      assert.equal(typeof lookup(lang, 'commands.type'), 'object');
      assert.equal(typeof lookup(lang, 'commands.status'), 'object');
    }
  });

  lotIt('W14-5', '103.5 one command socket event, one CSV export helper, config.json 0600', () => {
    assert.equal(SOCKET_EVENTS.AGENT_COMMAND_UPDATED, AGENT_COMMAND_SOCKET_EVENT);
    assert.match(code('server/src/services/agentCommand.service.ts'), /SOCKET_EVENTS\.AGENT_COMMAND_UPDATED/);
    assert.match(code('client/src/pages/agentDetail/CommandsTab.tsx'), /socket\.on\(SOCKET_EVENTS\.AGENT_COMMAND_UPDATED/);

    for (const f of ['client/src/pages/ipReputation/ActivityTab.tsx', 'client/src/pages/ipReputation/BansTab.tsx',
      'client/src/pages/ipReputation/WhitelistTab.tsx', 'client/src/pages/LiveEventsPage.tsx']) {
      const src = code(f);
      assert.doesNotMatch(src, /function downloadCsvExport|function csvExportError|const CSV_EXPORT_MAX/, `${f}: no local copy of the CSV helper`);
    }
    assert.match(read('server/src/utils/csv.ts'), /CSV_EXPORT_MAX = 50_000/);
    assert.match(read('client/src/utils/download.ts'), /export const CSV_EXPORT_MAX = 50_000;/, 'client cap == server cap');

    const main = read('agent/main.go');
    assert.match(main, /os\.WriteFile\(configFile, data, 0600\)/);
    assert.match(main, /os\.Chmod\(configFile, 0600\)/);
    assert.doesNotMatch(main, /os\.WriteFile\(configFile, data, 0644\)/);
  });
});
