package main

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// rlFirewall records ApplyRateLimits calls (rate-limit frame tests).
type rlFirewall struct {
	NoOpFirewall
	supported bool
	fail      bool
	calls     [][]RateLimitRule
}

func (f *rlFirewall) IsRateLimitSupported() bool { return f.supported }
func (f *rlFirewall) ApplyRateLimits(rules []RateLimitRule) error {
	f.calls = append(f.calls, append([]RateLimitRule{}, rules...))
	if f.fail {
		return errors.New("test: apply failed")
	}
	return nil
}

func resetRateLimitState(t *testing.T) {
	t.Helper()
	reset := func() {
		rateLimitState.mu.Lock()
		rateLimitState.applied = false
		rateLimitState.key = ""
		rateLimitState.unsupportedSeen = false
		rateLimitState.mu.Unlock()
	}
	reset()
	t.Cleanup(reset)
}

func decodeConfig(t *testing.T, frame string) cmdConfigMsg {
	t.Helper()
	var msg cmdConfigMsg
	if err := json.Unmarshal([]byte(frame), &msg); err != nil {
		t.Fatalf("decode %s: %v", frame, err)
	}
	return msg
}

func TestRateLimitsFieldAbsentVsEmpty(t *testing.T) {
	if msg := decodeConfig(t, `{"type":"config"}`); msg.RateLimits != nil {
		t.Fatalf("absent rateLimits must decode to nil, got %v", *msg.RateLimits)
	}
	if msg := decodeConfig(t, `{"type":"config","rateLimits":null}`); msg.RateLimits != nil {
		t.Fatalf("null rateLimits must decode to nil (unchanged), got %v", *msg.RateLimits)
	}
	msg := decodeConfig(t, `{"type":"config","rateLimits":[]}`)
	if msg.RateLimits == nil || len(*msg.RateLimits) != 0 {
		t.Fatalf("[] must decode to a present, empty list, got %v", msg.RateLimits)
	}
	msg = decodeConfig(t, `{"type":"config","rateLimits":[{"type":"rate","port":22,"maxValue":10,"banMultiplier":null,"action":"drop","banTtlSeconds":null}]}`)
	if msg.RateLimits == nil || len(*msg.RateLimits) != 1 || (*msg.RateLimits)[0].MaxValue != 10 || *(*msg.RateLimits)[0].Port != 22 {
		t.Fatalf("rule list not decoded: %+v", msg.RateLimits)
	}
}

func TestApplyRateLimitsFrame(t *testing.T) {
	resetRateLimitState(t)
	cfg := &Config{ServerURL: "https://203.0.113.10"}
	fw := &rlFirewall{supported: true}
	port := 22
	rules := []RateLimitRule{{Type: "rate", Port: &port, MaxValue: 10, Action: "drop"}}
	empty := []RateLimitRule{}

	// Absent: nothing applied (the old agent cleared on every heartbeat).
	applyRateLimitsFrame(cfg, fw, nil)
	if len(fw.calls) != 0 {
		t.Fatalf("absent field must leave the limits unchanged, got %d call(s)", len(fw.calls))
	}

	applyRateLimitsFrame(cfg, fw, &rules)
	applyRateLimitsFrame(cfg, fw, &rules) // identical set: skipped
	applyRateLimitsFrame(cfg, fw, nil)
	if len(fw.calls) != 1 || !reflect.DeepEqual(fw.calls[0], rules) {
		t.Fatalf("one apply expected for an unchanged set, got %+v", fw.calls)
	}

	// [] clears, once.
	applyRateLimitsFrame(cfg, fw, &empty)
	applyRateLimitsFrame(cfg, fw, &empty)
	if len(fw.calls) != 2 || len(fw.calls[1]) != 0 {
		t.Fatalf("[] must clear exactly once, got %+v", fw.calls)
	}

	// A changed set is applied again.
	other := []RateLimitRule{{Type: "connection", MaxValue: 50, Action: "reject"}}
	applyRateLimitsFrame(cfg, fw, &other)
	if len(fw.calls) != 3 || !reflect.DeepEqual(fw.calls[2], other) {
		t.Fatalf("a changed set must be applied, got %+v", fw.calls)
	}
}

func TestApplyRateLimitsFrameRetriesAfterFailure(t *testing.T) {
	resetRateLimitState(t)
	cfg := &Config{ServerURL: "https://203.0.113.10"}
	fw := &rlFirewall{supported: true, fail: true}
	rules := []RateLimitRule{{Type: "rate", MaxValue: 5, Action: "drop"}}
	applyRateLimitsFrame(cfg, fw, &rules)
	fw.fail = false
	applyRateLimitsFrame(cfg, fw, &rules)
	applyRateLimitsFrame(cfg, fw, &rules)
	if len(fw.calls) != 2 {
		t.Fatalf("a failed apply must be retried once on the next frame, got %d call(s)", len(fw.calls))
	}
}

func TestApplyRateLimitsFrameUnsupportedBackend(t *testing.T) {
	resetRateLimitState(t)
	fw := &rlFirewall{supported: false}
	rules := []RateLimitRule{{Type: "rate", MaxValue: 5, Action: "drop"}}
	applyRateLimitsFrame(&Config{}, fw, &rules)
	if len(fw.calls) != 0 {
		t.Fatalf("an unsupported backend must never be called, got %d call(s)", len(fw.calls))
	}
}

