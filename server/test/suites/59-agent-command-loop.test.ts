/**
 * 59 — W5-5 agent command loop, bounded event queue, clean uninstall (D9, D13):
 *   - agent/cmd_ws.go: a read loop and a single writer goroutine fed by a
 *     bounded queue (back-pressure, write deadline); config frames applied by
 *     a worker, firewall rule commands off the read loop with a timeout below
 *     the server's 30 s pushAndWait; ban deltas coalesced into one firewall
 *     worker; reconnection with jittered exponential backoff capped at 60 s;
 *   - agent/eventqueue.go: auth events in a bounded queue (10 000, drop-oldest,
 *     'dropped' count in the next events frame), flushed every 500 ms in
 *     batches of at most 500;
 *   - uninstall: `cleanup-firewall [--purge]` removes the firewall objects of
 *     every backend (agent/firewall_cleanup.go), run by the MSI uninstall
 *     custom action (not on upgrades) and by the remote uninstall scripts after
 *     the service stops; the Windows script uninstalls the installed
 *     ProductCode instead of a downloaded MSI.
 * Behaviour is covered by agent/eventqueue_test.go, run here when a Go
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
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
/** Go source without its line comments (checks target code, not prose). */
const code = (rel: string) => read(rel).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

function goAvailable(): boolean {
  return spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
}

