//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"strings"
)

func init() { platformRuleManager = &WindowsRuleManager{} }

// WindowsRuleManager manages Windows Defender Firewall rules via netsh.
type WindowsRuleManager struct{}

func (m *WindowsRuleManager) PlatformName() string { return "windows" }

func (m *WindowsRuleManager) ListRules() ([]FwRule, error) {
	out, err := exec.Command("netsh", "advfirewall", "firewall", "show", "rule", "name=all", "verbose").Output()
	if err != nil {
		return nil, fmt.Errorf("netsh show rule: %w", err)
	}
	rules := parseNetshVerbose(string(out))
	// Filter out Obliguard ban rules (they have thousands of IPs and are managed separately)
	var filtered []FwRule
	for _, r := range rules {
		if strings.HasPrefix(r.Name, "Obliguard-Block-") {
			continue
		}
		filtered = append(filtered, r)
	}
	return filtered, nil
}

func (m *WindowsRuleManager) AddRule(req FwAddRequest) error {
	name := req.Name
	if name == "" {
		name = fmt.Sprintf("Obliguard-Custom-%s-%s-%s", req.Direction, req.Protocol, req.LocalPort)
	}
	dir := "in"
	if req.Direction == "out" {
		dir = "out"
	}
	action := "block"
	if req.Action == "allow" {
		action = "allow"
	}

	args := []string{
		"advfirewall", "firewall", "add", "rule",
		"name=" + name,
		"dir=" + dir,
		"action=" + action,
		"enable=yes",
	}
	if req.Protocol != "" && req.Protocol != "any" {
		args = append(args, "protocol="+req.Protocol)
	} else {
		args = append(args, "protocol=any")
	}
	if req.LocalPort != "" && req.LocalPort != "any" {
		args = append(args, "localport="+req.LocalPort)
	}
	if req.RemoteIP != "" && req.RemoteIP != "any" {
		args = append(args, "remoteip="+req.RemoteIP)
	}

	if out, err := exec.Command("netsh", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("netsh add rule: %s — %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (m *WindowsRuleManager) DeleteRule(ruleID string) error {
	name, dir := parseRuleID(ruleID)
	args := []string{"advfirewall", "firewall", "delete", "rule", "name=" + name}
	if dir != "" {
		args = append(args, "dir="+dir)
	}
	if out, err := exec.Command("netsh", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("netsh delete rule: %s — %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (m *WindowsRuleManager) ToggleRule(ruleID string, enabled bool) error {
	name, dir := parseRuleID(ruleID)
	enableStr := "yes"
	if !enabled {
		enableStr = "no"
	}
	args := []string{"advfirewall", "firewall", "set", "rule", "name=" + name}
	if dir != "" {
		args = append(args, "dir="+dir)
	}
	args = append(args, "new", "enable="+enableStr)
	if out, err := exec.Command("netsh", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("netsh set rule: %s — %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

// parseRuleID splits "RuleName::in" into name and netsh dir value.
func parseRuleID(ruleID string) (name string, dir string) {
	if idx := strings.Index(ruleID, "::"); idx >= 0 {
		name = ruleID[:idx]
		d := ruleID[idx+2:]
		if d == "in" {
			dir = "in"
		} else if d == "out" {
			dir = "out"
		}
		return
	}
	return ruleID, ""
}

// parseNetshVerbose parses the verbose output of "netsh advfirewall firewall show rule name=all verbose".
// Rules are separated by blank lines. Each block has locale-dependent field labels.
// We parse by position: first non-separator line = rule name, then look for key patterns.
func parseNetshVerbose(output string) []FwRule {
	var rules []FwRule
	blocks := splitNetshBlocks(output)

	for _, block := range blocks {
		if len(block) < 3 {
			continue
		}
		rule := FwRule{Platform: "windows", Enabled: true, Source: "system"}

		for _, line := range block {
			// Split on first colon to get key-value
			parts := strings.SplitN(line, ":", 2)
			if len(parts) != 2 {
				continue
			}
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])

			// Match locale-independently by checking common substrings
			keyLower := strings.ToLower(key)
			switch {
			case isFieldName(keyLower):
				rule.Name = val
				rule.ID = val
			case isFieldDir(keyLower):
				valLower := strings.ToLower(val)
				// "In"/"Inbound"/"Actif"/"Eingehend"/"Entrante" = inbound
				// "Out"/"Outbound"/"Sortie"/"Ausgehend"/"Saliente" = outbound
				if strings.Contains(valLower, "in") || strings.Contains(valLower, "actif") || strings.Contains(valLower, "eingehend") || strings.Contains(valLower, "entrant") {
					rule.Direction = "in"
				} else {
					rule.Direction = "out"
				}
			case isFieldAction(keyLower):
				valLower := strings.ToLower(val)
				if strings.Contains(valLower, "block") || strings.Contains(valLower, "bloquer") {
					rule.Action = "block"
				} else {
					rule.Action = "allow"
				}
			case isFieldEnabled(keyLower):
				rule.Enabled = strings.Contains(strings.ToLower(val), "yes") || strings.Contains(strings.ToLower(val), "oui")
			case isFieldProtocol(keyLower):
				rule.Protocol = strings.ToLower(val)
			case isFieldLocalPort(keyLower):
				rule.LocalPort = val
			case isFieldRemoteIP(keyLower):
				rule.RemoteIP = val
			}
		}

		if rule.Name == "" {
			continue
		}

		// Composite ID to avoid ambiguity
		if rule.Direction != "" {
			rule.ID = rule.Name + "::" + rule.Direction
		}

		// Detect Obliguard-managed rules
		if strings.HasPrefix(rule.Name, "Obliguard-") {
			rule.Source = "obliguard"
		}

		// Normalize locale-dependent "any" values
		protLower := strings.ToLower(rule.Protocol)
		if rule.Protocol == "" || protLower == "tout" || protLower == "alle" || protLower == "todos" || protLower == "all" {
			rule.Protocol = "any"
		}
		if rule.LocalPort == "" {
			rule.LocalPort = "any"
		}
		remLower := strings.ToLower(rule.RemoteIP)
		if rule.RemoteIP == "" || remLower == "tout" || remLower == "alle" || remLower == "todos" || remLower == "any" || remLower == "quelconque" {
			rule.RemoteIP = "any"
		}

		rules = append(rules, rule)
	}
	return rules
}

func splitNetshBlocks(output string) [][]string {
	// netsh verbose output format:
	//   Nom de la règle :    RuleName
	//   -------
	//   Description :        ...
	//   Activé :             ...
	//   ...
	//   (empty line)
	//   Nom de la règle :    NextRule
	//   -------
	// Split on empty lines (block separator), skip --- lines within blocks
	var blocks [][]string
	var current []string
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimRight(line, "\r\n\t ")
		if strings.HasPrefix(trimmed, "---") {
			continue // skip separator lines, keep building current block
		}
		if trimmed == "" {
			if len(current) > 0 {
				blocks = append(blocks, current)
				current = nil
			}
			continue
		}
		current = append(current, trimmed)
	}
	if len(current) > 0 {
		blocks = append(blocks, current)
	}
	return blocks
}

// Locale-independent field detection — works for English, French, German, Spanish
func isFieldName(k string) bool {
	return strings.Contains(k, "rule name") || strings.Contains(k, "nom de la") || strings.Contains(k, "regelname") || strings.Contains(k, "nombre de la regla") || (strings.Contains(k, "nom") && strings.Contains(k, "gle"))
}
func isFieldDir(k string) bool {
	return strings.Contains(k, "direction") || strings.Contains(k, "richtung") || strings.Contains(k, "dirección")
}
func isFieldAction(k string) bool {
	return strings.Contains(k, "action") || strings.Contains(k, "aktion") || strings.Contains(k, "acción")
}
func isFieldEnabled(k string) bool {
	return strings.Contains(k, "enabled") || strings.Contains(k, "activ") || strings.Contains(k, "aktiviert") || strings.Contains(k, "habilitad")
}
func isFieldProtocol(k string) bool {
	return strings.Contains(k, "protocol") || strings.Contains(k, "protokoll")
}
func isFieldLocalPort(k string) bool {
	return strings.Contains(k, "localport") || strings.Contains(k, "port local") || strings.Contains(k, "lokaler port") || strings.Contains(k, "puerto local")
}
func isFieldRemoteIP(k string) bool {
	return strings.Contains(k, "remoteip") || strings.Contains(k, "ip distante") || strings.Contains(k, "remote-ip") || strings.Contains(k, "ip remota")
}
