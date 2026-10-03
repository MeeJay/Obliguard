/**
 * 102 — W14-4 release tooling, container hardening, dependency checks and
 * documentation (backlog C21-1, B14, D21; static checks, no database).
 *
 *   102.1 server image: production stage runs as `node`, no SSH client, no
 *         root entrypoint, production dependencies only, installed from the
 *         root lockfile, healthcheck on /health
 *   102.2 client image: static nginx stage (no Node.js), runs as `nginx`
 *         with cap_net_bind_service for port 80, pid file and cache paths
 *         writable by it, healthcheck present, lockfile used by the builder
 *   102.3 root `npm run audit`: npm audit --omit=dev over the workspaces,
 *         then govulncheck in agent/ when installed (skipped with a message
 *         otherwise); no stray root runtime dependency
 *   102.4 client/package.json: every runtime dependency is imported, type
 *         packages are devDependencies
 *   102.5 CLAUDE.md migration list = the migration files (when present:
 *         *.md files are local-only per .gitignore)
 *   102.6 docs/security.md names every STEP_UP_ACTIONS entry (when present)
 *   102.7 000-RegularUpdate.bat (owner script, untracked: when present):
 *         CRLF, version guard before each `git add -A`, deletion
 *         confirmation after it, earlier go test / manifest checks kept, the
 *         guard's inline node free of cmd-sensitive characters
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const abs = (rel: string) => path.join(REPO, rel);
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');
const exists = (rel: string) => fs.existsSync(abs(rel));

/** STEP_UP_ACTIONS read from the source (no service import: this suite needs no database). */
function stepUpActions(): string[] {
  const m = read('server/src/services/stepUp.service.ts').match(/export const STEP_UP_ACTIONS = \[([\s\S]*?)\] as const;/);
  assert.ok(m, 'STEP_UP_ACTIONS found');
  const list = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(list.length >= 10, 'STEP_UP_ACTIONS parsed');
  return list;
}

