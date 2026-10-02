/**
 * 46b — W2-2 Go agent update pipeline (agent side of the W2-1 contract):
 *   - one TLS policy: the WSS dial and every HTTP client of the agent go
 *     through agent/tlsconfig.go; InsecureSkipVerify only behind the explicit
 *     tlsInsecureSkipVerify / --tls-insecure opt-in;
 *   - downloads checked before install: Content-Length, X-Content-SHA256
 *     (refused on mismatch), X-Agent-Version;
 *   - the update runs in a goroutine behind an in-progress guard and reports
 *     each step with an update_status frame; the heartbeat carries
 *     capabilities;
 *   - Windows: stop through the SCM, msiexec exit code captured by the update
 *     script (old service restarted on failure), recovery actions;
 *   - installers accept TLS_INSECURE=1.
 * The behaviour itself is covered by agent/update_test.go, run here when a Go
 * toolchain is available.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const AGENT = path.join(REPO, 'agent');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** Non-test Go sources of the agent package (top level only). */
function agentGoSources(): Array<{ name: string; src: string }> {
  return fs.readdirSync(AGENT)
    .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
    .map((name) => ({ name, src: fs.readFileSync(path.join(AGENT, name), 'utf8') }));
}

describe('46b agent update pipeline (W2-2)', () => {
  lotIt('W2-2', '46b.1 one TLS policy: no unconditional InsecureSkipVerify, no ad-hoc http.Client', () => {
    const ws = read('agent/websocket.go');
    assert.doesNotMatch(ws, /InsecureSkipVerify:\s*true/, 'websocket.go still skips verification unconditionally');
    assert.match(ws, /newTLSConfig\(/, 'the WSS dial must use the shared TLS config');

    for (const { name, src } of agentGoSources()) {
      if (name === 'tlsconfig.go') continue;
      assert.doesNotMatch(src, /&http\.Client\{/, `${name} builds its own http.Client (use newHTTPClient)`);
      assert.doesNotMatch(src, /InsecureSkipVerify:\s*true/, `${name} skips TLS verification outside tlsconfig.go`);
    }

    const tls = read('agent/tlsconfig.go');
    assert.match(tls, /InsecureSkipVerify:\s*skip/, 'verification skipped only from the resolved policy');
    assert.match(read('agent/main.go'), /json:"tlsInsecureSkipVerify,omitempty"/);
    assert.match(read('agent/main.go'), /"tls-insecure"/, '--tls-insecure flag');
    for (const cap of ['update_status', 'sha256', 'tls_verify', 'tls_unverified']) {
      assert.ok(tls.includes(`"${cap}"`), `capability ${cap} not declared`);
    }
  });

  lotIt('W2-2', '46b.2 downloads are verified (length, X-Content-SHA256, X-Agent-Version) before install', () => {
    const main = read('agent/main.go');
    assert.match(main, /X-Content-SHA256/);
    assert.match(main, /X-Agent-Version/);
    assert.match(main, /func verifyDownload\(/);
    assert.match(main, /sha256 mismatch/);
    assert.match(main, /truncated/);
    // Staged in a protected directory, never the world-writable temp dir.
    assert.doesNotMatch(main, /os\.TempDir\(\)/, 'update artifacts must not be staged in the temp directory');
    assert.match(main, /\/inheritance:r/, 'Windows staging directory ACL is not restricted');
  });

  lotIt('W2-2', '46b.3 update runs async behind a guard and reports update_status; heartbeat carries capabilities', () => {
    const main = read('agent/main.go');
    assert.match(main, /updateInProgress\.CompareAndSwap\(false, true\)/);
    assert.match(main, /go func\(\)/);

    const cmd = read('agent/cmd_ws.go');
    assert.match(cmd, /startUpdateIfNewer\(cfg, msg\.LatestVersion\)/, 'config frame must start the update asynchronously');
    assert.doesNotMatch(cmd, /\bapplyUpdateIfNewer\(/, 'the WS read loop must not run the update inline');
    assert.match(cmd, /Type:\s*"update_status"/);
    assert.match(cmd, /json:"targetVersion"/);
    assert.match(cmd, /json:"phase"/);
    assert.match(cmd, /json:"capabilities,omitempty"/);
    for (const phase of ['downloading', 'verifying', 'installing', 'restarting', 'failed']) {
      assert.ok(cmd.includes(`"${phase}"`), `phase ${phase} missing`);
    }
  });

  lotIt('W2-2', '46b.4 Windows: SCM stop, msiexec exit code captured, old service restarted, recovery actions', () => {
    const restart = read('agent/restart_windows.go');
    assert.match(restart, /svc\.Stop/, 'restartWithNewBinary must stop through the SCM');

    const main = read('agent/main.go');
    assert.match(main, /set "RC=%ERRORLEVEL%"/, 'msiexec exit code not captured');
    assert.match(main, /sc start/, 'previous service not restarted on failure');

    const service = read('agent/service_windows.go');
    assert.match(service, /loadUpdateFailureMarker\(\)/, 'failed update not reported on next start');
    assert.match(service, /SetRecoveryActions\(/, 'no SCM recovery actions');
  });

  lotIt('W2-2', '46b.5 installers accept TLS_INSECURE and write tlsInsecureSkipVerify (default off)', () => {
    for (const rel of ['agent/installer/install.sh', 'agent/installer/install-freebsd.sh']) {
      const src = read(rel);
      assert.match(src, /TLS_INSECURE="\$\{TLS_INSECURE:-0\}"/, `${rel}: TLS_INSECURE must default to 0`);
      assert.match(src, /"tlsInsecureSkipVerify": \$TLS_INSECURE_JSON/, `${rel}: field not written to config.json`);
    }
    const mac = read('agent/installer/install-macos.sh');
    assert.match(mac, /TLS_INSECURE="\$\{TLS_INSECURE:-0\}"/);
    assert.match(mac, /"\$TLS_FLAG" install/, 'macOS installer must pass --tls-insecure=0|1 to the binary');

    const wxs = read('agent/installer/product.wxs');
    assert.match(wxs, /<Property Id="TLS_INSECURE"/);
    assert.match(wxs, /--tls-insecure=\[TLS_INSECURE\]/);
  });

  lotIt('W2-2', '46b.6 go test of the agent package (sha256 mismatch, missing header, TLS flag)', (t) => {
    // No shell: go(.exe) is resolved from PATH and the arguments stay literal.
    const probe = spawnSync('go', ['version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      t.skip('Go toolchain not available');
      return;
    }
    const res = spawnSync('go', ['test', '-count=1', './'], {
      cwd: AGENT,
      encoding: 'utf8',
      timeout: 200_000,
    });
    assert.equal(res.status, 0, `go test failed:\n${res.stdout}\n${res.stderr}`);
  }, { timeout: 220_000 });
});
