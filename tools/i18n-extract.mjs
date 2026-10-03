#!/usr/bin/env node
// i18n key extraction and literal check for the client (client/src).
//
//   node tools/i18n-extract.mjs              report: missing / unused keys, hard-coded literals
//   node tools/i18n-extract.mjs --check      same, exit 1 on a missing en/fr key, an en/fr
//                                            placeholder mismatch or a literal outside the allowlist
//   node tools/i18n-extract.mjs --fill-en    write the missing en keys from their defaultValue
//   node tools/i18n-extract.mjs --unused     list every en key no code references
//   node tools/i18n-extract.mjs --lang=de    also report the keys missing in another locale
//   node tools/i18n-extract.mjs --json       dump the extracted keys (key, default, plural, where)
//
// Extraction parses every .ts/.tsx file of client/src with the TypeScript
// compiler API (no regex guessing) and collects the calls t('key', ...) and
// <x>.t('key', ...) (i18n.t, i18next.t):
//   - the English default is the second argument when it is a string
//     (t('key', 'Fallback')) or the `defaultValue` option; plural defaults come
//     from `defaultValue_one` / `defaultValue_other`;
//   - a template-literal key (t(`bans.type.${x}`)) is dynamic: its static
//     prefix marks the keys under it as used, and the keys it can produce are
//     listed in tools/i18n-allowlist.json (`dynamicKeys`, checked to exist);
//   - errors.<code> keys come from the server error catalogue
//     (server/src/utils/errorCodes.ts), translated by api/client.ts.
//
// A key "exists" in a locale when it is a string, or when its plural forms
// (key_one / key_other) are. Only en and fr are required: the other 16
// locales fall back to English until their translation pass.
//
// The literal check flags, outside t():
//   - JSX text with letters (<p>Delete agent</p>);
//   - bare string literals given to a user-facing prop (title, placeholder,
//     aria-label, label, message...), to toast.*() or to the same fields of an
//     option object passed to a call (askConfirm({ title: '...' })).
// Brand names, technical tokens and sample values are allowed through
// tools/i18n-allowlist.json (`tokens`, `patterns`, per-file `files` entries).
//
// No dependency besides the repository's own `typescript`.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const ts = require('typescript');

const SRC = path.join(ROOT, 'client', 'src');
const LOCALES = path.join(SRC, 'i18n', 'locales');
const ALLOWLIST = path.join(ROOT, 'tools', 'i18n-allowlist.json');
const ERROR_CODES = path.join(ROOT, 'server', 'src', 'utils', 'errorCodes.ts');
const REQUIRED = ['en', 'fr'];

const args = new Set(process.argv.slice(2));
const opt = (name) => [...args].find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const CHECK = args.has('--check');

// ── Files ──────────────────────────────────────────────────────────────────

function listSources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== path.join(SRC, 'i18n')) out.push(...listSources(p)); }
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function loadLocale(lang) {
  const p = path.join(LOCALES, lang, 'translation.json');
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

function saveLocale(lang, tree) {
  // Same format as the committed files: 2 spaces, CRLF, final newline.
  const p = path.join(LOCALES, lang, 'translation.json');
  fs.writeFileSync(p, `${JSON.stringify(tree, null, 2).replace(/\n/g, '\r\n')}\r\n`);
}

const allow = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
const allowTokens = new Set(allow.tokens ?? []);
const allowPatterns = (allow.patterns ?? []).map((p) => new RegExp(p));
const allowFiles = allow.files ?? {};
const dynamicKeys = allow.dynamicKeys ?? [];
const ignoredPrefixes = allow.ignoredErrorCodes ?? [];

// ── Locale helpers ─────────────────────────────────────────────────────────

function lookup(tree, key) {
  let cur = tree;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** The text of a key: the plain string, else its plural `other` form. */
function textOf(tree, key) {
  const v = lookup(tree, key);
  if (typeof v === 'string') return v;
  const other = lookup(tree, `${key}_other`);
  return typeof other === 'string' ? other : undefined;
}

function setKey(tree, key, value) {
  const parts = key.split('.');
  let cur = tree;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] === undefined) cur[part] = {};
    if (typeof cur[part] !== 'object') return false; // a leaf is in the way
    cur = cur[part];
  }
  const last = parts[parts.length - 1];
  if (cur[last] !== undefined && typeof cur[last] !== 'string') return false;
  cur[last] = value;
  return true;
}

function leaves(tree, prefix = '', out = []) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') leaves(v, key, out);
    else out.push(key);
  }
  return out;
}

const placeholders = (s) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');

