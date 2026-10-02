package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// fakeRuleManager records what reaches the backend.
type fakeRuleManager struct {
	added   []FwAddRequest
	deleted []string
	toggled []string
}

func (f *fakeRuleManager) PlatformName() string         { return "fake" }
func (f *fakeRuleManager) ListRules() ([]FwRule, error) { return nil, nil }
func (f *fakeRuleManager) AddRule(req FwAddRequest) error {
	f.added = append(f.added, req)
	return nil
}
func (f *fakeRuleManager) DeleteRule(id string) error {
	f.deleted = append(f.deleted, id)
	return nil
}
func (f *fakeRuleManager) ToggleRule(id string, _ bool) error {
	f.toggled = append(f.toggled, id)
	return nil
}

func runFwCommand(t *testing.T, frm FirewallRuleManager, cmdType string, payload any) FwResponse {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"type": cmdType, "id": "c1", "payload": payload})
	if err != nil {
		t.Fatal(err)
	}
	var resp FwResponse
	handleFirewallCommand(frm, cmdType, "c1", raw, func(b []byte) {
		if err := json.Unmarshal(b, &resp); err != nil {
			t.Fatal(err)
		}
	})
	return resp
}

func validReq() FwAddRequest {
	return FwAddRequest{Direction: "in", Action: "block", Protocol: "tcp", LocalPort: "22", RemoteIP: "1.2.3.4"}
}

func TestValidateFwAddRequestRejectsInjection(t *testing.T) {
	cases := map[string]func(r *FwAddRequest){
		"protocol tokens":       func(r *FwAddRequest) { r.Protocol = "tcp accept" },
		"protocol unknown":      func(r *FwAddRequest) { r.Protocol = "sctp" },
		"remote ip tokens":      func(r *FwAddRequest) { r.RemoteIP = "1.2.3.4 accept" },
		"remote ip cidr tokens": func(r *FwAddRequest) { r.RemoteIP = "0.0.0.0/0 accept" },
		"remote ip newline":     func(r *FwAddRequest) { r.RemoteIP = "1.2.3.4\naccept" },
		"remote ip zone":        func(r *FwAddRequest) { r.RemoteIP = "fe80::1%eth0" },
		"remote ip hostname":    func(r *FwAddRequest) { r.RemoteIP = "example.com" },
		"remote ip bad prefix":  func(r *FwAddRequest) { r.RemoteIP = "1.2.3.4/33" },
		"local port tokens":     func(r *FwAddRequest) { r.LocalPort = "22 accept" },
		"local port nft set":    func(r *FwAddRequest) { r.LocalPort = "{ 22, 80 }" },
		"local port too big":    func(r *FwAddRequest) { r.LocalPort = "65536" },
		"local port zero":       func(r *FwAddRequest) { r.LocalPort = "0" },
		"local port bad range":  func(r *FwAddRequest) { r.LocalPort = "90-80" },
		"local port list":       func(r *FwAddRequest) { r.LocalPort = "80,443" },
		"remote port tokens":    func(r *FwAddRequest) { r.RemotePort = "53 counter accept" },
		"port without tcp/udp":  func(r *FwAddRequest) { r.Protocol = "any" },
		"port with icmp":        func(r *FwAddRequest) { r.Protocol = "icmp" },
		"direction tokens":      func(r *FwAddRequest) { r.Direction = "in out" },
		"direction empty":       func(r *FwAddRequest) { r.Direction = "" },
		"action nft verdict":    func(r *FwAddRequest) { r.Action = "accept" },
		"name quote":            func(r *FwAddRequest) { r.Name = `x" dir=out action=allow` },
		"name equals":           func(r *FwAddRequest) { r.Name = "x dir=out" },
		"name too long":         func(r *FwAddRequest) { r.Name = strings.Repeat("a", 65) },
		"name edge space":       func(r *FwAddRequest) { r.Name = " x" },
		"name ban rule":         func(r *FwAddRequest) { r.Name = "Obliguard-Block-in" },
		"name netsh wildcard":   func(r *FwAddRequest) { r.Name = "ALL" },
	}
	for name, mutate := range cases {
		r := validReq()
		mutate(&r)
		if _, err := validateFwAddRequest(r); err == nil {
			t.Errorf("%s: %+v accepted", name, r)
		}
	}
}