/** Dockerfile instructions (comments dropped, `\` continuations joined). */
function instructions(rel: string): string[] {
  return read(rel)
    .replace(/\r\n/g, '\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Instructions of the LAST stage (the image that ships). */
function finalStage(rel: string): string[] {
  const all = instructions(rel);
  let start = -1;
  all.forEach((l, i) => { if (/^FROM\s/i.test(l)) start = i; });
  assert.ok(start >= 0, `${rel}: no FROM`);
  return all.slice(start);
}

/** Instructions of the stage named `name`. */
function stage(rel: string, name: string): string[] {
  const all = instructions(rel);
  const start = all.findIndex((l) => new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}$`, 'i').test(l));
  assert.ok(start >= 0, `${rel}: stage ${name} not found`);
  const next = all.findIndex((l, i) => i > start && /^FROM\s/i.test(l));
  return all.slice(start, next < 0 ? undefined : next);
}

describe('102 release tooling and container hardening (W14-4)', () => {
  lotIt('W14-4', '102.1 server image runs unprivileged with production dependencies only', () => {
    const prod = finalStage('server/Dockerfile');
    assert.match(prod[0], /^FROM\s+node:\S+-alpine\s+AS\s+production$/i, 'minimal node alpine production stage');
    const users = prod.filter((l) => /^USER\s/i.test(l));
    assert.deepEqual(users, ['USER node'], 'production stage switches to the node user');
    const userAt = prod.indexOf('USER node');
    // Nothing after USER needs root: no RUN / COPY may follow it.
    assert.ok(!prod.slice(userAt + 1).some((l) => /^(RUN|COPY|ADD)\s/i.test(l)), 'no RUN/COPY after USER node');
    assert.ok(!prod.some((l) => /openssh|apk add/i.test(l)), 'no extra packages (openssh-client dropped)');
    assert.ok(!prod.some((l) => /^ENTRYPOINT\s/i.test(l)), 'no root entrypoint script');
    assert.ok(!prod.some((l) => /entrypoint\.sh/.test(l)), 'docker-entrypoint.sh not shipped');
    const installs = prod.filter((l) => /npm (install|ci)\b/.test(l));
    assert.ok(installs.length > 0, 'production dependencies installed');
    for (const l of installs) assert.match(l, /--omit=dev/, `production install omits dev dependencies: ${l}`);
    assert.ok(prod.some((l) => /^COPY\s.*package-lock\.json/.test(l)), 'production install uses the root lockfile');
    assert.ok(stage('server/Dockerfile', 'builder').some((l) => /^COPY\s.*package-lock\.json/.test(l)), 'builder uses the root lockfile');
    const hc = prod.find((l) => /^HEALTHCHECK\s/i.test(l));
    assert.ok(hc && /\/health\b/.test(hc), 'healthcheck on /health');
    assert.match(prod[prod.length - 1], /^CMD\s+\["node",\s*"dist\/src\/index\.js"\]$/, 'starts the compiled server');
  });

  lotIt('W14-4', '102.2 client image is static nginx running as nginx', () => {
    const prod = finalStage('client/Dockerfile');
    assert.match(prod[0], /^FROM\s+nginx:\S*alpine\S*\s+AS\s+production$/i, 'nginx alpine production stage');
    assert.ok(!prod.some((l) => /\bnpm\b|\bnode\b(?!_)/.test(l.replace(/node_modules/g, ''))), 'no Node.js in the served image');
    assert.deepEqual(prod.filter((l) => /^USER\s/i.test(l)), ['USER nginx'], 'runs as nginx');
    const userAt = prod.indexOf('USER nginx');
    assert.ok(!prod.slice(userAt + 1).some((l) => /^(RUN|COPY|ADD)\s/i.test(l)), 'no RUN/COPY after USER nginx');
    const setup = prod.slice(0, userAt).join('\n');
    assert.match(setup, /setcap\s+'?cap_net_bind_service=\+ep'?\s+\/usr\/sbin\/nginx/, 'port 80 kept through cap_net_bind_service');
    assert.match(setup, /pid \/tmp\/nginx\.pid/, 'pid file moved to a writable path');
    assert.match(setup, /\/\^user \/d/, 'the master-only `user` directive is dropped');
    assert.match(setup, /chown -R nginx:nginx \/var\/cache\/nginx/, 'nginx temp paths owned by nginx');
    assert.ok(prod.some((l) => /^EXPOSE\s+80$/.test(l)), 'still serves port 80 (compose maps LISTEN_PORT:80)');
    assert.ok(prod.some((l) => /^HEALTHCHECK\s/i.test(l)), 'healthcheck present');
    assert.ok(stage('client/Dockerfile', 'builder').some((l) => /^COPY\s.*package-lock\.json/.test(l)), 'builder uses the root lockfile');
  });

  lotIt('W14-4', '102.3 root audit script covers npm workspaces and the Go agent', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
    const audit = pkg.scripts?.audit ?? '';
    assert.ok(audit, 'npm run audit exists');
    assert.match(audit, /npm',\s*\['audit','--omit=dev','--workspaces','--include-workspace-root'\]|npm audit --omit=dev --workspaces/, 'npm audit --omit=dev over the workspaces');
    assert.match(audit, /govulncheck/, 'govulncheck in the agent');
    assert.match(audit, /cwd:\s*'agent'/, 'govulncheck runs in agent/');
    assert.match(audit, /ENOENT/, 'missing govulncheck is skipped');
    assert.match(audit, /not installed/, 'the skip is announced');
    assert.match(audit, /process\.exit\(rc\)/, 'a finding fails the script');
    assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'no runtime dependency at the workspace root');
  });

  lotIt('W14-4', '102.4 client dependencies are all used, types are dev-only', () => {
    const pkg = JSON.parse(read('client/package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?|css)$/.test(e.name)) sources.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(abs('client/src'));
    for (const f of ['client/vite.config.ts', 'client/tailwind.config.ts', 'client/postcss.config.js']) {
      if (exists(f)) sources.push(read(f));
    }
    const all = sources.join('\n');
    for (const dep of Object.keys(pkg.dependencies)) {
      assert.ok(!dep.startsWith('@types/'), `${dep} belongs in devDependencies`);
      if (dep === '@obliview/shared') continue;
      const esc = dep.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      assert.match(all, new RegExp(`['"\`]${esc}(/[^'"\`]*)?['"\`]`), `client dependency ${dep} is imported somewhere`);
    }
    for (const gone of ['recharts', '@dnd-kit/sortable', '@dnd-kit/utilities']) {
      assert.ok(!(gone in pkg.dependencies), `unused ${gone} removed`);
    }
  });

  lotIt('W14-4', '102.5 CLAUDE.md lists every migration', (t) => {
    if (!exists('CLAUDE.md')) { t.skip('CLAUDE.md is local-only (.gitignore *.md)'); return; }
    const doc = read('CLAUDE.md').replace(/\r\n/g, '\n');
    const files = fs.readdirSync(abs('server/src/db/migrations')).filter((f) => /^\d{3}_.*\.ts$/.test(f)).sort();
    const listed = new Set<number>();
    for (const m of doc.matchAll(/^- (\d{3})(?:-(\d{3}))?:/gm)) {
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      for (let n = a; n <= b; n++) listed.add(n);
    }
    for (const f of files) assert.ok(listed.has(Number(f.slice(0, 3))), `CLAUDE.md lists migration ${f}`);
    const count = doc.match(/^(\d+) migrations \(/m);
    assert.ok(count, 'CLAUDE.md states the migration count');
    assert.equal(Number(count![1]), files.length, 'stated migration count matches the files');
  });

  lotIt('W14-4', '102.6 docs/security.md documents every step-up action', (t) => {
    if (!exists('docs/security.md')) { t.skip('docs/ is local-only (.gitignore)'); return; }
    const doc = read('docs/security.md');
    for (const action of stepUpActions()) assert.ok(doc.includes(`\`${action}\``), `security.md names step-up action ${action}`);
    for (const topic of ['Threat model', 'TLS', 'Secrets', 'TRUSTED_PROXIES', 'TRUSTED_PROXY_HOPS']) {
      assert.ok(doc.includes(topic), `security.md covers ${topic}`);
    }
  });

  lotIt('W14-4', '102.7 release script guards (version regression, tracked deletions)', (t) => {
    const BAT = '000-RegularUpdate.bat';
    if (!exists(BAT)) { t.skip('000-RegularUpdate.bat is the owner\'s untracked script'); return; }
    const raw = read(BAT);
    assert.ok(!/[^\r]\n/.test(raw), 'CRLF line endings only');
    const lines = raw.split('\r\n');
    const idx = (pred: (l: string) => boolean) => lines.map((l, i) => (pred(l) ? i : -1)).filter((i) => i >= 0);
    // Subroutines exist once each.
    assert.equal(idx((l) => l === ':GUARD_AGENT_VERSION').length, 1, 'version guard subroutine');
    assert.equal(idx((l) => l === ':CONFIRM_DELETIONS').length, 1, 'deletion confirmation subroutine');
    // Guard right after the branch choice, before any bump is written.
    const branch = idx((l) => l === 'set SUM_BRANCH=!BRANCH!')[0];
    const firstBump = idx((l) => l.includes("writeFileSync('./agent/VERSION'"))[0];
    const earlyGuard = idx((l) => l === 'call :GUARD_AGENT_VERSION').find((i) => i > branch && i < firstBump);
    assert.ok(earlyGuard !== undefined, 'guard runs after the branch choice and before the bump');
    // Every `git add -A` is preceded by the guard and followed by the confirmation.
    const adds = idx((l) => l === 'git add -A');
    assert.ok(adds.length >= 2, 'intermediate and final commits');
    for (const a of adds) {
      assert.ok(lines.slice(Math.max(0, a - 3), a).includes('call :GUARD_AGENT_VERSION'), `guard before git add -A (line ${a + 1})`);
      assert.equal(lines[a + 1], 'call :CONFIRM_DELETIONS', `confirmation after git add -A (line ${a + 1})`);
      assert.match(lines[a + 2], /^if !_DEL_OK! neq 1 \(.*goto :SUMMARY \)$/, 'refusal skips the commit');
    }
    // Earlier checks are kept.
    assert.ok(raw.includes('call go test -count=1 ./...'), 'go test before the bump kept');
    assert.ok(raw.includes('agent-manifest.mjs check'), 'manifest check kept');
    // The guard: HEAD and origin/<branch>, inline node without cmd-sensitive characters.
    const g = lines.indexOf(':GUARD_AGENT_VERSION');
    const body = lines.slice(g, lines.indexOf('exit /b 0', g) + 1);
    assert.ok(body.some((l) => /^git fetch -q origin !BRANCH!$/.test(l)), 'fetches origin/<branch> first');
    const nodeLine = body.find((l) => l.startsWith('node -e "'));
    assert.ok(nodeLine, 'inline node comparison');
    const js = nodeLine!.slice('node -e "'.length, nodeLine!.lastIndexOf('"'));
    for (const ch of ['!', '^', '%', '"']) assert.ok(!js.includes(ch), `guard JS has no ${ch}`);
    assert.match(js, /'HEAD','origin\/'\+b/, 'compares with HEAD and origin/<branch>');
    const c = lines.indexOf(':CONFIRM_DELETIONS');
    const conf = lines.slice(c, lines.length);
    assert.ok(conf.includes('git diff --cached --quiet --diff-filter=D'), 'detects staged deletions');
    assert.ok(conf.includes('git reset -q'), 'refusal unstages (working tree kept)');
  });
});