// ── Extraction ─────────────────────────────────────────────────────────────

/** Props / option fields whose string value is shown to the user. */
const UI_PROPS = new Set([
  'title', 'placeholder', 'aria-label', 'ariaLabel', 'alt', 'label', 'description', 'message', 'hint',
  'tooltip', 'subtitle', 'helpText', 'emptyMessage', 'emptyText', 'confirmLabel', 'cancelLabel', 'deltaText',
]);

const stringOf = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);

function callName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.getText();
  return '';
}

function isTCall(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text === 't';
  return ts.isPropertyAccessExpression(e) && e.name.text === 't';
}

function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

const keys = new Map(); // key -> { defaults: Set, plural: {one, other} | null, where: [] }
const dynamicPrefixes = new Set();
const literals = []; // { file, line, text }

function record(key, def, plural, where) {
  let e = keys.get(key);
  if (!e) { e = { defaults: new Set(), plural: null, where: [] }; keys.set(key, e); }
  if (def !== undefined) e.defaults.add(def);
  if (plural) e.plural = plural;
  e.where.push(where);
}

function isAllowed(file, text) {
  if (allowTokens.has(text)) return true;
  if (allowPatterns.some((re) => re.test(text))) return true;
  return (allowFiles[file] ?? []).includes(text);
}

for (const abs of listSources(SRC)) {
  const file = rel(abs);
  const text = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const at = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

  walk(sf, (n) => {
    // t('key', ...) / i18n.t('key', ...)
    if (ts.isCallExpression(n) && isTCall(n) && n.arguments.length > 0) {
      const first = n.arguments[0];
      const second = n.arguments[1];
      const key = stringOf(first);
      if (key !== undefined) {
        if (!/^[A-Za-z0-9_.-]+$/.test(key) || !key.includes('.')) return; // not an i18n key (t('x') helpers)
        let def;
        let plural = null;
        if (second) {
          def = stringOf(second);
          if (ts.isObjectLiteralExpression(second)) {
            const prop = (name) => second.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === name);
            const dv = prop('defaultValue');
            if (dv) def = stringOf(dv.initializer);
            const one = prop('defaultValue_one');
            const other = prop('defaultValue_other');
            if (one || other) plural = { one: stringOf(one?.initializer), other: stringOf(other?.initializer) };
          }
        }
        record(key, def, plural, at(n));
      } else if (ts.isTemplateExpression(first)) {
        dynamicPrefixes.add(first.head.text);
      }
      return;
    }

    // Hard-coded JSX text.
    if (ts.isJsxText(n)) {
      const t = n.text.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]{2,}/.test(t) && !isAllowed(file, t)) literals.push({ file, line: at(n), text: t });
      return;
    }

    // Bare literal given to a user-facing prop, toast or option object.
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const t = n.text.trim();
      if (!/[A-Za-z]{2,}/.test(t) || isAllowed(file, t)) return;
      let p = n.parent;
      while (ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p) || ts.isBinaryExpression(p)) {
        // Comparison operands (x === 'banned') are values, not text.
        if (ts.isBinaryExpression(p) && p.operatorToken.kind !== ts.SyntaxKind.BarBarToken
          && p.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return;
        if (ts.isConditionalExpression(p) && p.condition === n) return;
        p = p.parent;
      }
      if (ts.isJsxExpression(p)) p = p.parent;
      const flagged =
        (ts.isJsxAttribute(p) && UI_PROPS.has(p.name.getText()))
        || (ts.isCallExpression(p) && /^toast(\.(error|success|loading))?$/.test(callName(p)))
        || (ts.isPropertyAssignment(p) && p.initializer === n && UI_PROPS.has(p.name.getText())
          && ts.isObjectLiteralExpression(p.parent) && ts.isCallExpression(p.parent.parent)
          && !isTCall(p.parent.parent));
      if (flagged) literals.push({ file, line: at(n), text: t });
    }
  });
}

