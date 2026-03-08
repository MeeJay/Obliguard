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
	// BanIP adds a DROP rule for the given IP.
	BanIP(ip string) error
	// UnbanIP removes the DROP rule for the given IP.
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
	rule := fmt.Sprintf("add rule inet %s %s ip saddr %s drop comment \"obliguard\"", nftTable, nftChain, ip)
	return exec.Command("nft", strings.Fields(rule)...).Run()
}

func (f *NftablesFirewall) UnbanIP(ip string) error {
	// List rules, find handle for this IP, delete it
	out, err := exec.Command("nft", "-a", "list", "chain", "inet", nftTable, nftChain).Output()
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, ip) && strings.Contains(line, "obliguard") {
			// Extract handle number
			parts := strings.Split(line, "# handle ")
			if len(parts) < 2 {
				continue
			}
			handle := strings.TrimSpace(parts[1])
			del := fmt.Sprintf("delete rule inet %s %s handle %s", nftTable, nftChain, handle)
			return exec.Command("nft", strings.Fields(del)...).Run()
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
	// Use a rich rule with source=<ip> action=drop
	rule := fmt.Sprintf("rule family=ipv4 source address=%s drop", ip)
	return exec.Command("firewall-cmd", "--permanent",
		fmt.Sprintf("--add-rich-rule=%s", rule)).Run()
}

func (f *FirewalldFirewall) UnbanIP(ip string) error {
	rule := fmt.Sprintf("rule family=ipv4 source address=%s drop", ip)
	_ = exec.Command("firewall-cmd", "--permanent",
		fmt.Sprintf("--remove-rich-rule=%s", rule)).Run()
	return exec.Command("firewall-cmd", "--reload").Run()
}

func (f *FirewalldFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("firewall-cmd", "--list-rich-rules").Output()
	if err != nil {
		return nil, err
	}
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "drop") {
			if m := ipRe.FindString(line); m != "" {
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
	return exec.Command("ufw", "insert", "1", "deny", "from", ip, "to", "any").Run()
}

func (f *UFWFirewall) UnbanIP(ip string) error {
	return exec.Command("ufw", "delete", "deny", "from", ip, "to", "any").Run()
}

func (f *UFWFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("ufw", "status", "numbered").Output()
	if err != nil {
		return nil, err
	}
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(strings.ToUpper(line), "DENY") {
			if m := ipRe.FindString(line); m != "" {
				ips = append(ips, m)
			}
		}
	}
	return ips, nil
}

// ── iptables ──────────────────────────────────────────────────────────────────

const iptChain = "OBLIGUARD"

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
	// Create chain if not exists
	exec.Command("iptables", "-N", iptChain).Run()
	// Jump to chain from INPUT if not already there
	checkCmd := exec.Command("iptables", "-C", "INPUT", "-j", iptChain)
	if checkCmd.Run() != nil {
		exec.Command("iptables", "-I", "INPUT", "1", "-j", iptChain).Run()
	}
	f.initialized = true
	return nil
}

func (f *IptablesFirewall) BanIP(ip string) error {
	_ = f.ensureChain()
	return exec.Command("iptables", "-A", iptChain, "-s", ip, "-j", "DROP").Run()
}

func (f *IptablesFirewall) UnbanIP(ip string) error {
	exec.Command("iptables", "-D", iptChain, "-s", ip, "-j", "DROP").Run()
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

const winRulePrefix = "Obliguard-Block-"

type WindowsFirewall struct{}

func (f *WindowsFirewall) Name() string { return "windows" }

func (f *WindowsFirewall) IsAvailable() bool {
	_, err := exec.LookPath("netsh")
	return err == nil
}

func (f *WindowsFirewall) BanIP(ip string) error {
	ruleName := winRulePrefix + strings.ReplaceAll(ip, ".", "-")
	return exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
		"name="+ruleName,
		"dir=in",
		"action=block",
		"remoteip="+ip,
		"enable=yes",
		"description=Obliguard auto-ban",
	).Run()
}

func (f *WindowsFirewall) UnbanIP(ip string) error {
	ruleName := winRulePrefix + strings.ReplaceAll(ip, ".", "-")
	return exec.Command("netsh", "advfirewall", "firewall", "delete", "rule",
		"name="+ruleName,
	).Run()
}

func (f *WindowsFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("netsh", "advfirewall", "firewall", "show", "rule",
		"name=all", "dir=in").Output()
	if err != nil {
		return nil, err
	}
	var ips []string
	lines := strings.Split(string(out), "\n")
	inObliguard := false
	ipRe := ipPattern()
	for _, line := range lines {
		if strings.Contains(line, winRulePrefix) {
			inObliguard = true
		}
		if inObliguard && strings.Contains(line, "RemoteIP:") {
			if m := ipRe.FindString(line); m != "" {
				ips = append(ips, m)
				inObliguard = false
			}
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

func (f *NoOpFirewall) Name() string                      { return "none" }
func (f *NoOpFirewall) IsAvailable() bool                 { return true }
func (f *NoOpFirewall) BanIP(ip string) error             { return nil }
func (f *NoOpFirewall) UnbanIP(ip string) error           { return nil }
func (f *NoOpFirewall) GetBannedIPs() ([]string, error)   { return nil, nil }

// ── Shared helper ─────────────────────────────────────────────────────────────

func ipPattern() *regexp.Regexp {
	return regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`)
}
