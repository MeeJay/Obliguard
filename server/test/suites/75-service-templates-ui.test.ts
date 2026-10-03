/**
 * 75 — W9-2 Service templates in MasterDetail (client, static + logic checks,
 * plus the server contract the editor relies on):
 *   - ServiceTemplatesPage: `embedded` prop (no PageContainer / PageHeader,
 *     editor tab in ?templateTab= since the Policies hub owns ?tab=),
 *     MasterDetail list / detail, selection in the URL (?template=id|new);
 *   - TemplateList (search, origin badges with TenantBadge, mode chips,
 *     enabled state, ActionMenu rows), TemplateEditor (SegmentedTabs
 *     Parser | Thresholds | Assignments | Usage, live regex tester),
 *     AssignmentsTab (tenant-owned targets, Modal + useConfirm);
 *   - UI kit only: no native dialogs, hand-rolled overlays / switches or
 *     silent catches; writes gated by useCan('templates.write') with the
 *     platform-template rule, never by user.role;
 *   - every string through t() with a defaultValue, serviceTemplates.* keys;
 *   - no log path override input (an arbitrary file read on agents): the
 *     only log path write is clearing one;
 *   - regexTester: RE2 rejections (lookarounds, backreferences, atomic
 *     groups, repeat counts) and the Go -> JavaScript preview translation;
 *   - server contract: a tenant admin edits its own templates but not the
 *     shared platform ones, an assignment upsert keeps fields left out (the
 *     edit dialog never resends a log path), `logPathOverride: null` clears.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createGroup, createUser } from '../seed';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const PAGE = 'client/src/pages/ServiceTemplatesPage.tsx';
const DIR = 'client/src/components/serviceTemplates';
const LIST = `${DIR}/TemplateList.tsx`;
const EDITOR = `${DIR}/TemplateEditor.tsx`;
const ASSIGN = `${DIR}/AssignmentsTab.tsx`;
const TESTER = `${DIR}/regexTester.ts`;
const API = 'client/src/api/serviceTemplates.api.ts';

/** Source without line / block comments (a comment may mention confirm()). */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function ownedFiles(): string[] {
  const files = [PAGE, API];
  for (const name of fs.readdirSync(path.join(REPO, DIR))) {
    if (/\.tsx?$/.test(name)) files.push(`${DIR}/${name}`);
  }
  return files;
}

