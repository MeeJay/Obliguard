package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ── pf (macOS, FreeBSD, OPNsense) ────────────────────────────────────────────
//
// Bans live in ONE anchor-qualified table on every pf platform:
//
//	pfctl -a obliguard -t obliguard_blocklist -T add|delete|show
//
// The 'obliguard' anchor holds the table and the two block rules
// (pfAnchorRules). A pf anchor is only evaluated when the main ruleset
// references it, so each platform gets an install-time hook:
//
//   - macOS / plain FreeBSD: /etc/pf.anchors/obliguard plus
//     `anchor "obliguard"` and `load anchor "obliguard" from ...` appended to
//     pf.conf (backup first, validated with pfctl -n before it replaces the
//     file). macOS also gets a launchd job that re-enables pf at boot
//     (pf is disabled by default there).
//   - OPNsense: pf.conf is generated, so a plugin hook
//     (/usr/local/etc/inc/plugins.inc.d/obliguard.inc) registers the anchor at
//     the head of the filter rules, then `configctl filter reload`.
//
// At runtime the agent (re)loads the anchor rules when they are missing,
// migrates the main-ruleset table left by older agents, repairs a missing
// hook once per start (pf.conf rewritten by an OS upgrade, agent upgraded
// from a version without the hook) and logs loudly while bans are not
// enforced (Enforcing).
//
// pf tables are radix trees: hosts and CIDR networks ("1.2.3.0/24") coexist,
// overlaps included, and `pfctl -T show` prints them back in the same form.
// Entries are canonicalized on the way in and out so the server delta
// converges.

const (
	pfAnchor = "obliguard"
	pfTable  = "obliguard_blocklist"

	// pfRecheckInterval spaces the enforcement checks done on the ban path
	// (GetBannedIPs runs on every heartbeat).
	pfRecheckInterval = 5 * time.Minute
	// pfTableChunk bounds the addresses passed on one pfctl command line.
	pfTableChunk = 200
)

// pfAnchorRules is the ruleset of the 'obliguard' anchor. Loading it never
// empties the table: a `table` definition without addresses keeps the
// entries of an existing table.
const pfAnchorRules = "table <" + pfTable + "> persist\n" +
	"block drop in quick from <" + pfTable + "> to any\n" +
	"block drop out quick from any to <" + pfTable + ">\n"

// pfAnchorFileHeader prefixes the anchor file loaded at boot.
const pfAnchorFileHeader = "# Obliguard IPS: ban table and block rules (managed by obliguard-agent, removed on uninstall)\n"

// pfTableArgs builds the argv of an anchor-qualified table command.
func pfTableArgs(cmd string, entries ...string) []string {
	return append([]string{"-a", pfAnchor, "-t", pfTable, "-T", cmd}, entries...)
}

// pfTableEntries parses `pfctl -T show` output into canonical entries
// (negated "!a.b.c.d" entries and blank lines are skipped).
func pfTableEntries(out string) []string {
	var res []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(out, "\n") {
		k, _, err := canonicalBanEntry(line)
		if err != nil || seen[k] {
			continue
		}
		seen[k] = true
		res = append(res, k)
	}
	return res
}

// pfShowTable returns the canonical entries of the anchor table.
func pfShowTable() ([]string, error) {
	out, err := fwOutput("pfctl", pfTableArgs("show")...)
	if err != nil {
		return nil, err
	}
	return pfTableEntries(string(out)), nil
}

