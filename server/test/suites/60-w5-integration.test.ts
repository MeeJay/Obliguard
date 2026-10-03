/**
 * 60 — W5 integration (W5-6): the followups of the W5 lots applied at
 * integration time.
 *   - every literal i18n key of the UI kit (components/common,
 *     components/status, hooks) and of the NotificationsPage tenant chips
 *     exists in the en and fr locales, with the same {{placeholders}};
 *   - the client drops resolved incidents and marks read alerts on the
 *     NOTIFICATION_RESOLVED / NOTIFICATION_READ socket events;
 *   - platform admins join the Default tenant's notification room (live-alert
 *     events are mirrored there) and the live-alert retention job is scheduled;
 *   - the hub logs the agent's 'dropped' events counter (W5-5 queue).
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { lotIt } from '../lots';

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

function listFiles(rel: string, exts: string[]): string[] {
  const abs = path.join(REPO, rel);
  const out: string[] = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** Literal keys passed to t('…') or held in i18nKey/shortKey/hintKey fields (comments stripped). */
function literalKeys(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const keys = new Set<string>();
  for (const m of code.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  for (const m of code.matchAll(/\b(?:i18nKey|shortKey|hintKey)\s*:\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  return [...keys];
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');

describe('60 W5 integration (W5-6)', () => {
  lotIt('W5-6', '60.1 every UI kit i18n key exists in en and fr with the same placeholders', () => {
    const en = locale('en');
    const fr = locale('fr');
    const files = [
      ...listFiles('client/src/components/common', ['.tsx', '.ts']),
      ...listFiles('client/src/components/status', ['.tsx', '.ts']),
      ...listFiles('client/src/hooks', ['.tsx', '.ts']),
    ];
    const missing: string[] = [];
    let checked = 0;
    for (const f of files) {
      for (const key of literalKeys(read(f))) {
        checked++;
        const e = lookup(en, key);
        const r = lookup(fr, key);
        if (typeof e !== 'string') { missing.push(`en:${key} (${f})`); continue; }
        if (typeof r !== 'string') { missing.push(`fr:${key} (${f})`); continue; }
        if (placeholders(e) !== placeholders(r)) missing.push(`placeholders differ: ${key}`);
      }
    }
    assert.ok(checked > 40, `expected the kit to use many keys, found ${checked}`);
    assert.deepEqual(missing, []);
  });

  lotIt('W5-6', '60.2 NotificationsPage tenant-binding keys exist in en and fr', () => {
    const en = locale('en');
    const fr = locale('fr');
    for (const k of ['globalInTenants', 'globalInTenantsHint', 'globalDefaultHint', 'globalTenantHint']) {
      assert.equal(typeof lookup(en, `notifications.${k}`), 'string', `en notifications.${k}`);
      assert.equal(typeof lookup(fr, `notifications.${k}`), 'string', `fr notifications.${k}`);
    }
    const page = read('client/src/pages/NotificationsPage.tsx');
    assert.ok(!/as TenantBinding\[\]/.test(page), 'NotificationBinding.tenantId comes from shared, no cast');
    assert.match(read('shared/src/types.ts'), /tenantId\?: number;\n\}/);
  });

  lotIt('W5-6', '60.3 client handles NOTIFICATION_RESOLVED / NOTIFICATION_READ', () => {
    const sock = read('client/src/hooks/useSocket.ts');
    assert.match(sock, /socket\.on\(SOCKET_EVENTS\.NOTIFICATION_RESOLVED,/);
    assert.match(sock, /socket\.off\(SOCKET_EVENTS\.NOTIFICATION_RESOLVED,/);
    assert.match(sock, /socket\.on\(SOCKET_EVENTS\.NOTIFICATION_READ,/);
    assert.match(sock, /socket\.off\(SOCKET_EVENTS\.NOTIFICATION_READ,/);
    const store = read('client/src/store/liveAlertsStore.ts');
    assert.match(store, /applyResolvedFromServer: \(ids\) =>/);
    assert.match(store, /applyReadFromServer: \(ids, readAt\) =>/);
  });

  lotIt('W5-6', '60.4 server wiring: admin notification room, retention job, dropped counter', () => {
    const socket = read('server/src/socket.ts');
    assert.match(socket, /if \(user\.role === 'admin'\) socket\.join\(`tenant:\$\{MASTER_TENANT_ID\}:notifications`\)/);
    const index = read('server/src/index.ts');
    // W12-1 moved the live-alert purge into the hourly retention service;
    // index.ts starts it at boot and stops it on shutdown.
    assert.match(read('server/src/services/retention.service.ts'), /liveAlertService\.cleanup\(LIVE_ALERT_RETENTION_DAYS\)/);
    assert.match(index, /retentionService\.start\(\)/);
    assert.match(index, /retentionService\.stop\(\)/);
    const hub = read('server/src/services/obliguardHub.service.ts');
    assert.match(hub, /Number\(msg\.dropped\)/);
    assert.match(read('server/test/suites/45-notifications.test.ts'), /^\/\/ verify-env: NOTIFICATION_ALLOW_PRIVATE_TARGETS=1/);
    assert.match(read('.env.example'), /NOTIFICATION_ALLOW_PRIVATE_TARGETS=/);
  });
});
