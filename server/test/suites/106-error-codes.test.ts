/**
 * 106 — Server error codes and client error translation (W15-3).
 *
 *   106.1 no bare AppError left in server/src/services: every throw goes
 *         through codedError (or a coded AgentKeyError) with a catalogue code;
 *   106.2 the catalogue is consistent (unique names and values, code format,
 *         one template each) and codedError keeps the status and the message;
 *   106.3 over HTTP, refusals carry their code and keep their status and
 *         English text (ban target too broad, duplicate ban, duplicate
 *         whitelist entry, unknown / foreign rate limit policy);
 *   106.4 the client translates by code: errors.<code> with the server text
 *         as fallback, applied in the response interceptor;
 *   106.5 every catalogue code has its errors.<code> text in en and fr,
 *         with the placeholders of the catalogue template.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness, Res } from '../harness';
import { lotIt } from '../lots';
import { nextIp } from '../seed';
import { AppError } from '../../src/middleware/errorHandler';
import { ERROR_CATALOGUE, ERROR_CODES, codedError, errorTemplate } from '../../src/utils/errorCodes';
import { banPrefixFloor } from '../../src/utils/ipValidation';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '');
/** Source without block / line comments (checks target code, not prose). */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function tsFiles(relDir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(REPO, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) out.push(...tsFiles(rel));
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const CODE_VALUES = new Set<string>(Object.values(ERROR_CATALOGUE).map((e) => e.code));
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/** A coded refusal: status, catalogue code, and the params (when echoed) fill the template. */
function assertCoded(r: Res, status: number, expected: string, label: string): void {
  assert.equal(r.status, status, `${label}: ${JSON.stringify(r.json)}`);
  assert.equal(r.json?.success, false, label);
  assert.equal(r.json?.code, expected, label);
  assert.equal(typeof r.json?.error, 'string', label);
  if (r.json?.params !== undefined) {
    const tpl = errorTemplate(expected);
    assert.ok(tpl, label);
    for (const p of placeholders(tpl)) assert.ok(p in r.json.params, `${label}: params.${p}`);
  }
}

describe('106 server error codes (W15-3)', () => {
  let h: Harness;

  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  lotIt('W15-3', '106.1 every AppError thrown by a service carries a catalogue code', () => {
    const files = tsFiles('server/src/services');
    assert.ok(files.length > 20, 'service files found');
    const bare: string[] = [];
    const unknown: string[] = [];
    for (const f of files) {
      const src = code(f);
      if (/\bnew AppError\(/.test(src)) bare.push(f);
      // codedError(status, 'CODE', ...) and AgentKeyError(status, message, 'CODE')
      for (const m of src.matchAll(/codedError\(\s*[^,]+,\s*'([^']+)'/g)) {
        if (!CODE_VALUES.has(m[1])) unknown.push(`${f}: ${m[1]}`);
      }
      for (const m of src.matchAll(/new AgentKeyError\(\s*\d+,\s*(?:'[^']*'|`[^`]*`),\s*'([^']+)'/g)) {
        if (!CODE_VALUES.has(m[1])) unknown.push(`${f}: ${m[1]}`);
      }
    }
    assert.deepEqual(bare, [], 'services throw codedError(...), not a bare AppError');
    assert.deepEqual(unknown, [], 'codes outside the catalogue');
    // Every AgentKeyError carries a code.
    const keys = code('server/src/services/agentKey.service.ts');
    const thrown = [...keys.matchAll(/new AgentKeyError\(([^;]*)\);/g)].map((m) => m[1]);
    assert.ok(thrown.length >= 5, 'AgentKeyError throw sites');
    for (const args of thrown) assert.match(args, /,\s*'[A-Z_]+'/, `AgentKeyError(${args}) has a code`);
  });

  lotIt('W15-3', '106.2 catalogue consistency; codedError keeps status and message', () => {
    const names = Object.keys(ERROR_CATALOGUE);
    const values = Object.values(ERROR_CATALOGUE).map((e) => e.code);
    assert.equal(new Set(values).size, values.length, 'code values are unique');
    for (const [name, e] of Object.entries(ERROR_CATALOGUE)) {
      assert.match(name, /^[A-Z][A-Z0-9_]*$/, `name ${name}`);
      assert.match(e.code, /^[A-Za-z][A-Za-z0-9_]{0,63}$/, `code ${e.code}`);
      assert.ok(e.en.trim().length > 0, `template of ${name}`);
      assert.equal(ERROR_CODES[name as keyof typeof ERROR_CODES], e.code, `ERROR_CODES.${name}`);
      // New codes are UPPER_SNAKE and named after their value.
      if (/^[A-Z][A-Z0-9_]*$/.test(e.code)) assert.equal(e.code, name, `UPPER_SNAKE code ${e.code} is its own name`);
      assert.equal(errorTemplate(e.code), e.en);
    }
    assert.ok(names.includes('BAN_TARGET_TOO_WIDE') && names.includes('TENANT_HAS_AGENTS') && names.includes('VALIDATION'));
    assert.equal(errorTemplate('NO_SUCH_CODE'), null);

    const err = codedError(409, 'IP_ALREADY_BANNED', 'This IP is already banned');
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 409);
    assert.equal(err.message, 'This IP is already banned');
    assert.equal(err.code, 'IP_ALREADY_BANNED');
    assert.equal(err.params, undefined, 'no params when none given');
    const withParams = codedError(400, 'FIELD_TOO_LONG', 'name must be at most 5 characters', { field: 'name', max: 5 });
    assert.deepEqual(withParams.params, { field: 'name', max: 5 });
    assert.equal(codedError(400, 'BAN_IP_REQUIRED', 'x', {}).params, undefined, 'an empty params object is dropped');
  });

  lotIt('W15-3', '106.3 HTTP refusals carry their code, status and English text unchanged', async () => {
    const def = await h.adminIn(1);
    const t2 = await h.adminIn(2);

    // Ban target too broad (400) — the floor fills the translation.
    const wide = await def.post('/api/bans', { ip: '8.0.0.0/8' });
    assertCoded(wide, 400, 'BAN_TARGET_TOO_WIDE', 'too broad');
    assert.match(String(wide.json.error), /too broad/i);
    if (wide.json.params !== undefined) {
      assert.deepEqual(wide.json.params, { prefix: banPrefixFloor().v4, family: 4 });
    }
    const invalid = await def.post('/api/bans', { ip: 'not-an-ip' });
    assertCoded(invalid, 400, 'BAN_TARGET_INVALID', 'invalid target');

    // Duplicate ban (409).
    const ip = nextIp();
    assert.equal((await def.post('/api/bans', { ip })).status, 201);
    const dup = await def.post('/api/bans', { ip });
    assertCoded(dup, 409, 'IP_ALREADY_BANNED', 'duplicate ban');
    assert.equal(dup.json.error, 'This IP is already banned');

    // Duplicate whitelist entry in the same scope (409).
    const wip = nextIp();
    assert.equal((await t2.post('/api/whitelist', { ip: wip })).status, 201);
    const wdup = await t2.post('/api/whitelist', { ip: wip });
    assertCoded(wdup, 409, 'WHITELIST_DUPLICATE', 'duplicate whitelist');
    assert.equal(wdup.json.error, 'This address is already whitelisted in this scope');

    // Rate limit policies: global outside Default (403), unknown id (404).
    const glob = await t2.post('/api/rate-limit-policies', { type: 'connection', scope: 'global', maxValue: 106_001 });
    assertCoded(glob, 403, 'RATE_LIMIT_GLOBAL_DEFAULT_TENANT_ONLY', 'global policy outside Default');
    const missing = await def.del('/api/rate-limit-policies/999999');
    assertCoded(missing, 404, 'RATE_LIMIT_POLICY_NOT_FOUND', 'unknown policy');
    assert.equal(missing.json.error, 'Rate limit policy not found');
    const range = await def.post('/api/rate-limit-policies', { type: 'connection', scope: 'global', maxValue: 0 });
    assertCoded(range, 400, 'RATE_LIMIT_MAX_VALUE_INVALID', 'maxValue out of range');
  });

  lotIt('W15-3', '106.4 the client translates errors.<code> with the server text as fallback', () => {
    const src = code('client/src/api/client.ts');
    assert.match(src, /export function localizeApiError\(/);
    assert.match(src, /`errors\.\$\{code\}`/, 'errors.<code> key');
    assert.match(src, /i18n\.exists\(/, 'only a known key replaces the server text');
    // Applied in the response interceptor, before the step-up / 401 handling.
    const interceptor = src.slice(src.indexOf('apiClient.interceptors.response.use('));
    assert.ok(interceptor.length > 0);
    const call = interceptor.indexOf('translateErrorBody(error.response?.data)');
    assert.ok(call > 0, 'interceptor translates the body');
    assert.ok(call < interceptor.indexOf('TWO_FACTOR_REQUIRED'), 'before the early returns');
    // The English text stays available.
    assert.match(src, /serverError/);
    // Placeholder values never become t() options (lng / ns / context...).
    assert.match(src, /replace:\s*vars/, 'params interpolated through `replace`');
    assert.doesNotMatch(src, /i18n\.t\(key,\s*\{\s*\.\.\.vars/, 'body fields are not spread as t() options');
  });

  lotIt('W15-3', '106.5 every catalogue code is translated in en and fr with the same placeholders', () => {
    const locale = (lng: string) => JSON.parse(read(`client/src/i18n/locales/${lng}/translation.json`)) as
      { errors?: Record<string, unknown> };
    const en = locale('en').errors;
    const fr = locale('fr').errors;
    assert.ok(en && typeof en === 'object' && fr && typeof fr === 'object', 'top-level `errors` object in en and fr');
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const e of Object.values(ERROR_CATALOGUE)) {
      const want = placeholders(e.en).join(',');
      for (const [lng, dict] of [['en', en], ['fr', fr]] as const) {
        const text = dict[e.code];
        if (typeof text !== 'string' || !text.trim()) { missing.push(`${lng}:${e.code}`); continue; }
        if (placeholders(text).join(',') !== want) mismatched.push(`${lng}:${e.code}`);
      }
    }
    assert.deepEqual(missing, [], 'errors.<code> keys missing');
    assert.deepEqual(mismatched, [], 'placeholders differ from the catalogue template');
  });
});
