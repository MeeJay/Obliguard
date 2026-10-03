/**
 * 64 — W6-4 admin / config pages on the UI kit (client, static checks):
 *   - the owned pages and components hold no native window.confirm / prompt /
 *     alert, no hand-rolled `fixed inset-0` overlay, no silent
 *     `.catch(() => {})` and no hand-rolled role="switch" toggle;
 *   - the pages render inside PageContainer + PageHeader;
 *   - SettingsPage: both platform wipes are danger confirms with
 *     requireText 'WIPE' (no double native confirm), the remote blocklist
 *     delete is a danger confirm, toggles are ToggleSwitch;
 *   - FirewallPanel / AddMikroTikModal / GlobalAddAgentModal dialogs are the
 *     shared <Modal>; FirewallPanel delete is a danger confirm;
 *   - GlobalAddAgentModal: literals through t('addAgent.*'), wizard download
 *     fetched as a blob through the API client with a toast on failure (no
 *     bare `<a download>` that fails silently).
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const PAGES = [
  'client/src/pages/NotificationsPage.tsx',
  'client/src/pages/GroupManagePage.tsx',
  'client/src/pages/GroupEditPage.tsx',
  'client/src/pages/SettingsPage.tsx',
];
const COMPONENT_DIRS = [
  'client/src/components/agent',
  'client/src/components/mikrotik',
  'client/src/components/notifications',
];
const ADD_AGENT = 'client/src/components/layout/GlobalAddAgentModal.tsx';

function ownedFiles(): string[] {
  // The remote blocklist section was split out of SettingsPage by W9-3.
  const files = [...PAGES, ADD_AGENT, 'client/src/components/settings/RemoteBlocklistsSection.tsx'];
  for (const dir of COMPONENT_DIRS) {
    for (const name of fs.readdirSync(path.join(REPO, dir))) {
      if (/\.tsx?$/.test(name)) files.push(`${dir}/${name}`);
    }
  }
  return files;
}

/** Source without line / block comments (a comment may mention confirm()). */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('64 admin pages on the UI kit (W6-4)', () => {
  lotIt('W6-4', '64.1 no native dialogs, hand-rolled overlays, silent catches or hand-rolled switches', () => {
    for (const rel of ownedFiles()) {
      const src = code(rel);
      assert.doesNotMatch(src, /(?<![\w.])(?:window\.)?(?:confirm|prompt|alert)\(/, `${rel}: native confirm/prompt/alert`);
      assert.doesNotMatch(src, /window\.(?:confirm|prompt|alert)\b/, `${rel}: native confirm/prompt/alert`);
      assert.ok(!src.includes('fixed inset-0'), `${rel}: hand-rolled 'fixed inset-0' overlay (use <Modal>/<Drawer>)`);
      assert.doesNotMatch(src, /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/, `${rel}: silent .catch(() => {})`);
      assert.doesNotMatch(src, /role="switch"/, `${rel}: hand-rolled switch (use <ToggleSwitch>)`);
    }
  });

  lotIt('W6-4', '64.2 pages render inside PageContainer + PageHeader', () => {
    for (const rel of PAGES) {
      const src = read(rel);
      assert.match(src, /from '@\/components\/common\/PageContainer'/, `${rel} imports PageContainer`);
      assert.match(src, /<PageContainer\b/, `${rel} renders PageContainer`);
      assert.match(src, /<PageHeader\b/, `${rel} renders PageHeader`);
      assert.doesNotMatch(src, /return \(\s*<div className="p-6\b/, `${rel}: hard-coded p-6 page root`);
    }
  });

  lotIt('W6-4', '64.3 SettingsPage: type-to-confirm wipes, danger deletes, kit toggles and dialogs', () => {
    const src = read('client/src/pages/SettingsPage.tsx');
    // W9-3 moved the remote blocklist section (delete confirm, add dialog) out of SettingsPage.
    const blocklists = read('client/src/components/settings/RemoteBlocklistsSection.tsx');
    assert.match(src, /useConfirm\(\)/);
    for (const route of ['/bans/wipe-bans', '/bans/wipe-reputation']) {
      const at = src.indexOf(`'${route}'`);
      assert.ok(at > 0, `${route} is called`);
      // The confirm guarding the call sits in the same function, just above it.
      const before = src.slice(Math.max(0, src.lastIndexOf('async function', at)), at);
      assert.match(before, /danger:\s*true/, `${route}: danger confirm`);
      assert.match(before, /requireText:\s*'WIPE'/, `${route}: requireText 'WIPE'`);
    }
    const del = blocklists.slice(blocklists.indexOf('const handleDelete = async (id: number'));
    assert.match(del.slice(0, 600), /danger:\s*true/, 'remote blocklist delete is a danger confirm');
    assert.match(src, /<ToggleSwitch\b/);
    assert.ok((src.match(/<Modal\b/g) ?? []).length + (blocklists.match(/<Modal\b/g) ?? []).length >= 2,'SMTP and add-blocklist dialogs use <Modal>');
    assert.match(src, /<IconButton\b/);
  });

  lotIt('W6-4', '64.4 agent / MikroTik dialogs use <Modal>, firewall delete is a danger confirm', () => {
    const fw = read('client/src/components/agent/FirewallPanel.tsx');
    assert.match(fw, /<Modal\b/);
    assert.match(fw, /<ToggleSwitch\b/);
    assert.match(fw, /useConfirm\(\)/);
    const del = fw.slice(fw.indexOf('const handleDelete'));
    assert.match(del.slice(0, 500), /danger:\s*true/, 'firewall rule delete is a danger confirm');
    assert.match(read('client/src/components/mikrotik/AddMikroTikModal.tsx'), /<Modal\b/);
    assert.match(read('client/src/components/agent/NotificationTypesPanel.tsx'), /<ToggleSwitch\b/);
    for (const rel of ['client/src/pages/NotificationsPage.tsx', 'client/src/pages/GroupManagePage.tsx']) {
      const src = read(rel);
      assert.match(src, /useConfirm\(\)/, `${rel} uses useConfirm`);
      assert.match(src, /danger:\s*true/, `${rel}: delete is a danger confirm`);
      assert.match(src, /<IconButton\b/, `${rel}: icon-only row actions are IconButtons`);
    }
  });

  lotIt('W6-4', '64.5 GlobalAddAgentModal: Modal, addAgent.* keys, wizard fetched with a failure toast', () => {
    const src = read(ADD_AGENT);
    assert.match(src, /<Modal\b/);
    assert.match(src, /useTranslation\(\)/);
    for (const key of ['title', 'noKeys', 'selectKey', 'chooseKey', 'manualDownload', 'downloadFailed', 'copyFailed']) {
      assert.match(src, new RegExp(`t\\('addAgent\\.${key}'`), `addAgent.${key} is used`);
    }
    assert.doesNotMatch(src, /<a\b[^>]*\bdownload=/, 'no bare <a download> for the wizard');
    assert.match(src, /responseType:\s*'blob'/, 'wizard fetched as a blob');
    assert.match(src, /saveBlob\(/, 'saved through utils/download');
    assert.match(src, /toast\.error\([^)]*addAgent\.downloadFailed/, 'download failure toasts');
    // No visible English literal left in JSX text (option labels that are
    // product names, e.g. "Windows 10+", are allowed).
    for (const literal of ['>Add Agent<', '>Agent version', 'Create an API Key first', 'Choose an API key', '> Download wizard', '>Close<']) {
      assert.ok(!src.includes(literal), `literal ${JSON.stringify(literal)} goes through t()`);
    }
  });
});
