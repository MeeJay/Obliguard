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

// ── nftables ──────────────────────────────────────────────────────────────────

const nftTable = "obliguard"
const nftChain = "blocklist"
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
	cmds := []string{
		fmt.Sprintf("add table inet %s", nftTable),
		fmt.Sprintf("add chain inet %s %s { type filter hook input priority -10; policy accept; }", nftTable, nftChain),
		fmt.Sprintf("add chain inet %s %s { type filter hook output priority -10; policy accept; }", nftTable, nftChainOut),
	}
	for _, c := range cmds {
		if err := exec.Command("nft", strings.Fields(c)...).Run(); err != nil {
			return err
		}
	}
	f.initialized = true
	return nil
}

func (f *NftablesFirewall) BanIP(ip string) error {
	if err := f.ensureTable(); err != nil {
		return err
	}
	ruleIn := fmt.Sprintf("add rule inet %s %s ip saddr %s drop comment \"obliguard\"", nftTable, nftChain, ip)
	ruleOut := fmt.Sprintf("add rule inet %s %s ip daddr %s drop comment \"obliguard\"", nftTable, nftChainOut, ip)
	if err := exec.Command("nft", strings.Fields(ruleIn)...).Run(); err != nil {
		return err
	}
	return exec.Command("nft", strings.Fields(ruleOut)...).Run()
}

func (f *NftablesFirewall) UnbanIP(ip string) error {
	for _, chain := range []string{nftChain, nftChainOut} {
		out, err := exec.Command("nft", "-a", "list", "chain", "inet", nftTable, chain).Output()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(line, ip) && strings.Contains(line, "obliguard") {
				parts := strings.Split(line, "# handle ")
				if len(parts) < 2 {
					continue
				}
				handle := strings.TrimSpace(parts[1])
				del := fmt.Sprintf("delete rule inet %s %s handle %s", nftTable, chain, handle)
				exec.Command("nft", strings.Fields(del)...).Run()
			}
		}
	}
	return nil
}

func (f *NftablesFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("nft", "-a", "list", "chain", "inet", nftTable, nftChain).Output()
	if err != nil {
		return nil, nil
	}
	return extractIPsFromNftOutput(string(out)), nil
}

func extractIPsFromNftOutput(output string) []string {
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(output, "\n") {
		if !strings.Contains(line, "obliguard") {
			continue
		}
		if m := ipRe.FindString(line); m != "" {
			ips = append(ips, m)
		}
	}
	return ips
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
	// Block inbound from IP
	exec.Command("ufw", "insert", "1", "deny", "from", ip, "to", "any").Run()
	// Block outbound to IP
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

// ── iptables ──────────────────────────────────────────────────────────────────

const iptChain = "OBLIGUARD"
const iptChainOut = "OBLIGUARD_OUT"

type IptablesFirewall struct{ initialized bool }

func (f *IptablesFirewall) Name() string { return "iptables" }

func (f *IptablesFirewall) IsAvailable() bool {
	_, err := exec.LookPath("iptables")
	return err == nil
}

func (f *IptablesFirewall) ensureChain() error {
	if f.initialized {
		return nil
	}
	// Input chain
	exec.Command("iptables", "-N", iptChain).Run()
	checkIn := exec.Command("iptables", "-C", "INPUT", "-j", iptChain)
	if checkIn.Run() != nil {
		exec.Command("iptables", "-I", "INPUT", "1", "-j", iptChain).Run()
	}
	// Output chain
	exec.Command("iptables", "-N", iptChainOut).Run()
	checkOut := exec.Command("iptables", "-C", "OUTPUT", "-j", iptChainOut)
	if checkOut.Run() != nil {
		exec.Command("iptables", "-I", "OUTPUT", "1", "-j", iptChainOut).Run()
	}
	f.initialized = true
	return nil
}

func (f *IptablesFirewall) BanIP(ip string) error {
	_ = f.ensureChain()
	exec.Command("iptables", "-A", iptChain, "-s", ip, "-j", "DROP").Run()
	return exec.Command("iptables", "-A", iptChainOut, "-d", ip, "-j", "DROP").Run()
}

func (f *IptablesFirewall) UnbanIP(ip string) error {
	exec.Command("iptables", "-D", iptChain, "-s", ip, "-j", "DROP").Run()
	exec.Command("iptables", "-D", iptChainOut, "-d", ip, "-j", "DROP").Run()
	return nil
}

func (f *IptablesFirewall) GetBannedIPs() ([]string, error) {
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

// ── Windows Firewall ──────────────────────────────────────────────────────────

// Rule naming:
//   new:    Obliguard-Block-A-B-C-D-in   (inbound)
//           Obliguard-Block-A-B-C-D-out  (outbound)
//   legacy: Obliguard-Block-A-B-C-D      (inbound only, pre-fix)
//
// UnbanIP always removes all three variants to clean up duplicates.

const winRulePrefix = "Obliguard-Block-"

type WindowsFirewall struct{}

func (f *WindowsFirewall) Name() string { return "windows" }

func (f *WindowsFirewall) IsAvailable() bool {
	_, err := exec.LookPath("netsh")
	return err == nil
}

func (f *WindowsFirewall) ruleBase(ip string) string {
	return winRulePrefix + strings.ReplaceAll(ip, ".", "-")
}

// ruleExists checks whether a firewall rule with exactly this name exists.
func (f *WindowsFirewall) ruleExists(name string) bool {
	out, err := exec.Command("netsh", "advfirewall", "firewall", "show", "rule",
		"name="+name).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), name)
}

