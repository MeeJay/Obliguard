/**
 * 96 — W13-4 Download page with versions and availability (UI-PAGES-FLEET-21,
 * backlog D21; mirror of Obliance DownloadPage).
 *
 *   96.1 DownloadPage reads the served versions: /agent/desktop-version and
 *        /agent/version (missingBuilds), and probes each download with a
 *        HEAD (availability, build date, X-Agent-Version)
 *   96.2 missing builds are rendered disabled with a note (no dead link);
 *        outdated agent builds (missingBuilds) carry a note
 *   96.3 the stale build-from-source block (non-existent desktop-app/) is
 *        gone, replaced by a link to the obli.tools release notes
 *   96.4 kit presentation: PageContainer + PageHeader, new strings through
 *        t('download.*', { defaultValue }), no silent .catch(() => {})
 *   96.5 server contract the page relies on: desktop-version answers
 *        { version }, the logged-in /agent/version carries missingBuilds,
 *        a download that is not served answers 404 JSON to HEAD (never the
 *        SPA HTML the page would mistake for a file)
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'client/src/pages/DownloadPage.tsx';
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** Source without line / block comments (a comment may mention desktop-app/). */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('96 download page (W13-4)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h?.close(); });

  lotIt('W13-4', '96.1 versions come from the server, each download is probed', () => {
    const src = code(PAGE);
    assert.match(src, /['"`]\/agent\/desktop-version['"`]/, 'fetches /api/agent/desktop-version');
    assert.match(src, /agentApi\.getVersion\(\)/, 'fetches /api/agent/version through agentApi');
    assert.match(src, /missingBuilds/, 'reads missingBuilds from /agent/version');
    assert.match(src, /method:\s*'HEAD'/, 'availability probe is a HEAD request');
    assert.match(src, /last-modified/i, 'build date from Last-Modified');
    assert.match(src, /x-agent-version/i, 'per-artifact agent version from X-Agent-Version');
    assert.match(src, /\/api\/agent\/download\//, 'agent builds are served from /api/agent/download/');
    assert.match(src, /\/downloads\//, 'desktop builds are served from /downloads/');
    // Every agent artifact the server allow-lists is listed.
    for (const f of [
      'obliguard-agent.msi', 'obliguard-agent.exe', 'obliguard-agent-linux-amd64', 'obliguard-agent-linux-arm64',
      'obliguard-agent-darwin-amd64', 'obliguard-agent-darwin-arm64', 'obliguard-agent-freebsd-amd64',
    ]) {
      assert.ok(src.includes(`'${f}'`), `agent artifact ${f} listed`);
    }
  });

  lotIt('W13-4', '96.2 missing builds are disabled with a note, outdated agent builds flagged', () => {
    const src = code(PAGE);
    assert.match(src, /state: 'missing'/, 'probe has a missing state');
    assert.match(src, /<button type="button" disabled\b/, 'missing build rendered as a disabled control');
    assert.match(src, /t\('download\.notAvailable'/, 'missing note through download.notAvailable');
    assert.match(src, /t\('download\.agent\.outdated'/, 'outdated agent build note');
    assert.match(src, /text\/html/, 'SPA HTML fallback is not taken for a served file');
    // Only an explicit absence (404 / 410 / SPA HTML) disables a build: a 429 or 5xx
    // from a proxy must not turn a served file into a dead control.
    assert.match(src, /res\.status === 404/, 'missing only on an explicit 404');
    assert.doesNotMatch(src, /if \(!res\.ok[^)]*\) return \{ state: 'missing' \}/, 'any non-2xx is not taken as missing');
  });

  lotIt('W13-4', '96.3 no stale build-from-source block; release notes link instead', () => {
    const src = code(PAGE);
    assert.ok(!src.includes('desktop-app/'), 'no reference to the non-existent desktop-app/ folder');
    assert.doesNotMatch(src, /download\.buildFromSource/, 'build-from-source strings no longer rendered');
    assert.doesNotMatch(src, /build-windows\.ps1|build-mac\.sh/, 'no build script instructions');
    assert.match(src, /https:\/\/[a-z.]*obli\.tools/, 'links to obli.tools');
    assert.match(src, /t\('download\.releaseNotes'/, 'release notes label through i18n');
    assert.match(src, /rel="noopener noreferrer"/, 'external link opened safely');
  });

  lotIt('W13-4', '96.4 kit presentation, i18n strings, no silent catches', () => {
    const src = code(PAGE);
    assert.match(src, /from '@\/components\/common\/PageContainer'/);
    assert.match(src, /from '@\/components\/common\/PageHeader'/);
    assert.match(src, /<PageContainer\b/);
    assert.match(src, /<PageHeader\b/);
    assert.doesNotMatch(src, /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/, 'silent .catch(() => {})');
    // Every t() key of the page lives under download.* or common.*.
    const keys = [...src.matchAll(/\bt\(\s*[`'"]([^`'"]+)[`'"]/g)].map((m) => m[1]);
    assert.ok(keys.length > 10, 'page strings go through t()');
    for (const k of keys) assert.match(k, /^(download\.|common\.)/, `t key ${k} outside download.* / common.*`);
    // New keys carry an English default (integration adds en + fr).
    for (const k of ['download.pageTitle', 'download.notAvailable', 'download.releaseNotes', 'download.agent.title', 'download.builtOn']) {
      assert.match(src, new RegExp(`t\\('${k.replace(/\./g, '\\.')}',\\s*\\{[^}]*defaultValue`), `${k} has a defaultValue`);
    }
  });

  lotIt('W13-4', '96.5 server contract: desktop-version, missingBuilds, 404 JSON on HEAD of a missing build', async () => {
    const anon = h.anon();
    const dv = await anon.get('/api/agent/desktop-version');
    assert.equal(dv.status, 200);
    assert.equal(typeof dv.json?.version, 'string', 'desktop-version answers { version }');

    const v = await (await h.as('member_b')).get('/api/agent/version');
    assert.equal(v.status, 200);
    assert.equal(typeof v.json?.version, 'string');
    assert.ok(Array.isArray(v.json?.missingBuilds), 'logged-in /agent/version carries missingBuilds');

    for (const p of ['/api/agent/download/not-an-agent.bin', '/downloads/not-a-desktop-build.exe']) {
      const r = await anon.request('HEAD', p);
      assert.equal(r.status, 404, `HEAD ${p}`);
      assert.doesNotMatch(String(r.headers['content-type'] ?? ''), /text\/html/, `HEAD ${p} is not the SPA HTML`);
    }
  });
});