func TestValidateFwAddRequestCanonical(t *testing.T) {
	cases := []struct {
		in   FwAddRequest
		want FwAddRequest
	}{
		{validReq(), validReq()},
		{
			FwAddRequest{Direction: "out", Action: "allow", Protocol: "", LocalPort: "any", RemoteIP: "ANY"},
			FwAddRequest{Direction: "out", Action: "allow", Protocol: "any"},
		},
		{
			FwAddRequest{Name: "Web 8080", Direction: "in", Action: "allow", Protocol: "udp", LocalPort: "8000-8000", RemotePort: "1000-2000", RemoteIP: "10.1.2.3/8"},
			FwAddRequest{Name: "Web 8080", Direction: "in", Action: "allow", Protocol: "udp", LocalPort: "8000", RemotePort: "1000-2000", RemoteIP: "10.0.0.0/8"},
		},
		{
			FwAddRequest{Direction: "in", Action: "block", Protocol: "icmp", RemoteIP: "::ffff:1.2.3.4"},
			FwAddRequest{Direction: "in", Action: "block", Protocol: "icmp", RemoteIP: "1.2.3.4"},
		},
		{
			FwAddRequest{Direction: "in", Action: "block", Protocol: "tcp", RemoteIP: "2001:DB8::1/64"},
			FwAddRequest{Direction: "in", Action: "block", Protocol: "tcp", RemoteIP: "2001:db8::/64"},
		},
	}
	for _, c := range cases {
		got, err := validateFwAddRequest(c.in)
		if err != nil {
			t.Errorf("%+v: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%+v: got %+v, want %+v", c.in, got, c.want)
		}
	}
}

func TestValidateFwRuleID(t *testing.T) {
	ok := []string{
		"inet:filter:input:12", "ufw:3", "ipt:INPUT:2", "port:8000-8100/tcp", "rich:0", "pf:4",
		"Remote Desktop - User Mode (TCP-In)::in",
		"Partage de fichiers et d’imprimantes (Demande d’écho - Trafic entrant ICMPv4)::in",
	}
	for _, id := range ok {
		if err := validateFwRuleID(id); err != nil {
			t.Errorf("%q rejected: %v", id, err)
		}
	}
	bad := []string{"", "-F", "x\"y", `a\b`, "a\nb", "a\x00b", "a\u0085b", strings.Repeat("a", 257), "\xff"}
	for _, id := range bad {
		if validateFwRuleID(id) == nil {
			t.Errorf("%q accepted", id)
		}
	}
}

func TestNftArgv(t *testing.T) {
	got := nftAddArgs(validReq(), "inet")
	want := []string{"add", "rule", "inet", "filter", "input", "ip", "saddr", "1.2.3.4", "tcp", "dport", "22", "drop", "comment", `"obliguard-custom"`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nft in: %q", got)
	}
	out := FwAddRequest{Direction: "out", Action: "allow", Protocol: "udp", LocalPort: "5000", RemotePort: "53", RemoteIP: "2001:db8::/32"}
	got = nftAddArgs(out, "ip6")
	want = []string{"add", "rule", "ip6", "filter", "output", "ip6", "daddr", "2001:db8::/32", "udp", "sport", "5000", "udp", "dport", "53", "accept", "comment", `"obliguard-custom"`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nft out: %q", got)
	}
	got = nftAddArgs(FwAddRequest{Direction: "in", Action: "block", Protocol: "icmp"}, "inet")
	want = []string{"add", "rule", "inet", "filter", "input", "meta", "l4proto", "icmp", "drop", "comment", `"obliguard-custom"`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("nft icmp: %q", got)
	}
	for _, a := range nftAddArgs(out, "inet") {
		if strings.ContainsAny(a, " \t\n;{}") {
			t.Fatalf("nft argv element %q holds several tokens", a)
		}
	}

	if args, err := nftDeleteArgs("inet:filter:input:12"); err != nil || !reflect.DeepEqual(args, []string{"delete", "rule", "inet", "filter", "input", "handle", "12"}) {
		t.Fatalf("nft delete: %q %v", args, err)
	}
	for _, id := range []string{"inet:filter:input:12 accept", "inet:filter:input", "evil:filter:input:1", "inet:fil ter:input:1", "inet:filter:input:x", "inet:obliguard:input:3"} {
		if _, err := nftDeleteArgs(id); err == nil {
			t.Errorf("nft delete %q accepted", id)
		}
	}
}

