package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ── Windows Firewall (netsh fallback, grouped rules) ─────────────────────────
//
// Used when the WFP backend (firewall_wfp_windows.go) cannot start. Bans are
// grouped into block rules whose remoteip field lists up to maxIPsPerRule
// entries: "Obliguard-Block-in" / "Obliguard-Block-out" for a single group,
// "Obliguard-Block-in-N" / "Obliguard-Block-out-N" (N = 1, 2, …) above
// maxIPsPerRule entries.
//
// remoteip accepts CIDR natively, so networks ("1.2.3.0/24") sit in the same
// list as single addresses. Entries are kept in canonical form (see
// canonicalBanEntry) so GetBannedIPs returns exactly what the server sent.
//
// obliguard-banlist.txt (next to the binary, shared with the WFP backend) is
// the source of truth: it is written atomically (temp file + rename) before
// the rules are touched, and the rules are rebuilt from it at the first Flush
// of a process. A group that already exists is updated in place
// ("set rule … new remoteip=", no window without the rule); delete + add is
// only used to (re)create one. Rule output is parsed without depending on the
// display language (see parseNetshRuleNames).

const winRuleIn = "Obliguard-Block-in"
const winRuleOut = "Obliguard-Block-out"
const winRulePrefix = "Obliguard-Block-" // kept for legacy cleanup

// maxIPsPerRule — conservative limit for Windows Firewall reliability.
// netsh can fail silently with large remoteip lists; 500 is safe.
const maxIPsPerRule = 500

// netshRetryDelays: pauses between attempts of a rule creation or update
// (netsh fails transiently while MpsSvc/BFE is busy, e.g. right after boot).
var netshRetryDelays = []time.Duration{250 * time.Millisecond, time.Second}

// netshSleep is replaced in tests.
var netshSleep = time.Sleep

// netshFallbackPurge, set on Windows by firewall_wfp_windows.go, removes the
// persistent WFP filters a previous WFP run left behind: the netsh backend
// cannot see them, so an IP unbanned here would stay blocked by WFP.
var netshFallbackPurge func()

// netshStaleWalkMax bounds the delete-by-name walk used when the rule list
// cannot be read.
const netshStaleWalkMax = 1000

type WindowsFirewall struct {
	// mu serializes the ban goroutine (BanIP/UnbanIP/Flush) and the heartbeat
	// (GetBannedIPs): both touch the cache map.
	mu            sync.Mutex
	cache         map[string]bool
	dirty         bool
	loaded        bool
	legacyCleaned bool
	wfpPurged     bool
	// appliedRules maps each grouped rule this process created or updated to
	// its remoteip list. nil until the first sync (state unknown: rebuild).
	appliedRules map[string]string
	// unapplied holds the entries of groups whose last create/update failed:
	// not reported as enforced, so the server re-sends them and the next
	// Flush retries.
	unapplied map[string]bool
	// banlistFile overrides the banlist location (tests); empty = next to the binary.
	banlistFile string
}

func (f *WindowsFirewall) Name() string { return "windows" }

func (f *WindowsFirewall) IsAvailable() bool {
	return fwHave("netsh")
}

// banlistPath returns the path to the persistent IP list file next to the agent binary.
func (f *WindowsFirewall) banlistPath() string {
	if f.banlistFile != "" {
		return f.banlistFile
	}
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "obliguard-banlist.txt")
}

// loadCache reads the banlist file into memory, then imports any legacy per-IP rules.
func (f *WindowsFirewall) loadCache() {
	if f.loaded {
		return
	}
	f.loaded = true
	f.cache = make(map[string]bool)

	// 1. Read from banlist file (source of truth). Lines are canonicalized,
	// so CRLF, blanks and garbage are tolerated.
	data, err := os.ReadFile(f.banlistPath())
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if k, _, err := canonicalBanEntry(line); err == nil {
				f.cache[k] = true
			}
		}
	}

	// 2. Also import any legacy per-IP rules still in the firewall
	legacyIPs := f.getLegacyIPs()
	if len(legacyIPs) > 0 {
		log.Printf("Firewall: importing %d legacy per-IP rules", len(legacyIPs))
		for _, ip := range legacyIPs {
			f.cache[ip] = true
		}
		f.dirty = true
	}

	if len(f.cache) > 0 {
		log.Printf("Firewall: loaded %d banned IPs", len(f.cache))
		// Rebuild the rules from the file at the first Flush (a previous run
		// may have stopped between the file and the rules).
		f.dirty = true
	}
}

