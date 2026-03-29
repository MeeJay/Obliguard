package main

import (
	"fmt"
	"log"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

// ── FirewallManager interface ─────────────────────────────────────────────────

// FirewallManager abstracts platform-specific firewall operations.
type FirewallManager interface {
	// BanIP adds DROP rules (inbound + outbound) for the given IP.
	BanIP(ip string) error
	// UnbanIP removes all Obliguard rules for the given IP.
	UnbanIP(ip string) error
	// GetBannedIPs returns the list of IPs currently banned by Obliguard.
	GetBannedIPs() ([]string, error)
	// IsAvailable returns true if this firewall backend is usable.
	IsAvailable() bool
	// Name returns the backend identifier string (sent in push body).
	Name() string
}

// ── Auto-detection ────────────────────────────────────────────────────────────

// DetectFirewall probes available firewall backends and returns the best one.
// Priority on Linux: nftables → firewalld → ufw → iptables
// Windows: Windows Defender Firewall (netsh)
// macOS: pf
func DetectFirewall() FirewallManager {
	switch runtime.GOOS {
	case "windows":
		fw := &WindowsFirewall{}
		if fw.IsAvailable() {
			return fw
		}
		return &NoOpFirewall{}

	case "darwin":
		fw := &PFFirewall{}
		if fw.IsAvailable() {
			return fw
		}
		return &NoOpFirewall{}

	case "freebsd":
		fw := &FreeBSDPFFirewall{}
		if fw.IsAvailable() {
			log.Printf("Firewall: using %s", fw.Name())
			return fw
		}
		log.Printf("Firewall: pf not available — bans will not be enforced locally")
		return &NoOpFirewall{}

	default: // Linux + others
		candidates := []FirewallManager{
			&NftablesFirewall{},
			&FirewalldFirewall{},
			&UFWFirewall{},
			&IptablesFirewall{},
		}
		for _, fw := range candidates {
			if fw.IsAvailable() {
				log.Printf("Firewall: using %s", fw.Name())
				return fw
			}
		}
		log.Printf("Firewall: no supported backend found — bans will not be enforced locally")
		return &NoOpFirewall{}
	}
}

// ── nftables (set-based — single rule matches all IPs) ──────────────────────
//
// Strategy: one nftables set "obliguard_ips" holds all banned IPs.
// Two rules (inbound + outbound) match the set. Ban/unban = add/delete from set.
// Result: 2 rules total regardless of IP count.

const nftTable    = "obliguard"
const nftSet      = "obliguard_ips"
const nftChain    = "blocklist"
const nftChainOut = "blocklist_out"

type NftablesFirewall struct{ initialized bool }

func (f *NftablesFirewall) Name() string { return "nftables" }

func (f *NftablesFirewall) IsAvailable() bool {
	_, err := exec.LookPath("nft")
	return err == nil
}

func (f *NftablesFirewall) ensureTable() error {
	if f.initialized {
		return nil
	}
	// Create table, set, chains, and rules idempotently.
	// nft 'add' is idempotent — re-adding existing objects is a no-op.
	cmds := []string{
		fmt.Sprintf("add table inet %s", nftTable),
		fmt.Sprintf("add set inet %s %s { type ipv4_addr; }", nftTable, nftSet),
		fmt.Sprintf("add chain inet %s %s { type filter hook input priority -10; policy accept; }", nftTable, nftChain),
		fmt.Sprintf("add chain inet %s %s { type filter hook output priority -10; policy accept; }", nftTable, nftChainOut),
	}
	for _, c := range cmds {
		exec.Command("nft", strings.Fields(c)...).Run() // ignore errors (already exists)
	}
	// Add set-matching rules (flush first to avoid duplicates)
	exec.Command("nft", "flush", "chain", "inet", nftTable, nftChain).Run()
	exec.Command("nft", "flush", "chain", "inet", nftTable, nftChainOut).Run()
	ruleIn := fmt.Sprintf("add rule inet %s %s ip saddr @%s drop", nftTable, nftChain, nftSet)
	ruleOut := fmt.Sprintf("add rule inet %s %s ip daddr @%s drop", nftTable, nftChainOut, nftSet)
	exec.Command("nft", strings.Fields(ruleIn)...).Run()
	exec.Command("nft", strings.Fields(ruleOut)...).Run()
	f.initialized = true
	return nil
}

func (f *NftablesFirewall) BanIP(ip string) error {
	if err := f.ensureTable(); err != nil {
		return err
	}
	cmd := fmt.Sprintf("add element inet %s %s { %s }", nftTable, nftSet, ip)
	return exec.Command("nft", strings.Fields(cmd)...).Run()
}

func (f *NftablesFirewall) UnbanIP(ip string) error {
	cmd := fmt.Sprintf("delete element inet %s %s { %s }", nftTable, nftSet, ip)
	exec.Command("nft", strings.Fields(cmd)...).Run() // ignore error if not in set
	return nil
}

func (f *NftablesFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("nft", "list", "set", "inet", nftTable, nftSet).Output()
	if err != nil {
		return nil, nil
	}
	// Output format: "elements = { 1.2.3.4, 5.6.7.8 }"
	var ips []string
	ipRe := ipPattern()
	for _, m := range ipRe.FindAllString(string(out), -1) {
		ips = append(ips, m)
	}
	return ips, nil
}

// ── firewalld ─────────────────────────────────────────────────────────────────

type FirewalldFirewall struct{}

func (f *FirewalldFirewall) Name() string { return "firewalld" }

func (f *FirewalldFirewall) IsAvailable() bool {
	out, err := exec.Command("firewall-cmd", "--state").Output()
	return err == nil && strings.TrimSpace(string(out)) == "running"
}

func (f *FirewalldFirewall) BanIP(ip string) error {
	ruleIn := fmt.Sprintf("rule family=ipv4 source address=%s drop", ip)
	ruleOut := fmt.Sprintf("rule family=ipv4 destination address=%s drop", ip)
	exec.Command("firewall-cmd", "--permanent", fmt.Sprintf("--add-rich-rule=%s", ruleIn)).Run()
	exec.Command("firewall-cmd", "--permanent", fmt.Sprintf("--add-rich-rule=%s", ruleOut)).Run()
	return exec.Command("firewall-cmd", "--reload").Run()
}

func (f *FirewalldFirewall) UnbanIP(ip string) error {
	ruleIn := fmt.Sprintf("rule family=ipv4 source address=%s drop", ip)
	ruleOut := fmt.Sprintf("rule family=ipv4 destination address=%s drop", ip)
	exec.Command("firewall-cmd", "--permanent", fmt.Sprintf("--remove-rich-rule=%s", ruleIn)).Run()
	exec.Command("firewall-cmd", "--permanent", fmt.Sprintf("--remove-rich-rule=%s", ruleOut)).Run()
	return exec.Command("firewall-cmd", "--reload").Run()
}

func (f *FirewalldFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("firewall-cmd", "--list-rich-rules").Output()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "drop") {
			if m := ipRe.FindString(line); m != "" && !seen[m] {
				seen[m] = true
				ips = append(ips, m)
			}
		}
	}
	return ips, nil
}

