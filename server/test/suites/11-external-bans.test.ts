/**
 * 11 — cross-suite external bans (Obligate delegation tokens, JWKS).
 * Every request mints a fresh token (new jti). Defaults keep exp - iat <= 300
 * (A11-2's lifetime cap).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import type { MintOpts } from '../fakeObligate';
import { nextIp } from '../seed';

describe('11 external bans', () => {
  let h: Harness;
  before(async () => { h = await startHarness({ obligate: true }); });
  after(async () => { await h.close(); });

  const bearer = (o: MintOpts, x?: { foreignKey?: boolean; tamper?: 'bitflip' }) =>
    ({ authorization: `Bearer ${h.obligate!.mintDelegation(o, x)}` });
  const app = { sub: 'app:oblihub' };
  const rowsFor = (ip: string) => h.db('ip_bans').whereRaw('host(ip) = ?', [ip]);

  it('11.1 bearer required; an app token pings [BASELINE]', async () => {
    const r = await h.anon().post('/api/external-bans', { ip: nextIp() });
    assert.equal(r.status, 401);
    assert.equal(r.json?.code, 'missing_bearer');
    const p = await h.anon().get('/api/external-bans/ping', { headers: bearer(app) });
    assert.equal(p.status, 200);
    assert.equal(p.json.data.sourceApp, 'oblihub');
    assert.equal(p.json.data.allowed, true);
  });

  it('11.2 token refusals [BASELINE]', async () => {
    const cases: Array<[string, MintOpts, { foreignKey?: boolean; tamper?: 'bitflip' } | undefined, number, string]> = [
      ['user token', { sub: '42' }, undefined, 403, 'user_token_refused'],
      ['wrong audience', { sub: 'app:oblihub', aud: 'obliview' }, undefined, 403, 'wrong_audience'],
      ['unknown kid', app, { foreignKey: true }, 401, 'kid_unknown'],
      ['expired', { sub: 'app:oblihub', iatOffsetSec: -400, expOffsetSec: -100 }, undefined, 401, 'expired'],
      ['not yet valid', { sub: 'app:oblihub', nbfOffsetSec: 200, expOffsetSec: 280 }, undefined, 401, 'not_yet_valid'],
      ['bad signature', app, { tamper: 'bitflip' }, 401, 'bad_signature'],
    ];
    for (const [label, o, x, status, code] of cases) {
      const r = await h.anon().get('/api/external-bans/ping', { headers: bearer(o, x) });
      assert.equal(r.status, status, label);
      assert.equal(r.json?.code, code, label);
    }
    const ip = nextIp();
    const e = await h.anon().post('/api/external-bans', { ip }, { headers: bearer({ sub: 'app:evilapp' }) });
    assert.equal(e.status, 403);
    assert.equal(e.json?.code, 'source_app_not_allowed');
    assert.equal((await rowsFor(ip)).length, 0);
  });

  lotIt('D4', '11.3 external ban create / refresh / withdraw', async () => {
    const ip = nextIp();
    const until = new Date(Date.now() + 3600_000).toISOString();
    const a = await h.anon().post('/api/external-bans', { ip, banned_until: until }, { headers: bearer(app) });
    assert.equal(a.status, 201);
    assert.equal(a.json.data.isNew, true);
    let rows = await rowsFor(ip).where({ is_active: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ban_type, 'external');
    assert.equal(rows[0].scope, 'global');
    assert.equal(rows[0].origin_app, 'oblihub');
    assert.equal(rows[0].tenant_id, null);
    const b = await h.anon().post('/api/external-bans', { ip, banned_until: until }, { headers: bearer(app) });
    assert.equal(b.status, 200);
    assert.equal(b.json.data.isNew, false);
    rows = await rowsFor(ip).where({ is_active: true });
    assert.equal(rows.length, 1);
    const d = await h.anon().del(`/api/external-bans/${encodeURIComponent(ip)}`, undefined, { headers: bearer(app) });
    assert.equal(d.status, 200);
    assert.equal(d.json.data.deleted, 1);
    assert.equal((await rowsFor(ip).where({ is_active: true })).length, 0);
  });

  lotIt('D4', '11.4 external bans use the shared ban-target validator', async () => {
    for (const ip of ['not-an-ip', '10.0.0.0/8', '127.0.0.1']) {
      const before = Number((await h.db('ip_bans').count<{ c: string }[]>({ c: '*' }))[0].c);
      const r = await h.anon().post('/api/external-bans', { ip }, { headers: bearer(app) });
      assert.ok([400, 422].includes(r.status), `${ip}: ${r.status}`);
      assert.equal(Number((await h.db('ip_bans').count<{ c: string }[]>({ c: '*' }))[0].c), before, ip);
    }
  });

  lotIt('A11', '11.5 delegation hardening: replay, lifetime cap, typ', async () => {
    const token = h.obligate!.mintDelegation(app);
    const ip = nextIp();
    const headers = { authorization: `Bearer ${token}` };
    await h.anon().del(`/api/external-bans/${ip}`, undefined, { headers });
    const replay = await h.anon().del(`/api/external-bans/${ip}`, undefined, { headers });
    assert.equal(replay.status, 401);
    assert.equal(replay.json?.code, 'replayed');
    const long = await h.anon().get('/api/external-bans/ping', { headers: bearer({ sub: 'app:oblihub', expOffsetSec: 3600 }) });
    assert.equal(long.status, 401);
    assert.equal(long.json?.code, 'lifetime_excessive');
    const noTyp = await h.anon().get('/api/external-bans/ping', { headers: bearer({ sub: 'app:oblihub', typ: null }) });
    assert.equal(noTyp.status, 401);
  });
});