func (f *WindowsFirewall) BanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loadCache()
	ip, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	if f.cache[ip] {
		if f.unapplied[ip] {
			f.dirty = true // re-sent after a failed rule update: retry
		}
		return nil
	}
	f.cache[ip] = true
	f.dirty = true
	return nil
}

func (f *WindowsFirewall) UnbanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loadCache()
	if k, _, err := canonicalBanEntry(ip); err == nil {
		ip = k
	}
	if !f.cache[ip] {
		return nil
	}
	delete(f.cache, ip)
	f.dirty = true
	return nil
}

// Flush writes all pending changes to both the banlist file AND the Windows Firewall.
func (f *WindowsFirewall) Flush() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loadCache()
	if !f.dirty {
		return nil
	}
	f.dirty = false

	// Build sorted IP list for deterministic chunking
	ips := make([]string, 0, len(f.cache))
	for ip := range f.cache {
		ips = append(ips, ip)
	}
	sort.Strings(ips)

	// 1. Persist to file (source of truth — survives crashes)
	f.saveBanlist(ips)

	// 2. Apply to Windows Firewall
	err := f.syncRules(ips)

	// 3. On the first flush only: remove stale groups left by a previous run
	// (more groups than now) and legacy per-IP rules.
	if !f.legacyCleaned {
		f.legacyCleaned = true
		f.cleanupStaleRules(len(chunkStrings(ips, maxIPsPerRule)))
	}

	if err != nil {
		f.dirty = true // retried at the next Flush
		return err
	}

	// 4. netsh now enforces the full list: drop WFP filters left by an
	// earlier WFP run (Windows only, once).
	if !f.wfpPurged && netshFallbackPurge != nil {
		f.wfpPurged = true
		netshFallbackPurge()
	}
	return nil
}

// GetBannedIPs returns the banned entries, minus those whose group could not
// be written at the last Flush.
func (f *WindowsFirewall) GetBannedIPs() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loadCache()
	var ips []string
	for ip := range f.cache {
		if !f.unapplied[ip] {
			ips = append(ips, ip)
		}
	}
	return ips, nil
}

func (f *WindowsFirewall) saveBanlist(ips []string) {
	data := strings.Join(ips, "\n")
	if len(ips) > 0 {
		data += "\n"
	}
	if err := writeFileAtomic(f.banlistPath(), []byte(data), 0644); err != nil {
		log.Printf("Firewall: failed to save banlist: %v", err)
	}
}

// writeFileAtomic writes data to a temporary file in the same directory,
// syncs it and renames it over path, so a crash never leaves a truncated
// file (os.Rename replaces the destination on Windows too).
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Chmod(name, mode); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// groupedRule is one desired block rule.
type groupedRule struct {
	name    string
	dir     string // "in" | "out"
	ipList  string
	entries []string
}

// desiredGroupedRules splits the sorted entries into the rule set.
func desiredGroupedRules(ips []string) []groupedRule {
	chunks := chunkStrings(ips, maxIPsPerRule)
	out := make([]groupedRule, 0, 2*len(chunks))
	for i, chunk := range chunks {
		suffix := ""
		if len(chunks) > 1 {
			suffix = fmt.Sprintf("-%d", i+1)
		}
		list := strings.Join(chunk, ",")
		out = append(out,
			groupedRule{name: winRuleIn + suffix, dir: "in", ipList: list, entries: chunk},
			groupedRule{name: winRuleOut + suffix, dir: "out", ipList: list, entries: chunk},
		)
	}
	return out
}

// syncRules converges the grouped rules on ips. The first call of a process
// recreates every group (state unknown); later calls only touch the groups
// whose list changed, updating them in place.
func (f *WindowsFirewall) syncRules(ips []string) error {
	first := f.appliedRules == nil
	if first {
		f.appliedRules = make(map[string]string)
	}
	unapplied := make(map[string]bool)
	desired := desiredGroupedRules(ips)
	want := make(map[string]bool, len(desired))
	updated, failed := 0, 0
	var firstErr error

	for _, r := range desired {
		want[r.name] = true
		prev, known := f.appliedRules[r.name]
		if known && prev == r.ipList {
			continue
		}
		if err := f.applyGroupedRule(r, known); err != nil {
			delete(f.appliedRules, r.name)
			for _, ip := range r.entries {
				unapplied[ip] = true
			}
			if firstErr == nil {
				firstErr = err
			}
			failed++
			continue
		}
		f.appliedRules[r.name] = r.ipList
		updated++
	}

	// Groups no longer needed (fewer entries, or single ↔ numbered naming).
	for name := range f.appliedRules {
		if want[name] {
			continue
		}
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+name)
		delete(f.appliedRules, name)
		updated++
	}
	// First sync with numbered groups: the base names of a previous
	// single-group run are not in appliedRules.
	if first && len(desired) > 2 {
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleIn)
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleOut)
	}

	f.unapplied = unapplied
	if updated > 0 || failed > 0 {
		log.Printf("Firewall: synced %d IPs (%d rules, %d updated, %d failed)", len(ips), len(desired), updated, failed)
	}
	if firstErr != nil {
		return fmt.Errorf("netsh: %d rule(s) not applied: %w", failed, firstErr)
	}
	return nil
}

