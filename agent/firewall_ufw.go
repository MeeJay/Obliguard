package main

import (
	"log"
	"strings"
	"sync"
)

// ── UFW (uses ipset under the hood if available) ─────────────────────────────
//
// UFW doesn't support ipsets natively. When ipset is available, we bypass ufw
// and inject iptables rules matching the ipset directly. This scales to 30K+ IPs.
// The set is hash:net, so hosts and CIDR networks share it (shared helpers in
// firewall_iptables.go). Fallback: individual ufw deny rules, one per entry
// (`ufw deny from 1.2.3.0/24` accepts CIDR; slow for large sets).

const ufwSetName = "obliguard"

type UFWFirewall struct {
	// mu serializes the ban goroutine and the heartbeat (see IptablesFirewall).
	mu          sync.Mutex
	hasIpset    bool
	initialized bool
	cidrOK      bool
	pendingAdd  []string
	pendingDel  []string
}

func (f *UFWFirewall) Name() string { return "ufw" }

func (f *UFWFirewall) IsAvailable() bool {
	out, err := fwOutput("ufw", "status")
	return err == nil && strings.Contains(string(out), "Status: active")
}

// ufwRebind moves the INPUT/OUTPUT set rules from one set to another, adding
// the new rules before removing the old ones.
func ufwRebind(from, to string) {
	fwRun("iptables", "-I", "INPUT", "1", "-m", "set", "--match-set", to, "src", "-j", "DROP")
	fwRun("iptables", "-I", "OUTPUT", "1", "-m", "set", "--match-set", to, "dst", "-j", "DROP")
	fwRun("iptables", "-D", "INPUT", "-m", "set", "--match-set", from, "src", "-j", "DROP")
	fwRun("iptables", "-D", "OUTPUT", "-m", "set", "--match-set", from, "dst", "-j", "DROP")
}

// init is always called with f.mu held.
func (f *UFWFirewall) init() {
	if f.initialized {
		return
	}
	f.initialized = true
	f.hasIpset = fwHave("ipset")
	if !f.hasIpset {
		f.cidrOK = true // ufw rules accept CIDR
		return
	}
	// hash:net set (migrated in place from an older hash:ip set).
	f.cidrOK = ensureIpsetNet(ufwSetName, ufwRebind)
	// Add iptables rules matching the ipset (bypass ufw for performance)
	if fwRun("iptables", "-C", "INPUT", "-m", "set", "--match-set", ufwSetName, "src", "-j", "DROP") != nil {
		fwRun("iptables", "-I", "INPUT", "1", "-m", "set", "--match-set", ufwSetName, "src", "-j", "DROP")
	}
	if fwRun("iptables", "-C", "OUTPUT", "-m", "set", "--match-set", ufwSetName, "dst", "-j", "DROP") != nil {
		fwRun("iptables", "-I", "OUTPUT", "1", "-m", "set", "--match-set", ufwSetName, "dst", "-j", "DROP")
	}
	// Migrate legacy per-IP ufw rules into ipset
	f.migrateLegacyUfwRules()
}

// SupportsCIDR implements cidrSupporter.
func (f *UFWFirewall) SupportsCIDR() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	return f.cidrOK
}

func (f *UFWFirewall) BanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	if f.hasIpset {
		k, err := iptEntry(ip, f.cidrOK)
		if err != nil {
			return err
		}
		f.pendingAdd = append(f.pendingAdd, k)
		return nil
	}
	k, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	fwRun("ufw", "insert", "1", "deny", "from", k, "to", "any")
	return fwRun("ufw", "insert", "1", "deny", "out", "from", "any", "to", k)
}

func (f *UFWFirewall) UnbanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	k, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	if f.hasIpset {
		f.pendingDel = append(f.pendingDel, k)
		return nil
	}
	fwRun("ufw", "delete", "deny", "from", k, "to", "any")
	fwRun("ufw", "delete", "deny", "out", "from", "any", "to", k)
	return nil
}

func (f *UFWFirewall) Flush() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.hasIpset {
		return nil
	}
	ipsetApply(ufwSetName, f.pendingAdd, f.pendingDel)
	f.pendingAdd = nil
	f.pendingDel = nil
	return nil
}

func (f *UFWFirewall) GetBannedIPs() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	if f.hasIpset {
		members, err := ipsetMembers(ufwSetName)
		if err != nil {
			return nil, nil
		}
		return members, nil
	}
	out, err := fwOutput("ufw", "status", "numbered")
	if err != nil {
		return nil, err
	}
	return parseUfwDenyEntries(string(out), false), nil
}

// parseUfwDenyEntries returns the first address or network of every DENY line
// of `ufw status numbered` ("[ 1] Anywhere  DENY IN  1.2.3.0/24"). hostsOnly
// keeps single addresses only.
func parseUfwDenyEntries(out string, hostsOnly bool) []string {
	seen := make(map[string]bool)
	var res []string
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(strings.ToUpper(line), "DENY") {
			continue
		}
		entries := parseBanEntries(line)
		if len(entries) == 0 {
			continue
		}
		k := entries[0]
		if hostsOnly && strings.Contains(k, "/") {
			continue
		}
		if !seen[k] {
			seen[k] = true
			res = append(res, k)
		}
	}
	return res
}

// migrateLegacyUfwRules removes individual "deny from X.X.X.X" ufw rules
// and imports their IPs into the ipset. Only single-address rules are taken:
// a network rule is more likely an admin's own and is left alone.
func (f *UFWFirewall) migrateLegacyUfwRules() {
	out, err := fwOutput("ufw", "status", "numbered")
	if err != nil {
		return
	}
	var legacyIPs []string
	for _, ip := range parseUfwDenyEntries(string(out), true) {
		if ipPattern().MatchString(ip) {
			legacyIPs = append(legacyIPs, ip)
		}
	}
	if len(legacyIPs) == 0 {
		return
	}
	log.Printf("Firewall: migrating %d legacy ufw rules to ipset...", len(legacyIPs))
	// Add all IPs to ipset first
	for _, ip := range legacyIPs {
		fwRun("ipset", "add", ufwSetName, ip, "-exist")
	}
	// Delete legacy ufw rules (delete from bottom to top to keep numbering stable)
	for i := len(legacyIPs) - 1; i >= 0; i-- {
		ip := legacyIPs[i]
		fwRun("ufw", "--force", "delete", "deny", "from", ip, "to", "any")
		fwRun("ufw", "--force", "delete", "deny", "out", "from", "any", "to", ip)
	}
	log.Printf("Firewall: migration complete — %d IPs moved to ipset", len(legacyIPs))
}

// UFW sits on iptables and already injects raw iptables rules for its bans, so
// rate limiting reuses the shared iptables path (connection/rate; volume needs tc).
func (f *UFWFirewall) IsRateLimitSupported() bool { return true }
func (f *UFWFirewall) ApplyRateLimits(rules []RateLimitRule) error {
	return applyIptablesRateLimits(rules)
}
