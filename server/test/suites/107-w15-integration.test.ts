/**
 * 107 — W15 integration (W15-4): locale consolidation and the i18n check.
 *
 *   107.1 `node tools/i18n-extract.mjs --check` passes: every t('key') of
 *         client/src, the dynamic keys of tools/i18n-allowlist.json and the
 *         errors.<code> of the server catalogue exist in en and fr with the
 *         same placeholders, and no hard-coded JSX literal is left outside
 *         the allowlist; `npm run i18n:check -w client` runs that script;
 *   107.2 the 18 locales parse, keep the committed format (2 spaces, CRLF,
 *         final newline), and the dead Obliview namespaces (monitors,
 *         remediations, maintenance, importExport) are gone;
 *         remediations.globalActive moved to notifications.globalActive;
 *   107.3 an AppError's `params` are echoed next to `code` (error handler)
 *         and an AgentKeyError's code reaches the client (agentKeys.controller);
 *   107.4 the legacy Node agent workspace is gone from the root workspaces.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { banPrefixFloor } from '../../src/utils/ipValidation';

const REPO = path.resolve(__dirname, '..', '..', '..');
const LOCALES = path.join(REPO, 'client', 'src', 'i18n', 'locales');
const raw = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('107 W15 integration (W15-4)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  lotIt('W15-4', '107.1 the i18n check passes (keys in en/fr, no stray literal) and is wired in client/package.json', () => {
    const run = spawnSync(process.execPath, [path.join(REPO, 'tools', 'i18n-extract.mjs'), '--check'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(run.status, 0, `i18n check failed:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /en: no missing key/);
    assert.match(run.stdout, /fr: no missing key/);
    assert.match(run.stdout, /no hard-coded literal outside the allowlist/);
    const m = /(\d+) literal key\(s\)/.exec(run.stdout);
    assert.ok(m && Number(m[1]) > 2000, `expected the client to use many keys: ${run.stdout.split('\n')[0]}`);

    const pkg = JSON.parse(raw('client/package.json')) as { scripts?: Record<string, string> };
    assert.match(pkg.scripts?.['i18n:check'] ?? '', /tools\/i18n-extract\.mjs --check/);
    const allow = JSON.parse(raw('tools/i18n-allowlist.json')) as { tokens: string[]; dynamicKeys: string[] };
    assert.ok(Array.isArray(allow.tokens) && allow.tokens.includes('Obliguard'));
    assert.ok(allow.dynamicKeys.includes('agentDetail.tabs.overview'));
  });

  lotIt('W15-4', '107.2 18 locales, committed format, dead Obliview namespaces removed', () => {
    const langs = fs.readdirSync(LOCALES);
    assert.equal(langs.length, 18);
    for (const lang of langs) {
      const text = fs.readFileSync(path.join(LOCALES, lang, 'translation.json'), 'utf8');
      const tree = JSON.parse(text) as Record<string, Record<string, unknown>>;
      assert.equal(text, `${JSON.stringify(tree, null, 2).replace(/\n/g, '\r\n')}\r\n`, `${lang}: 2-space CRLF format`);
      for (const ns of ['monitors', 'remediations', 'maintenance', 'importExport']) {
        assert.equal(tree[ns], undefined, `${lang}: dead namespace ${ns}`);
      }
    }
    for (const lang of ['en', 'fr']) {
      const tree = JSON.parse(raw(`client/src/i18n/locales/${lang}/translation.json`)) as Record<string, Record<string, unknown>>;
      assert.equal(typeof tree.notifications.globalActive, 'string', `${lang}: notifications.globalActive`);
    }
    const page = raw('client/src/pages/NotificationsPage.tsx');
    assert.doesNotMatch(page, /t\('remediations\./);
  });

  lotIt('W15-4', '107.3 error params and agent-key codes reach the client', async () => {
    const def = await h.adminIn(1);
    const wide = await def.post('/api/bans', { ip: '8.0.0.0/8' });
    assert.equal(wide.status, 400);
    assert.equal(wide.json.code, 'BAN_TARGET_TOO_WIDE');
    assert.deepEqual(wide.json.params, { prefix: banPrefixFloor().v4, family: 4 });

    const dup = await def.put('/api/agent/keys/999999', { name: 'x' });
    assert.equal(dup.status, 404, JSON.stringify(dup.json));
    assert.equal(dup.json.code, 'AGENT_KEY_NOT_FOUND');
    assert.equal(dup.json.error, 'API key not found');
  });

  lotIt('W15-4', '107.4 the legacy Node agent workspace is removed', () => {
    const root = JSON.parse(raw('package.json')) as { workspaces: string[] };
    assert.deepEqual(root.workspaces, ['shared', 'server', 'client']);
    assert.equal(fs.existsSync(path.join(REPO, 'agent', 'package.json')), false);
    assert.equal(fs.existsSync(path.join(REPO, 'agent', 'src')), false);
    const lock = JSON.parse(raw('package-lock.json')) as { packages: Record<string, unknown> };
    assert.equal(lock.packages.agent, undefined);
    assert.equal(lock.packages['node_modules/@obliview/agent'], undefined);
  });
});
