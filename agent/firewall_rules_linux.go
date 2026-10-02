//go:build linux

package main

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

func init() { platformRuleManager = detectLinuxRuleManager() }

func detectLinuxRuleManager() FirewallRuleManager {
	if _, err := exec.LookPath("nft"); err == nil {
		return &NftRuleManager{}
	}
	if out, err := exec.Command("firewall-cmd", "--state").Output(); err == nil && strings.TrimSpace(string(out)) == "running" {
		return &FirewalldRuleManager{}
	}
	if out, err := exec.Command("ufw", "status").Output(); err == nil && strings.Contains(string(out), "Status: active") {
		return &UfwRuleManager{}
	}
	if _, err := exec.LookPath("iptables"); err == nil {
		return &IptablesRuleManager{}
	}
	return &NoOpRuleManager{}
}

// ── nftables ─────────────────────────────────────────────────────────────────

type NftRuleManager struct{}

func (m *NftRuleManager) PlatformName() string { return "nftables" }

func (m *NftRuleManager) ListRules() ([]FwRule, error) {
	out, err := exec.Command("nft", "-a", "list", "ruleset").Output()
	if err != nil {
		return nil, fmt.Errorf("nft list ruleset: %w", err)
	}
	return parseNftRuleset(string(out)), nil
}

// AddRule receives a validated request (validateFwAddRequest); nftAddArgs
// builds the argv. Try the inet filter table first, then the single-family one.
func (m *NftRuleManager) AddRule(req FwAddRequest) error {
	fallback := "ip"
	if fwIPFamily(req.RemoteIP) == 6 {
		fallback = "ip6"
	}
	if err := exec.Command("nft", nftAddArgs(req, "inet")...).Run(); err != nil {
		if out, err2 := exec.Command("nft", nftAddArgs(req, fallback)...).CombinedOutput(); err2 != nil {
			return fmt.Errorf("nft add rule: %s — %w", strings.TrimSpace(string(out)), err2)
		}
	}
	return nil
}

func (m *NftRuleManager) DeleteRule(ruleID string) error {
	// ruleID format: "family:table:chain:handle", each part re-validated.
	args, err := nftDeleteArgs(ruleID)
	if err != nil {
		return err
	}
	if out, err := exec.Command("nft", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("nft delete: %s — %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (m *NftRuleManager) ToggleRule(_ string, _ bool) error {
	return fmt.Errorf("nftables does not support enabling/disabling individual rules")
}

func parseNftRuleset(output string) []FwRule {
	var rules []FwRule
	ipRe := regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(/\d+)?`)
	handleRe := regexp.MustCompile(`# handle (\d+)`)
	var currentFamily, currentTable, currentChain string

	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "table ") {
			parts := strings.Fields(trimmed)
			if len(parts) >= 3 {
				currentFamily = parts[1]
				currentTable = strings.TrimSuffix(parts[2], " {")
			}
			continue
		}
		if strings.HasPrefix(trimmed, "chain ") {
			parts := strings.Fields(trimmed)
			if len(parts) >= 2 {
				currentChain = strings.TrimSuffix(parts[1], " {")
			}
			continue
		}
		if strings.Contains(trimmed, "drop") || strings.Contains(trimmed, "accept") || strings.Contains(trimmed, "reject") {
			handleMatch := handleRe.FindStringSubmatch(trimmed)
			if len(handleMatch) < 2 {
				continue
			}
			handle := handleMatch[1]

			rule := FwRule{
				ID:        fmt.Sprintf("%s:%s:%s:%s", currentFamily, currentTable, currentChain, handle),
				Platform:  "nftables",
				Enabled:   true,
				Source:     "system",
				Protocol:  "any",
				LocalPort: "any",
				RemoteIP:  "any",
			}

			// Direction from chain name
			chainLower := strings.ToLower(currentChain)
			if strings.Contains(chainLower, "input") || strings.Contains(chainLower, "blocklist") {
				rule.Direction = "in"
			} else if strings.Contains(chainLower, "output") {
				rule.Direction = "out"
			} else {
				rule.Direction = "both"
			}

			// Action
			if strings.Contains(trimmed, "drop") {
				rule.Action = "block"
			} else {
				rule.Action = "allow"
			}

			// Protocol
			for _, proto := range []string{"tcp", "udp", "icmp"} {
				if strings.Contains(trimmed, proto+" ") {
					rule.Protocol = proto
					break
				}
			}

			// Port
			if idx := strings.Index(trimmed, "dport "); idx >= 0 {
				rest := trimmed[idx+6:]
				rule.LocalPort = strings.Fields(rest)[0]
			}

			// Remote IP
			if strings.Contains(trimmed, "saddr") || strings.Contains(trimmed, "daddr") {
				if m := ipRe.FindString(trimmed); m != "" {
					rule.RemoteIP = m
				}
			}

			// Obliguard source detection
			if strings.Contains(trimmed, "obliguard") || currentTable == "obliguard" {
				rule.Source = "obliguard"
			}

			// Name
			rule.Name = fmt.Sprintf("%s/%s #%s", currentTable, currentChain, handle)
			if rule.Source == "obliguard" {
				rule.Name = "Obliguard: " + rule.Name
			}

			rules = append(rules, rule)
		}
	}
	return rules
}