// pfAddEntries adds canonical entries to the anchor table in chunks.
func pfAddEntries(entries []string) error {
	var firstErr error
	for _, chunk := range chunkStrings(entries, pfTableChunk) {
		if err := fwRun("pfctl", pfTableArgs("add", chunk...)...); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// pfAnchorReferenced reports whether `pfctl -s rules` (main ruleset) output
// evaluates the 'obliguard' anchor.
func pfAnchorReferenced(rules string) bool {
	for _, line := range strings.Split(rules, "\n") {
		l := strings.TrimSpace(line)
		if l == `anchor "`+pfAnchor+`"` || strings.HasPrefix(l, `anchor "`+pfAnchor+`" `) {
			return true
		}
	}
	return false
}

// pfAnchorRulesLoaded reports whether `pfctl -a obliguard -s rules` output
// holds both block rules on the ban table.
func pfAnchorRulesLoaded(rules string) bool {
	in, out := false, false
	for _, line := range strings.Split(rules, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || f[0] != "block" || !strings.Contains(line, "<"+pfTable+">") {
			continue
		}
		for _, w := range f {
			switch w {
			case "in":
				in = true
			case "out":
				out = true
			}
		}
	}
	return in && out
}

// pfEnabled reports whether `pfctl -s info` says pf is enabled.
func pfEnabled() bool {
	out, err := fwOutput("pfctl", "-s", "info")
	return err == nil && strings.Contains(string(out), "Status: Enabled")
}

// pfEnforcementProblem returns "" when bans in the anchor table are dropped,
// otherwise the reason they are not.
func pfEnforcementProblem() string {
	if !pfEnabled() {
		return "pf is disabled"
	}
	if out, err := fwOutput("pfctl", "-s", "rules"); err != nil || !pfAnchorReferenced(string(out)) {
		return `the main pf ruleset does not reference anchor "` + pfAnchor + `"`
	}
	if out, err := fwOutput("pfctl", "-a", pfAnchor, "-s", "rules"); err != nil || !pfAnchorRulesLoaded(string(out)) {
		return `anchor "` + pfAnchor + `" has no block rules`
	}
	return ""
}

// pfLoadAnchorRules loads pfAnchorRules into the anchor. Entries the table
// held before are re-added if the load dropped any (it should not).
func pfLoadAnchorRules() error {
	before, _ := pfShowTable()
	if err := fwRunStdin(pfAnchorRules, "pfctl", "-a", pfAnchor, "-f", "-"); err != nil {
		return err
	}
	if len(before) == 0 {
		return nil
	}
	after, _ := pfShowTable()
	have := make(map[string]bool, len(after))
	for _, k := range after {
		have[k] = true
	}
	var missing []string
	for _, k := range before {
		if !have[k] {
			missing = append(missing, k)
		}
	}
	return pfAddEntries(missing)
}

// ── Platforms ────────────────────────────────────────────────────────────────

const (
	pfKindMacOS    = "macos"
	pfKindFreeBSD  = "freebsd"
	pfKindOPNsense = "opnsense"

	pfAnchorFilePath   = "/etc/pf.anchors/obliguard"
	pfConfDefault      = "/etc/pf.conf"
	pfMacBootPlist     = "/Library/LaunchDaemons/com.obliguard.pf.plist"
	pfMacBootLabel     = "com.obliguard.pf"
	pfOPNsensePlugin   = "/usr/local/etc/inc/plugins.inc.d/obliguard.inc"
	pfConfBackupSuffix = ".obliguard.bak"
)

// pfPlatform describes where a pf platform hooks the 'obliguard' anchor.
type pfPlatform struct {
	kind string
	goos string
	// pfConf is the main ruleset patched with the anchor lines ("" on OPNsense).
	pfConf string
	// anchorFile holds pfAnchorRules for `load anchor` at boot ("" on OPNsense).
	anchorFile string
	// pluginFile is the OPNsense plugin that registers the anchor.
	pluginFile string
	// bootPlist is the macOS launchd job that runs `pfctl -E` at boot.
	bootPlist string
	// legacyFiles were written by older agents (OPNsense configd hook,
	// unused pf.opnsense.d include) and are removed on install/uninstall.
	legacyFiles []string
}

var pfLegacyFiles = []string{
	"/usr/local/opnsense/scripts/filter/obliguard_reload.sh",
	"/usr/local/opnsense/service/conf/actions.d/actions_obliguard.conf",
	"/usr/local/etc/pf.opnsense.d/obliguard.conf",
	"/usr/local/etc/pf.obliguard.conf",
}

// pfDetectPlatform returns the pf platform of this host (replaced in tests).
var pfDetectPlatform = func(goos string) pfPlatform {
	switch {
	case goos == "darwin":
		return pfPlatform{kind: pfKindMacOS, goos: goos, pfConf: pfConfDefault,
			anchorFile: pfAnchorFilePath, bootPlist: pfMacBootPlist}
	case isOPNsenseAgent():
		return pfPlatform{kind: pfKindOPNsense, goos: goos, pluginFile: pfOPNsensePlugin,
			legacyFiles: pfLegacyFiles}
	default:
		p := pfPlatform{kind: pfKindFreeBSD, goos: goos, pfConf: pfConfDefault,
			anchorFile: pfAnchorFilePath, legacyFiles: pfLegacyFiles}
		// rc.conf may point pf at another ruleset file.
		if out, err := fwOutput("sysrc", "-n", "pf_rules"); err == nil {
			if s := strings.TrimSpace(string(out)); strings.HasPrefix(s, "/") {
				p.pfConf = s
			}
		}
		return p
	}
}

// pfAutoSetup reports whether the agent may repair the install-time hook of
// pl by itself: only as root on the platform itself (replaced in tests).
var pfAutoSetup = func(pl pfPlatform) bool {
	return runtime.GOOS == pl.goos && os.Geteuid() == 0
}

// pfInstructions tells the operator how to make pl enforce bans.
func pfInstructions(pl pfPlatform) string {
	switch pl.kind {
	case pfKindOPNsense:
		return "check that " + pl.pluginFile + " exists and run `configctl filter reload`, " +
			`or run "obliguard-agent pf-setup" as root; ` +
			"`pfctl -s rules | grep obliguard` must list the anchor"
	case pfKindMacOS:
		return `run "sudo obliguard-agent pf-setup" (adds the anchor to ` + pl.pfConf +
			" and enables pf with `pfctl -E`)"
	default:
		return `run "obliguard-agent pf-setup" as root (adds the anchor to ` + pl.pfConf +
			"), then enable pf: `sysrc pf_enable=YES && service pf start`"
	}
}

// ── pf.conf patching ─────────────────────────────────────────────────────────

// pfConfMarker precedes the lines the agent appends to pf.conf.
const pfConfMarker = "# Obliguard IPS: ban anchor (managed by obliguard-agent, removed on uninstall)"

// pfConfLegacyLines were appended to /etc/pf.conf by older FreeBSD agents
// (main-ruleset table, which the agent no longer fills).
var pfConfLegacyLines = map[string]bool{
	"# Obliguard IPS — managed automatically, do not edit": true,
	"table <" + pfTable + "> persist":                      true,
	"block in quick from <" + pfTable + ">":                true,
	"block out quick to <" + pfTable + ">":                 true,
}

func pfConfIsAnchorLine(l string) bool {
	return l == `anchor "`+pfAnchor+`"` || l == "anchor "+pfAnchor
}

func pfConfIsLoadLine(l string) bool {
	return strings.HasPrefix(l, `load anchor "`+pfAnchor+`" from `) ||
		strings.HasPrefix(l, "load anchor "+pfAnchor+" from ")
}

// pfConfLines splits pf.conf content into lines (CR dropped).
func pfConfLines(conf string) []string {
	conf = strings.ReplaceAll(conf, "\r", "")
	if conf == "" {
		return nil
	}
	return strings.Split(conf, "\n")
}

// pfConfJoin joins lines, trims trailing blank lines and ends with a newline
// ("" for an empty file).
func pfConfJoin(lines []string) string {
	s := strings.TrimRight(strings.Join(lines, "\n"), "\n \t")
	if s == "" {
		return ""
	}
	return s + "\n"
}

// pfConfWithAnchor returns conf with the legacy Obliguard lines removed and
// the anchor referenced and loaded from anchorFile. An `anchor "obliguard"`
// line the operator placed elsewhere (e.g. above their own pass quick rules)
// is kept where it is. changed is false when conf is already right.
func pfConfWithAnchor(conf, anchorFile string) (string, bool) {
	var kept []string
	hasAnchor, hasLoad := false, false
	for _, line := range pfConfLines(conf) {
		l := strings.TrimSpace(line)
		if pfConfLegacyLines[l] {
			continue
		}
		if pfConfIsAnchorLine(l) {
			hasAnchor = true
		}
		if pfConfIsLoadLine(l) {
			hasLoad = true
		}
		kept = append(kept, line)
	}
	var add []string
	if !hasAnchor || !hasLoad {
		add = append(add, pfConfMarker)
		if !hasAnchor {
			add = append(add, `anchor "`+pfAnchor+`"`)
		}
		if !hasLoad {
			add = append(add, `load anchor "`+pfAnchor+`" from "`+anchorFile+`"`)
		}
	}
	out := pfConfJoin(kept)
	if len(add) > 0 {
		if out != "" {
			out += "\n"
		}
		out += strings.Join(add, "\n") + "\n"
	}
	return out, out != strings.ReplaceAll(conf, "\r", "")
}

// pfConfWithoutAnchor removes every Obliguard line (marker, anchor reference,
// load anchor, legacy table and block rules) from conf.
func pfConfWithoutAnchor(conf string) (string, bool) {
	var kept []string
	removed := false
	for _, line := range pfConfLines(conf) {
		l := strings.TrimSpace(line)
		if l == pfConfMarker || pfConfLegacyLines[l] || pfConfIsAnchorLine(l) || pfConfIsLoadLine(l) {
			removed = true
			continue
		}
		kept = append(kept, line)
	}
	if !removed {
		return conf, false
	}
	return pfConfJoin(kept), true
}

// ── Install / uninstall ──────────────────────────────────────────────────────

// pfOPNsensePluginSource registers the anchor at the head of the generated
// filter rules (OPNsense plugin hook <name>_firewall, see
// OPNsense\Firewall\Plugin::registerAnchor).
const pfOPNsensePluginSource = `<?php

/*
 * Obliguard IPS: evaluate the pf anchor "obliguard" (ban table filled by
 * obliguard-agent) before the other filter rules.
 * Installed by obliguard-agent, removed on uninstall.
 */

function obliguard_firewall($fw)
{
    $fw->registerAnchor('obliguard', 'fw', 0, 'head');
}
`

// pfMacBootPlistSource is the launchd job that enables pf at boot.
func pfMacBootPlistSource() string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>` + pfMacBootLabel + `</string>

    <!-- Obliguard IPS: pf is disabled by default on macOS; enable it at boot
         so the "obliguard" anchor blocks banned addresses. -->
    <key>ProgramArguments</key>
    <array>
        <string>/sbin/pfctl</string>
        <string>-E</string>
    </array>

    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`
}

// pfWriteFile writes data to path through a temporary file and a rename.
func pfWriteFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	tmp := path + ".obliguard-new"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// pfInstall installs the hook that makes the main ruleset evaluate the
// 'obliguard' anchor on pl, loads the anchor rules and, on macOS, enables pf
// (now and at boot). logf receives progress lines. Idempotent.
func pfInstall(pl pfPlatform, logf func(format string, args ...any)) error {
	for _, f := range pl.legacyFiles {
		if err := os.Remove(f); err == nil {
			logf("Removed legacy pf hook %s", f)
		}
	}

	if pl.kind == pfKindOPNsense {
		if err := pfWriteFile(pl.pluginFile, []byte(pfOPNsensePluginSource), 0644); err != nil {
			return fmt.Errorf("write %s: %w", pl.pluginFile, err)
		}
		logf("OPNsense plugin hook written to %s", pl.pluginFile)
		if err := pfLoadAnchorRules(); err != nil {
			return fmt.Errorf("load anchor rules: %w", err)
		}
		if err := fwRun("configctl", "filter", "reload"); err != nil {
			return fmt.Errorf("configctl filter reload: %w", err)
		}
		logf("OPNsense filter reloaded")
		return nil
	}

	if err := pfWriteFile(pl.anchorFile, []byte(pfAnchorFileHeader+pfAnchorRules), 0644); err != nil {
		return fmt.Errorf("write %s: %w", pl.anchorFile, err)
	}
	logf("pf anchor rules written to %s", pl.anchorFile)

	orig, err := os.ReadFile(pl.pfConf)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read %s: %w", pl.pfConf, err)
	}
	existed := err == nil
	mode := os.FileMode(0644)
	if st, statErr := os.Stat(pl.pfConf); statErr == nil {
		mode = st.Mode().Perm()
	}
	patched, changed := pfConfWithAnchor(string(orig), pl.anchorFile)
	if changed {
		backup := pl.pfConf + pfConfBackupSuffix
		if _, err := os.Stat(backup); existed && os.IsNotExist(err) {
			if err := os.WriteFile(backup, orig, mode); err != nil {
				return fmt.Errorf("back up %s: %w", pl.pfConf, err)
			}
			logf("Backed up %s to %s", pl.pfConf, backup)
		}
		// Validate the patched ruleset before it replaces the live file.
		cand := pl.pfConf + ".obliguard-new"
		if err := os.WriteFile(cand, []byte(patched), mode); err != nil {
			return fmt.Errorf("write %s: %w", cand, err)
		}
		if err := fwRun("pfctl", "-n", "-f", cand); err != nil {
			os.Remove(cand)
			return fmt.Errorf("%s with the obliguard anchor does not parse (left unchanged): %w", pl.pfConf, err)
		}
		if err := os.Rename(cand, pl.pfConf); err != nil {
			os.Remove(cand)
			return fmt.Errorf("replace %s: %w", pl.pfConf, err)
		}
		logf("Anchor %q added to %s", pfAnchor, pl.pfConf)
	}
	if err := fwRun("pfctl", "-f", pl.pfConf); err != nil {
		return fmt.Errorf("pfctl -f %s: %w", pl.pfConf, err)
	}
	logf("pf ruleset reloaded from %s", pl.pfConf)

	if pl.kind == pfKindMacOS {
		if err := pfWriteFile(pl.bootPlist, []byte(pfMacBootPlistSource()), 0644); err != nil {
			return fmt.Errorf("write %s: %w", pl.bootPlist, err)
		}
		_ = fwRun("launchctl", "unload", pl.bootPlist)
		if err := fwRun("launchctl", "load", "-w", pl.bootPlist); err != nil {
			logf("Warning: launchctl load %s: %v", pl.bootPlist, err)
		}
		if err := fwRun("pfctl", "-E"); err != nil {
			return fmt.Errorf("pfctl -E: %w", err)
		}
		logf("pf enabled (launchd job %s re-enables it at boot)", pfMacBootLabel)
	}
	return nil
}

// pfUninstall removes everything pfInstall and the agent added: the pf.conf
// lines (other lines untouched), the anchor rules and table, the anchor file,
// the OPNsense plugin and the macOS boot job. pf itself is left enabled
// (other software may rely on it). Best effort; problems go to logf.
func pfUninstall(pl pfPlatform, logf func(format string, args ...any)) {
	if pl.pfConf != "" {
		if data, err := os.ReadFile(pl.pfConf); err == nil {
			if cleaned, changed := pfConfWithoutAnchor(string(data)); changed {
				mode := os.FileMode(0644)
				if st, err := os.Stat(pl.pfConf); err == nil {
					mode = st.Mode().Perm()
				}
				if err := pfWriteFile(pl.pfConf, []byte(cleaned), mode); err != nil {
					logf("Warning: cannot clean %s: %v", pl.pfConf, err)
				} else {
					logf("Obliguard lines removed from %s", pl.pfConf)
					if err := fwRun("pfctl", "-f", pl.pfConf); err != nil {
						logf("Warning: pfctl -f %s: %v", pl.pfConf, err)
					}
				}
			}
		}
	}

	// Anchor rules and table. Never `-F all`: it would also flush the state
	// table of the whole host.
	_ = fwRun("pfctl", "-a", pfAnchor, "-F", "rules")
	_ = fwRun("pfctl", pfTableArgs("kill")...)
	// Main-ruleset table filled by older agents.
	_ = fwRun("pfctl", pfLegacyTableArgs("flush")...)

	files := append([]string{}, pl.legacyFiles...)
	for _, f := range []string{pl.anchorFile, pl.pluginFile} {
		if f != "" {
			files = append(files, f)
		}
	}
	if pl.bootPlist != "" {
		if _, err := os.Stat(pl.bootPlist); err == nil {
			_ = fwRun("launchctl", "unload", pl.bootPlist)
			files = append(files, pl.bootPlist)
		}
	}
	for _, f := range files {
		if err := os.Remove(f); err == nil {
			logf("Removed %s", f)
		} else if !os.IsNotExist(err) {
			logf("Warning: could not remove %s: %v", f, err)
		}
	}

	if pl.kind == pfKindOPNsense {
		if err := fwRun("configctl", "filter", "reload"); err != nil {
			logf("Warning: configctl filter reload: %v", err)
		}
	}
}

// ── Runtime enforcement ──────────────────────────────────────────────────────

// pfCore is the state shared by the macOS and FreeBSD backends.
type pfCore struct {
	mu        sync.Mutex
	started   bool
	platform  pfPlatform
	lastCheck time.Time
	// lastProblem is the last reported enforcement problem ("" = enforcing).
	lastProblem string
	// legacyPending: the main-ruleset table of older agents has not been
	// migrated yet (retried at each check until the ban-safety guard exists).
	legacyPending bool
	// legacyKept: legacy entries were copied but the legacy table is kept
	// (old pf.conf rules may still use it) until the anchor is enforced;
	// unbans are mirrored to it meanwhile.
	legacyKept bool
}

// ensure keeps the anchor usable. The first call (process start) detects the
// platform, loads the anchor rules, migrates the legacy table, enables pf on
// macOS and repairs a missing install-time hook; later calls, at most every
// pfRecheckInterval, reload missing anchor rules and log state changes.
func (c *pfCore) ensure(goos string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.started && time.Since(c.lastCheck) < pfRecheckInterval {
		return
	}
	c.lastCheck = time.Now()
	first := !c.started
	c.started = true
	if first {
		c.platform = pfDetectPlatform(goos)
		c.legacyPending = true
	}

	if out, err := fwOutput("pfctl", "-a", pfAnchor, "-s", "rules"); err != nil || !pfAnchorRulesLoaded(string(out)) {
		if err := pfLoadAnchorRules(); err != nil {
			log.Printf("Firewall: cannot load pf anchor %q: %v", pfAnchor, err)
		}
	}

	problem := pfEnforcementProblem()
	if first && problem != "" && pfAutoSetup(c.platform) {
		log.Printf("Firewall: pf does not enforce bans (%s) — installing the anchor hook", problem)
		if err := pfInstall(c.platform, log.Printf); err != nil {
			log.Printf("Firewall: pf hook install failed: %v", err)
		}
		problem = pfEnforcementProblem()
	}
	if c.legacyPending {
		c.migrateLegacyTable(problem == "")
	} else if c.legacyKept && problem == "" {
		// The anchor is enforced now: the legacy table is no longer needed.
		if err := fwRun("pfctl", pfLegacyTableArgs("flush")...); err != nil {
			log.Printf("Firewall: pf legacy table flush: %v", err)
		}
		c.legacyKept = false
	}

	if problem != c.lastProblem || first {
		if problem == "" {
			log.Printf("Firewall: pf enforcing bans (anchor %q, table <%s>)", pfAnchor, pfTable)
		} else {
			log.Printf("Firewall: WARNING — bans are NOT enforced: %s. Fix: %s", problem, pfInstructions(c.platform))
		}
	}
	c.lastProblem = problem
}

// pfLegacyTableArgs builds the argv of a command on the main-ruleset table
// filled by older agents (migration and cleanup only, never new bans).
func pfLegacyTableArgs(cmd string, entries ...string) []string {
	return append([]string{"-t", pfTable, "-T", cmd}, entries...)
}

// pfCurrentBanSafety returns the process-wide ban-safety guard, nil before
// the first ban list was received.
func pfCurrentBanSafety() *banSafety {
	agentBanSafetyMu.Lock()
	defer agentBanSafetyMu.Unlock()
	return agentBanSafety
}

// migrateLegacyTable copies the entries older agents put in the main-ruleset
// table into the anchor table, through the ban-safety guard (on macOS that
// table was never evaluated: copying an unsafe entry would start enforcing
// it). It waits for the guard to exist. The legacy table is flushed only
// once the anchor is enforced: until then the old pf.conf rules may still
// use it, so unbans are mirrored to it (legacyKept).
func (c *pfCore) migrateLegacyTable(enforcing bool) {
	out, err := fwOutput("pfctl", pfLegacyTableArgs("show")...)
	if err != nil {
		c.legacyPending = false // no legacy table
		return
	}
	legacy := pfTableEntries(string(out))
	if len(legacy) == 0 {
		c.legacyPending = false
		return
	}
	guard := pfCurrentBanSafety()
	if guard == nil {
		return // retried at the next check
	}
	c.legacyPending = false
	safe := guard.Filter(legacy)
	if err := pfAddEntries(safe); err != nil {
		log.Printf("Firewall: pf legacy table migration: %v", err)
	}
	if !enforcing {
		c.legacyKept = true
		log.Printf("Firewall: copied %d legacy ban(s) into anchor %q (legacy table kept until the anchor is enforced)", len(safe), pfAnchor)
		return
	}
	if err := fwRun("pfctl", pfLegacyTableArgs("flush")...); err != nil {
		log.Printf("Firewall: pf legacy table flush: %v", err)
	}
	log.Printf("Firewall: moved %d legacy ban(s) into anchor %q", len(safe), pfAnchor)
}

// enforcing runs the live enforcement check.
func (c *pfCore) enforcing() bool {
	return pfEnforcementProblem() == ""
}

func (c *pfCore) banIP(goos, ip string) error {
	k, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	c.ensure(goos)
	return fwRun("pfctl", pfTableArgs("add", k)...)
}

func (c *pfCore) unbanIP(goos, ip string) error {
	k, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	c.ensure(goos)
	c.mu.Lock()
	kept := c.legacyKept
	c.mu.Unlock()
	if kept {
		// Old pf.conf rules may still evaluate the legacy table.
		_ = fwRun("pfctl", pfLegacyTableArgs("delete", k)...)
	}
	return fwRun("pfctl", pfTableArgs("delete", k)...)
}

func (c *pfCore) getBannedIPs(goos string) ([]string, error) {
	c.ensure(goos)
	entries, err := pfShowTable()
	if err != nil {
		// No table yet (nothing banned since boot).
		return nil, nil
	}
	return entries, nil
}

// ── macOS pf ──────────────────────────────────────────────────────────────────

type PFFirewall struct{ core pfCore }

func (f *PFFirewall) Name() string { return "macos_pf" }

func (f *PFFirewall) IsAvailable() bool {
	return fwHave("pfctl")
}

func (f *PFFirewall) BanIP(ip string) error           { return f.core.banIP("darwin", ip) }
func (f *PFFirewall) UnbanIP(ip string) error         { return f.core.unbanIP("darwin", ip) }
func (f *PFFirewall) GetBannedIPs() ([]string, error) { return f.core.getBannedIPs("darwin") }
func (f *PFFirewall) Flush() error                    { return nil }

// Enforcing reports whether pf is enabled, the main ruleset references the
// 'obliguard' anchor and the anchor holds the block rules.
func (f *PFFirewall) Enforcing() bool { return f.core.enforcing() }

// ── FreeBSD / OPNsense pf ────────────────────────────────────────────────────

type FreeBSDPFFirewall struct{ core pfCore }

func (f *FreeBSDPFFirewall) Name() string { return "freebsd_pf" }

func (f *FreeBSDPFFirewall) IsAvailable() bool {
	return fwHave("pfctl") && pfEnabled()
}

func (f *FreeBSDPFFirewall) BanIP(ip string) error           { return f.core.banIP("freebsd", ip) }
func (f *FreeBSDPFFirewall) UnbanIP(ip string) error         { return f.core.unbanIP("freebsd", ip) }
func (f *FreeBSDPFFirewall) GetBannedIPs() ([]string, error) { return f.core.getBannedIPs("freebsd") }
func (f *FreeBSDPFFirewall) Flush() error                    { return nil }

// Enforcing reports whether pf is enabled, the main ruleset references the
// 'obliguard' anchor and the anchor holds the block rules.
func (f *FreeBSDPFFirewall) Enforcing() bool { return f.core.enforcing() }

// errPFUnsupported is returned by the pf CLI helpers on other platforms.
var errPFUnsupported = errors.New("pf is only managed on macOS and FreeBSD")

// pfSetupCLI installs the pf hook of this host (`obliguard-agent pf-setup`,
// install subcommands). Prints progress to stdout.
func pfSetupCLI() error {
	if runtime.GOOS != "darwin" && runtime.GOOS != "freebsd" {
		return errPFUnsupported
	}
	pl := pfDetectPlatform(runtime.GOOS)
	printf := func(format string, args ...any) { fmt.Printf(format+"\n", args...) }
	if err := pfInstall(pl, printf); err != nil {
		return err
	}
	if p := pfEnforcementProblem(); p != "" {
		return fmt.Errorf("bans are not enforced yet: %s. Fix: %s", p, pfInstructions(pl))
	}
	printf("pf enforces Obliguard bans (anchor %q)", pfAnchor)
	return nil
}

// pfCleanupCLI removes the pf hook of this host (`obliguard-agent
// pf-cleanup`, uninstall paths). Prints progress to stdout.
func pfCleanupCLI() {
	if runtime.GOOS != "darwin" && runtime.GOOS != "freebsd" {
		return
	}
	pfUninstall(pfDetectPlatform(runtime.GOOS), func(format string, args ...any) {
		fmt.Printf(format+"\n", args...)
	})
}

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// Not wired for pf yet: it would need a dedicated rate-limit anchor (pf
// keep-state max-src-conn / dummynet) — a separate pass.

func (f *PFFirewall) IsRateLimitSupported() bool              { return false }
func (f *PFFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }

func (f *FreeBSDPFFirewall) IsRateLimitSupported() bool              { return false }
func (f *FreeBSDPFFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }
