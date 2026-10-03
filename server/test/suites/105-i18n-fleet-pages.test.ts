/**
 * 105 — W15-2 i18n sweep B: the fleet, admin and auth pages and the shared
 * components render no hard-coded English (backlog C18/C19, gaps
 * UI-PAGES-FLEET-20, FLEET-AGENT-17, UI-SHELL-9; static checks, no database).
 *
 *   105.1 no JSX text node with letters outside t() in the owned files,
 *         except brand names and technical tokens (allowlist below)
 *   105.2 user-facing string props (title, placeholder, aria-label, label,
 *         message, confirmLabel...) and toast.*() messages are not bare
 *         literals, except brand names and sample values (IPs, paths, slugs)
 *   105.3 every literal t('key') of the owned files carries an English
 *         default (second argument or { defaultValue }) unless the key
 *         already exists in en: a key missing from the locales never renders
 *         as its raw path
 *   105.4 spot checks: the firewall rule form (validation messages included),
 *         the service templates and notification bindings panels, the MikroTik
 *         panels, the notification center relative times and the French
 *         leftovers ("Apparence") go through t()
 *
 * Header.tsx is owner work (not swept). Locale files are W15-4's (en + fr
 * filled from the defaultValues).
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '');

const dirFiles = (dir: string) => fs.readdirSync(path.join(REPO, dir))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => `${dir}/${f}`);

/** The files of W15-2 (spec files_owned; Header.tsx excluded). */
const OWNED = [
  'client/src/pages/AgentListPage.tsx',
  ...dirFiles('client/src/components/agents'),
  'client/src/pages/AgentDetailPage.tsx',
  ...dirFiles('client/src/pages/agentDetail'),
  'client/src/pages/AdminAgentPage.tsx',
  ...dirFiles('client/src/components/agent'),
  'client/src/pages/GroupDetailPage.tsx',
  'client/src/pages/GroupEditPage.tsx',
  'client/src/pages/GroupManagePage.tsx',
  'client/src/pages/AdminUsersPage.tsx',
  'client/src/pages/AdminTenantsPage.tsx',
  'client/src/pages/NotificationsPage.tsx',
  ...dirFiles('client/src/components/notifications'),
  ...dirFiles('client/src/components/mikrotik'),
  'client/src/pages/ProfilePage.tsx',
  'client/src/pages/LoginPage.tsx',
  'client/src/pages/EnrollmentPage.tsx',
  'client/src/pages/ForgotPasswordPage.tsx',
  'client/src/pages/ResetPasswordPage.tsx',
  'client/src/pages/DownloadPage.tsx',
  'client/src/pages/AuditLogPage.tsx',
  'client/src/pages/NoTenantPage.tsx',
  'client/src/pages/NotFoundPage.tsx',
  'client/src/components/layout/AppLayout.tsx',
  'client/src/components/layout/Sidebar.tsx',
  'client/src/components/layout/TenantSwitcher.tsx',
  'client/src/components/layout/NotificationCenter.tsx',
  'client/src/components/layout/LiveAlerts.tsx',
  'client/src/components/layout/GlobalAddAgentModal.tsx',
  'client/src/components/layout/DesktopUpdateBanner.tsx',
  'client/src/components/layout/ProtectedRoute.tsx',
  ...dirFiles('client/src/components/common'),
  ...dirFiles('client/src/components/status'),
  'client/src/components/PermissionSetsTab.tsx',
];

/** Brand names, protocol / OS names and technical tokens allowed as bare JSX text / props. */
const ALLOWED_TEXT = new Set([
  'Obliguard', 'MikroTik', 'guard.obli.tools', 'TCP', 'UDP', 'ICMP', 'IP', 'OS', 'SSO', 'SSO ·', 'SHA-256', 'CSV',
  'Windows 10+', 'curl | bash', '&times;',
]);

/** Props whose string value is shown to the user. */
const UI_PROPS = new Set([
  'title', 'placeholder', 'aria-label', 'ariaLabel', 'alt', 'label', 'description', 'message', 'hint',
  'tooltip', 'subtitle', 'helpText', 'emptyMessage', 'emptyText', 'confirmLabel', 'cancelLabel',
]);

/** A sample value (IP, CIDR, URL, path, number, slug, masked secret), not prose. */
const isSample = (s: string) =>
  /^[\d./:\s]+$/.test(s)
  || /^https?:\/\//.test(s)
  || s.startsWith('/')
  || /^[a-z0-9-]+$/.test(s)
  || /^\*+$/.test(s);

