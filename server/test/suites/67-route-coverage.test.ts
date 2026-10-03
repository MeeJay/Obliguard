/**
 * 67 — W7-2 route coverage: every write route of the API is listed in the
 * route-to-capability matrix (server/src/middleware/routePermissions.ts) and
 * actually guarded.
 *
 *   67.1 the express router tree is walked (tenantRouter AND the routers
 *        mounted outside it: /tenants, /permission-sets, /admin/config,
 *        /live-alerts, /oblitools, /system, /agent, ...): every non-GET route
 *        has exactly one entry, every entry names a live route
 *   67.2 entries are well-formed (known capabilities, no duplicates) and
 *        every guarded write route carries guard middleware of its own
 *   67.3 behaviour: a tenant member holding no capability gets 403 on every
 *        capability / platform route; the tenant admin gets 403 on every
 *        platform route; the platform admin operating tenant 2 gets 403 on
 *        every Default-only route; an anonymous caller gets 401 on every
 *        session route
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Knex } from 'knex';
import { startHarness } from '../harness';
import type { Harness, Client, Res } from '../harness';
import { lotIt } from '../lots';
import { ADMIN_B } from '../fixtures';
import { createUser } from '../seed';
import { routes } from '../../src/routes';
import {
  ROUTE_PERMISSIONS,
  findRoutePermission,
  guardCapabilities,
  isAccessKind,
} from '../../src/middleware/routePermissions';
import type { RoutePermission } from '../../src/middleware/routePermissions';
import { isTenantCapability, isCapabilityAlias } from '@obliview/shared';

// ── Router walk ──────────────────────────────────────────────────────────────

interface WalkedRoute {
  method: string;
  path: string;
  /** Middleware ahead of the handler: inherited router.use() layers + the route's own. */
  middleware: Array<{ name: string }>;
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { name: string } }> };
  handle: { name: string; stack?: Layer[] };
  regexp: RegExp & { fast_slash?: boolean };
}

/** Express 4 mount regexp (`^\/groups\/?(?=\/|$)`) back to its path ('/groups'). */
const MOUNT_TAIL = String.raw`\/?(?=\/|$)`;
function mountPath(layer: Layer): string {
  if (layer.regexp.fast_slash) return '';
  const src = layer.regexp.source;
  if (!src.startsWith('^') || !src.endsWith(MOUNT_TAIL)) throw new Error(`unexpected mount regexp ${src}`);
  const path = src.slice(1, -MOUNT_TAIL.length).split(String.raw`\/`).join('/');
  if (!/^(\/[\w.-]+)+$/.test(path)) throw new Error(`unexpected mount path ${path} (${src})`);
  return path;
}

