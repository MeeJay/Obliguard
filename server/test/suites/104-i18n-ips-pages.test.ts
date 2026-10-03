/**
 * 104 — W15-1 i18n sweep A: the IPS pages render no hard-coded English
 * (backlog C18/C19, gaps UI-PAGES-IPS-13/21; static checks, no database).
 *
 *   104.1 no JSX text node with letters outside t() in the owned files,
 *         except brand names and technical tokens (allowlist below)
 *   104.2 user-facing string props (title, placeholder, aria-label, label,
 *         message, confirmLabel...), the same fields of an option object
 *         passed to a call (askConfirm({...})) and toast.*() messages are not bare
 *         literals, except brand names and sample values (IPs, URLs, paths)
 *   104.3 every literal t('key') of the owned files carries an English
 *         default (second argument or { defaultValue }) unless the key
 *         already exists in en: a key missing from the locales never renders
 *         as its raw path
 *   104.4 spot checks: dashboard relative times, Settings About / Obligate /
 *         Danger zone, the NetMap canvas labels and the service-type option
 *         labels go through t()
 *
 * Locale files are W15-4's (en + fr filled from the defaultValues).
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

/** The files of W15-1 (spec files_owned). */
const OWNED = [
  'client/src/pages/DashboardPage.tsx',
  ...dirFiles('client/src/components/dashboard'),
  'client/src/pages/IPReputationPage.tsx',
  ...dirFiles('client/src/pages/ipReputation'),
  ...dirFiles('client/src/components/ip'),
  'client/src/pages/LiveEventsPage.tsx',
  'client/src/pages/NetMapPage.tsx',
  ...dirFiles('client/src/netmap'),
  ...dirFiles('client/src/netmap3d'),
  'client/src/pages/ServiceTemplatesPage.tsx',
  ...dirFiles('client/src/components/serviceTemplates'),
  'client/src/pages/RateLimitPage.tsx',
  'client/src/pages/PoliciesPage.tsx',
  ...dirFiles('client/src/components/policies'),
  'client/src/pages/SettingsPage.tsx',
  ...dirFiles('client/src/components/settings'),
];

/** Brand names and technical tokens allowed as bare JSX text / props. */
const ALLOWED_TEXT = new Set([
  'AbuseIPDB', 'Shodan', 'VirusTotal', 'PostgreSQL', 'Node.js', 'Obli.tools', 'Obli.tools Global', 'URL',
  'DISABLE_2FA_FORCE=true', '&times;',
]);

/** Props whose string value is shown to the user. */
const UI_PROPS = new Set([
  'title', 'placeholder', 'aria-label', 'ariaLabel', 'alt', 'label', 'description', 'message', 'hint',
  'tooltip', 'subtitle', 'helpText', 'emptyMessage', 'emptyText', 'confirmLabel', 'cancelLabel', 'deltaText',
]);

/** A sample value (IP, CIDR, URL, path, regex, number, key prefix), not prose. */
const isSample = (s: string) =>
  /^[\d./:\s]+$/.test(s)
  || /^https?:\/\//.test(s)
  || s.startsWith('/')
  || /^[\d.]+ \/ [\d./]+$/.test(s)
  || /\(\?P</.test(s)
  || /^[a-z0-9]+_x+$/.test(s)
  || /^[a-z0-9-]+$/.test(s);

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

describe('104 i18n sweep A (IPS pages)', () => {
  lotIt('W15-1', '104.1 no JSX text outside t() in the IPS pages (brand names aside)', () => {
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

  lotIt('W15-1', '104.2 user-facing props and toasts are not bare English literals', () => {
    const bad: string[] = [];
    for (const rel of OWNED) {
      const sf = source(rel);
      walk(sf, (n) => {
        if (!(ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) return;
        const text = n.text.trim();
        if (!/[A-Za-z]{2,}/.test(text) || ALLOWED_TEXT.has(text) || isSample(text)) return;
        let p: ts.Node = n.parent;
        while (ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p) || ts.isBinaryExpression(p)) {
          // Comparison operands (x === 'banned') are values, not text.
          if (ts.isBinaryExpression(p) && p.operatorToken.kind !== ts.SyntaxKind.BarBarToken
            && p.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return;
          if (ts.isConditionalExpression(p) && p.condition === n) return;
          p = p.parent;
        }
        if (ts.isJsxExpression(p)) p = p.parent;
        if (ts.isJsxAttribute(p) && UI_PROPS.has(p.name.getText())) bad.push(where(sf, n, text));
        else if (ts.isCallExpression(p) && /^toast(\.(error|success|loading))?$/.test(callName(p))) bad.push(where(sf, n, text));
        // askConfirm({ title: 'Delete?', message: '...' }) and other option objects passed to a call.
        else if (ts.isPropertyAssignment(p) && p.initializer === n && UI_PROPS.has(p.name.getText())
          && ts.isObjectLiteralExpression(p.parent) && ts.isCallExpression(p.parent.parent)
          && callName(p.parent.parent) !== 't') bad.push(where(sf, n, text));
      });
    }
    assert.deepEqual(bad, []);
  });

  lotIt('W15-1', '104.3 every literal t() key of the IPS pages has an English default or an en entry', () => {
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
        && second.properties.some((p) => p.name?.getText() === 'defaultValue');
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
    assert.ok(seen > 1000, `expected the IPS pages to use many t() keys, found ${seen}`);
    assert.deepEqual(bad, []);
  });

  lotIt('W15-1', '104.4 dashboard, Settings, NetMap and template spots go through t()', () => {
    const dash = read('client/src/pages/DashboardPage.tsx');
    for (const k of ['secondsAgo', 'minutesAgo', 'hoursAgo', 'daysAgo', 'hourTick', 'colIp']) {
      assert.match(dash, new RegExp(`t\\('dashboard\\.${k}'`), `dashboard.${k}`);
    }
    assert.doesNotMatch(dash, /\}[smhd] ago`/);
    assert.match(dash, /t\(`status\.scope\.\$\{ban\.scope\}`/);
    assert.match(dash, /t\(`bans\.type\.\$\{ban\.banType\}`/);

    const settings = read('client/src/pages/SettingsPage.tsx');
    for (const k of [
      'settings.about.title', 'settings.about.uptime', 'settings.about.loadFailed', 'settings.obligate.title',
      'settings.obligate.saved', 'settings.obligate.keyHint', 'settings.security.force2faBypass',
      'settings.danger.title', 'settings.danger.wipeBansLabel', 'settings.danger.wipeIpsDesc',
    ]) assert.ok(settings.includes(`t('${k}'`), k);
    assert.doesNotMatch(settings, /toast\.(error|success)\('/);

    const netmap = read('client/src/pages/NetMapPage.tsx');
    assert.match(netmap, /canvasTextRef\.current = \{\s*offline: t\('netmap\.canvas\.offline'/);
    assert.doesNotMatch(netmap, /offline: 'OFFLINE'/);
    assert.doesNotMatch(netmap, /`\$\{n\} IPs`/);

    const editor = read('client/src/components/serviceTemplates/TemplateEditor.tsx');
    assert.match(editor, /t\(`serviceTemplates\.serviceType\.\$\{s\.value\}`, \{ defaultValue: s\.label \}\)/);
  });
});
