package main

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// queueTestFirewall is an in-memory ban set (queued command tests).
type queueTestFirewall struct {
	NoOpFirewall
	mu      sync.Mutex
	set     map[string]bool
	banned  []string
	lifted  []string
	flushes int
}

func newQueueTestFirewall(entries ...string) *queueTestFirewall {
	f := &queueTestFirewall{set: make(map[string]bool)}
	for _, e := range entries {
		f.set[e] = true
	}
	return f
}

func (f *queueTestFirewall) BanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.set[ip] = true
	f.banned = append(f.banned, ip)
	return nil
}

func (f *queueTestFirewall) UnbanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.set, ip)
	f.lifted = append(f.lifted, ip)
	return nil
}

func (f *queueTestFirewall) Flush() error {
	f.mu.Lock()
	f.flushes++
	f.mu.Unlock()
	return nil
}

func (f *queueTestFirewall) GetBannedIPs() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.set))
	for k := range f.set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

// queueErrFirewall cannot read its state back.
type queueErrFirewall struct{ NoOpFirewall }

func (f *queueErrFirewall) GetBannedIPs() ([]string, error) { return nil, errors.New("backend down") }

// resetQueuedCommands clears the remembered ids and restores the hooks.
func resetQueuedCommands(t *testing.T) {
	t.Helper()
	savedRestart, savedUninstall, savedExit := prepareRestartFn, launchUninstallFn, exitProcessFn
	reset := func() {
		queuedCmds.mu.Lock()
		queuedCmds.state = nil
		queuedCmds.order = nil
		queuedCmds.mu.Unlock()
	}
	reset()
	t.Cleanup(func() {
		reset()
		prepareRestartFn, launchUninstallFn, exitProcessFn = savedRestart, savedUninstall, savedExit
	})
}

// commandHarness wires a session on a pipe and collects the command_ack frames.
type commandHarness struct {
	s    *cmdSession
	rt   *cmdRuntime
	acks chan cmdAckMsg
}

func newCommandHarness(t *testing.T, fw FirewallManager) *commandHarness {
	t.Helper()
	resetQueuedCommands(t)
	s, peer := pipeSession(t)
	h := &commandHarness{
		s:    s,
		rt:   &cmdRuntime{config: make(chan []byte, 4), cfg: &Config{ServerURL: "https://192.0.2.10"}, fw: fw},
		acks: make(chan cmdAckMsg, 16),
	}
	go func() {
		for {
			_, payload, err := peer.ReadFrame()
			if err != nil {
				return
			}
			var m cmdAckMsg
			if json.Unmarshal(payload, &m) == nil && m.Type == "command_ack" {
				h.acks <- m
			}
		}
	}()
	return h
}

func (h *commandHarness) deliver(t *testing.T, frame string) {
	t.Helper()
	if !h.s.dispatch(h.rt, []byte(frame)) {
		t.Fatal("dispatch ended the session")
	}
}

func (h *commandHarness) next(t *testing.T) cmdAckMsg {
	t.Helper()
	select {
	case m := <-h.acks:
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("no command_ack within 5 s")
	}
	return cmdAckMsg{}
}

