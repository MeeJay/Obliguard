/**
 * 83 — W10-4 group detail / edit information architecture (client, static
 * checks):
 *   - GroupDetailPage mirrors Obliance: PageContainer + PageHeader with the
 *     TenantBadge, the group path and the evaluate-only badge; edit / delete
 *     gated by canWriteGroup (groups.manage), "Update outdated agents" by
 *     agents.update; an "Attached policies" read-only summary linking to the
 *     edit page tabs; the shared AgentTable embedded on the whole sub-tree,
 *     stats from the live presence (wsConnected), no stacked admin forms;
 *   - GroupEditPage: SegmentedTabs General | Agent settings | Service
 *     templates | Network limits | Notifications synced to ?tab= (useTabParam);
 *     the notification bindings, notification types, service templates,
 *     network limits and agent group config panels live here only (no
 *     duplicate between the two pages);
 *   - the agent update policy selector survives intact (Inherit / Automatic /
 *     Manual / Off, inherited value + source shown) and stays platform-admin
 *     only (owner directive); writes on another tenant's group are read-only;
 *   - labels moved off the Obliview monitors.* keys; no native dialogs, no
 *     hand-rolled switch, no role check (isAdmin) left on either page.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const DETAIL = 'client/src/pages/GroupDetailPage.tsx';
const EDIT = 'client/src/pages/GroupEditPage.tsx';

/** Source without line / block comments (a comment may mention a pattern). */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Config panels that must be rendered by exactly one of the two pages (the edit page). */
const CONFIG_PANELS = [
  'NotificationBindingsPanel',
  'NotificationTypesPanel',
  'ServiceTemplatesPanel',
  'NetworkLimitsPanel',
  'AgentGroupSettingsPanel',
  'GroupTemplatesPanel',
];