func (f *WindowsFirewall) BanIP(ip string) error {
	base := f.ruleBase(ip)
	ruleIn := base + "-in"
	ruleOut := base + "-out"

	// Inbound — skip if already present (idempotent)
	if !f.ruleExists(ruleIn) {
		if err := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
			"name="+ruleIn,
			"dir=in",
			"action=block",
			"remoteip="+ip,
			"enable=yes",
			"description=Obliguard auto-ban",
		).Run(); err != nil {
			return fmt.Errorf("add inbound rule: %w", err)
		}
	}

	// Outbound — skip if already present (idempotent)
	if !f.ruleExists(ruleOut) {
		if err := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
			"name="+ruleOut,
			"dir=out",
			"action=block",
			"remoteip="+ip,
			"enable=yes",
			"description=Obliguard auto-ban",
		).Run(); err != nil {
			return fmt.Errorf("add outbound rule: %w", err)
		}
	}

	return nil
}

func (f *WindowsFirewall) UnbanIP(ip string) error {
	base := f.ruleBase(ip)
	// Remove new-style rules
	exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+base+"-in").Run()
	exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+base+"-out").Run()
	// Remove legacy rules (without suffix) — also cleans up duplicates from the loop bug
	exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+base).Run()
	return nil
}

// GetBannedIPs reads the Windows Firewall rule list and extracts banned IPs
// from rule NAMES (locale-independent — avoids relying on translated field
// labels like "RemoteIP:" which differ on French/other-language Windows).
func (f *WindowsFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("netsh", "advfirewall", "firewall", "show", "rule",
		"name=all", "dir=in").Output()
	if err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	var ips []string
	ipRe := ipPattern()

	for _, line := range strings.Split(string(out), "\n") {
		// Find any line that contains our rule prefix (the rule name line).
		// Works regardless of Windows UI language since rule names are never translated.
		idx := strings.Index(line, winRulePrefix)
		if idx < 0 {
			continue
		}
		// Extract from the prefix onward, trim whitespace/CR
		raw := strings.TrimRight(line[idx:], " \r\n\t")
		// Strip -in / -out suffix so both old and new naming resolve to the same IP
		raw = strings.TrimSuffix(raw, "-in")
		raw = strings.TrimSuffix(raw, "-out")
		// The remaining part after the prefix is the IP with dashes
		ipDashes := strings.TrimPrefix(raw, winRulePrefix)
		ip := strings.ReplaceAll(ipDashes, "-", ".")
		if ipRe.MatchString(ip) && !seen[ip] {
			seen[ip] = true
			ips = append(ips, ip)
		}
	}
	return ips, nil
}

// ── macOS pf ──────────────────────────────────────────────────────────────────

const pfAnchor = "obliguard"
const pfTable = "obliguard_blocklist"

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
