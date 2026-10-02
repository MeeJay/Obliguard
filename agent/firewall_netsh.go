package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ── Windows Firewall (single rule with comma-separated IPs) ─────────────────
//
// Strategy: two rules total — "Obliguard-Block-in" and "Obliguard-Block-out".
// Each rule's remoteip field is a comma-separated list of all banned IPs.
// Ban = add IP to the list. Unban = remove IP from the list.
// Result: 2 rules total regardless of IP count.
//
// remoteip accepts CIDR natively, so networks ("1.2.3.0/24") sit in the same
// list as single addresses. Entries are kept in canonical form (see
// canonicalBanEntry) so GetBannedIPs returns exactly what the server sent.

const winRuleIn = "Obliguard-Block-in"
const winRuleOut = "Obliguard-Block-out"
const winRulePrefix = "Obliguard-Block-" // kept for legacy cleanup

type WindowsFirewall struct {
	cache         map[string]bool
	dirty         bool
	loaded        bool
	legacyCleaned bool
	// Track which chunks are currently applied (hash per chunk index)
	appliedChunks map[int]string
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

	// 1. Read from banlist file (source of truth)
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
	}
}

func (f *WindowsFirewall) BanIP(ip string) error {
	f.loadCache()
	ip, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	if f.cache[ip] {
		return nil
	}
	f.cache[ip] = true
	f.dirty = true
	return nil
}

func (f *WindowsFirewall) UnbanIP(ip string) error {
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
	if len(ips) == 0 {
		f.deleteGroupedRules()
	} else {
		f.syncRules(ips)
	}

	// 3. Clean up legacy per-IP rules on first flush only
	if !f.legacyCleaned {
		f.legacyCleaned = true
		f.cleanupLegacyRules()
	}
	return nil
}

func (f *WindowsFirewall) GetBannedIPs() ([]string, error) {
	f.loadCache()
	var ips []string
	for ip := range f.cache {
		ips = append(ips, ip)
	}
	return ips, nil
}

func (f *WindowsFirewall) saveBanlist(ips []string) {
	data := strings.Join(ips, "\n") + "\n"
	if err := os.WriteFile(f.banlistPath(), []byte(data), 0644); err != nil {
		log.Printf("Firewall: failed to save banlist: %v", err)
	}
}

// maxIPsPerRule — conservative limit for Windows Firewall reliability.
// netsh can fail silently with large remoteip lists; 500 is safe.
const maxIPsPerRule = 500

func (f *WindowsFirewall) syncRules(ips []string) error {
	if f.appliedChunks == nil {
		f.appliedChunks = make(map[int]string)
	}

	chunks := chunkStrings(ips, maxIPsPerRule)
	updated := 0

	for i, chunk := range chunks {
		ipList := strings.Join(chunk, ",")
		if f.appliedChunks[i] == ipList {
			continue
		}

		suffix := ""
		if len(chunks) > 1 {
			suffix = fmt.Sprintf("-%d", i+1)
		}
		nameIn := winRuleIn + suffix
		nameOut := winRuleOut + suffix

		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+nameIn)
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+nameOut)

		if out, err := fwOutput("netsh", "advfirewall", "firewall", "add", "rule",
			"name="+nameIn, "dir=in", "action=block",
			"remoteip="+ipList, "enable=yes",
			"description=Obliguard blocked IPs",
		); err != nil {
			log.Printf("Firewall: rule %s FAILED: %v — %s", nameIn, err, strings.TrimSpace(string(out)))
		}
		if out, err := fwOutput("netsh", "advfirewall", "firewall", "add", "rule",
			"name="+nameOut, "dir=out", "action=block",
			"remoteip="+ipList, "enable=yes",
			"description=Obliguard blocked IPs",
		); err != nil {
			log.Printf("Firewall: rule %s FAILED: %v — %s", nameOut, err, strings.TrimSpace(string(out)))
		}

		f.appliedChunks[i] = ipList
		updated++
	}

	// Delete any extra chunks from previous syncs (if IP count decreased)
	for i := len(chunks); i < len(chunks)+50; i++ {
		key := i
		if _, ok := f.appliedChunks[key]; !ok {
			break // no more old chunks
		}
		suffix := fmt.Sprintf("-%d", i+1)
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleIn+suffix)
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleOut+suffix)
		delete(f.appliedChunks, key)
		updated++
	}
	// Clean base name (no suffix) if we use numbered chunks
	if len(chunks) > 1 {
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleIn)
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleOut)
	}

	if updated > 0 {
		log.Printf("Firewall: synced %d IPs (%d chunks, %d updated)", len(ips), len(chunks), updated)
	}
	return nil
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

func (f *WindowsFirewall) cleanupLegacyRules() {
	out, _ := fwOutput("netsh", "advfirewall", "firewall", "show", "rule", "name=all", "dir=in")
	for _, line := range strings.Split(string(out), "\n") {
		idx := strings.Index(line, winRulePrefix)
		if idx < 0 {
			continue
		}
		raw := strings.TrimRight(line[idx:], " \r\n\t")
		if raw == winRuleIn || raw == winRuleOut {
			continue
		}
		fwRun("netsh", "advfirewall", "firewall", "delete", "rule", "name="+raw)
	}
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
	for _, line := range strings.Split(string(out), "\n") {
		idx := strings.Index(line, winRulePrefix)
		if idx < 0 {
			continue
		}
		raw := strings.TrimRight(line[idx:], " \r\n\t")
		if raw == winRuleIn || raw == winRuleOut {
			continue
		}
		raw = strings.TrimSuffix(raw, "-in")
		raw = strings.TrimSuffix(raw, "-out")
		ipDashes := strings.TrimPrefix(raw, winRulePrefix)
		ip := strings.ReplaceAll(ipDashes, "-", ".")
		if ipRe.MatchString(ip) && !seen[ip] {
			seen[ip] = true
			ips = append(ips, ip)
		}
	}
	return ips
}

// WindowsFirewall rate limiting lives in firewall_ratelimit_windows.go (real,
// WinDivert-based) and firewall_ratelimit_other.go (no-op on non-Windows).