// ── UFW ───────────────────────────────────────────────────────────────────────

type UFWFirewall struct{}

func (f *UFWFirewall) Name() string { return "ufw" }

func (f *UFWFirewall) IsAvailable() bool {
	out, err := exec.Command("ufw", "status").Output()
	return err == nil && strings.Contains(string(out), "Status: active")
}

func (f *UFWFirewall) BanIP(ip string) error {
	exec.Command("ufw", "insert", "1", "deny", "from", ip, "to", "any").Run()
	return exec.Command("ufw", "insert", "1", "deny", "out", "from", "any", "to", ip).Run()
}

func (f *UFWFirewall) UnbanIP(ip string) error {
	exec.Command("ufw", "delete", "deny", "from", ip, "to", "any").Run()
	exec.Command("ufw", "delete", "deny", "out", "from", "any", "to", ip).Run()
	return nil
}

func (f *UFWFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("ufw", "status", "numbered").Output()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(strings.ToUpper(line), "DENY") {
			if m := ipRe.FindString(line); m != "" && !seen[m] {
				seen[m] = true
				ips = append(ips, m)
			}
		}
	}
	return ips, nil
}

// ── iptables (ipset-based if available, fallback to chain rules) ─────────────
//
// Strategy: if ipset is available, use a hash:ip set "obliguard" with two
// iptables rules matching the set. Otherwise, fall back to individual chain rules.

const iptChain    = "OBLIGUARD"
const iptChainOut = "OBLIGUARD_OUT"
const iptSetName  = "obliguard"

type IptablesFirewall struct {
	initialized bool
	hasIpset    bool
}

func (f *IptablesFirewall) Name() string { return "iptables" }

func (f *IptablesFirewall) IsAvailable() bool {
	_, err := exec.LookPath("iptables")
	return err == nil
}