describe('83 group detail / edit pages (W10-4)', () => {
  lotIt('W10-4', '83.1 detail page: kit header with tenant badge, path, evaluate-only badge and gated actions', () => {
    const src = code(DETAIL);
    assert.match(src, /<PageContainer\b/);
    assert.match(src, /<PageHeader\b/);
    assert.match(src, /<TenantBadge\b[^>]*tenantId=\{group\.tenantId\}/, 'TenantBadge on the group');
    assert.match(src, /ancestorPath\(/, 'group path breadcrumb');
    assert.match(src, /evaluateOnly\.badge/, 'evaluate-only badge in the header');
    assert.match(src, /canWriteGroup\(groupId\)/, 'edit / delete gated by canWriteGroup');
    assert.match(src, /\{canWrite && \(/);
    assert.match(src, /to=\{`\/group\/\$\{groupId\}\/edit`\}/, 'edit link');
    assert.match(src, /useCan\('agents\.update'\)/, 'group update gated by agents.update');
    assert.match(src, /requestGroupUpdate\(/);
    assert.match(src, /useConfirm\(\)/);
    assert.match(src, /danger:\s*true/, 'delete is a danger confirm');
  });

  lotIt('W10-4', '83.2 detail page: attached policies summary and the sub-tree agents (shared AgentTable)', () => {
    const src = code(DETAIL);
    assert.match(src, /groups\.policies\.title/, "'Attached policies' card");
    for (const call of [
      'serviceTemplatesApi.getResolvedForGroup(',
      'rateLimitPoliciesApi.list(',
      'notificationsApi.getResolvedBindings(',
    ]) {
      assert.ok(src.includes(call), `summary reads ${call}`);
    }
    assert.match(src, /useCan\('notifications\.manage'\)/, 'bindings summary gated like its route');
    assert.match(src, /\/edit\?tab=\$\{tab\}/, 'summary rows link to the edit page tabs');
    assert.match(src, /useGroupUpdatePolicyView\(/, 'effective update policy + source');
    assert.match(src, /listDevices\(\{\s*groupId,\s*recursive:\s*true\s*\}\)/, 'whole sub-tree, server-filtered');
    assert.match(src, /<AgentTable\s+groupId=\{groupId\}\s+recursive\s+embedded\s*\/>/, 'shared AgentTable embedded on the sub-tree');
    assert.match(src, /d\.wsConnected/, 'online count from wsConnected');
    assert.match(src, /SOCKET_RESYNC_EVENT/, 'reloads on socket resync');
  });

  lotIt('W10-4', '83.3 edit page: tabbed sections synced to ?tab=', () => {
    const src = code(EDIT);
    assert.match(src, /<PageContainer\b/);
    assert.match(src, /<PageHeader\b/);
    assert.match(src, /<SegmentedTabs\b/);
    assert.match(src, /useTabParam<GroupEditTab>\(GROUP_EDIT_TABS, 'general'\)/);
    const tabs = src.match(/GROUP_EDIT_TABS = \[([^\]]*)\]/);
    assert.ok(tabs, 'GROUP_EDIT_TABS declared');
    assert.deepEqual(
      tabs[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean),
      ['general', 'agent', 'templates', 'limits', 'notifications'],
    );
    for (const key of ['general', 'agentSettings', 'serviceTemplates', 'networkLimits', 'notifications']) {
      assert.match(src, new RegExp(`groups\\.tabs\\.${key}`), `tab label groups.tabs.${key}`);
    }
  });

  lotIt('W10-4', '83.4 config panels live on the edit page only (no duplicate on the detail page)', () => {
    const detail = code(DETAIL);
    const edit = code(EDIT);
    for (const panel of CONFIG_PANELS) {
      assert.ok(!new RegExp(`<${panel}\\b`).test(detail), `${panel} not rendered on the detail page`);
      const uses = (edit.match(new RegExp(`<${panel}\\b`, 'g')) ?? []).length;
      assert.equal(uses, 1, `${panel} rendered exactly once on the edit page`);
    }
    assert.match(edit, /<Can\s+cap="notifications\.manage"/, 'bindings panel gated by notifications.manage');
    assert.match(edit, /useCan\('templates\.write'\)/, 'template writes gated by templates.write');
  });

  lotIt('W10-4', '83.5 update policy selector intact and platform-admin only; foreign groups read-only', () => {
    const src = code(EDIT);
    for (const v of ['inherit', 'auto', 'manual', 'off']) {
      assert.match(src, new RegExp(`<option value="${v}">`), `option ${v}`);
    }
    assert.match(src, /agentUpdate\.frozenBy/, "'Frozen by <source>' shown");
    assert.match(src, /updatePolicySourceLabel\(/, 'inherited source labelled');
    assert.match(src, /ancestorUpdatePolicyChain\(/, 'group chain resolved');
    assert.match(src, /const canSetPolicy = useIsPlatformAdmin\(\)/);
    assert.match(src, /disabled=\{savingPolicy \|\| !canSetPolicy\}/, 'selector disabled for non platform admins');
    // The operating tenant's policy is never applied to another tenant's group.
    assert.match(src, /group\.tenantId !== tenantPolicy\.tenantId/);
    assert.match(src, /const readOnly = !isOwnTenantGroup/);
    assert.match(src, /<fieldset disabled=\{readOnly\}/);
    // Config writes send only the edited keys: re-sending the stored
    // updatePolicy (e.g. `{ ...cfg, notificationTypes }`) is a 403 for
    // non platform admins holding groups.manage.
    assert.match(src, /agentGroupConfig:\s*\{\s*notificationTypes:\s*notifTypes\s*\}/);
    assert.match(src, /updateAgentGroupConfig\(group\.id,\s*\{\s*agentGroupConfig:\s*patch\s*\}\)/);
    assert.doesNotMatch(src, /\.\.\.cfg,\s*notificationTypes/);
  });

  lotIt('W10-4', '83.6 no Obliview monitors.* keys, native dialogs, hand-rolled switches or role checks', () => {
    for (const rel of [DETAIL, EDIT]) {
      const src = code(rel);
      assert.doesNotMatch(src, /t\('monitors\./, `${rel}: monitors.* key`);
      assert.doesNotMatch(src, /(?<![\w.])(?:window\.)?(?:confirm|prompt|alert)\(/, `${rel}: native dialog`);
      assert.doesNotMatch(src, /role="switch"/, `${rel}: hand-rolled switch (use <ToggleSwitch>)`);
      assert.doesNotMatch(src, /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/, `${rel}: silent .catch(() => {})`);
      assert.doesNotMatch(src, /\bisAdmin\b/, `${rel}: role check instead of capabilities`);
      assert.doesNotMatch(src, /user\?\.role === 'admin'/, `${rel}: role check instead of capabilities`);
    }
  });
});
