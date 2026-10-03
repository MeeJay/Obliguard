/**
 * 82 — W10-3 Agent detail page (client, static + logic checks):
 *   - AgentDetailPage is a shell (Obliance DeviceDetailPage model): lifecycle
 *     header, labelled SegmentedTabs synced to ?tab= (useTabParam), one
 *     component per tab through the tab registry agentDetail/tabs.tsx
 *     (Overview | Events | Services & templates | Firewall | Settings),
 *     back link to /agents (never navigate(-1));
 *   - model.ts: tab ids + legacy ?tab= aliases, the combined lifecycle status
 *     (approval > uninstall > running update > MikroTik config > WS) and the
 *     action matrix mirroring the server guards (agents.approve / manage /
 *     update / delete, foreign tenant and read-only team grant = no write);
 *   - header: AgentStatusBadge, LastSeenPill, TenantBadge, group chip,
 *     evaluate-only, UpdateStatusBadge, inline Approve / Refuse, ActionMenu;
 *     Danger Zone in Settings;
 *   - useConfirm only (no native dialogs), uninstall / delete type the
 *     hostname, no hard-coded ONLINE / OFFLINE, the local IpDrawer is gone
 *     (IPs open the shared drawer), live rows through ip:events + agent watch;
 *   - every former feature still reachable; the agent update policy UI
 *     (owner directive C17) is intact and platform-admin only;
 *   - agentDetail.* strings carry a defaultValue.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const PAGE = 'client/src/pages/AgentDetailPage.tsx';
const DIR = 'client/src/pages/agentDetail';
const MODEL = `${DIR}/model.ts`;
const TABS = `${DIR}/tabs.tsx`;
const HEADER = `${DIR}/AgentHeader.tsx`;
const LIFECYCLE = `${DIR}/useAgentLifecycle.ts`;
const SETTINGS = `${DIR}/SettingsTab.tsx`;
const SETTINGS_PANEL = `${DIR}/AgentSettingsPanel.tsx`;

/** Source without line / block comments (a comment may mention confirm()). */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function ownedFiles(): string[] {
  const files = [PAGE];
  for (const name of fs.readdirSync(path.join(REPO, DIR))) {
    if (/\.tsx?$/.test(name)) files.push(`${DIR}/${name}`);
  }
  return files;
}