// ── firewalld ────────────────────────────────────────────────────────────────

type FirewalldRuleManager struct{}

func (m *FirewalldRuleManager) PlatformName() string { return "firewalld" }

func (m *FirewalldRuleManager) ListRules() ([]FwRule, error) {
	var rules []FwRule

	// Ports
	out, _ := exec.Command("firewall-cmd", "--list-ports").Output()
	for _, port := range strings.Fields(strings.TrimSpace(string(out))) {
		parts := strings.SplitN(port, "/", 2)
		proto := "tcp"
		if len(parts) == 2 {
			proto = parts[1]
		}
		rules = append(rules, FwRule{
			ID: "port:" + port, Name: "Allow " + port,
			Direction: "in", Action: "allow", Protocol: proto,
			LocalPort: parts[0], RemoteIP: "any", Enabled: true,
			Source: "system", Platform: "firewalld",
		})
	}

	// Rich rules
	out, _ = exec.Command("firewall-cmd", "--list-rich-rules").Output()
	ipRe := regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(/\d+)?`)
	for i, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		rule := FwRule{
			ID: "rich:" + strconv.Itoa(i), Name: line,
			Direction: "in", Protocol: "any", LocalPort: "any",
			RemoteIP: "any", Enabled: true, Source: "system", Platform: "firewalld",
		}
		if strings.Contains(line, "drop") || strings.Contains(line, "reject") {
			rule.Action = "block"
		} else {
			rule.Action = "allow"
		}
		if m := ipRe.FindString(line); m != "" {
			rule.RemoteIP = m
		}
		if strings.Contains(line, "destination") {
			rule.Direction = "out"
		}
		rules = append(rules, rule)
	}
	return rules, nil
}

// AddRule receives a validated request; firewalldAddCommands builds the
// --add-port / --add-rich-rule argv (the whole rich rule is one element).
// A permanent change only applies after --reload.
func (m *FirewalldRuleManager) AddRule(req FwAddRequest) error {
	cmds, err := firewalldAddCommands(req)
	if err != nil {
		return err
	}
	for _, args := range cmds {
		if out, err := exec.Command("firewall-cmd", args...).CombinedOutput(); err != nil {
			return fmt.Errorf("firewall-cmd: %s — %w", strings.TrimSpace(string(out)), err)
		}
	}
	return exec.Command("firewall-cmd", "--reload").Run()
}

func (m *FirewalldRuleManager) DeleteRule(ruleID string) error {
	if strings.HasPrefix(ruleID, "port:") {
		args, err := firewalldDeletePortArgs(ruleID)
		if err != nil {
			return err
		}
		// The port may exist in the runtime config only: the reload drops it anyway.
		_ = exec.Command("firewall-cmd", args...).Run()
		return exec.Command("firewall-cmd", "--reload").Run()
	}
	// Rich rule — the ID contains the index, we need to re-list and match
	return fmt.Errorf("rich rule deletion by index not supported — use firewall-cmd manually")
}

func (m *FirewalldRuleManager) ToggleRule(_ string, _ bool) error {
	return fmt.Errorf("firewalld does not support enabling/disabling individual rules")
}

// ── ufw ──────────────────────────────────────────────────────────────────────

type UfwRuleManager struct{}

func (m *UfwRuleManager) PlatformName() string { return "ufw" }

func (m *UfwRuleManager) ListRules() ([]FwRule, error) {
	out, err := exec.Command("ufw", "status", "numbered").Output()
	if err != nil {
		return nil, err
	}
	var rules []FwRule
	ipRe := regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(/\d+)?`)
	for _, line := range strings.Split(string(out), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "[") {
			continue
		}
		// Format: [ 1] 80/tcp ALLOW IN Anywhere
		bracketEnd := strings.Index(trimmed, "]")
		if bracketEnd < 0 {
			continue
		}
		num := strings.TrimSpace(trimmed[1:bracketEnd])
		rest := strings.TrimSpace(trimmed[bracketEnd+1:])

		rule := FwRule{
			ID: "ufw:" + num, Platform: "ufw",
			Direction: "in", Enabled: true, Source: "system",
			Protocol: "any", LocalPort: "any", RemoteIP: "any",
		}
		if strings.Contains(strings.ToUpper(rest), "DENY") {
			rule.Action = "block"
		} else {
			rule.Action = "allow"
		}
		if strings.Contains(rest, "OUT") {
			rule.Direction = "out"
		}
		if ip := ipRe.FindString(rest); ip != "" {
			rule.RemoteIP = ip
		}
		// Extract port
		fields := strings.Fields(rest)
		if len(fields) > 0 && strings.Contains(fields[0], "/") {
			parts := strings.SplitN(fields[0], "/", 2)
			rule.LocalPort = parts[0]
			if len(parts) > 1 {
				rule.Protocol = parts[1]
			}
		}
		rule.Name = rest
		rules = append(rules, rule)
	}
	return rules, nil
}