func (f *IptablesFirewall) ensureChain() error {
	if f.initialized {
		return nil
	}
	// Check for ipset support
	_, ipsetErr := exec.LookPath("ipset")
	f.hasIpset = ipsetErr == nil

	if f.hasIpset {
		// Create ipset (ignore error if already exists)
		exec.Command("ipset", "create", iptSetName, "hash:ip", "-exist").Run()
		// Create chains
		exec.Command("iptables", "-N", iptChain).Run()
		exec.Command("iptables", "-N", iptChainOut).Run()
		// Hook chains into INPUT/OUTPUT
		if exec.Command("iptables", "-C", "INPUT", "-j", iptChain).Run() != nil {
			exec.Command("iptables", "-I", "INPUT", "1", "-j", iptChain).Run()
		}
		if exec.Command("iptables", "-C", "OUTPUT", "-j", iptChainOut).Run() != nil {
			exec.Command("iptables", "-I", "OUTPUT", "1", "-j", iptChainOut).Run()
		}
		// Flush chains and add set-matching rules
		exec.Command("iptables", "-F", iptChain).Run()
		exec.Command("iptables", "-F", iptChainOut).Run()
		exec.Command("iptables", "-A", iptChain, "-m", "set", "--match-set", iptSetName, "src", "-j", "DROP").Run()
		exec.Command("iptables", "-A", iptChainOut, "-m", "set", "--match-set", iptSetName, "dst", "-j", "DROP").Run()
	} else {
		// Fallback: individual rules in custom chains
		exec.Command("iptables", "-N", iptChain).Run()
		if exec.Command("iptables", "-C", "INPUT", "-j", iptChain).Run() != nil {
			exec.Command("iptables", "-I", "INPUT", "1", "-j", iptChain).Run()
		}
		exec.Command("iptables", "-N", iptChainOut).Run()
		if exec.Command("iptables", "-C", "OUTPUT", "-j", iptChainOut).Run() != nil {
			exec.Command("iptables", "-I", "OUTPUT", "1", "-j", iptChainOut).Run()
		}
	}
	f.initialized = true
	return nil
}

func (f *IptablesFirewall) BanIP(ip string) error {
	_ = f.ensureChain()
	if f.hasIpset {
		return exec.Command("ipset", "add", iptSetName, ip, "-exist").Run()
	}
	exec.Command("iptables", "-A", iptChain, "-s", ip, "-j", "DROP").Run()
	return exec.Command("iptables", "-A", iptChainOut, "-d", ip, "-j", "DROP").Run()
}

func (f *IptablesFirewall) UnbanIP(ip string) error {
	if f.hasIpset {
		exec.Command("ipset", "del", iptSetName, ip, "-exist").Run()
		return nil
	}
	exec.Command("iptables", "-D", iptChain, "-s", ip, "-j", "DROP").Run()
	exec.Command("iptables", "-D", iptChainOut, "-d", ip, "-j", "DROP").Run()
	return nil
}

func (f *IptablesFirewall) GetBannedIPs() ([]string, error) {
	if f.hasIpset {
		out, err := exec.Command("ipset", "list", iptSetName).Output()
		if err != nil {
			return nil, nil
		}
		var ips []string
		ipRe := ipPattern()
		inMembers := false
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(line, "Members:") {
				inMembers = true
				continue
			}
			if inMembers {
				if m := ipRe.FindString(line); m != "" {
					ips = append(ips, m)
				}
			}
		}
		return ips, nil
	}
	out, err := exec.Command("iptables", "-L", iptChain, "-n").Output()
	if err != nil {
		return nil, nil
	}
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "DROP") {
			if m := ipRe.FindString(line); m != "" {
				ips = append(ips, m)
			}
		}
	}
	return ips, nil
}

// ── Windows Firewall (single rule with comma-separated IPs) ─────────────────
//
// Strategy: two rules total — "Obliguard-Block-in" and "Obliguard-Block-out".
// Each rule's remoteip field is a comma-separated list of all banned IPs.
// Ban = add IP to the list. Unban = remove IP from the list.
// Result: 2 rules total regardless of IP count.

const winRuleIn  = "Obliguard-Block-in"
const winRuleOut = "Obliguard-Block-out"
const winRulePrefix = "Obliguard-Block-" // kept for legacy cleanup

type WindowsFirewall struct {
	migrated bool // true after legacy per-IP rules have been consolidated
}

func (f *WindowsFirewall) Name() string { return "windows" }

func (f *WindowsFirewall) IsAvailable() bool {
	_, err := exec.LookPath("netsh")
	return err == nil
}

func (f *WindowsFirewall) BanIP(ip string) error {
	f.ensureMigrated()
	current, _ := f.GetBannedIPs()
	for _, existing := range current {
		if existing == ip {
			return nil
		}
	}
	newList := append(current, ip)
	return f.syncRules(newList)
}