/** model.ts, transpiled and evaluated (type-only imports). */
function loadModel(): Record<string, any> {
  const src = read(MODEL);
  assert.doesNotMatch(src, /^import (?!type )/m, `${MODEL} must keep type-only imports`);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod: { exports: Record<string, any> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', js)(mod.exports, mod, () => ({}));
  return mod.exports;
}

/** The argument list of every `t('<prefix>…'` call (balanced parentheses). */
function tCalls(src: string, prefix: string): string[] {
  const out: string[] = [];
  const needle = `t('${prefix}`;
  let i = src.indexOf(needle);
  while (i >= 0) {
    let depth = 0;
    let j = i + 1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf(needle, j);
  }
  return out;
}

const DEVICE = {
  status: 'approved', wsConnected: true, deviceType: 'agent', mikrotikStatus: undefined,
  pendingCommand: null, uninstallCommandedAt: null, update: null, accessLevel: 'rw',
  updateAvailable: false, updatePending: false, resolvedUpdatePolicy: 'manual',
};
const ALL_CAPS = { canManage: true, canApprove: true, canUpdate: true, canDelete: true, foreign: false, updateFailed: false };

describe('82 agent detail page (W10-3)', () => {
  lotIt('W10-3', '82.1 shell: PageContainer, labelled SegmentedTabs on ?tab=, tab registry, back link to /agents', () => {
    const src = code(PAGE);
    assert.match(src, /<PageContainer/);
    assert.match(src, /useTabParam<AgentDetailTab>\(visibleIds, DEFAULT_AGENT_DETAIL_TAB\)/, '?tab= deep links through useTabParam');
    assert.match(src, /<SegmentedTabs[\s\S]*?label: t\(def\.labelKey/, 'labelled tabs (icon + text), not an icon rail');
    assert.match(src, /AGENT_DETAIL_TAB_DEFS/, 'tab bodies come from the registry');
    assert.match(src, /activeDef\.render\(tabContext\)/);
    assert.doesNotMatch(src, /activeTab === '/, 'no inline ternary tab bodies');
    assert.doesNotMatch(src, /navigate\(-1\)/, 'back goes to /agents, not history');
    assert.match(read(HEADER), /to="\/agents"/);
    assert.doesNotMatch(src, /w-14 flex-shrink-0 border-l/, 'the icon-only right rail is gone');
    assert.ok(src.split('\n').length < 400, 'AgentDetailPage stays a shell');
  });

  lotIt('W10-3', '82.2 model: tab ids, registry order, legacy ?tab= aliases', () => {
    const m = loadModel();
    assert.deepEqual([...m.AGENT_DETAIL_TABS], ['overview', 'events', 'services', 'firewall', 'settings']);
    assert.equal(m.DEFAULT_AGENT_DETAIL_TAB, 'overview');
    const registryIds = [...code(TABS).matchAll(/id: '([a-z]+)'/g)].map((x) => x[1]);
    assert.deepEqual(registryIds, [...m.AGENT_DETAIL_TABS], 'registry order = model order');
    assert.equal(m.resolveAgentDetailTab('events'), 'events');
    assert.equal(m.resolveAgentDetailTab('starmap'), 'overview');
    assert.equal(m.resolveAgentDetailTab('netlimits'), 'firewall');
    assert.equal(m.resolveAgentDetailTab('nope'), null);
    assert.equal(m.resolveAgentDetailTab(null), null);
  });

  lotIt('W10-3', '82.3 model: combined lifecycle status precedence', () => {
    const { agentLifecycleStatus: s } = loadModel();
    assert.equal(s({ ...DEVICE }), 'online');
    assert.equal(s({ ...DEVICE, wsConnected: false }), 'offline');
    assert.equal(s({ ...DEVICE, status: 'pending' }), 'pending', 'approval first, whatever the channel');
    assert.equal(s({ ...DEVICE, status: 'refused' }), 'refused');
    assert.equal(s({ ...DEVICE, status: 'suspended' }), 'suspended');
    assert.equal(s({ ...DEVICE, pendingCommand: 'uninstall' }), 'uninstalling');
    assert.equal(s({ ...DEVICE, wsConnected: false, uninstallCommandedAt: '2026-10-01T00:00:00Z' }), 'uninstalling');
    assert.equal(s({ ...DEVICE, update: { phase: 'installing' } }), 'updating');
    assert.equal(s({ ...DEVICE, update: { phase: 'offered' } }), 'online', 'an offer alone is not a running update');
    assert.equal(s({ ...DEVICE, update: { phase: 'failed' } }), 'online', 'a failure is shown by UpdateStatusBadge');
    assert.equal(s({ ...DEVICE, deviceType: 'mikrotik', mikrotikStatus: 'misconfigured', wsConnected: false }), 'misconfigured');
    assert.equal(s({ ...DEVICE, deviceType: 'mikrotik', mikrotikStatus: 'online', wsConnected: true }), 'online');
  });

  lotIt('W10-3', '82.4 model: action matrix mirrors the server guards', () => {
    const { agentActions: a } = loadModel();
    const none = (r: Record<string, boolean>) => Object.values(r).every((v) => v === false);

    assert.ok(none(a({ ...DEVICE, updateAvailable: true }, { ...ALL_CAPS, foreign: true })), 'foreign tenant: read-only');
    assert.ok(none(a({ ...DEVICE, accessLevel: 'ro', updateAvailable: true }, ALL_CAPS)), 'read-only team grant: read-only');
    assert.ok(none(a({ ...DEVICE, updateAvailable: true, updatePending: true }, { ...ALL_CAPS, canManage: false, canApprove: false, canUpdate: false, canDelete: false })));

    const pending = a({ ...DEVICE, status: 'pending' }, ALL_CAPS);
    assert.equal(pending.approve, true);
    assert.equal(pending.refuse, true);
    assert.equal(pending.suspend, false);
    assert.equal(pending.moveGroup, false, 'the group is chosen at approval');
    assert.equal(pending.uninstall, false);
    assert.equal(a({ ...DEVICE, status: 'pending' }, { ...ALL_CAPS, canApprove: false }).approve, false, 'approve needs agents.approve');

    const approved = a({ ...DEVICE }, ALL_CAPS);
    assert.equal(approved.suspend, true);
    assert.equal(approved.reinstate, false);
    assert.equal(approved.moveGroup, true);
    assert.equal(approved.rename, true);
    assert.equal(approved.uninstall, true);
    assert.equal(approved.delete, true);
    assert.equal(a({ ...DEVICE }, { ...ALL_CAPS, canApprove: false }).suspend, false, 'status changes need agents.approve');
    assert.equal(a({ ...DEVICE }, { ...ALL_CAPS, canManage: false }).moveGroup, false, 'group / name need agents.manage');
    assert.equal(a({ ...DEVICE }, { ...ALL_CAPS, canDelete: false }).uninstall, false, 'uninstall needs agents.delete');
    assert.equal(a({ ...DEVICE }, { ...ALL_CAPS, canDelete: false }).delete, false);

    assert.equal(a({ ...DEVICE, status: 'suspended' }, ALL_CAPS).reinstate, true);
    assert.equal(a({ ...DEVICE, status: 'refused' }, ALL_CAPS).requeue, true);
    assert.equal(a({ ...DEVICE, deviceType: 'mikrotik' }, ALL_CAPS).uninstall, false, 'no agent to uninstall on a router');
    assert.equal(a({ ...DEVICE, pendingCommand: 'uninstall' }, ALL_CAPS).uninstall, false, 'already requested');

    const upd = { ...DEVICE, updateAvailable: true };
    assert.equal(a(upd, ALL_CAPS).requestUpdate, true);
    assert.equal(a(upd, { ...ALL_CAPS, canUpdate: false }).requestUpdate, false, 'Update now needs agents.update');
    assert.equal(a({ ...upd, resolvedUpdatePolicy: 'off' }, ALL_CAPS).requestUpdate, false, "'off' (frozen) is absolute");
    assert.equal(a(upd, { ...ALL_CAPS, updateFailed: true }).requestUpdate, false, 'a failed attempt is retried from the badge');
    assert.equal(a({ ...upd, updatePending: true }, ALL_CAPS).requestUpdate, false);
    assert.equal(a({ ...upd, updatePending: true }, ALL_CAPS).cancelUpdate, true);
    assert.equal(a({ ...upd, status: 'suspended' }, ALL_CAPS).requestUpdate, false);
  });

  lotIt('W10-3', '82.5 page wiring: capabilities, read-only grant, update Retry on agents.update', () => {
    const src = code(PAGE);
    for (const cap of ['agents.manage', 'agents.approve', 'agents.update', 'agents.delete']) {
      assert.match(src, new RegExp(`useCan\\('${cap.replace('.', '\\.')}'\\)`), `gated on ${cap}`);
    }
    assert.match(src, /device\?\.accessLevel === 'ro'/, 'read-only team grant hides writes');
    assert.match(src, /<UpdateStatusBadge[\s\S]*?canRetry=\{!readOnly && canUpdate && device\.status === 'approved' && device\.resolvedUpdatePolicy !== 'off'\}/, 'Retry gated by agents.update, hidden under off');
    assert.doesNotMatch(src, /MONITOR_RW|role === 'admin'/, 'no legacy role / alias checks');
    assert.match(code(`${DIR}/FirewallTab.tsx`), /useCan\('firewall\.rules\.write'\)/);
    assert.match(code(`${DIR}/FirewallTab.tsx`), /useCan\('firewall\.rules\.read'\)/);
    assert.match(code(`${DIR}/ServicesTab.tsx`), /useCan\('templates\.write'\)/);
    assert.match(code(`${DIR}/ServicesTab.tsx`), /useCan\('integrations\.mikrotik'\)/);
  });

  lotIt('W10-3', '82.6 header: status, last seen, tenant, group, evaluate-only, update state, Approve / Refuse, ActionMenu', () => {
    const src = code(HEADER);
    for (const tag of ['<AgentStatusBadge', '{lastSeen}', '<TenantBadge', '{updateBadge}', '<ActionMenu']) {
      assert.ok(src.includes(tag), `header renders ${tag}`);
    }
    // LastSeenPill / UpdateStatusBadge are composed by the shell (suite 46c reads them there).
    assert.match(code(PAGE), /lastSeen=\{<LastSeenPill lastSeenAt=\{device\.lastSeenAt\} \/>\}/);
    assert.match(src, /to=\{`\/group\/\$\{device\.groupId\}`\}/, 'group chip');
    assert.match(src, /device\.evaluateOnly &&/, 'evaluate-only badge');
    assert.match(src, /actions\.approve &&[\s\S]*?onClick=\{onApprove\}/, 'inline Approve for pending agents');
    assert.match(src, /actions\.refuse &&[\s\S]*?lifecycle\.refuse\(\)/, 'inline Refuse for pending agents');
    for (const key of ['requestUpdate', 'cancelUpdate', 'moveGroup', 'suspend', 'reinstate', 'uninstall', 'delete']) {
      assert.match(src, new RegExp(`key: '${key}'[\\s\\S]*?hidden: !actions\\.${key}`), `menu item ${key} gated by the model`);
    }
    assert.match(src, /trigger=\{\(p\) => \(/, 'labelled menu trigger (coarse-pointer friendly)');
    assert.match(code(`${DIR}/AgentStatusBadge.tsx`), /status\.agent\./, 'status labels translated');
  });

  lotIt('W10-3', '82.7 dialogs: useConfirm only, hostname typed for uninstall / delete, Danger Zone', () => {
    for (const file of ownedFiles()) {
      const src = code(file);
      assert.doesNotMatch(src, /(^|[^\w.])(confirm|alert|prompt)\(/m, `${file}: no native dialog`);
      assert.doesNotMatch(src, /window\.(confirm|alert|prompt)/, `${file}: no native dialog`);
      assert.doesNotMatch(src, /'ONLINE'|'OFFLINE'|>ONLINE<|>OFFLINE</, `${file}: no hard-coded status label`);
      assert.doesNotMatch(src, /'ip:flow'/, `${file}: live rows through SOCKET_EVENTS.IP_EVENTS`);
      assert.doesNotMatch(src, /function IpDrawer\b/, `${file}: the local IP drawer is gone`);
    }
    const lc = code(LIFECYCLE);
    assert.match(lc, /const askConfirm = useConfirm\(\)/);
    const uninstall = lc.slice(lc.indexOf('const uninstall'), lc.indexOf('const remove'));
    assert.match(uninstall, /requireText: device\.hostname/, 'uninstall: type the hostname');
    assert.match(uninstall, /sendCommand\(device\.id, 'uninstall'\)/);
    const remove = lc.slice(lc.indexOf('const remove'));
    assert.match(remove, /requireText: device\.hostname/, 'delete: type the hostname');
    assert.match(remove, /deleteDevice\(device\.id\)/);
    const settings = code(SETTINGS);
    assert.match(settings, /border-red-500\/30[\s\S]*?agentDetail\.danger\.title/, 'Danger Zone section');
    for (const fn of ['suspend', 'reinstate', 'uninstall', 'remove']) {
      assert.match(settings, new RegExp(`lifecycle\\.${fn}\\(\\)`), `Danger Zone runs ${fn}`);
    }
  });

  lotIt('W10-3', '82.8 IPs open the shared drawer; live rows via ip:events and the agent watch', () => {
    for (const file of [`${DIR}/OverviewTab.tsx`, `${DIR}/EventsTab.tsx`]) {
      const src = code(file);
      assert.match(src, /useIpDrawer\(\)/, `${file}: shared IP drawer`);
      assert.match(src, /useIpActions\(\)/, `${file}: shared IP actions (confirm + toast)`);
      assert.match(src, /useAgentIpEvents\(devId/, `${file}: live rows`);
    }
    const parts = code(`${DIR}/parts.tsx`);
    assert.match(parts, /socket\.on\(SOCKET_EVENTS\.IP_EVENTS, onFrame\)/);
    assert.match(parts, /r\.deviceId === deviceId/);
    const watch = code(`${DIR}/useAgentWatch.ts`);
    assert.match(watch, /emit\(CLIENT_SOCKET_EVENTS\.AGENT_WATCH, \{ deviceId \}/);
    assert.match(watch, /emit\(CLIENT_SOCKET_EVENTS\.AGENT_UNWATCH, \{ deviceId \}/);
    assert.match(watch, /socket\.on\('connect', watch\)/, 're-joined after a reconnect');
    assert.match(code(PAGE), /useAgentWatch\(/);
  });

  lotIt('W10-3', '82.9 every former feature is still reachable', () => {
    const all = ownedFiles().map(code).join('\n');
    for (const needle of [
      '<FirewallPanel', '<NetworkLimitsPanel', '<ServiceTemplatesPanel', '<MikroTikPanel', '<NotificationTypesPanel',
      '<AgentMiniMap', '<EvaluateOnlyBanner', '<LookupButtons', '/api/auth/device-links', "listLocal('agent'",
      "ownerScope:     'agent'", 'wanMatchingEnabled', 'evaluateOnly:', 'overrideGroupSettings', 'maxMissedPushes',
      'requestUpdate(device.id)', 'cancelUpdate(device.id)', 'onRetried',
    ]) {
      assert.ok(all.includes(needle), `still present: ${needle}`);
    }
    assert.match(code(PAGE), /<UpdateStatusBadge[\s\S]*?onRetried=\{setDevice\}/, 'update status + Retry');
  });

  lotIt('W10-3', '82.10 agent update policy UI intact (owner directive C17), platform-admin writes', () => {
    const panel = code(SETTINGS_PANEL);
    for (const v of ['inherit', 'auto', 'manual', 'off']) {
      assert.match(panel, new RegExp(`<option value="${v}">`), `option ${v}`);
    }
    assert.match(panel, /frozenFromAbove = resolvedPolicy === 'off' && policySource !== 'agent'/, "'off' above is absolute");
    assert.match(panel, /updatePolicySourceLabel\(policySource/, 'source of the effective value shown');
    assert.match(panel, /updatePolicySourceGroupId/, 'group source named');
    assert.match(panel, /updatePolicy: v === 'inherit' \? null : v/);
    assert.match(code(SETTINGS), /canEditUpdatePolicy=\{isPlatformAdmin && !readOnly && device\.deviceType === 'agent'\}/, 'policy writes: platform admin only');
  });

  lotIt('W10-3', '82.12 approval without agents.manage sends no group (PATCH {status, groupId} needs both caps)', () => {
    const lc = code(LIFECYCLE);
    assert.match(lc, /groupId === undefined \? \{ status: 'approved' \} : \{ status: 'approved', groupId \}/);
    const modal = code(`${DIR}/GroupChoiceModal.tsx`);
    assert.match(modal, /onConfirm\(pickGroup \? groupId : undefined\)/);
    assert.match(modal, /\{pickGroup && \(/, 'no group picker without agents.manage');
    assert.match(code(PAGE), /canPickGroup=\{actions\.rename\}/);
  });

  lotIt('W10-3', '82.11 agentDetail.* strings carry a defaultValue', () => {
    for (const file of ownedFiles()) {
      for (const call of tCalls(read(file), 'agentDetail.')) {
        assert.match(call, /defaultValue:/, `${file}: ${call.slice(0, 80)}`);
      }
    }
  });
});