// applyGroupedRule writes one group: in place when this process already
// created it (exists), otherwise delete + add. A failed in-place update
// (rule removed out of band) falls back to delete + add, which is retried.
func (f *WindowsFirewall) applyGroupedRule(r groupedRule, exists bool) error {
	if exists {
		if _, err := fwOutput("netsh", "advfirewall", "firewall", "set", "rule",
			"name="+r.name, "dir="+r.dir, "new", "remoteip="+r.ipList, "enable=yes",
		); err == nil {
			return nil
		}
	}
	fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+r.name)
	out, err := netshRetry("netsh", "advfirewall", "firewall", "add", "rule",
		"name="+r.name, "dir="+r.dir, "action=block",
		"remoteip="+r.ipList, "enable=yes",
		"description=Obliguard blocked IPs",
	)
	if err != nil {
		log.Printf("Firewall: rule %s FAILED: %v — %s", r.name, err, strings.TrimSpace(string(out)))
		return fmt.Errorf("rule %s: %w", r.name, err)
	}
	return nil
}

// netshRetry runs a netsh command, retrying after netshRetryDelays on failure.
func netshRetry(name string, args ...string) ([]byte, error) {
	out, err := fwOutput(name, args...)
	for i := 0; err != nil && i < len(netshRetryDelays); i++ {
		netshSleep(netshRetryDelays[i])
		out, err = fwOutput(name, args...)
	}
	return out, err
}

// cleanupStaleRules removes, once per process, the Obliguard-Block-* rules
// that are neither a current group nor kept: stale numbered groups from a run
// with more entries, base names from a single-group run, and legacy per-IP
// rules. When the rule list cannot be read, stale numbered groups are deleted
// by name instead (legacy rules are then left for the next start).
func (f *WindowsFirewall) cleanupStaleRules(groups int) {
	names, err := f.listObliguardRuleNames()
	if err != nil {
		log.Printf("Firewall: cannot list rules (%v) — deleting stale groups by name", err)
		start := groups + 1
		if groups <= 1 {
			start = 1 // the single group uses the base names
		}
		if groups == 0 {
			// Nothing banned: the base names of a single-group run go too.
			fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleIn)
			fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleOut)
		}
		f.deleteNumberedRulesFrom(start)
		return
	}
	for _, name := range names {
		if _, current := f.appliedRules[name]; current {
			continue
		}
		if isGroupedRuleName(name) {
			// A group of this process that failed is kept for the retry.
			if f.isDesiredGroupName(name, groups) {
				continue
			}
		}
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+name)
	}
}

// isDesiredGroupName reports whether name is one of the groups wanted for
// the given group count.
func (f *WindowsFirewall) isDesiredGroupName(name string, groups int) bool {
	if groups == 1 {
		return name == winRuleIn || name == winRuleOut
	}
	for i := 1; i <= groups; i++ {
		if name == fmt.Sprintf("%s-%d", winRuleIn, i) || name == fmt.Sprintf("%s-%d", winRuleOut, i) {
			return true
		}
	}
	return false
}

// deleteNumberedRulesFrom deletes Obliguard-Block-in/out-N for N ≥ start
// until 8 consecutive numbers are absent (bounded by netshStaleWalkMax).
func (f *WindowsFirewall) deleteNumberedRulesFrom(start int) {
	del := func(name string) bool {
		return fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+name) == nil
	}
	misses := 0
	for i := start; misses < 8 && i < start+netshStaleWalkMax; i++ {
		hit := del(fmt.Sprintf("%s-%d", winRuleIn, i))
		if del(fmt.Sprintf("%s-%d", winRuleOut, i)) {
			hit = true
		}
		if hit {
			misses = 0
		} else {
			misses++
		}
	}
}