func TestFirewalldArgv(t *testing.T) {
	cmds, err := firewalldAddCommands(FwAddRequest{Direction: "in", Action: "allow", Protocol: "tcp", LocalPort: "8000-8100"})
	if err != nil || !reflect.DeepEqual(cmds, [][]string{{"--permanent", "--add-port=8000-8100/tcp"}}) {
		t.Fatalf("firewalld port: %q %v", cmds, err)
	}
	// An allowed port restricted to one source must not open the port to all.
	cmds, err = firewalldAddCommands(FwAddRequest{Direction: "in", Action: "allow", Protocol: "tcp", LocalPort: "22", RemoteIP: "10.0.0.0/8"})
	want := [][]string{{"--permanent", `--add-rich-rule=rule family="ipv4" source address="10.0.0.0/8" port port="22" protocol="tcp" accept`}}
	if err != nil || !reflect.DeepEqual(cmds, want) {
		t.Fatalf("firewalld rich: %q %v", cmds, err)
	}
	cmds, err = firewalldAddCommands(FwAddRequest{Direction: "in", Action: "block", Protocol: "any", RemoteIP: "2001:db8::1"})
	want = [][]string{{"--permanent", `--add-rich-rule=rule family="ipv6" source address="2001:db8::1" drop`}}
	if err != nil || !reflect.DeepEqual(cmds, want) {
		t.Fatalf("firewalld v6: %q %v", cmds, err)
	}
	if _, err := firewalldAddCommands(FwAddRequest{Direction: "out", Action: "block", Protocol: "any", RemoteIP: "1.2.3.4"}); err == nil {
		t.Error("firewalld outbound accepted")
	}
	if _, err := firewalldAddCommands(FwAddRequest{Direction: "in", Action: "block", Protocol: "any"}); err == nil {
		t.Error("firewalld match-all rule accepted")
	}
	if args, err := firewalldDeletePortArgs("port:80/tcp"); err != nil || !reflect.DeepEqual(args, []string{"--permanent", "--remove-port=80/tcp"}) {
		t.Fatalf("firewalld delete: %q %v", args, err)
	}
	for _, id := range []string{"port:80/tcp --panic-on", "port:80", "port:x/tcp", "port:80/icmp"} {
		if _, err := firewalldDeletePortArgs(id); err == nil {
			t.Errorf("firewalld delete %q accepted", id)
		}
	}
}

func TestUfwArgv(t *testing.T) {
	// A remote IP keeps the port and protocol (the old code dropped them).
	got, err := ufwAddArgs(validReq())
	want := []string{"deny", "in", "proto", "tcp", "from", "1.2.3.4", "to", "any", "port", "22"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("ufw in: %q %v", got, err)
	}
	got, err = ufwAddArgs(FwAddRequest{Direction: "out", Action: "allow", Protocol: "udp", LocalPort: "5000-5010", RemotePort: "53"})
	want = []string{"allow", "out", "proto", "udp", "from", "any", "port", "5000:5010", "to", "any", "port", "53"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("ufw out: %q %v", got, err)
	}
	if _, err := ufwAddArgs(FwAddRequest{Direction: "in", Action: "block", Protocol: "any"}); err == nil {
		t.Error("ufw match-all rule accepted")
	}
	if args, err := ufwDeleteArgs("ufw:3"); err != nil || !reflect.DeepEqual(args, []string{"--force", "delete", "3"}) {
		t.Fatalf("ufw delete: %q %v", args, err)
	}
	for _, id := range []string{"ufw:3 reset", "3", "ufw:", "ufw:-1"} {
		if _, err := ufwDeleteArgs(id); err == nil {
			t.Errorf("ufw delete %q accepted", id)
		}
	}
}

func TestIptablesArgv(t *testing.T) {
	bin, got := iptablesAddCommand(validReq())
	want := []string{"-A", "INPUT", "-p", "tcp", "-s", "1.2.3.4", "--dport", "22", "-j", "DROP"}
	if bin != "iptables" || !reflect.DeepEqual(got, want) {
		t.Fatalf("iptables: %s %q", bin, got)
	}
	bin, got = iptablesAddCommand(FwAddRequest{Direction: "out", Action: "allow", Protocol: "tcp", RemotePort: "443-444", RemoteIP: "2001:db8::/32"})
	want = []string{"-A", "OUTPUT", "-p", "tcp", "-d", "2001:db8::/32", "--dport", "443:444", "-j", "ACCEPT"}
	if bin != "ip6tables" || !reflect.DeepEqual(got, want) {
		t.Fatalf("ip6tables: %s %q", bin, got)
	}
	if args, err := iptablesDeleteArgs("ipt:INPUT:2"); err != nil || !reflect.DeepEqual(args, []string{"-D", "INPUT", "2"}) {
		t.Fatalf("iptables delete: %q %v", args, err)
	}
	for _, id := range []string{"ipt:FORWARD:2", "ipt:INPUT:-F", "ipt:INPUT", "INPUT:2", "ipt:INPUT:2 -j ACCEPT"} {
		if _, err := iptablesDeleteArgs(id); err == nil {
			t.Errorf("iptables delete %q accepted", id)
		}
	}
}