// ensureMigrated consolidates legacy per-IP rules into the grouped rules on first run.
func (f *WindowsFirewall) ensureMigrated() {
	if f.migrated {
		return
	}
	f.migrated = true

	// Collect all IPs from legacy per-IP rules
	legacyIPs := f.getLegacyIPs()
	if len(legacyIPs) == 0 {
		return
	}

	log.Printf("Firewall: migrating %d legacy per-IP rules to grouped rules...", len(legacyIPs))

	// Also get any IPs already in the grouped rule
	groupedIPs := f.getGroupedIPs()
	seen := make(map[string]bool)
	var allIPs []string
	for _, ip := range groupedIPs {
		if !seen[ip] {
			seen[ip] = true
			allIPs = append(allIPs, ip)
		}
	}
	for _, ip := range legacyIPs {
		if !seen[ip] {
			seen[ip] = true
			allIPs = append(allIPs, ip)
		}
	}

	// Create the grouped rules
	if len(allIPs) > 0 {
		f.syncRules(allIPs)
	}

	// Delete ALL legacy per-IP rules
	f.cleanupLegacyRules()
	log.Printf("Firewall: migration complete — %d IPs in 2 grouped rules", len(allIPs))
}

func (f *WindowsFirewall) UnbanIP(ip string) error {
	f.ensureMigrated()
	current := f.getGroupedIPs()
	var newList []string
	found := false
	for _, existing := range current {
		if existing == ip {
			found = true
		} else {
			newList = append(newList, existing)
		}
	}
	if !found {
		return nil // IP wasn't in the list
	}
	if len(newList) == 0 {
		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleIn).Run()
		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleOut).Run()
		return nil
	}
	return f.syncRules(newList)
}

// syncRules creates or updates the two Obliguard rules with the given IP list.
func (f *WindowsFirewall) syncRules(ips []string) error {
	if len(ips) == 0 {
		return nil
	}
	ipList := strings.Join(ips, ",")

	// Delete and recreate (netsh doesn't support modifying remoteip on existing rules reliably)
	exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleIn).Run()
	exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleOut).Run()

	if err := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
		"name="+winRuleIn, "dir=in", "action=block",
		"remoteip="+ipList, "enable=yes",
		"description=Obliguard blocked IPs",
	).Run(); err != nil {
		return fmt.Errorf("add inbound rule: %w", err)
	}

	if err := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
		"name="+winRuleOut, "dir=out", "action=block",
		"remoteip="+ipList, "enable=yes",
		"description=Obliguard blocked IPs",
	).Run(); err != nil {
		return fmt.Errorf("add outbound rule: %w", err)
	}

	// Clean up legacy per-IP rules from old versions
	f.cleanupLegacyRules()
	return nil
}

// cleanupLegacyRules removes old-style per-IP rules (Obliguard-Block-A-B-C-D-*)
func (f *WindowsFirewall) cleanupLegacyRules() {
	out, _ := exec.Command("netsh", "advfirewall", "firewall", "show", "rule", "name=all", "dir=in").Output()
	for _, line := range strings.Split(string(out), "\n") {
		idx := strings.Index(line, winRulePrefix)
		if idx < 0 {
			continue
		}
		raw := strings.TrimRight(line[idx:], " \r\n\t")
		// Skip the new grouped rules
		if raw == winRuleIn || raw == winRuleOut {
			continue
		}
		// Delete any legacy per-IP rule
		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+raw).Run()
	}
}

func (f *WindowsFirewall) GetBannedIPs() ([]string, error) {
	f.ensureMigrated()
	grouped := f.getGroupedIPs()
	legacy := f.getLegacyIPs()

	seen := make(map[string]bool)
	var all []string
	for _, ip := range grouped {
		if !seen[ip] {
			seen[ip] = true
			all = append(all, ip)
		}
	}
	for _, ip := range legacy {
		if !seen[ip] {
			seen[ip] = true
			all = append(all, ip)
		}
	}
	return all, nil
}

