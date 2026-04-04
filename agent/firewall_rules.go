package main

import (
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"runtime"
	"strings"
)

// ── Firewall rule management — system-wide rule listing/manipulation ─────────
// Distinct from FirewallManager which only handles Obliguard ban rules.

// FwRule is the unified representation of a firewall rule across all platforms.
type FwRule struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Direction string `json:"direction"` // "in", "out", "both"
	Action    string `json:"action"`    // "allow", "block"
	Protocol  string `json:"protocol"`  // "tcp", "udp", "any", "icmp"
	LocalPort string `json:"localPort"` // "80", "80,443", "any"
	RemoteIP  string `json:"remoteIp"`  // IP/CIDR or "any"
	Enabled   bool   `json:"enabled"`
	Source    string `json:"source"`   // "system" or "obliguard"
	Platform  string `json:"platform"`
}

// FwAddRequest is the payload for adding a new rule.
type FwAddRequest struct {
	Name      string `json:"name"`
	Direction string `json:"direction"`
	Action    string `json:"action"`
	Protocol  string `json:"protocol"`
	LocalPort string `json:"localPort"`
	RemoteIP  string `json:"remoteIp"`
}

// FwResponse is sent back to the server after a firewall command.
type FwResponse struct {
	Type    string   `json:"type"` // "firewall_response"
	ID      string   `json:"id"`   // correlation ID
	Success bool     `json:"success"`
	Error   string   `json:"error,omitempty"`
	Rules   []FwRule `json:"rules,omitempty"`
	Platform string  `json:"platform,omitempty"`
}

// FirewallRuleManager handles system-wide firewall rule operations.
type FirewallRuleManager interface {
	ListRules() ([]FwRule, error)
	AddRule(req FwAddRequest) error
	DeleteRule(ruleID string) error
	ToggleRule(ruleID string, enabled bool) error
	PlatformName() string
}

// DetectFirewallRuleManager returns the appropriate rule manager for the current OS.
// Platform-specific implementations are in firewall_rules_<os>.go files.
// This function is overridden via the platformRuleManager variable set by each platform file's init().
var platformRuleManager FirewallRuleManager

func DetectFirewallRuleManager() FirewallRuleManager {
	if platformRuleManager != nil {
		return platformRuleManager
	}
	return &NoOpRuleManager{}
}

func init() {
	// Fallback — platform-specific init() in firewall_rules_<os>.go will override this
	_ = runtime.GOOS
}

// ── Command handlers called from cmd_ws.go ──────────────────────────────────

func handleFirewallCommand(frm FirewallRuleManager, cmdType string, cmdID string, rawMsg json.RawMessage, sendFn func([]byte)) {
	resp := FwResponse{Type: "firewall_response", ID: cmdID, Platform: frm.PlatformName()}

	// Extract the nested "payload" field from the full WS message
	var envelope struct {
		Payload json.RawMessage `json:"payload"`
	}
	_ = json.Unmarshal(rawMsg, &envelope)
	payload := envelope.Payload
	if len(payload) == 0 {
		payload = rawMsg
	}

	switch cmdType {
	case "firewall_list":
		rules, err := frm.ListRules()
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Success = true
			resp.Rules = rules
		}

	case "firewall_add":
		var req FwAddRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			resp.Error = "invalid payload: " + err.Error()
		} else if err := frm.AddRule(req); err != nil {
			resp.Error = err.Error()
		} else {
			resp.Success = true
			if rules, err := frm.ListRules(); err == nil {
				resp.Rules = rules
			}
		}

	case "firewall_delete":
		var req struct{ RuleID string `json:"ruleId"` }
		if err := json.Unmarshal(payload, &req); err != nil {
			resp.Error = "invalid payload: " + err.Error()
		} else if err := frm.DeleteRule(req.RuleID); err != nil {
			resp.Error = err.Error()
		} else {
			resp.Success = true
			if rules, err := frm.ListRules(); err == nil {
				resp.Rules = rules
			}
		}

	case "firewall_toggle":
		var req struct {
			RuleID  string `json:"ruleId"`
			Enabled bool   `json:"enabled"`
		}
		if err := json.Unmarshal(payload, &req); err != nil {
			resp.Error = "invalid payload: " + err.Error()
		} else if err := frm.ToggleRule(req.RuleID, req.Enabled); err != nil {
			resp.Error = err.Error()
		} else {
			resp.Success = true
			if rules, err := frm.ListRules(); err == nil {
				resp.Rules = rules
			}
		}

	default:
		resp.Error = "unknown firewall command: " + cmdType
	}

	data, _ := json.Marshal(resp)
	sendFn(data)
	if resp.Error != "" {
		log.Printf("Firewall cmd %s: error: %s", cmdType, resp.Error)
	} else {
		log.Printf("Firewall cmd %s: success (%d rules)", cmdType, len(resp.Rules))
	}
}

// ── pf rule parser (shared by darwin + freebsd) ─────────────────────────────

func parsePfRules(output string, platform string) []FwRule {
	var rules []FwRule
	ipRe := regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(/\d+)?`)

	for i, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		rule := FwRule{
			ID: fmt.Sprintf("pf:%d", i), Name: trimmed,
			Direction: "both", Protocol: "any", LocalPort: "any", RemoteIP: "any",
			Enabled: true, Source: "system", Platform: platform,
		}
		if strings.Contains(trimmed, "block") {
			rule.Action = "block"
		} else if strings.Contains(trimmed, "pass") {
			rule.Action = "allow"
		} else {
			continue
		}
		if strings.Contains(trimmed, " in ") {
			rule.Direction = "in"
		} else if strings.Contains(trimmed, " out ") {
			rule.Direction = "out"
		}
		if strings.Contains(trimmed, "proto tcp") {
			rule.Protocol = "tcp"
		} else if strings.Contains(trimmed, "proto udp") {
			rule.Protocol = "udp"
		}
		if strings.Contains(trimmed, "port ") {
			fields := strings.Fields(trimmed)
			for j, f := range fields {
				if f == "port" && j+1 < len(fields) {
					rule.LocalPort = fields[j+1]
				}
			}
		}
		if ip := ipRe.FindString(trimmed); ip != "" {
			rule.RemoteIP = ip
		}
		if strings.Contains(trimmed, "obliguard") {
			rule.Source = "obliguard"
		}
		rules = append(rules, rule)
	}
	return rules
}

// ── No-op fallback ──────────────────────────────────────────────────────────

type NoOpRuleManager struct{}

func (m *NoOpRuleManager) PlatformName() string                    { return "unsupported" }
func (m *NoOpRuleManager) ListRules() ([]FwRule, error)            { return nil, nil }
func (m *NoOpRuleManager) AddRule(req FwAddRequest) error          { return fmt.Errorf("unsupported platform") }
func (m *NoOpRuleManager) DeleteRule(ruleID string) error          { return fmt.Errorf("unsupported platform") }
func (m *NoOpRuleManager) ToggleRule(ruleID string, _ bool) error  { return fmt.Errorf("unsupported platform") }