func TestNetshArgv(t *testing.T) {
	r := validReq()
	r.Name = "Block SSH"
	got := netshAddArgs(r)
	want := []string{"advfirewall", "firewall", "add", "rule", "name=Block SSH", "dir=in", "action=block", "enable=yes", "protocol=tcp", "localport=22", "remoteip=1.2.3.4"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("netsh add: %q", got)
	}
	got = netshAddArgs(FwAddRequest{Direction: "out", Action: "allow", Protocol: "icmp", RemoteIP: "2001:db8::1"})
	want = []string{"advfirewall", "firewall", "add", "rule", "name=Obliguard-Custom-out-icmp-any", "dir=out", "action=allow", "enable=yes", "protocol=icmpv6", "remoteip=2001:db8::1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("netsh add icmp: %q", got)
	}

	name, dir, err := netshParseRuleID("Remote Desktop - User Mode (TCP-In)::in")
	if err != nil || name != "Remote Desktop - User Mode (TCP-In)" || dir != "in" {
		t.Fatalf("netsh id: %q %q %v", name, dir, err)
	}
	if got := netshToggleArgs(name, dir, false); !reflect.DeepEqual(got, []string{"advfirewall", "firewall", "set", "rule", "name=Remote Desktop - User Mode (TCP-In)", "dir=in", "new", "enable=no"}) {
		t.Fatalf("netsh toggle: %q", got)
	}
	if got := netshDeleteArgs("a::b", "out"); !reflect.DeepEqual(got, []string{"advfirewall", "firewall", "delete", "rule", "name=a::b", "dir=out"}) {
		t.Fatalf("netsh delete: %q", got)
	}
	if name, dir, err := netshParseRuleID("a::b::out"); err != nil || name != "a::b" || dir != "out" {
		t.Fatalf("netsh id with '::' in the name: %q %q %v", name, dir, err)
	}
	for _, id := range []string{"all", "ALL::in", "Obliguard-Block-in::in", "obliguard-block-out", "::in", `x"::in`} {
		if _, _, err := netshParseRuleID(id); err == nil {
			t.Errorf("netsh id %q accepted", id)
		}
	}
}

func TestHandleFirewallCommandValidates(t *testing.T) {
	f := &fakeRuleManager{}
	resp := runFwCommand(t, f, "firewall_add", map[string]any{"direction": "in", "action": "allow", "protocol": "tcp accept"})
	if resp.Success || !strings.Contains(resp.Error, "invalid rule") || len(f.added) != 0 {
		t.Fatalf("injected protocol: %+v added=%v", resp, f.added)
	}
	resp = runFwCommand(t, f, "firewall_add", map[string]any{"direction": "in", "action": "block", "protocol": "tcp", "localPort": "22", "remoteIp": "1.2.3.4 accept"})
	if resp.Success || len(f.added) != 0 {
		t.Fatalf("injected remote IP: %+v", resp)
	}
	resp = runFwCommand(t, f, "firewall_add", map[string]any{"direction": "in", "action": "block", "protocol": "tcp", "localPort": "22", "remoteIp": "1.2.3.4/24", "extra": "x"})
	if !resp.Success || len(f.added) != 1 || f.added[0].RemoteIP != "1.2.3.0/24" {
		t.Fatalf("valid add: %+v added=%+v", resp, f.added)
	}

	resp = runFwCommand(t, f, "firewall_delete", map[string]any{"ruleId": "-F"})
	if resp.Success || len(f.deleted) != 0 {
		t.Fatalf("delete with bad id: %+v", resp)
	}
	resp = runFwCommand(t, f, "firewall_delete", map[string]any{"ruleId": "ufw:2"})
	if !resp.Success || !reflect.DeepEqual(f.deleted, []string{"ufw:2"}) {
		t.Fatalf("delete: %+v", resp)
	}

	resp = runFwCommand(t, f, "firewall_toggle", map[string]any{"ruleId": "Rule::in"})
	if resp.Success || len(f.toggled) != 0 {
		t.Fatalf("toggle without enabled: %+v", resp)
	}
	resp = runFwCommand(t, f, "firewall_toggle", map[string]any{"ruleId": "Rule\n::in", "enabled": true})
	if resp.Success || len(f.toggled) != 0 {
		t.Fatalf("toggle with bad id: %+v", resp)
	}
	resp = runFwCommand(t, f, "firewall_toggle", map[string]any{"ruleId": "Rule::in", "enabled": false})
	if !resp.Success || len(f.toggled) != 1 {
		t.Fatalf("toggle: %+v", resp)
	}
}