// getGroupedIPs reads IPs from the grouped "Obliguard-Block-in" rule.
func (f *WindowsFirewall) getGroupedIPs() []string {
	out, err := exec.Command("netsh", "advfirewall", "firewall", "show", "rule",
		"name="+winRuleIn, "verbose").Output()
	if err != nil {
		return nil
	}
	// Find the line containing RemoteIP — it has IPs separated by commas.
	// The field name varies by locale, but the value line follows a pattern:
	// IPs are on a line that contains dots and commas (e.g. "1.2.3.4,5.6.7.8")
	// or after a label like "RemoteIP:" / "Adresse IP distante:"
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		trimmed := strings.TrimSpace(line)
		// Skip empty lines and lines that are just labels
		if trimmed == "" || trimmed == "Any" || trimmed == "Quelconque" {
			continue
		}
		// Look for a line with multiple IPs (comma-separated)
		ips := ipRe.FindAllString(trimmed, -1)
		if len(ips) >= 1 && strings.Contains(trimmed, ".") {
			// Verify this isn't a subnet mask or version number line
			// by checking at least one result has 4 octets
			if ipRe.MatchString(ips[0]) {
				return ips
			}
		}
	}
	return nil
}

// getLegacyIPs reads IPs from old-style per-IP rules (Obliguard-Block-A-B-C-D-*).
func (f *WindowsFirewall) getLegacyIPs() []string {
	out, err := exec.Command("netsh", "advfirewall", "firewall", "show", "rule",
		"name=all", "dir=in").Output()
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
		// Skip the new grouped rules
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

// ── macOS pf ──────────────────────────────────────────────────────────────────

const pfAnchor = "obliguard"
const pfTable  = "obliguard_blocklist"

type PFFirewall struct{ anchorFile string }

func (f *PFFirewall) Name() string { return "macos_pf" }

func (f *PFFirewall) IsAvailable() bool {
	_, err := exec.LookPath("pfctl")
	return err == nil
}

func (f *PFFirewall) BanIP(ip string) error {
	return exec.Command("pfctl", "-t", pfTable, "-T", "add", ip).Run()
}

func (f *PFFirewall) UnbanIP(ip string) error {
	return exec.Command("pfctl", "-t", pfTable, "-T", "delete", ip).Run()
}

func (f *PFFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("pfctl", "-t", pfTable, "-T", "show").Output()
	if err != nil {
		return nil, nil
	}
	var ips []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			ips = append(ips, line)
		}
	}
	return ips, nil
}

// ── FreeBSD pf (table-based, OPNsense-friendly) ─────────────────────────────

const freebsdPFTable = "obliguard_blocklist"

type FreeBSDPFFirewall struct{}

func (f *FreeBSDPFFirewall) Name() string { return "freebsd_pf" }

func (f *FreeBSDPFFirewall) IsAvailable() bool {
	if _, err := exec.LookPath("pfctl"); err != nil {
		return false
	}
	out, err := exec.Command("pfctl", "-si").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "Status: Enabled")
}

func (f *FreeBSDPFFirewall) BanIP(ip string) error {
	f.ensureTable()
	return exec.Command("pfctl", "-t", freebsdPFTable, "-T", "add", ip).Run()
}

func (f *FreeBSDPFFirewall) UnbanIP(ip string) error {
	return exec.Command("pfctl", "-t", freebsdPFTable, "-T", "delete", ip).Run()
}

func (f *FreeBSDPFFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("pfctl", "-t", freebsdPFTable, "-T", "show").Output()
	if err != nil {
		return nil, nil
	}
	var ips []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			ips = append(ips, line)
		}
	}
	return ips, nil
}

func (f *FreeBSDPFFirewall) ensureTable() {
	cmd := exec.Command("pfctl", "-a", "obliguard", "-t", freebsdPFTable, "-T", "show")
	if cmd.Run() == nil {
		return
	}
	if exec.Command("pfctl", "-t", freebsdPFTable, "-T", "show").Run() == nil {
		return
	}
	rules := fmt.Sprintf("table <%s> persist\nblock in quick from <%s>\nblock out quick to <%s>\n",
		freebsdPFTable, freebsdPFTable, freebsdPFTable)
	anchorCmd := exec.Command("pfctl", "-a", "obliguard", "-f", "-")
	anchorCmd.Stdin = strings.NewReader(rules)
	if err := anchorCmd.Run(); err != nil {
		log.Printf("Firewall: pf anchor init warning: %v", err)
	}
}

// ── No-op (fallback when no firewall is available) ────────────────────────────

type NoOpFirewall struct{}

func (f *NoOpFirewall) Name() string                    { return "none" }
func (f *NoOpFirewall) IsAvailable() bool               { return true }
func (f *NoOpFirewall) BanIP(ip string) error           { return nil }
func (f *NoOpFirewall) UnbanIP(ip string) error         { return nil }
func (f *NoOpFirewall) GetBannedIPs() ([]string, error) { return nil, nil }

// ── Shared helper ─────────────────────────────────────────────────────────────

func ipPattern() *regexp.Regexp {
	return regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`)
}
