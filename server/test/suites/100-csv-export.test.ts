/**
 * 100 — W14-3 CSV exports (UI-PAGES-IPS-20): GET /api/ip-reputation/export,
 * /api/bans/export, /api/whitelist/export and /api/ip-events/export.
 *
 *   100.1 csvField / toCsv: RFC 4180 quoting, formula neutralisation (= + - @
 *         tab CR), numbers kept, BOM + CRLF document
 *   100.2 ip-events: tenant scoped (tenant 2 never reads tenant 3, Default
 *         reads both, ?tenants= narrows), team scoped, formula cells escaped,
 *         ?anon=1 masks the address / username / raw log, audited
 *   100.3 bans: global + own bans only outside Default, team scope hides the
 *         group bans of ungranted agents, the reason is formula-safe
 *   100.4 whitelist: another tenant's entries never leak, labels formula-safe
 *   100.5 ip-reputation: rows follow the tenant's events, usernames escaped
 *   100.6 cap: 50 001 matching events export 50 000 rows with X-Truncated
 *   100.7 every export needs a session (401) and rejects invalid filters (400)
 *   100.8 client: the four lists export through the server route + saveBlob
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness, Client, Res } from '../harness';
import { lotIt } from '../lots';
import { D, G } from '../fixtures';
import { createDevice, createGroup, createUser, insertBan, insertWhitelist, nextIp } from '../seed';
import { CSV_EXPORT_MAX, csvField, toCsv } from '../../src/utils/csv';

const REPO = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const SERVICE = 'custom:csv-export';
const FORMULA_USER = `=HYPERLINK("http://evil.test","x")`;
const FORMULA_LOG = '@SUM(1+1)*cmd';

/** RFC 4180 parser (quoted fields, doubled quotes, CRLF rows); drops the BOM. */
function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && s[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** The CSV rows of a response as objects keyed by header. */
function records(res: Res): Array<Record<string, string>> {
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.match(String(res.headers['content-type']), /^text\/csv/);
  assert.match(String(res.headers['content-disposition']), /^attachment; filename="obliguard-[a-z-]+-[0-9-]+\.csv"$/);
  assert.ok(res.text.startsWith('﻿'), 'UTF-8 BOM');
  const [header, ...rows] = parseCsv(res.text);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

describe('100 CSV exports (W14-3)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  let seq = 0;
  /** A tenant-2 user restricted by a team grant on `groupId`. */
  async function restrictedUser(groupId: number): Promise<Client> {
    const u = await createUser(h.db, { tenants: [2] });
    const [t] = await h.db('user_teams')
      .insert({ name: `t100-${Date.now()}-${++seq}`, tenant_id: 2, can_create: false })
      .returning('id') as Array<{ id: number }>;
    await h.db('team_memberships').insert({ team_id: t.id, user_id: u.id });
    await h.db('team_permissions').insert({ team_id: t.id, scope: 'group', scope_id: groupId, level: 'ro' });
    return h.login(u.username);
  }

  async function events(deviceId: number, tenantId: number, ip: string, n = 1): Promise<void> {
    await h.db('ip_events').insert(Array.from({ length: n }, () => ({
      device_id: deviceId, tenant_id: tenantId, ip, username: FORMULA_USER, service: SERVICE,
      event_type: 'auth_failure', timestamp: new Date(), raw_log: FORMULA_LOG, track_only: false,
    })));
  }

  lotIt('W14-3', '100.1 csvField / toCsv quote, neutralise formulas and keep numbers', () => {
    assert.equal(csvField('=1+1'), `'=1+1`);
    assert.equal(csvField('+cmd'), `'+cmd`);
    assert.equal(csvField('-2+3'), `'-2+3`);
    assert.equal(csvField('@SUM(A1)'), `'@SUM(A1)`);
    assert.equal(csvField('\tx'), `'\tx`);
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
    assert.equal(csvField('=a,"b"'), `"'=a,""b"""`);
    assert.equal(csvField('line\nbreak'), '"line\nbreak"');
    assert.equal(csvField(-5), '-5', 'a negative number is not a formula');
    assert.equal(csvField(null), '');
    assert.equal(csvField(true), 'true');
    assert.equal(toCsv(['A', 'B'], [[1, '=x']]), `A,B\r\n1,'=x\r\n`);
    assert.equal(CSV_EXPORT_MAX, 50_000);
  });

  lotIt('W14-3', '100.2 ip-events export: tenant + team scope, formula-safe, anonymised, audited', async () => {
    const ipB = nextIp();
    const ipC = nextIp();
    await events(D.B.id, 2, ipB, 2);
    await events(D.C.id, 3, ipC, 1);

    const mb = await h.as('member_b');
    const own = records(await mb.get(`/api/ip-events/export?service=${encodeURIComponent(SERVICE)}`));
    const ips = new Set(own.map((r) => r.IP));
    assert.ok(ips.has(ipB), 'own events exported');
    assert.ok(!ips.has(ipC), 'tenant 3 events never reach tenant 2');
    const row = own.find((r) => r.IP === ipB)!;
    assert.equal(row.Username, `'${FORMULA_USER}`, 'username formula neutralised');
    assert.equal(row['Raw log'], `'${FORMULA_LOG}`, 'raw log formula neutralised');
    assert.equal(row.Agent, D.B.hostname);
    assert.equal(row['Agent ID'], String(D.B.id));

    // The export follows the list filters.
    const one = records(await mb.get(`/api/ip-events/export?ip=${ipB}`));
    assert.equal(one.length, 2);
    // ?tenants= is ignored outside Default.
    assert.equal(records(await mb.get(`/api/ip-events/export?ip=${ipC}&tenants=3`)).length, 0);

    // Default (god view) reads both, narrowed by ?tenants=.
    const dm = await h.as('default_member');
    const god = records(await dm.get(`/api/ip-events/export?service=${encodeURIComponent(SERVICE)}`));
    assert.ok(god.some((r) => r.IP === ipB) && god.some((r) => r.IP === ipC));
    const narrowed = records(await dm.get(`/api/ip-events/export?service=${encodeURIComponent(SERVICE)}&tenants=3`));
    assert.ok(narrowed.length > 0 && narrowed.every((r) => r.Tenant === narrowed[0].Tenant) && !narrowed.some((r) => r.IP === ipB));

    // Team scope: an agent outside the grant is left out.
    const hidden = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: G.B_EVAL });
    const shown = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: G.B });
    const ipT = nextIp();
    await events(hidden.id, 2, ipT);
    await events(shown.id, 2, ipT);
    const rc = await restrictedUser(G.B);
    const team = records(await rc.get(`/api/ip-events/export?ip=${ipT}`));
    assert.deepEqual(team.map((r) => Number(r['Agent ID'])), [shown.id]);
    assert.equal(records(await mb.get(`/api/ip-events/export?ip=${ipT}`)).length, 2, 'an unrestricted member sees both');

    // Anonymous mode masks the address, the username and the raw log.
    const anon = records(await mb.get(`/api/ip-events/export?ip=${ipB}&anon=1`));
    assert.equal(anon.length, 2);
    assert.notEqual(anon[0].IP, ipB);
    assert.match(anon[0].IP, /^\d+\.•+\.•+\.•+$/);
    assert.ok(!anon[0].Username.includes('HYPERLINK'));
    assert.ok(!anon[0]['Raw log'].includes('SUM'));
    assert.ok(!anon[0].Agent.includes(D.B.hostname.slice(3)), 'hostname masked');

    // Audited in the operating tenant.
    const audit = await h.db('audit_logs').where({ action: 'ip_events.exported', tenant_id: 2 }).orderBy('id', 'desc').first() as
      { details: Record<string, unknown> | string | null; user_id: number | null } | undefined;
    assert.ok(audit, 'ip_events.exported audit row');
    const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    assert.equal(details?.truncated, false);
    assert.equal(typeof details?.rows, 'number');
  });

  lotIt('W14-3', '100.3 bans export: visibility, team scope, formula-safe reason', async () => {
    const ownIp = nextIp();
    const foreignIp = nextIp();
    const globalIp = nextIp();
    const own = await insertBan(h.db, { ip: ownIp, scope: 'tenant', tenantId: 2, originTenantId: 2 });
    await insertBan(h.db, { ip: foreignIp, scope: 'tenant', tenantId: 3, originTenantId: 3 });
    await insertBan(h.db, { ip: globalIp, scope: 'global' });
    await h.db('ip_bans').where({ id: own }).update({ reason: '+1+1 attacker' });

    const res = await (await h.as('member_b')).get('/api/bans/export?state=active');
    assert.equal(res.headers['x-truncated'], 'false');
    const rows = records(res);
    const ips = rows.map((r) => r.IP);
    assert.ok(ips.includes(ownIp) && ips.includes(globalIp));
    assert.ok(!ips.includes(foreignIp), 'tenant 3 ban never exported to tenant 2');
    assert.equal(rows.find((r) => r.IP === ownIp)!.Reason, `'+1+1 attacker`);
    assert.equal(rows.find((r) => r.IP === ownIp)!.State, 'active');
    // The cap / filename headers stay readable by a cross-origin client.
    assert.match(String(res.headers['access-control-expose-headers']), /X-Truncated/);

    // Anonymous mode masks the addresses and the agent named by an agent-scoped ban.
    const agentIp = nextIp();
    await insertBan(h.db, { ip: agentIp, scope: 'agent', scopeId: D.B.id, tenantId: 2, originTenantId: 2 });
    const anonRows = records(await (await h.as('member_b')).get('/api/bans/export?state=active&anon=1'));
    assert.ok(anonRows.length > 0 && !anonRows.some((r) => r.IP === ownIp || r.IP === agentIp), 'addresses masked');
    const agentRow = anonRows.find((r) => r.Scope === 'agent');
    assert.ok(agentRow, 'agent-scoped ban exported');
    assert.ok(!agentRow['Scope target'].includes(D.B.hostname.slice(3)), 'agent name masked');

    // Default reads every tenant; ?tenants=3 keeps tenant 3's rows.
    const god = records(await (await h.as('default_member')).get('/api/bans/export?state=active&tenants=3')).map((r) => r.IP);
    assert.ok(god.includes(foreignIp) && !god.includes(ownIp));

    // Team scope: group bans of an ungranted group are hidden.
    const g = await createGroup(h.db, { tenantId: 2 });
    const other = await createGroup(h.db, { tenantId: 2 });
    // The team scope is resolved through the agents of the granted groups.
    await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: g });
    await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: other });
    const inIp = nextIp();
    const outIp = nextIp();
    await insertBan(h.db, { ip: inIp, scope: 'group', scopeId: g, tenantId: 2, originTenantId: 2 });
    await insertBan(h.db, { ip: outIp, scope: 'group', scopeId: other, tenantId: 2, originTenantId: 2 });
    const team = records(await (await restrictedUser(g)).get('/api/bans/export')).map((r) => r.IP);
    assert.ok(team.includes(inIp) && !team.includes(outIp));

    // Filters are validated like the list.
    assert.equal((await (await h.as('member_b')).get('/api/bans/export?state=nope')).status, 400);
    assert.ok(await h.db('audit_logs').where({ action: 'bans.exported', tenant_id: 2 }).first());
  });

  lotIt('W14-3', '100.4 whitelist export: no foreign entries, formula-safe labels', async () => {
    const own = await insertWhitelist(h.db, { ip: '192.0.2.64/28', scope: 'tenant', tenantId: 2 });
    await insertWhitelist(h.db, { ip: '192.0.2.80/28', scope: 'tenant', tenantId: 3 });
    await h.db('ip_whitelist').where({ id: own }).update({ label: '-2+3 office' });

    const rows = records(await (await h.as('member_b')).get('/api/whitelist/export'));
    const ips = rows.map((r) => r['IP / range']);
    assert.ok(ips.includes('192.0.2.64/28'));
    assert.ok(!ips.includes('192.0.2.80/28'), 'tenant 3 entry never exported to tenant 2');
    assert.equal(rows.find((r) => r['IP / range'] === '192.0.2.64/28')!.Label, `'-2+3 office`);

    const god = records(await (await h.as('default_member')).get('/api/whitelist/export?tenants=3')).map((r) => r['IP / range']);
    assert.ok(god.includes('192.0.2.80/28') && !god.includes('192.0.2.64/28'));
    const anon = records(await (await h.as('member_b')).get('/api/whitelist/export?search=192.0.2.64%2F28&anon=1'));
    assert.ok(anon.length > 0 && anon.every((r) => r['IP / range'].endsWith('/28') && !r['IP / range'].includes('.64')));
    assert.ok(await h.db('audit_logs').where({ action: 'whitelist.exported', tenant_id: 2 }).first());
  });

  lotIt('W14-3', '100.5 ip-reputation export follows the tenant events, usernames escaped', async () => {
    const ipB = nextIp();
    const ipC = nextIp();
    await events(D.B.id, 2, ipB);
    await events(D.C.id, 3, ipC);
    const now = new Date();
    await h.db('ip_reputation').insert([ipB, ipC].map((ip) => ({
      ip, total_failures: 3, affected_agents_count: 1, affected_services: [SERVICE],
      attempted_usernames: [FORMULA_USER, 'root'], first_seen: now, last_seen: now,
    })));

    const mb = await h.as('member_b');
    const rowsB = records(await mb.get(`/api/ip-reputation/export?search=${ipB}`));
    assert.equal(rowsB.length, 1);
    assert.equal(rowsB[0].IP, ipB);
    assert.ok(rowsB[0].Usernames.startsWith(`'=`), 'joined usernames starting with = are neutralised');
    assert.equal(records(await mb.get(`/api/ip-reputation/export?search=${ipC}`)).length, 0, 'tenant 3 IP never exported to tenant 2');

    const dm = await h.as('default_member');
    assert.equal(records(await dm.get(`/api/ip-reputation/export?search=${ipC}`)).length, 1);
    assert.equal(records(await dm.get(`/api/ip-reputation/export?search=${ipC}&tenants=2`)).length, 0);
    assert.ok(await h.db('audit_logs').where({ action: 'ip_reputation.exported', tenant_id: 2 }).first());
  });

  lotIt('W14-3', '100.6 a capped export returns 50 000 rows and X-Truncated: true', async () => {
    const ip = nextIp();
    const service = 'custom:csv-cap';
    await h.db.raw(
      `INSERT INTO ip_events (device_id, tenant_id, ip, username, service, event_type, timestamp, raw_log, track_only)
       SELECT ?, 3, ?::inet, 'u', ?, 'auth_success', NOW() - (g || ' seconds')::interval, 'x', false
       FROM generate_series(1, ?) AS g`,
      [D.C.id, ip, service, CSV_EXPORT_MAX + 1],
    );
    try {
      const mc = await h.as('member_c');
      const res = await mc.get(`/api/ip-events/export?service=${encodeURIComponent(service)}`, { timeoutMs: 120_000 });
      assert.equal(res.headers['x-truncated'], 'true');
      assert.equal(res.headers['x-export-rows'], String(CSV_EXPORT_MAX));
      const lines = res.text.split('\r\n').filter((l) => l !== '');
      assert.equal(lines.length, CSV_EXPORT_MAX + 1, 'header + 50 000 rows');

      // Another tenant gets none of them, and no truncation.
      const other = await (await h.as('member_b')).get(`/api/ip-events/export?service=${encodeURIComponent(service)}`);
      assert.equal(other.headers['x-truncated'], 'false');
      assert.equal(records(other).length, 0);
    } finally {
      await h.db('ip_events').where({ service }).del();
    }
  });

  lotIt('W14-3', '100.7 exports need a session and validate filters', async () => {
    const anon = h.anon();
    for (const p of ['/api/ip-reputation/export', '/api/bans/export', '/api/whitelist/export', '/api/ip-events/export']) {
      assert.equal((await anon.get(p)).status, 401, p);
    }
    const mb = await h.as('member_b');
    assert.equal((await mb.get('/api/ip-events/export?from=garbage')).status, 400);
    assert.equal((await mb.get('/api/ip-events/export?deviceId=abc')).status, 400);
    assert.equal((await mb.get('/api/whitelist/export?scopeId=-1')).status, 400);
    // Not mistaken for an address by the /:ip routes.
    assert.match(String((await mb.get('/api/ip-reputation/export')).headers['content-type']), /^text\/csv/);
  });

  lotIt('W14-3', '100.8 client: the four lists export through the server route with saveBlob', () => {
    const pages: Array<[string, string]> = [
      ['client/src/pages/ipReputation/ActivityTab.tsx', '/ip-reputation/export'],
      ['client/src/pages/ipReputation/BansTab.tsx', '/bans/export'],
      ['client/src/pages/ipReputation/WhitelistTab.tsx', '/whitelist/export'],
      ['client/src/pages/LiveEventsPage.tsx', '/ip-events/export'],
    ];
    // W14-5: the helper (blob fetch, anon forward, X-Truncated, saveBlob) lives
    // once in utils/download.ts; each page calls it with its route.
    const dl = read('client/src/utils/download.ts');
    assert.match(dl, /export async function downloadCsvExport\(/, 'downloadCsvExport exported by utils/download');
    assert.match(dl, /saveBlob\(/, 'the export saves through saveBlob');
    assert.match(dl, /responseType: 'blob'/, 'the CSV is fetched as a blob');
    assert.match(dl, /isAnonymous\(\)[^\n]*anon/, 'anonymous mode is forwarded');
    assert.match(dl, /x-truncated/, 'a capped export is reported');
    for (const [file, route] of pages) {
      const src = read(file);
      assert.ok(src.includes(`downloadCsvExport('${route}'`), `${file} exports through downloadCsvExport('${route}')`);
      assert.match(src, /import \{[^}]*\bdownloadCsvExport\b[^}]*\} from '@\/utils\/download'/, `${file} imports the helper from utils/download`);
      assert.match(src, /r\.truncated/, `${file} reports a capped export`);
      assert.ok(!/URL\.createObjectURL/.test(src), `${file}: no hand-made object URL`);
    }
  });
});