func (h *commandHarness) none(t *testing.T) {
	t.Helper()
	select {
	case m := <-h.acks:
		t.Fatalf("unexpected ack %+v", m)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestQueuedFirewallResyncReconcilesTheFullList(t *testing.T) {
	resetRateLimitState(t)
	fw := newQueueTestFirewall("203.0.113.1", "203.0.113.2", "198.51.100.0/24")
	h := newCommandHarness(t, fw)
	rateLimitState.mu.Lock()
	rateLimitState.applied = true
	rateLimitState.mu.Unlock()

	h.deliver(t, `{"type":"command","id":"7","command":"firewall_resync","payload":{"bans":["203.0.113.2","203.0.113.3","198.51.100.9/24","192.0.2.10"]}}`)

	if a := h.next(t); a.ID != "7" || a.Status != cmdAckAcked {
		t.Fatalf("first ack = %+v, want acked", a)
	}
	a := h.next(t)
	if a.Status != cmdAckSucceeded {
		t.Fatalf("final ack = %+v, want succeeded", a)
	}
	// The server address is refused by the ban-safety guard; the /24 is canonical.
	if a.Result["desired"] != float64(3) || a.Result["added"] != float64(1) || a.Result["removed"] != float64(1) {
		t.Fatalf("result = %v", a.Result)
	}
	got, _ := fw.GetBannedIPs()
	want := []string{"198.51.100.0/24", "203.0.113.2", "203.0.113.3"}
	if len(got) != len(want) {
		t.Fatalf("firewall = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("firewall = %v, want %v", got, want)
		}
	}
	// Entries already enforced are never added twice.
	if len(fw.banned) != 1 || fw.banned[0] != "203.0.113.3" {
		t.Fatalf("BanIP calls = %v", fw.banned)
	}
	rateLimitState.mu.Lock()
	applied := rateLimitState.applied
	rateLimitState.mu.Unlock()
	if applied {
		t.Fatal("rate limits must be re-applied by the next config frame")
	}
}

func TestQueuedFirewallResyncFailures(t *testing.T) {
	h := newCommandHarness(t, newQueueTestFirewall())
	h.deliver(t, `{"type":"command","id":"8","command":"firewall_resync","payload":{}}`)
	h.next(t)
	if a := h.next(t); a.Status != cmdAckFailed || a.Result["error"] == nil {
		t.Fatalf("missing ban list: %+v", a)
	}

	h2 := newCommandHarness(t, &queueErrFirewall{})
	h2.deliver(t, `{"type":"command","id":"9","command":"firewall_resync","payload":{"bans":[]}}`)
	h2.next(t)
	if a := h2.next(t); a.Status != cmdAckFailed {
		t.Fatalf("unreadable firewall: %+v", a)
	}
}

func TestQueuedRestartAcksBeforeRestarting(t *testing.T) {
	h := newCommandHarness(t, newQueueTestFirewall())
	restarted := make(chan struct{}, 1)
	prepareRestartFn = func() (func(), error) {
		return func() { restarted <- struct{}{} }, nil
	}
	h.deliver(t, `{"type":"command","id":"10","command":"restart","payload":{}}`)
	if a := h.next(t); a.Status != cmdAckAcked {
		t.Fatalf("first ack = %+v", a)
	}
	if a := h.next(t); a.Status != cmdAckSucceeded {
		t.Fatalf("final ack = %+v", a)
	}
	select {
	case <-restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("restart not performed")
	}

	prepareRestartFn = func() (func(), error) { return nil, errors.New("no service manager") }
	h.deliver(t, `{"type":"command","id":"11","command":"restart"}`)
	h.next(t)
	if a := h.next(t); a.Status != cmdAckFailed {
		t.Fatalf("failed restart: %+v", a)
	}
}

func TestQueuedUninstallAcksThenExits(t *testing.T) {
	h := newCommandHarness(t, newQueueTestFirewall())
	launched := false
	exited := make(chan int, 1)
	launchUninstallFn = func(*Config) error { launched = true; return nil }
	exitProcessFn = func(code int) { exited <- code }
	h.deliver(t, `{"type":"command","id":"12","command":"uninstall","payload":{}}`)
	h.next(t)
	if a := h.next(t); a.Status != cmdAckSucceeded {
		t.Fatalf("final ack = %+v", a)
	}
	select {
	case code := <-exited:
		if code != 0 || !launched {
			t.Fatalf("exit %d, launched %v", code, launched)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agent did not exit after the uninstall")
	}

	launchUninstallFn = func(*Config) error { return errors.New("script write failed") }
	h.deliver(t, `{"type":"command","id":"13","command":"uninstall"}`)
	h.next(t)
	if a := h.next(t); a.Status != cmdAckFailed {
		t.Fatalf("failed uninstall: %+v", a)
	}
	select {
	case <-exited:
		t.Fatal("must not exit when the script could not be launched")
	default:
	}
}

func TestQueuedCommandRedeliveryAndUnknown(t *testing.T) {
	h := newCommandHarness(t, newQueueTestFirewall())
	runs := 0
	prepareRestartFn = func() (func(), error) { runs++; return func() {}, nil }
	h.deliver(t, `{"type":"command","id":"20","command":"restart"}`)
	h.next(t)
	final := h.next(t)

	// Delivered again (the ack was lost): answered with the same outcome, not run twice.
	h.deliver(t, `{"type":"command","id":"20","command":"restart"}`)
	if again := h.next(t); again.Status != final.Status || again.ID != "20" {
		t.Fatalf("re-delivery answered %+v, want %+v", again, final)
	}
	h.none(t)
	if runs != 1 {
		t.Fatalf("restart prepared %d times", runs)
	}

	h.deliver(t, `{"type":"command","id":"21","command":"collect_logs"}`)
	h.next(t)
	if a := h.next(t); a.Status != cmdAckFailed {
		t.Fatalf("unknown command: %+v", a)
	}

	// Malformed frames are ignored (no id, oversized id).
	h.deliver(t, `{"type":"command","command":"restart"}`)
	h.deliver(t, `{"type":"command","id":"`+strings.Repeat("9", 65)+`","command":"restart"}`)
	h.none(t)
}

func TestHeartbeatAdvertisesCommandQueue(t *testing.T) {
	for _, c := range heartbeatCapabilities(&NoOpFirewall{}) {
		if c == "cmdqueue" {
			return
		}
	}
	t.Fatal("heartbeat capabilities must advertise cmdqueue")
}