function source(rel: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function where(sf: ts.SourceFile, node: ts.Node, text: string): string {
  return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${text.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}

function walk(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

const callName = (call: ts.CallExpression): string => {
  const e = call.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.getText() : '';
};

describe('105 i18n sweep B (fleet, admin, auth pages and shared components)', () => {
  lotIt('W15-2', '105.1 no JSX text outside t() in the fleet / admin / auth pages (brand names aside)', () => {
    const bad: string[] = [];
    for (const rel of OWNED) {
      if (!rel.endsWith('.tsx')) continue;
      const sf = source(rel);
      walk(sf, (n) => {
        if (!ts.isJsxText(n)) return;
        const text = n.text.replace(/\s+/g, ' ').trim();
        if (!/[A-Za-z]{2,}/.test(text) || ALLOWED_TEXT.has(text)) return;
        bad.push(where(sf, n, text));
      });
    }
    assert.deepEqual(bad, []);
  });

  lotIt('W15-2', '105.2 user-facing props and toasts are not bare English literals', () => {
    const bad: string[] = [];
    for (const rel of OWNED) {
      const sf = source(rel);
      walk(sf, (n) => {
        if (!(ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n))) return;
        const text = (ts.isTemplateExpression(n)
          ? n.head.text + n.templateSpans.map((s) => s.literal.text).join(' ')
          : n.text).trim();
        if (!/[A-Za-z]{2,}/.test(text) || ALLOWED_TEXT.has(text) || isSample(text)) return;
        let p: ts.Node = n.parent;
        while (ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p) || ts.isBinaryExpression(p)) {
          // Comparison operands (x === 'agent') are values, not text.
          if (ts.isBinaryExpression(p) && p.operatorToken.kind !== ts.SyntaxKind.BarBarToken
            && p.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return;
          if (ts.isConditionalExpression(p) && p.condition === n) return;
          p = p.parent;
        }
        if (ts.isJsxExpression(p)) p = p.parent;
        if (ts.isJsxAttribute(p) && UI_PROPS.has(p.name.getText())) bad.push(where(sf, n, text));
        else if (ts.isCallExpression(p) && /^toast(\.(error|success|loading))?$/.test(callName(p))) bad.push(where(sf, n, text));
      });
    }
    assert.deepEqual(bad, []);
  });

  lotIt('W15-2', '105.3 every literal t() key of the swept files has an English default or an en entry', () => {
    const en = JSON.parse(read('client/src/i18n/locales/en/translation.json').replace(/^﻿/, '')) as Record<string, unknown>;
    const inEn = (key: string): boolean => {
      let cur: unknown = en;
      for (const part of key.split('.')) {
        if (!cur || typeof cur !== 'object') return false;
        cur = (cur as Record<string, unknown>)[part];
      }
      return typeof cur === 'string' || (!!cur && typeof cur === 'object' && Object.keys(cur).some((k) => /_(one|other)$/.test(k)));
    };
    const hasDefault = (call: ts.CallExpression): boolean => {
      const second = call.arguments[1];
      if (!second) return false;
      if (ts.isStringLiteral(second) || ts.isNoSubstitutionTemplateLiteral(second) || ts.isTemplateExpression(second)) return true;
      return ts.isObjectLiteralExpression(second)
        && second.properties.some((p) => /^defaultValue(_one|_other)?$/.test(p.name?.getText() ?? ''));
    };
    const bad: string[] = [];
    let seen = 0;
    for (const rel of OWNED) {
      const sf = source(rel);
      walk(sf, (n) => {
        if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 't') return;
        const first = n.arguments[0];
        if (!first || !ts.isStringLiteral(first)) return;
        seen += 1;
        if (!hasDefault(n) && !inEn(first.text)) bad.push(where(sf, n, first.text));
      });
    }
    assert.ok(seen > 1000, `expected the swept pages to use many t() keys, found ${seen}`);
    assert.deepEqual(bad, []);
  });

  lotIt('W15-2', '105.4 firewall form, templates / bindings / MikroTik panels and the notification center go through t()', () => {
    const fw = read('client/src/components/agent/FirewallPanel.tsx');
    for (const k of ['title', 'addTitle', 'deleteConfirm', 'errPort', 'errRemoteIp', 'errNameReserved', 'ruleCount', 'inbound', 'outbound']) {
      assert.ok(fw.includes(`t('agentDetail.firewall.${k}'`), `agentDetail.firewall.${k}`);
    }
    // The validation helper receives t: its messages are translated too.
    assert.match(fw, /function validateRuleFields\([^)]*, t: TFunction\)/);
    assert.doesNotMatch(fw, /toast\.(error|success)\('/);

    const tpl = read('client/src/components/agent/ServiceTemplatesPanel.tsx');
    for (const k of ['title', 'bind', 'unbind', 'boundAgent', 'unboundGroup', 'overridesSaved', 'templateDefault']) {
      assert.ok(tpl.includes(`t('agentDetail.templatesPanel.${k}'`), `agentDetail.templatesPanel.${k}`);
    }
    assert.doesNotMatch(tpl, /toast\.(error|success)\('/);

    const bindings = read('client/src/components/notifications/NotificationBindingsPanel.tsx');
    for (const k of ['title', 'bound', 'excludedState', 'via', 'replaceHint', 'updateFailed']) {
      assert.ok(bindings.includes(`t('notifications.bindings.${k}'`), `notifications.bindings.${k}`);
    }
    assert.doesNotMatch(bindings, /buttonLabel = '/);

    const add = read('client/src/components/mikrotik/AddMikroTikModal.tsx');
    for (const k of ['title', 'step1', 'step2', 'step3', 'importEnabled']) {
      assert.ok(add.includes(`t('mikrotik.add.${k}'`), `mikrotik.add.${k}`);
    }
    const panel = read('client/src/components/mikrotik/MikroTikPanel.tsx');
    for (const k of ['title', 'testConnection', 'syncBans', 'syncComplete', 'misconfiguredHint']) {
      assert.ok(panel.includes(`t('mikrotik.panel.${k}'`), `mikrotik.panel.${k}`);
    }
    assert.doesNotMatch(panel, /`Sync (failed|complete)/);

    const center = read('client/src/components/layout/NotificationCenter.tsx');
    for (const k of ['secondsAgo', 'minutesAgo', 'hoursAgo', 'daysAgo', 'count', 'empty']) {
      assert.ok(center.includes(`t('notifications.center.${k}'`), `notifications.center.${k}`);
    }
    assert.doesNotMatch(center, /\}[smhd] ago`/);

    // French leftovers of the appearance step / section.
    for (const rel of ['client/src/pages/EnrollmentPage.tsx', 'client/src/pages/ProfilePage.tsx']) {
      assert.doesNotMatch(read(rel), /Apparence|Choisissez/, `${rel}: no hard-coded French`);
    }
  });
});