/** The regex tester module, transpiled and evaluated (it has no runtime imports). */
function loadTester(): Record<string, any> {
  const src = read(TESTER);
  assert.doesNotMatch(src, /^import (?!type )/m, `${TESTER} must keep type-only imports`);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod: { exports: Record<string, any> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', js)(mod.exports, mod, () => ({}));
  return mod.exports;
}

describe('75 service templates in MasterDetail (W9-2)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  lotIt('W9-2', '75.1 page: embedded contract, MasterDetail, selection in the URL', () => {
    const src = code(PAGE);
    assert.match(src, /export function ServiceTemplatesPage\(\{ embedded = false \}: ServiceTemplatesPageProps = \{\}\)/);
    assert.match(src, /if \(embedded\) return body;/, 'embedded: no PageContainer / PageHeader');
    const tail = src.slice(src.indexOf('if (embedded) return body;'));
    assert.match(tail, /<PageContainer[\s\S]*<PageHeader/, 'standalone: PageContainer + PageHeader');
    assert.doesNotMatch(src.slice(0, src.indexOf('if (embedded) return body;')), /<PageContainer|<PageHeader/);
    assert.match(src, /<MasterDetail\b/);
    assert.match(src, /const TEMPLATE_PARAM = 'template';/);
    assert.match(src, /useTabParam<EditorTab>\(EDITOR_TABS, 'parser', \{ param: embedded \? 'templateTab' : 'tab' \}\)/,
      'editor tab in the URL, not clashing with the hub ?tab=');
    assert.match(src, /<TemplateList\b/);
    assert.match(src, /<TemplateEditor\b[\s\S]*?key=\{editorTemplate\?\.id \?\? 'new'\}/, 'the form resets with the selection');

    const editor = code(EDITOR);
    assert.match(editor, /export const EDITOR_TABS = \['parser', 'thresholds', 'assignments', 'usage'\] as const;/);
    assert.match(editor, /<SegmentedTabs\b/);
    assert.match(editor, /<AssignmentsTab\b/);
    assert.match(editor, /<RegexTester\b/);
    assert.match(editor, /hidden: creating/, 'a new template shows Parser and Thresholds only');

    const list = code(LIST);
    assert.match(list, /type="search"/, 'searchable list');
    assert.match(list, /<OriginBadge\b/);
    assert.match(list, /<ModeChip\b/);
    assert.match(list, /<EnabledChip\b/);
    assert.match(list, /<ActionMenu\b/, 'row overflow through ActionMenu');
    assert.match(list, /<TenantFilterChips\b/);
    assert.match(code(`${DIR}/TemplateBadges.tsx`), /<TenantBadge tenantId=\{template\.tenantId\} \/>/, 'tenant origin names the tenant (god view)');
  });

  lotIt('W9-2', '75.2 UI kit only, capability-gated writes', () => {
    for (const rel of ownedFiles()) {
      const src = code(rel);
      assert.doesNotMatch(src, /(?<![\w.])(?:window\.)?(?:confirm|prompt|alert)\(/, `${rel}: native confirm/prompt/alert`);
      assert.doesNotMatch(src, /fixed inset-0/, `${rel}: hand-rolled overlay`);
      assert.doesNotMatch(src, /role="switch"/, `${rel}: hand-rolled switch`);
      assert.doesNotMatch(src, /\.catch\(\(\) => \{\s*\}\)/, `${rel}: silent catch`);
      assert.doesNotMatch(src, /role === 'admin'/, `${rel}: role check instead of a capability`);
    }
    const page = code(PAGE);
    assert.ok(page.includes("useCan('templates.write')"), 'writes gated by templates.write');
    assert.match(page, /if \(tpl\.tenantId == null\) return isPlatformAdmin \|\| isMaster;/, 'platform templates: platform admin or Default only');
    assert.match(page, /return tpl\.tenantId === currentTenantId;/, 'tenant templates: own tenant only');
    assert.match(page, /danger: true/, 'template delete is a danger confirm');
    assert.match(code(ASSIGN), /<Modal\b/);
    assert.match(code(ASSIGN), /useConfirm\(\)/);
    assert.match(code(ASSIGN), /danger: true/, 'assignment removal is a danger confirm');
    assert.match(code(EDITOR), /<ToggleSwitch\b/);
    // Assignment targets: the operating tenant's groups and writable agents.
    assert.match(page, /ownTree\(tree, currentTenantId\)/);
    assert.match(page, /d\.tenantId === currentTenantId\) && d\.accessLevel !== 'ro'/);
  });

  lotIt('W9-2', '75.3 strings through t() with defaults, serviceTemplates.* keys', () => {
    for (const rel of ownedFiles().filter((f) => f.endsWith('.tsx'))) {
      const src = code(rel);
      const calls = [...src.matchAll(/\bt\(\s*(['`])([^'`]+)\1\s*(,\s*\{[^)]*)?/g)];
      assert.ok(calls.length > 0, `${rel}: uses t()`);
      for (const m of calls) {
        const key = m[2];
        assert.match(key, /^(serviceTemplates\.|common\.)/, `${rel}: key ${key} outside serviceTemplates.* / common.*`);
        if (key.startsWith('serviceTemplates.')) {
          assert.match(m[3] ?? '', /defaultValue/, `${rel}: ${key} has no defaultValue`);
        }
      }
      // No user-facing literal between tags (icons, numbers and punctuation aside).
      for (const text of src.matchAll(/>\s*([A-Z][a-z]+(?: [a-z]+){1,})\s*</g)) {
        assert.fail(`${rel}: hard-coded text "${text[1]}"`);
      }
    }
  });

  lotIt('W9-2', '75.4 no log path override input; the only write clears one', () => {
    const assign = code(ASSIGN);
    const writes = [...assign.matchAll(/logPathOverride:\s*([^,}\n]+)/g)].map((m) => m[1].trim());
    assert.deepEqual(writes, ['null'], 'logPathOverride is only ever sent as null (clear)');
    assert.doesNotMatch(assign, /setLogPath|logPathOverride\s*\}?\s*onChange|value=\{[^}]*logPath/i, 'no log path input');
    assert.doesNotMatch(code(EDITOR), /logPathOverride/, 'the editor never writes assignment log paths');
    assert.doesNotMatch(code(PAGE), /logPathOverride/);
  });

  lotIt('W9-2', '75.5 regex tester: RE2 rejections and the Go -> JavaScript preview', () => {
    const m = loadTester();
    const codes = (p: string) => (m.findRe2Issues(p) as Array<{ code: string }>).map((i) => i.code);

    assert.deepEqual(codes('(?P<ip>\\d+\\.\\d+\\.\\d+\\.\\d+) user (?P<username>\\S+)'), []);
    assert.deepEqual(codes('(?<ip>[0-9.]+)'), [], 'Go 1.22 accepts (?<name>)');
    assert.deepEqual(codes('foo(?=bar)'), ['lookahead']);
    assert.deepEqual(codes('foo(?!bar)'), ['lookahead']);
    assert.deepEqual(codes('(?<=from )\\S+'), ['lookbehind']);
    assert.deepEqual(codes('(?<!x)y'), ['lookbehind']);
    assert.deepEqual(codes('(a)\\1'), ['backreference']);
    assert.deepEqual(codes('(?<u>a)\\k<u>'), ['namedBackreference']);
    assert.deepEqual(codes('(?P<u>a)(?P=u)'), ['namedBackreference']);
    assert.deepEqual(codes('(?>abc)'), ['atomicGroup']);
    assert.deepEqual(codes('a{1001}'), ['repeatCount']);
    assert.deepEqual(codes('a{2,1000}'), []);
    assert.deepEqual(codes('(ab'), ['unbalanced']);
    // Escaped and in-class lookalikes are literals, \012 is an octal code.
    assert.deepEqual(codes('\\(?=x\\)'), []);
    assert.deepEqual(codes('[(?=]'), []);
    assert.deepEqual(codes('[]a]\\012'), []);
    assert.deepEqual(codes('\\Q(?=\\E'), []);
    // Escapes and group forms Go refuses at compile time (the agent would drop the template).
    assert.deepEqual(codes('a\\Z'), ['escape']);
    assert.deepEqual(codes('\\u0041'), ['escape']);
    assert.deepEqual(codes('[\\b]'), ['escape']);
    assert.deepEqual(codes('abc\\'), ['escape']);
    assert.deepEqual(codes('\\8'), ['backreference']);
    assert.deepEqual(codes('(?#note)a'), ['group']);
    assert.deepEqual(codes('\\Aa\\b\\.\\-\\x41\\x{41}\\pL\\p{Greek}[\\d\\]]\\z'), []);
    assert.deepEqual(codes('(?i)a(?-s:b)(?:c)(?P<ip>d)(?<u>e)'), []);

    const ok = (p: string) => {
      const r = m.toJsRegex(p);
      assert.ok(r.ok, `${p}: ${r.message ?? ''}`);
      return r.regex as RegExp;
    };
    const ssh = ok('(?i)failed password for (?:invalid user )?(?P<username>\\S+) from (?P<ip>[0-9a-f:.]+)');
    assert.ok(ssh.flags.includes('i'), 'leading (?i) becomes the i flag');
    const rows = m.runSamples(ssh, 'Failed password for invalid user bob from 203.0.113.9 port 22\nAccepted publickey for alice\n\n');
    assert.equal(rows.length, 2, 'blank lines are skipped');
    assert.equal(rows[0].matched, true);
    assert.equal(rows[0].ip, '203.0.113.9');
    assert.equal(rows[0].username, 'bob');
    assert.equal(rows[1].matched, false);

    assert.equal(ok('\\Ahost [[:digit:]]+\\z').test('host 42'), true, '\\A, \\z and POSIX classes are translated');
    assert.equal(ok('\\Qa.b\\E').test('axb'), false, '\\Q…\\E is literal');
    assert.equal(ok('[]x]').test(']'), true, 'leading ] in a class is a literal');
    assert.equal(m.toJsRegex('a(?i)b').reason, 'untranslatable', 'mid-pattern flags cannot be previewed');
    assert.equal(m.toJsRegex('(?U)a+').reason, 'untranslatable');
    assert.equal(m.toJsRegex('a(b').reason, 'invalid');
    assert.equal(ok('\\x{41}b').test('Ab'), true, '\\x{…} is translated');
    assert.equal(m.toJsRegex('\\x{1F600}').reason, 'untranslatable');
    assert.notEqual(m.toJsRegex('a(?i:b)').reason, 'invalid', 'scoped flags are valid Go, at worst not previewable');

    assert.deepEqual(m.namedGroups('(?P<ip>x)\\(?P<no>y)(?<username>z)'), ['ip', 'username']);
    assert.equal(m.looksLikeIp('198.51.100.7'), true);
    assert.equal(m.looksLikeIp('2001:db8::1'), true);
    assert.equal(m.looksLikeIp('999.1.1.1'), false);
    assert.equal(m.looksLikeIp('bob'), false);

    // The editor refuses to save a regex with RE2 issues.
    assert.match(code(EDITOR), /regex: re2Issues\.length > 0/);
    assert.match(code(EDITOR), /if \(parserInvalid\) \{ onTabChange\('parser'\); return; \}/);
  });

  lotIt('W9-2', '75.6 typed API: origin helper, assignment upsert returns the row', () => {
    const api = code(API);
    assert.doesNotMatch(api, /\bany\b/);
    assert.match(api, /export type ServiceTemplateOrigin = 'builtin' \| 'platform' \| 'tenant' \| 'local';/);
    assert.match(api, /export function templateOrigin\(/);
    assert.match(api, /Promise<ServiceTemplateAssignment>/);
    assert.match(api, /apiClient\.put<ApiResponse<ServiceTemplateAssignment>>\(/);
  });

  lotIt('W9-2', '75.7 server contract used by the editor and the assignment dialog', async () => {
    const admin = await createUser(h.db, { tenants: [2], tenantRole: 'admin' });
    const c = await h.login(admin.username);
    const ssh = await h.db('service_templates')
      .where({ service_type: 'ssh', is_builtin: true })
      .whereNull('owner_scope')
      .first('id', 'threshold') as { id: number; threshold: number };

    // Shared platform template: read-only for a tenant admin outside Default.
    const shared = await c.put(`/api/service-templates/${ssh.id}`, { threshold: ssh.threshold + 1 });
    assert.equal(shared.status, 403);

    // Own tenant template: create / update / assign / delete.
    const name = `w92-${Date.now()}`;
    const created = await c.post('/api/service-templates', {
      name, serviceType: 'custom', customRegex: 'fail from (?P<ip>\\S+)', threshold: 4, windowSeconds: 120, mode: 'track', enabled: false,
    });
    assert.equal(created.status, 201);
    const tpl = created.json?.data as { id: number; tenantId: number | null; ownerScope: string | null };
    assert.equal(tpl.tenantId, 2);
    assert.equal(tpl.ownerScope, null);
    const listed = await c.get('/api/service-templates');
    assert.ok((listed.json?.data as Array<{ id: number }>).some((x) => x.id === tpl.id), 'listed');
    const updated = await c.put(`/api/service-templates/${tpl.id}`, { name: `${name}-x`, threshold: 6, mode: 'ban' });
    assert.equal(updated.status, 200);
    assert.equal(updated.json?.data?.threshold, 6);
    assert.equal(updated.json?.data?.mode, 'ban');

    const g = await createGroup(h.db, { tenantId: 2 });
    const first = await c.put(`/api/service-templates/${tpl.id}/assign/group/${g}`, { enabledOverride: true, thresholdOverride: null, windowSecondsOverride: null });
    assert.equal(first.status, 200);
    assert.equal(first.json?.data?.scopeId, g, 'the upsert answers the assignment row');

    // A log path planted earlier is kept by an override edit (field left out) …
    await h.db('service_template_assignments').where({ template_id: tpl.id, scope: 'group', scope_id: g }).update({ log_path_override: '/var/log/app.log' });
    const edit = await c.put(`/api/service-templates/${tpl.id}/assign/group/${g}`, { enabledOverride: false, thresholdOverride: 9, windowSecondsOverride: null });
    assert.equal(edit.status, 200);
    let row = await h.db('service_template_assignments').where({ template_id: tpl.id, scope: 'group', scope_id: g }).first();
    assert.equal(row.log_path_override, '/var/log/app.log');
    assert.equal(row.threshold_override, 9);
    assert.equal(row.enabled_override, false);
    // … and cleared by `logPathOverride: null` (the only log path write of the UI).
    const clear = await c.put(`/api/service-templates/${tpl.id}/assign/group/${g}`, { logPathOverride: null });
    assert.equal(clear.status, 200);
    row = await h.db('service_template_assignments').where({ template_id: tpl.id, scope: 'group', scope_id: g }).first();
    assert.equal(row.log_path_override, null);
    assert.equal(row.threshold_override, 9, 'other overrides untouched');

    const detail = await c.get(`/api/service-templates/${tpl.id}`);
    assert.equal(detail.status, 200);
    assert.equal((detail.json?.data?.assignments as unknown[]).length, 1);

    // Another tenant cannot open it; the Default god view can, read-only.
    // Adapted for W10-5 (owner default 'decision 5', W10.json W10-5 spec; see
    // audit-2026-09-26/waves/_defaults.txt): the read god view exists only on
    // Default, whatever the platform role.
    assert.equal((await (await h.adminIn(1)).get(`/api/service-templates/${tpl.id}`)).status, 200,
      'the Default god view reads it');
    assert.equal((await (await h.adminIn(3)).get(`/api/service-templates/${tpl.id}`)).status, 404,
      'no god view outside Default (W10-5)');
    const other = await createUser(h.db, { tenants: [3], tenantRole: 'admin' });
    const oc = await h.login(other.username);
    assert.equal((await oc.get(`/api/service-templates/${tpl.id}`)).status, 404);
    assert.equal((await oc.put(`/api/service-templates/${tpl.id}`, { threshold: 1 })).status, 404);

    const del = await c.del(`/api/service-templates/${tpl.id}`);
    assert.equal(del.status, 200);
    assert.equal(await h.db('service_templates').where({ id: tpl.id }).first(), undefined);
    assert.equal((await h.db('service_template_assignments').where({ template_id: tpl.id })).length, 0);
  });
});