// errors.<code>: the server error catalogue, translated by api/client.ts.
const errorKeys = [];
if (fs.existsSync(ERROR_CODES)) {
  const src = fs.readFileSync(ERROR_CODES, 'utf8');
  const entry = /code:\s*(?:'([A-Za-z0-9_]+)'|HTTP_ERROR_CODES\.(\w+))\s*,\s*en:\s*(['"`])((?:\\.|(?!\3).)*)\3/g;
  for (const m of src.matchAll(entry)) {
    const code = m[1] ?? m[2]; // HTTP_ERROR_CODES.X has the value 'X'
    if (ignoredPrefixes.some((p) => code.startsWith(p))) continue;
    errorKeys.push({ key: `errors.${code}`, def: m[4].replace(/\\(['"`\\])/g, '$1') });
  }
  dynamicPrefixes.add('errors.');
}

// ── Report ─────────────────────────────────────────────────────────────────

const locales = { en: loadLocale('en'), fr: loadLocale('fr') };
const extra = opt('lang');
if (extra && !locales[extra]) locales[extra] = loadLocale(extra);

/** Every key a locale must hold, with its English default and plural flag. */
const required = new Map();
for (const [key, e] of keys) required.set(key, { def: [...e.defaults][0], plural: e.plural, where: e.where[0] });
for (const key of dynamicKeys) if (!required.has(key)) required.set(key, { def: undefined, plural: null, where: 'tools/i18n-allowlist.json (dynamicKeys)' });
for (const { key, def } of errorKeys) if (!required.has(key)) required.set(key, { def, plural: null, where: 'server/src/utils/errorCodes.ts' });

function missingIn(lang) {
  const tree = locales[lang];
  const out = [];
  for (const [key, r] of required) {
    const ok = r.plural
      ? typeof lookup(tree, `${key}_other`) === 'string' || typeof lookup(tree, key) === 'string'
      : textOf(tree, key) !== undefined;
    if (!ok) out.push({ key, ...r });
  }
  return out;
}

if (args.has('--fill-en')) {
  const en = locales.en;
  let added = 0;
  const skipped = [];
  for (const m of missingIn('en')) {
    if (m.plural?.other) {
      const ok = setKey(en, m.key, m.plural.other)
        && setKey(en, `${m.key}_one`, m.plural.one ?? m.plural.other)
        && setKey(en, `${m.key}_other`, m.plural.other);
      if (ok) { added += 1; continue; }
    } else if (m.def !== undefined && setKey(en, m.key, m.def)) { added += 1; continue; }
    skipped.push(`${m.key} (${m.where})`);
  }
  saveLocale('en', en);
  console.log(`[i18n] en: ${added} key(s) added from their defaultValue`);
  if (skipped.length) console.log(`[i18n] en: ${skipped.length} key(s) without a usable default:\n  ${skipped.join('\n  ')}`);
  process.exit(0);
}

if (args.has('--json')) {
  const out = {};
  for (const [key, r] of required) out[key] = r;
  console.log(JSON.stringify({ keys: out, dynamicPrefixes: [...dynamicPrefixes] }, null, 2));
  process.exit(0);
}

let failed = false;
const langs = [...REQUIRED, ...(extra && !REQUIRED.includes(extra) ? [extra] : [])];
console.log(`[i18n] ${keys.size} literal key(s), ${dynamicPrefixes.size} dynamic prefix(es), ${errorKeys.length} error code(s)`);
for (const lang of langs) {
  const miss = missingIn(lang);
  if (miss.length === 0) { console.log(`[i18n] ${lang}: no missing key`); continue; }
  console.log(`[i18n] ${lang}: ${miss.length} missing key(s)`);
  for (const m of miss.slice(0, 200)) console.log(`  ${m.key}  (${m.where})`);
  if (REQUIRED.includes(lang)) failed = true;
}

// en and fr carry the same placeholders for every required key.
const mismatched = [];
for (const key of required.keys()) {
  const e = textOf(locales.en, key);
  const f = textOf(locales.fr, key);
  if (e !== undefined && f !== undefined && placeholders(e) !== placeholders(f)) mismatched.push(key);
}
if (mismatched.length) {
  failed = true;
  console.log(`[i18n] ${mismatched.length} key(s) whose fr placeholders differ from en:\n  ${mismatched.join('\n  ')}`);
}

const usedBy = (key) => {
  const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
  return required.has(base) || [...dynamicPrefixes].some((p) => p && base.startsWith(p));
};
const unused = leaves(locales.en).filter((k) => !usedBy(k));
console.log(`[i18n] en: ${unused.length} key(s) not referenced statically (maps of keys, labelKey tables...)`);
if (args.has('--unused')) for (const k of unused) console.log(`  ${k}`);

if (literals.length) {
  failed = true;
  console.log(`[i18n] ${literals.length} hard-coded literal(s) outside t() (translate them or extend tools/i18n-allowlist.json):`);
  for (const l of literals) console.log(`  ${l.line}  ${JSON.stringify(l.text.slice(0, 80))}`);
} else {
  console.log('[i18n] no hard-coded literal outside the allowlist');
}

if (CHECK && failed) process.exit(1);
