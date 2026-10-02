package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/netip"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
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
	Source    string `json:"source"` // "system" or "obliguard"
	Platform  string `json:"platform"`
}

// FwAddRequest is the payload for adding a new rule. Backends only ever see a
// request returned by validateFwAddRequest (canonical values, "" = any).
type FwAddRequest struct {
	Name       string `json:"name"`
	Direction  string `json:"direction"`
	Action     string `json:"action"`
	Protocol   string `json:"protocol"`
	LocalPort  string `json:"localPort"`
	RemotePort string `json:"remotePort"`
	RemoteIP   string `json:"remoteIp"`
}

// capFwRemotePort is the heartbeat capability telling the server that this
// agent honours FwAddRequest.RemotePort (older agents drop the field, so the
// server refuses a remote port for them instead of creating a broader rule).
const capFwRemotePort = "fw_remote_port"

// FwResponse is sent back to the server after a firewall command.
type FwResponse struct {
	Type     string   `json:"type"` // "firewall_response"
	ID       string   `json:"id"`   // correlation ID
	Success  bool     `json:"success"`
	Error    string   `json:"error,omitempty"`
	Rules    []FwRule `json:"rules,omitempty"`
	Platform string   `json:"platform,omitempty"`
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
		} else if valid, err := validateFwAddRequest(req); err != nil {
			resp.Error = "invalid rule: " + err.Error()
		} else if err := frm.AddRule(valid); err != nil {
			resp.Error = err.Error()
		} else {
			resp.Success = true
			if rules, err := frm.ListRules(); err == nil {
				resp.Rules = rules
			}
		}

	case "firewall_delete":
		var req struct {
			RuleID string `json:"ruleId"`
		}
		if err := json.Unmarshal(payload, &req); err != nil {
			resp.Error = "invalid payload: " + err.Error()
		} else if err := validateFwRuleID(req.RuleID); err != nil {
			resp.Error = err.Error()
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
			Enabled *bool  `json:"enabled"`
		}
		if err := json.Unmarshal(payload, &req); err != nil {
			resp.Error = "invalid payload: " + err.Error()
		} else if err := validateFwRuleID(req.RuleID); err != nil {
			resp.Error = err.Error()
		} else if req.Enabled == nil {
			resp.Error = "invalid payload: enabled is required"
		} else if err := frm.ToggleRule(req.RuleID, *req.Enabled); err != nil {
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

// ── Validation (SECURITY-PARITY-21) ─────────────────────────────────────────
// Mirrors server/src/validators/firewall.schema.ts. The server already
// validates, but the agent runs these commands as root / SYSTEM: every field
// is re-checked here, and backends only receive canonical values. nft joins
// its argv into one string and re-parses it, so discrete argv elements alone
// would not stop token injection there: this validation is what does.

var (
	fwNameRe      = regexp.MustCompile(`^[A-Za-z0-9 _.-]{1,64}$`)
	fwPortRe      = regexp.MustCompile(`^([1-9][0-9]{0,4})(?:-([1-9][0-9]{0,4}))?$`)
	fwNftNameRe   = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`)
	fwDigitsRe    = regexp.MustCompile(`^[0-9]{1,10}$`)
	fwNftFamilies = map[string]bool{"ip": true, "ip6": true, "inet": true, "arp": true, "bridge": true, "netdev": true}
)

const fwRuleIDMaxLen = 256

// Names owned by the ban enforcement (FirewallManager): never touched through
// rule management. Kept local so this file does not depend on the backend files.
const (
	fwNftBanTable      = "obliguard"
	fwWinBanRulePrefix = "Obliguard-Block-"
)

// fwReservedName reports names a custom rule must never take: the Obliguard
// ban rules (managed by FirewallManager) and netsh's "all" wildcard.
func fwReservedName(name string) bool {
	return strings.EqualFold(name, "all") || strings.HasPrefix(strings.ToLower(name), strings.ToLower(fwWinBanRulePrefix))
}

// fwIsAny: "", "any" (any case) mean "no constraint".
func fwIsAny(s string) bool {
	t := strings.TrimSpace(s)
	return t == "" || strings.EqualFold(t, "any")
}

// normalizeFwPort returns "N" or "A-B" (1-65535, A < B); A-A collapses to A.
func normalizeFwPort(s string) (string, error) {
	m := fwPortRe.FindStringSubmatch(s)
	if m == nil {
		return "", fmt.Errorf("invalid port %q: a number from 1 to 65535 or a range like 8000-8100", s)
	}
	a, _ := strconv.Atoi(m[1])
	if a > 65535 {
		return "", fmt.Errorf("invalid port %q", s)
	}
	if m[2] == "" {
		return strconv.Itoa(a), nil
	}
	b, _ := strconv.Atoi(m[2])
	if b > 65535 || b < a {
		return "", fmt.Errorf("invalid port range %q", s)
	}
	if a == b {
		return strconv.Itoa(a), nil
	}
	return fmt.Sprintf("%d-%d", a, b), nil
}

// normalizeFwRemoteIP returns the canonical address ("1.2.3.4", "2001:db8::1")
// or network ("10.0.0.0/8", host bits masked). IPv4-mapped IPv6 becomes IPv4.
func normalizeFwRemoteIP(s string) (string, error) {
	bad := fmt.Errorf("invalid remote IP %q: an IP address or a CIDR network", s)
	if len(s) > 64 || strings.ContainsAny(s, " \t%") {
		return "", bad
	}
	var addr netip.Addr
	var bits int
	if strings.Contains(s, "/") {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return "", bad
		}
		addr, bits = p.Addr(), p.Bits()
	} else {
		a, err := netip.ParseAddr(s)
		if err != nil || a.Zone() != "" {
			return "", bad
		}
		addr, bits = a, a.BitLen()
	}
	if addr.Is4In6() {
		if bits < 96 {
			return "", bad
		}
		addr, bits = addr.Unmap(), bits-96
	}
	if bits == addr.BitLen() {
		return addr.String(), nil
	}
	p, err := addr.Prefix(bits)
	if err != nil {
		return "", bad
	}
	return p.String(), nil
}

// validateFwAddRequest re-validates a firewall_add payload and returns it in
// canonical form ("" for any port / remote IP, protocol never empty).
func validateFwAddRequest(req FwAddRequest) (FwAddRequest, error) {
	var out FwAddRequest
	if req.Name != "" {
		if !fwNameRe.MatchString(req.Name) || strings.TrimSpace(req.Name) != req.Name {
			return out, errors.New("invalid name: 1-64 characters, letters, digits, space, _ . - only")
		}
		if fwReservedName(req.Name) {
			return out, errors.New("invalid name: reserved")
		}
		out.Name = req.Name
	}
	switch req.Direction {
	case "in", "out":
		out.Direction = req.Direction
	default:
		return out, fmt.Errorf("invalid direction %q: in or out", req.Direction)
	}
	switch req.Action {
	case "allow", "block":
		out.Action = req.Action
	default:
		return out, fmt.Errorf("invalid action %q: allow or block", req.Action)
	}
	out.Protocol = req.Protocol
	if out.Protocol == "" {
		out.Protocol = "any"
	}
	switch out.Protocol {
	case "tcp", "udp", "icmp", "any":
	default:
		return out, fmt.Errorf("invalid protocol %q: tcp, udp, icmp or any", req.Protocol)
	}
	var err error
	if !fwIsAny(req.LocalPort) {
		if out.LocalPort, err = normalizeFwPort(req.LocalPort); err != nil {
			return out, err
		}
	}
	if !fwIsAny(req.RemotePort) {
		if out.RemotePort, err = normalizeFwPort(req.RemotePort); err != nil {
			return out, err
		}
	}
	if (out.LocalPort != "" || out.RemotePort != "") && out.Protocol != "tcp" && out.Protocol != "udp" {
		return out, errors.New("a port needs protocol tcp or udp")
	}
	if !fwIsAny(req.RemoteIP) {
		if out.RemoteIP, err = normalizeFwRemoteIP(req.RemoteIP); err != nil {
			return out, err
		}
	}
	return out, nil
}

// validateFwRuleID is the platform-independent check of a delete/toggle id
// (same rule as the server): printable, no quote or backslash, no leading
// '-'. Each backend then parses its own id format strictly.
func validateFwRuleID(id string) error {
	bad := errors.New("invalid rule id")
	if id == "" || !utf8.ValidString(id) || utf8.RuneCountInString(id) > fwRuleIDMaxLen || strings.HasPrefix(id, "-") {
		return bad
	}
	for _, r := range id {
		if unicode.IsControl(r) || r == '"' || r == '\\' {
			return bad
		}
	}
	return nil
}

// fwIPFamily: 4 or 6 for a canonical remote IP, 0 when there is none.
func fwIPFamily(ip string) int {
	switch {
	case ip == "":
		return 0
	case strings.Contains(ip, ":"):
		return 6
	default:
		return 4
	}
}

// ── argv builders (pure, one element per token) ─────────────────────────────
// Built here rather than in the platform files so go test covers every
// backend on any OS. Inputs are validated requests / ids.

// nftAddArgs: nft add rule <family> filter input|output <match...> accept|drop comment "obliguard-custom".
func nftAddArgs(req FwAddRequest, family string) []string {
	chain, remoteKey, localPortKey, remotePortKey := "input", "saddr", "dport", "sport"
	if req.Direction == "out" {
		chain, remoteKey, localPortKey, remotePortKey = "output", "daddr", "sport", "dport"
	}
	args := []string{"add", "rule", family, "filter", chain}
	v6 := fwIPFamily(req.RemoteIP) == 6
	if req.RemoteIP != "" {
		ipKw := "ip"
		if v6 {
			ipKw = "ip6"
		}
		args = append(args, ipKw, remoteKey, req.RemoteIP)
	}
	switch req.Protocol {
	case "tcp", "udp":
		if req.LocalPort == "" && req.RemotePort == "" {
			args = append(args, "meta", "l4proto", req.Protocol)
		}
		if req.LocalPort != "" {
			args = append(args, req.Protocol, localPortKey, req.LocalPort)
		}
		if req.RemotePort != "" {
			args = append(args, req.Protocol, remotePortKey, req.RemotePort)
		}
	case "icmp":
		l4 := "icmp"
		if v6 {
			l4 = "ipv6-icmp"
		}
		args = append(args, "meta", "l4proto", l4)
	}
	action := "drop"
	if req.Action == "allow" {
		action = "accept"
	}
	return append(args, action, "comment", `"obliguard-custom"`)
}

// nftDeleteArgs parses "family:table:chain:handle" into nft delete rule argv.
// The Obliguard ban table is managed by FirewallManager, never from here.
func nftDeleteArgs(ruleID string) ([]string, error) {
	parts := strings.SplitN(ruleID, ":", 4)
	if len(parts) != 4 || !fwNftFamilies[parts[0]] || !fwNftNameRe.MatchString(parts[1]) ||
		!fwNftNameRe.MatchString(parts[2]) || !fwDigitsRe.MatchString(parts[3]) {
		return nil, fmt.Errorf("invalid nft rule ID: %s", ruleID)
	}
	if parts[1] == fwNftBanTable {
		return nil, errors.New("Obliguard ban rules are managed by the agent and cannot be deleted here")
	}
	return []string{"delete", "rule", parts[0], parts[1], parts[2], "handle", parts[3]}, nil
}

// firewalldAddCommands returns the firewall-cmd invocations (before --reload).
// A plain allowed port uses --add-port; anything else is one rich rule
// (rich rules hold a single port / source-port / protocol element and only
// filter inbound traffic).
func firewalldAddCommands(req FwAddRequest) ([][]string, error) {
	if req.Direction == "out" {
		return nil, errors.New("firewalld rules only filter inbound traffic")
	}
	if req.Action == "allow" && req.RemoteIP == "" && req.RemotePort == "" && req.LocalPort != "" {
		return [][]string{{"--permanent", "--add-port=" + req.LocalPort + "/" + req.Protocol}}, nil
	}
	if req.LocalPort != "" && req.RemotePort != "" {
		return nil, errors.New("firewalld cannot combine a local and a remote port in one rule")
	}
	v6 := fwIPFamily(req.RemoteIP) == 6
	parts := []string{"rule"}
	if req.RemoteIP != "" {
		fam := "ipv4"
		if v6 {
			fam = "ipv6"
		}
		parts = append(parts, `family="`+fam+`"`, `source address="`+req.RemoteIP+`"`)
	}
	switch {
	case req.LocalPort != "":
		parts = append(parts, `port port="`+req.LocalPort+`" protocol="`+req.Protocol+`"`)
	case req.RemotePort != "":
		parts = append(parts, `source-port port="`+req.RemotePort+`" protocol="`+req.Protocol+`"`)
	case req.Protocol == "tcp" || req.Protocol == "udp":
		parts = append(parts, `protocol value="`+req.Protocol+`"`)
	case req.Protocol == "icmp":
		p := "icmp"
		if v6 {
			p = "ipv6-icmp"
		}
		parts = append(parts, `protocol value="`+p+`"`)
	}
	if len(parts) == 1 {
		return nil, errors.New("firewalld needs a remote IP, a port or a protocol")
	}
	if req.Action == "block" {
		parts = append(parts, "drop")
	} else {
		parts = append(parts, "accept")
	}
	return [][]string{{"--permanent", "--add-rich-rule=" + strings.Join(parts, " ")}}, nil
}

// firewalldDeletePortArgs parses "port:<port>/<proto>".
func firewalldDeletePortArgs(ruleID string) ([]string, error) {
	spec := strings.TrimPrefix(ruleID, "port:")
	port, proto, ok := strings.Cut(spec, "/")
	if !ok {
		return nil, fmt.Errorf("invalid firewalld rule ID: %s", ruleID)
	}
	if p, err := normalizeFwPort(port); err != nil || p != port {
		return nil, fmt.Errorf("invalid firewalld rule ID: %s", ruleID)
	}
	switch proto {
	case "tcp", "udp", "sctp", "dccp":
	default:
		return nil, fmt.Errorf("invalid firewalld rule ID: %s", ruleID)
	}
	return []string{"--permanent", "--remove-port=" + port + "/" + proto}, nil
}

// ufwAddArgs uses ufw's full syntax so a remote IP never drops the port and
// protocol constraints: ufw allow|deny in|out [proto P] from A [port X] to B [port Y].
func ufwAddArgs(req FwAddRequest) ([]string, error) {
	if req.Protocol == "icmp" {
		return nil, errors.New("ufw cannot add ICMP rules from the command line")
	}
	if req.RemoteIP == "" && req.LocalPort == "" && req.RemotePort == "" {
		return nil, errors.New("ufw requires a port or a remote IP")
	}
	action := "allow"
	if req.Action == "block" {
		action = "deny"
	}
	ufwPort := func(p string) string { return strings.ReplaceAll(p, "-", ":") }
	remote := req.RemoteIP
	if remote == "" {
		remote = "any"
	}
	args := []string{action, req.Direction}
	if req.Protocol == "tcp" || req.Protocol == "udp" {
		args = append(args, "proto", req.Protocol)
	}
	if req.Direction == "out" {
		args = append(args, "from", "any")
		if req.LocalPort != "" {
			args = append(args, "port", ufwPort(req.LocalPort))
		}
		args = append(args, "to", remote)
		if req.RemotePort != "" {
			args = append(args, "port", ufwPort(req.RemotePort))
		}
	} else {
		args = append(args, "from", remote)
		if req.RemotePort != "" {
			args = append(args, "port", ufwPort(req.RemotePort))
		}
		args = append(args, "to", "any")
		if req.LocalPort != "" {
			args = append(args, "port", ufwPort(req.LocalPort))
		}
	}
	return args, nil
}

// ufwDeleteArgs parses "ufw:N".
func ufwDeleteArgs(ruleID string) ([]string, error) {
	num := strings.TrimPrefix(ruleID, "ufw:")
	if num == ruleID || !fwDigitsRe.MatchString(num) {
		return nil, fmt.Errorf("invalid ufw rule ID: %s", ruleID)
	}
	return []string{"--force", "delete", num}, nil
}

// iptablesAddCommand returns the binary (iptables / ip6tables) and its argv.
func iptablesAddCommand(req FwAddRequest) (string, []string) {
	bin := "iptables"
	v6 := fwIPFamily(req.RemoteIP) == 6
	if v6 {
		bin = "ip6tables"
	}
	chain, ipFlag, localPortFlag, remotePortFlag := "INPUT", "-s", "--dport", "--sport"
	if req.Direction == "out" {
		chain, ipFlag, localPortFlag, remotePortFlag = "OUTPUT", "-d", "--sport", "--dport"
	}
	args := []string{"-A", chain}
	switch req.Protocol {
	case "tcp", "udp":
		args = append(args, "-p", req.Protocol)
	case "icmp":
		if v6 {
			args = append(args, "-p", "ipv6-icmp")
		} else {
			args = append(args, "-p", "icmp")
		}
	}
	if req.RemoteIP != "" {
		args = append(args, ipFlag, req.RemoteIP)
	}
	if req.LocalPort != "" {
		args = append(args, localPortFlag, strings.ReplaceAll(req.LocalPort, "-", ":"))
	}
	if req.RemotePort != "" {
		args = append(args, remotePortFlag, strings.ReplaceAll(req.RemotePort, "-", ":"))
	}
	target := "ACCEPT"
	if req.Action == "block" {
		target = "DROP"
	}
	return bin, append(args, "-j", target)
}

// iptablesDeleteArgs parses "ipt:INPUT|OUTPUT:N" (the chains ListRules reports).
func iptablesDeleteArgs(ruleID string) ([]string, error) {
	chain, num, ok := strings.Cut(strings.TrimPrefix(ruleID, "ipt:"), ":")
	if !ok || !strings.HasPrefix(ruleID, "ipt:") || (chain != "INPUT" && chain != "OUTPUT") || !fwDigitsRe.MatchString(num) {
		return nil, fmt.Errorf("invalid iptables rule ID: %s", ruleID)
	}
	return []string{"-D", chain, num}, nil
}

// netshAddArgs: netsh advfirewall firewall add rule name=... (one argv each).
func netshAddArgs(req FwAddRequest) []string {
	name := req.Name
	if name == "" {
		port := req.LocalPort
		if port == "" {
			port = "any"
		}
		name = fmt.Sprintf("Obliguard-Custom-%s-%s-%s", req.Direction, req.Protocol, port)
	}
	action := "block"
	if req.Action == "allow" {
		action = "allow"
	}
	proto := req.Protocol
	if proto == "icmp" {
		proto = "icmpv4"
		if fwIPFamily(req.RemoteIP) == 6 {
			proto = "icmpv6"
		}
	}
	args := []string{
		"advfirewall", "firewall", "add", "rule",
		"name=" + name,
		"dir=" + req.Direction,
		"action=" + action,
		"enable=yes",
		"protocol=" + proto,
	}
	if req.LocalPort != "" {
		args = append(args, "localport="+req.LocalPort)
	}
	if req.RemotePort != "" {
		args = append(args, "remoteport="+req.RemotePort)
	}
	if req.RemoteIP != "" {
		args = append(args, "remoteip="+req.RemoteIP)
	}
	return args
}

// netshParseRuleID splits "RuleName::in|out" into the rule name and netsh dir
// (empty when the id carries none). The Obliguard ban rules and the "all"
// wildcard (which would hit every rule) are refused.
func netshParseRuleID(ruleID string) (name string, dir string, err error) {
	name = ruleID
	if idx := strings.LastIndex(ruleID, "::"); idx >= 0 {
		if d := ruleID[idx+2:]; d == "in" || d == "out" {
			name, dir = ruleID[:idx], d
		}
	}
	if strings.TrimSpace(name) == "" || validateFwRuleID(name) != nil {
		return "", "", fmt.Errorf("invalid rule ID: %s", ruleID)
	}
	if fwReservedName(name) {
		return "", "", errors.New("reserved rule: Obliguard ban rules and \"all\" cannot be changed here")
	}
	return name, dir, nil
}

func netshDeleteArgs(name, dir string) []string {
	args := []string{"advfirewall", "firewall", "delete", "rule", "name=" + name}
	if dir != "" {
		args = append(args, "dir="+dir)
	}
	return args
}

func netshToggleArgs(name, dir string, enabled bool) []string {
	enableStr := "yes"
	if !enabled {
		enableStr = "no"
	}
	args := []string{"advfirewall", "firewall", "set", "rule", "name=" + name}
	if dir != "" {
		args = append(args, "dir="+dir)
	}
	return append(args, "new", "enable="+enableStr)
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

func (m *NoOpRuleManager) PlatformName() string           { return "unsupported" }
func (m *NoOpRuleManager) ListRules() ([]FwRule, error)   { return nil, nil }
func (m *NoOpRuleManager) AddRule(req FwAddRequest) error { return fmt.Errorf("unsupported platform") }
func (m *NoOpRuleManager) DeleteRule(ruleID string) error { return fmt.Errorf("unsupported platform") }
func (m *NoOpRuleManager) ToggleRule(ruleID string, _ bool) error {
	return fmt.Errorf("unsupported platform")
}