func TestRateLimitCapabilities(t *testing.T) {
	for _, tc := range []struct {
		fw   FirewallManager
		want bool
	}{
		{&NftablesFirewall{}, true},
		{&IptablesFirewall{}, true},
		{&FirewalldFirewall{}, false},
		{&PFFirewall{}, false},
		{&FreeBSDPFFirewall{}, false},
		{&WindowsFirewall{}, false},
		{&NoOpFirewall{}, false},
	} {
		got := rateLimitCapabilities(tc.fw)
		has := len(got) == 1 && got[0] == capRateLimit
		if has != tc.want || (!tc.want && len(got) != 0) {
			t.Errorf("%T: rateLimitCapabilities = %v, want ratelimit=%v", tc.fw, got, tc.want)
		}
	}
}

func TestRateLimitExemptAddrs(t *testing.T) {
	fx := newGuardFixture("https://guard.example.com")
	got := rateLimitExemptAddrs(fx.g)
	// Server (v4 only), own non-loopback v4 address, gateway; sorted.
	want := []string{"192.168.1.1", "192.168.1.20", "203.0.113.10"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rateLimitExemptAddrs = %v want %v", got, want)
	}
}

func TestNftablesRateLimits(t *testing.T) {
	sim := newNftSim()
	r := &fakeRunner{handle: sim.handle}
	useFakeRunner(t, r)
	fw := &NftablesFirewall{}
	port := 22
	mult := 20
	fw.SetRateLimitExempt([]string{"203.0.113.10", "2001:db8::1", "bogus", "192.168.1.1"})
	if err := fw.ApplyRateLimits([]RateLimitRule{{Type: "rate", Port: &port, MaxValue: 10, BanMultiplier: &mult, Action: "drop"}}); err != nil {
		t.Fatal(err)
	}
	scripts := r.stdins("nft -f -")
	script := scripts[len(scripts)-1]
	lines := strings.Split(strings.TrimSpace(script), "\n")
	exempt := indexOfLine(lines, "add rule inet obliguard ratelimit_in ip saddr { 203.0.113.10, 192.168.1.1 } accept")
	banDrop := indexOfLine(lines, "add rule inet obliguard ratelimit_in ip saddr @obliguard_rl_bans drop")
	if exempt < 0 || banDrop < 0 || exempt > banDrop {
		t.Fatalf("protected addresses must be accepted before any rate-limit rule:\n%s", script)
	}
	for _, want := range []string{
		"flush chain inet obliguard ratelimit_in",
		"flush chain inet obliguard ratelimit_fwd",
		"add rule inet obliguard ratelimit_fwd ip saddr { 203.0.113.10, 192.168.1.1 } accept",
		"add rule inet obliguard ratelimit_in tcp dport 22 ct state new meter og_i_r_22 { ip saddr limit rate over 10/second } drop",
	} {
		if indexOfLine(lines, want) < 0 {
			t.Errorf("rate-limit script lacks %q:\n%s", want, script)
		}
	}

	// An empty set removes the chains and the escalation set.
	r.reset()
	if err := fw.ApplyRateLimits(nil); err != nil {
		t.Fatal(err)
	}
	got := r.lines()
	for _, want := range []string{
		"nft delete chain inet obliguard ratelimit_in",
		"nft delete chain inet obliguard ratelimit_fwd",
		"nft delete set inet obliguard obliguard_rl_bans",
	} {
		if indexOfLine(got, want) < 0 {
			t.Errorf("clearing lacks %q: %v", want, got)
		}
	}
	if indexOfLine(got, "nft delete set inet obliguard obliguard_rl_bans") < indexOfLine(got, "nft delete chain inet obliguard ratelimit_fwd") {
		t.Errorf("the set must be deleted after the chains that reference it: %v", got)
	}
}

// iptables and ufw share applyIptablesRateLimits: the ban-safety protected
// IPv4 addresses RETURN at the top of OBLIGUARD_RL, before any meter.
func TestIptablesRateLimitExempt(t *testing.T) {
	port := 22
	for _, fw := range []interface {
		FirewallManager
		rateLimitExempter
	}{&IptablesFirewall{}, &UFWFirewall{}} {
		r := &fakeRunner{handle: func(c fakeCall) (string, error) { return "", nil }}
		useFakeRunner(t, r)
		fw.SetRateLimitExempt([]string{"203.0.113.10", "2001:db8::1", "bogus", "192.168.1.1"})
		if err := fw.ApplyRateLimits([]RateLimitRule{{Type: "rate", Port: &port, MaxValue: 10, Action: "drop"}}); err != nil {
			t.Fatal(err)
		}
		lines := r.lines()
		flush := indexOfLine(lines, "iptables -F OBLIGUARD_RL")
		ex1 := indexOfLine(lines, "iptables -A OBLIGUARD_RL -s 203.0.113.10 -j RETURN")
		ex2 := indexOfLine(lines, "iptables -A OBLIGUARD_RL -s 192.168.1.1 -j RETURN")
		first := -1
		for i, l := range lines {
			if strings.Contains(l, "hashlimit") {
				first = i
				break
			}
		}
		if flush < 0 || ex1 < flush || ex2 < flush || first < 0 || ex1 > first || ex2 > first {
			t.Fatalf("%s: protected addresses must RETURN right after the flush, before any meter:\n%s", fw.Name(), strings.Join(lines, "\n"))
		}
		for _, l := range lines {
			if strings.Contains(l, "2001:db8::1") || strings.Contains(l, "bogus") {
				t.Errorf("%s: non-IPv4 exemption reached iptables: %q", fw.Name(), l)
			}
		}
	}
}