// AddRule receives a validated request; ufwAddArgs uses the full
// "from ... to ..." syntax so a remote IP keeps the port and protocol.
func (m *UfwRuleManager) AddRule(req FwAddRequest) error {
	args, err := ufwAddArgs(req)
	if err != nil {
		return err
	}
	if out, err := exec.Command("ufw", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("ufw: %s — %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (m *UfwRuleManager) DeleteRule(ruleID string) error {
	args, err := ufwDeleteArgs(ruleID)
	if err != nil {
		return err
	}
	return exec.Command("ufw", args...).Run()
}

func (m *UfwRuleManager) ToggleRule(_ string, _ bool) error {
	return fmt.Errorf("ufw does not support enabling/disabling individual rules")
}

// ── iptables ─────────────────────────────────────────────────────────────────

type IptablesRuleManager struct{}

func (m *IptablesRuleManager) PlatformName() string { return "iptables" }

func (m *IptablesRuleManager) ListRules() ([]FwRule, error) {
	var rules []FwRule
	for _, info := range []struct {
		chain string
		dir   string
	}{{"INPUT", "in"}, {"OUTPUT", "out"}} {
		out, err := exec.Command("iptables", "-L", info.chain, "-n", "--line-numbers").Output()
		if err != nil {
			continue
		}
		ipRe := regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(/\d+)?`)
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 4 {
				continue
			}
			num, err := strconv.Atoi(fields[0])
			if err != nil {
				continue
			}
			target := fields[1]
			proto := strings.ToLower(fields[2])

			rule := FwRule{
				ID:        fmt.Sprintf("ipt:%s:%d", info.chain, num),
				Name:      strings.Join(fields[1:], " "),
				Direction: info.dir,
				Protocol:  proto,
				LocalPort: "any",
				RemoteIP:  "any",
				Enabled:   true,
				Source:     "system",
				Platform:  "iptables",
			}
			if target == "DROP" || target == "REJECT" {
				rule.Action = "block"
			} else if target == "ACCEPT" {
				rule.Action = "allow"
			} else {
				rule.Action = target
			}
			if ip := ipRe.FindString(line); ip != "" && ip != "0.0.0.0" {
				rule.RemoteIP = ip
			}
			if strings.Contains(line, "dpt:") {
				for _, f := range fields {
					if strings.HasPrefix(f, "dpt:") {
						rule.LocalPort = strings.TrimPrefix(f, "dpt:")
					}
				}
			}
			if strings.Contains(line, "OBLIGUARD") || strings.Contains(line, "obliguard") {
				rule.Source = "obliguard"
			}
			rules = append(rules, rule)
		}
	}
	return rules, nil
}

// AddRule receives a validated request; an IPv6 remote goes to ip6tables.
func (m *IptablesRuleManager) AddRule(req FwAddRequest) error {
	bin, args := iptablesAddCommand(req)
	if out, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %s — %w", bin, strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (m *IptablesRuleManager) DeleteRule(ruleID string) error {
	// Format: "ipt:INPUT|OUTPUT:NUM"
	args, err := iptablesDeleteArgs(ruleID)
	if err != nil {
		return err
	}
	return exec.Command("iptables", args...).Run()
}

func (m *IptablesRuleManager) ToggleRule(_ string, _ bool) error {
	return fmt.Errorf("iptables does not support enabling/disabling individual rules")
}