function normalize(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function walk(router: { stack: Layer[] }, prefix: string, inherited: Array<{ name: string }>, out: WalkedRoute[]): void {
  const local = [...inherited];
  for (const layer of router.stack) {
    if (layer.route) {
      const own = layer.route.stack.map((l) => l.handle);
      for (const m of Object.keys(layer.route.methods)) {
        if (m === '_all') continue;
        out.push({ method: m.toUpperCase(), path: normalize(prefix + layer.route.path), middleware: [...local, ...own.slice(0, -1)] });
      }
    } else if (layer.handle.stack) {
      walk(layer.handle as { stack: Layer[] }, prefix + mountPath(layer), local, out);
    } else if (mountPath(layer) === '') {
      // router.use(fn): applies to every later layer of this router.
      local.push(layer.handle);
    }
  }
}

/** Middleware that authenticate or resolve the tenant but authorise nothing. */
const NOT_A_GUARD = new Set(['requireAuth', 'requireTenant', 'require2faSetup', 'jsonParser', 'textParser']);

const WALKED: WalkedRoute[] = [];
walk(routes as unknown as { stack: Layer[] }, '/api', [], WALKED);

const key = (method: string, path: string) => `${method} ${path}`;

// ── Probes ───────────────────────────────────────────────────────────────────

const NONE = '999999';
const concrete = (path: string) => path.replace(/:\w+/g, NONE);

function call(c: Client, e: RoutePermission): Promise<Res> {
  const path = concrete(e.path);
  switch (e.method) {
    case 'GET': return c.get(path);
    case 'POST': return c.post(path, {});
    case 'PUT': return c.put(path, {});
    case 'PATCH': return c.patch(path, {});
    case 'DELETE': return c.del(path);
  }
}

const isGuarded = (e: RoutePermission) => !isAccessKind(e.guard) || e.guard === 'platform';

/** admin_b: seeded by seed.ts once it knows ADMIN_B, created here otherwise. */
async function ensureAdminB(db: Knex): Promise<void> {
  const row = await db('users').where({ username: ADMIN_B.username }).first('id') as { id: number } | undefined;
  if (!row) {
    await createUser(db, { username: ADMIN_B.username, tenants: [ADMIN_B.tenant], tenantRole: ADMIN_B.tenantRole });
    return;
  }
  await db('user_tenants').where({ user_id: row.id, tenant_id: ADMIN_B.tenant }).update({ role: ADMIN_B.tenantRole });
}

describe('67 route coverage (W7-2)', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
    await ensureAdminB(h.db);
  });
  after(async () => { await h.close(); });

  lotIt('W7-2', '67.1 every write route has exactly one entry; every entry names a live route', () => {
    assert.ok(WALKED.length > 100, `walked only ${WALKED.length} routes`);
    // The walk reaches the routers mounted outside tenantRouter (critic C.5).
    for (const prefix of ['/api/tenants', '/api/tenant', '/api/permission-sets', '/api/admin/config', '/api/live-alerts',
      '/api/oblitools', '/api/system', '/api/agent', '/api/groups', '/api/bans', '/api/geo']) {
      assert.ok(WALKED.some((r) => r.path === prefix || r.path.startsWith(`${prefix}/`)), `no route walked under ${prefix}`);
    }

    const missing = WALKED
      .filter((r) => r.method !== 'GET' && !findRoutePermission(r.method, r.path))
      .map((r) => key(r.method, r.path));
    assert.deepEqual(missing, [], 'write routes without an entry in routePermissions.ts');

    const live = new Set(WALKED.map((r) => key(r.method, r.path)));
    const stale = ROUTE_PERMISSIONS.filter((e) => !live.has(key(e.method, e.path))).map((e) => key(e.method, e.path));
    assert.deepEqual(stale, [], 'entries without a route');
  });

  lotIt('W7-2', '67.2 entries are well-formed and guarded routes carry guard middleware', () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const e of ROUTE_PERMISSIONS) {
      const k = key(e.method, e.path);
      if (seen.has(k)) dup.push(k);
      seen.add(k);
      if (!isAccessKind(e.guard)) {
        const caps = guardCapabilities(e.guard);
        assert.ok(caps.length > 0, `${k}: empty capability list`);
        for (const c of caps) assert.ok(isTenantCapability(c) || isCapabilityAlias(c), `${k}: unknown capability ${c}`);
      } else {
        assert.ok(!e.byBody, `${k}: byBody needs capabilities`);
      }
      if (e.byBody) assert.ok(guardCapabilities(e.guard).length > 1, `${k}: byBody lists every capability it may need`);
    }
    assert.deepEqual(dup, [], 'duplicate entries');

    const unguarded = WALKED
      .filter((r) => r.method !== 'GET')
      .filter((r) => { const e = findRoutePermission(r.method, r.path); return e && isGuarded(e); })
      .filter((r) => !r.middleware.some((m) => !NOT_A_GUARD.has(m.name)))
      .map((r) => key(r.method, r.path));
    assert.deepEqual(unguarded, [], 'guarded entries whose route has no guard middleware');

    // Explicit read entries (W2 / W6 followups, critic C.5).
    assert.equal(findRoutePermission('POST', '/api/geo/batch')?.guard, 'public-read');
    assert.equal(findRoutePermission('GET', '/api/dashboard/summary')?.guard, 'public-read');
    assert.equal(findRoutePermission('GET', '/api/ip-events/stats')?.guard, 'public-read');
  });

  lotIt('W7-2', '67.3 every guarded route refuses callers that lack its guard', async () => {
    const nocap = await createUser(h.db, { tenants: [2], tenantRole: 'no-such-set' });
    const noCap = await h.login(nocap.username);
    const tenantAdmin = await h.as(ADMIN_B.username);
    const platformB = await h.adminIn(2);
    const anon = h.anon();
    const wrong: string[] = [];
    const expect = async (who: string, c: Client, e: RoutePermission, status: number) => {
      const r = await call(c, e);
      if (r.status !== status) wrong.push(`${who} ${key(e.method, e.path)}: ${r.status} (expected ${status}) ${r.text.slice(0, 100)}`);
    };

    for (const e of ROUTE_PERMISSIONS) {
      if (e.guard === 'public' || e.guard === 'self') continue;
      await expect('anonymous', anon, e, 401);
      if (isGuarded(e)) await expect('no-capability member', noCap, e, 403);
      if (e.guard === 'platform') await expect('tenant admin', tenantAdmin, e, 403);
      if (e.defaultTenantOnly) await expect('platform admin on tenant 2', platformB, e, 403);
    }
    assert.deepEqual(wrong, []);
  });
});