describe('59 agent command loop, event queue, uninstall cleanup (W5-5)', () => {
  lotIt('W5-5', '59.1 single writer, read loop never runs slow work, firewall commands time out', () => {
    const cmd = code('agent/cmd_ws.go');
    // The connection is written by writeLoop only (pongs included).
    const writes = cmd.match(/\.WriteFrame\(/g) ?? [];
    assert.equal(writes.length, 1, 'exactly one WriteFrame call site (the writer goroutine)');
    assert.match(cmd, /func \(s \*cmdSession\) writeLoop\(\)[\s\S]*?SetWriteDeadline/);
    assert.doesNotMatch(cmd, /SendText\(|SendPong\(/, 'every frame goes through the writer queue');
    assert.match(cmd, /out:\s+make\(chan wsOutFrame, cmdWSOutQueueSize\)/, 'bounded outbound queue');
    assert.match(cmd, /case <-t\.C:\s*\n\s*s\.fail\(errCmdWSBackpressure\)/, 'back-pressure: a stalled writer fails the session');
    // Firewall commands: own goroutine, timeout under the server's 30 s.
    assert.match(cmd, /fwCommandTimeout = 25 \* time\.Second/);
    // The slot is released when the command ends (not when it times out):
    // hung commands cannot pile up goroutines behind fwCommandMu.
    assert.match(cmd, /release := func\(\) \{ <-fwCommandSlots \}/);
    assert.match(cmd, /go func\(\) \{\s*\n\s*if done != nil \{\s*\n\s*defer done\(\)/);
    assert.doesNotMatch(cmd, /go handleFirewallCommand\(/);
    // Config frames: worker inbox, never applied in the read loop.
    assert.match(cmd, /case rt\.config <- payload:/);
    assert.match(cmd, /go configWorker\(cfg, lw, fw, rt\.config\)/);
    // Ban deltas: one coalescing worker instead of a goroutine per frame.
    assert.match(cmd, /queueBanDelta\(fw, guard\.Filter\(msg\.BanList\.Add\), canonicalBanList\(msg\.BanList\.Remove\)\)/);
    assert.doesNotMatch(cmd, /guard\.Filter\(rawAdd\)/);
  });

  lotIt('W5-5', '59.2 jittered exponential reconnect backoff capped at 60 s', () => {
    const cmd = code('agent/cmd_ws.go');
    assert.match(cmd, /cmdWSReconnectMax\s+= 60 \* time\.Second/);
    assert.match(cmd, /func nextBackoff\(d time\.Duration\) time\.Duration \{\s*\n\s*d \*= 2/);
    assert.match(cmd, /rand\.Int63n\(/, 'jitter');
    assert.match(cmd, /if connected && time\.Since\(start\) >= cmdWSStableSession \{\s*\n\s*backoff = cmdWSReconnectBase/,
      'only a session that stayed up resets the backoff');
  });

  lotIt('W5-5', '59.3 bounded event queue: 10 000, drop-oldest, batches of 500 every 500 ms, dropped reported', () => {
    const q = code('agent/eventqueue.go');
    assert.match(q, /eventQueueCap = 10000/);
    assert.match(q, /eventBatchMax = 500/);
    const cmd = code('agent/cmd_ws.go');
    assert.match(cmd, /cmdWSEventFlushInterval = 500 \* time\.Millisecond/);
    assert.match(cmd, /Dropped int `json:"dropped,omitempty"`/, 'older servers ignore an absent field');
    assert.match(cmd, /q\.PopBatch\(eventBatchMax\)/);
    assert.match(cmd, /q\.Requeue\(batch, dropped\)/, 'a batch that cannot be written is kept');
    assert.match(cmd, /go pumpEvents\(lw, rt\.events\)/, 'the queue fills while disconnected too');
    assert.doesNotMatch(cmd, /time\.After\(cmdWSEventDebounce\)/, 'no restarted debounce (starves under a continuous stream)');
  });

  lotIt('W5-5', '59.4 uninstall removes the firewall objects of every backend and the agent data', () => {
    const fw = code('agent/firewall_cleanup.go');
    assert.match(fw, /"nft", "delete", "table", "inet", nftTable/);
    assert.match(fw, /"ipset", "destroy", set/);
    assert.match(fw, /iptSetName, iptSetName \+ "_mig", iptRLBanSet/);
    assert.match(fw, /"--delete-ipset=" \+ set/);
    assert.match(fw, /pfUninstall\(pfDetectPlatform\(runtime\.GOOS\), logf\)/);
    assert.doesNotMatch(fw, /DetectFirewall\(\)/, 'a live backend would re-apply bans during the cleanup');
    const win = code('agent/firewall_cleanup_windows.go');
    assert.match(win, /sess\.DeleteRule\(r\.ID\)/);
    assert.match(win, /DeleteSublayer\(obliSublayerID\)/);
    assert.match(win, /DeleteProvider\(obliProviderID\)/);
    assert.match(win, /deleteGroupedRules\(\)/);
    assert.match(win, /os\.Remove\(wfpBanlistPath\(\)\)/);

    const un = code('agent/uninstall.go');
    assert.match(un, /os\.Args\[1\] != cleanupFirewallArg/, 'subcommand dispatched before main()');
    assert.doesNotMatch(un, /downloadFile\(|api\/agent\/download/, 'msiexec /x the installed ProductCode, not a downloaded MSI');
    assert.match(un, /`msiexec \/x `\+productCode/);
    assert.doesNotMatch(un, /timeout \/t/, 'timeout.exe fails without a console (service context)');
    assert.match(un, /linuxFirewallCleanupShell\(\)/, 'shell fallback when the binary cannot run');
    assert.match(un, /"systemd-run"/, 'the script must leave the agent unit cgroup');
    assert.match(un, /unixPurgeScript\(\)/);
  });

  lotIt('W5-5', '59.5 MSI uninstall custom action runs the cleanup, never on a major upgrade', () => {
    const wxs = read('agent/installer/product.wxs');
    assert.match(wxs, /<CustomAction Id="AgentCleanup"\s+FileRef="AgentExeFile"\s+ExeCommand="cleanup-firewall --purge"\s+Execute="deferred"\s+Impersonate="no"\s+Return="ignore" \/>/);
    assert.match(wxs, /<Custom Action="AgentCleanup" After="StopServices"\s+Condition="REMOVE=&quot;ALL&quot; AND NOT UPGRADINGPRODUCTCODE" \/>/);
  });

  lotIt('W5-5', '59.6 go test of the queue, the command loop and the uninstall cleanup', (t) => {
    if (!goAvailable()) {
      t.skip('Go toolchain not available');
      return;
    }
    const res = spawnSync('go', [
      'test', '-count=1',
      '-run', '^Test(EventQueue|FlushEventQueue|SessionSendAfterClose|ReconnectBackoff|RunFirewallCommandTimeout|BanDeltaLastOperationWins|CleanupLinuxFirewall|UninstallScripts|PFUninstallScript)',
      './',
    ], { cwd: AGENT, encoding: 'utf8', timeout: 200_000 });
    assert.equal(res.status, 0, `go test failed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /^ok\s/m);
  }, { timeout: 220_000 });
});