// deleteGroupedRules removes all Obliguard-Block-in/out rules by exact name.
// It walks the numbered chunks (-1, -2, …) until several consecutive names are
// absent, so it scales to ANY chunk count — 34920 IPs at 500/rule = 70 chunks,
// which the old fixed -1..-50 limit left half-cleaned. Deletion is by known
// name only (no `netsh show rule` parse — that call is slow/unreliable on a
// huge ruleset and is exactly what made the WFP migration skip cleanup).
func (f *WindowsFirewall) deleteGroupedRules() {
	// netsh exits 0 when it removed ≥1 rule, non-zero ("No rules match") when
	// nothing matched → err==nil means a rule with that name was deleted.
	del := func(name string) bool {
		return fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+name) == nil
	}
	del(winRuleIn) // base names (single-chunk case)
	del(winRuleOut)
	misses := 0
	for i := 1; misses < 8 && i <= 100000; i++ {
		suffix := fmt.Sprintf("-%d", i)
		hit := del(winRuleIn + suffix)
		if del(winRuleOut + suffix) {
			hit = true
		}
		if hit {
			misses = 0
		} else {
			misses++
		}
	}
}

// cleanupLegacyRules deletes the old per-IP rules (Obliguard-Block-1-2-3-4-in),
// keeping the grouped ones.
func (f *WindowsFirewall) cleanupLegacyRules() {
	names, _ := f.listObliguardRuleNames()
	for _, name := range names {
		if isGroupedRuleName(name) {
			continue
		}
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+name)
	}
}

// listObliguardRuleNames lists the Obliguard-Block-* rules of both directions.
func (f *WindowsFirewall) listObliguardRuleNames() ([]string, error) {
	out, err := fwOutput("netsh", "advfirewall", "firewall", "show", "rule", "name=all")
	if err != nil {
		return nil, err
	}
	return parseNetshRuleNames(string(out)), nil
}

// parseNetshRuleNames extracts the Obliguard-Block-* rule names from
// "netsh advfirewall firewall show rule" output in any display language: it
// does not read the field labels ("Rule Name:", "Nom de la règle :",
// "Regelname:"…), only a value that starts with the prefix, is a single token
// and comes right after a label ending with a colon (ASCII or full-width) or
// alone on its line.
// Description lines ("Obliguard blocked IPs") and names mentioned inside a
// longer text never match.
func parseNetshRuleNames(out string) []string {
	seen := make(map[string]bool)
	var names []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, " \r\t")
		idx := strings.Index(line, winRulePrefix)
		if idx < 0 {
			continue
		}
		if idx > 0 {
			before := strings.TrimRight(line[:idx], " \t")
			if before != "" && !strings.HasSuffix(before, ":") && !strings.HasSuffix(before, "：") {
				continue
			}
		}
		name := line[idx:]
		if strings.ContainsAny(name, " \t,;") || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

// isGroupedRuleName reports whether name is one of the current grouped rules
// ("Obliguard-Block-in", "Obliguard-Block-out-3"), which the legacy cleanup
// must keep: only per-IP rules ("Obliguard-Block-1-2-3-4-in") are legacy.
func isGroupedRuleName(name string) bool {
	for _, base := range []string{winRuleIn, winRuleOut} {
		if name == base {
			return true
		}
		if n := strings.TrimPrefix(name, base+"-"); n != name && n != "" && strings.Trim(n, "0123456789") == "" {
			return true
		}
	}
	return false
}

// getLegacyIPs reads IPs from old-style per-IP rules (Obliguard-Block-A-B-C-D-*).
func (f *WindowsFirewall) getLegacyIPs() []string {
	out, err := fwOutput("netsh", "advfirewall", "firewall", "show", "rule",
		"name=all", "dir=in")
	if err != nil {
		return nil
	}
	seen := make(map[string]bool)
	var ips []string
	ipRe := ipPattern()
	for _, raw := range parseNetshRuleNames(string(out)) {
		if isGroupedRuleName(raw) {
			continue
		}
		raw = strings.TrimSuffix(raw, "-in")
		raw = strings.TrimSuffix(raw, "-out")
		ipDashes := strings.TrimPrefix(raw, winRulePrefix)
		ip := strings.ReplaceAll(ipDashes, "-", ".")
		if !ipRe.MatchString(ip) {
			continue
		}
		if k, _, err := canonicalBanEntry(ip); err == nil && !seen[k] {
			seen[k] = true
			ips = append(ips, k)
		}
	}
	return ips
}

// WindowsFirewall rate limiting is unsupported: firewall_ratelimit_windows.go
// and firewall_ratelimit_other.go are both no-ops (owner decision 23, no
// WinDivert). The backend does not advertise the 'ratelimit' capability, so
// the server shows rate limiting as unsupported for this agent.
