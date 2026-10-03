package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// ── Event queue ───────────────────────────────────────────────────────────────

func testEvents(from, n int) []AgentIpEvent {
	out := make([]AgentIpEvent, n)
	for i := range out {
		out[i] = AgentIpEvent{ID: fmt.Sprintf("e%d", from+i), IP: "203.0.113.7", Service: "ssh", EventType: "auth_failure"}
	}
	return out
}

func eventIDs(evts []AgentIpEvent) []string {
	ids := make([]string, len(evts))
	for i, e := range evts {
		ids[i] = e.ID
	}
	return ids
}

func TestEventQueueDropOldest(t *testing.T) {
	q := newEventQueue(5)
	q.Push(testEvents(0, 3)...)
	q.Push(testEvents(3, 5)...) // 8 pushed, capacity 5: e0..e2 dropped
	if q.Len() != 5 {
		t.Fatalf("len = %d, want 5", q.Len())
	}
	if d := q.TakeDropped(); d != 3 {
		t.Fatalf("dropped = %d, want 3", d)
	}
	if d := q.TakeDropped(); d != 0 {
		t.Fatalf("dropped counter not reset: %d", d)
	}
	got := eventIDs(q.PopBatch(10))
	if want := []string{"e3", "e4", "e5", "e6", "e7"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("kept %v, want the newest %v", got, want)
	}
	if q.PopBatch(10) != nil || q.Len() != 0 {
		t.Fatal("queue not empty")
	}
}

func TestEventQueueDefaultCapacity(t *testing.T) {
	q := newEventQueue(0)
	q.Push(testEvents(0, eventQueueCap+250)...)
	if q.Len() != eventQueueCap || q.TakeDropped() != 250 {
		t.Fatalf("len = %d, want the %d cap", q.Len(), eventQueueCap)
	}
}

func TestEventQueueBatchSizes(t *testing.T) {
	q := newEventQueue(eventQueueCap)
	q.Push(testEvents(0, 1234)...)
	var sizes []int
	var ids []string
	for {
		b := q.PopBatch(eventBatchMax)
		if b == nil {
			break
		}
		sizes = append(sizes, len(b))
		ids = append(ids, eventIDs(b)...)
	}
	if !reflect.DeepEqual(sizes, []int{500, 500, 234}) {
		t.Fatalf("batch sizes = %v", sizes)
	}
	for i, id := range ids {
		if id != fmt.Sprintf("e%d", i) {
			t.Fatalf("order broken at %d: %s", i, id)
		}
	}
	if b := q.PopBatch(0); b != nil {
		t.Fatal("empty queue returned a batch")
	}
}

func TestEventQueueRequeue(t *testing.T) {
	q := newEventQueue(4)
	q.Push(testEvents(0, 3)...)
	batch := q.PopBatch(2) // e0 e1 fail to send
	q.Push(testEvents(3, 1)...)
	q.Requeue(batch, 7)
	if got := eventIDs(q.PopBatch(10)); !reflect.DeepEqual(got, []string{"e0", "e1", "e2", "e3"}) {
		t.Fatalf("requeued order = %v", got)
	}
	if d := q.TakeDropped(); d != 7 {
		t.Fatalf("dropped count not restored: %d", d)
	}

	// Overflow while the batch was out: the requeued (oldest) events go first.
	q.Push(testEvents(10, 2)...)
	batch = q.PopBatch(2) // e10 e11
	q.Push(testEvents(12, 3)...)
	q.Requeue(batch, 0)
	if got := eventIDs(q.PopBatch(10)); !reflect.DeepEqual(got, []string{"e11", "e12", "e13", "e14"}) {
		t.Fatalf("overflow kept %v", got)
	}
	if d := q.TakeDropped(); d != 1 {
		t.Fatalf("overflow dropped = %d, want 1", d)
	}
}

func TestEventQueueRawLogTruncated(t *testing.T) {
	q := newEventQueue(10)
	e := testEvents(0, 1)[0]
	e.RawLog = "x" + strings.Repeat("é", 1500)
	q.Push(e)
	got := q.PopBatch(1)[0].RawLog
	if len(got) > eventRawLogMax || !utf8.ValidString(got) || !strings.HasPrefix(got, "xé") {
		t.Fatalf("raw log len=%d valid=%v", len(got), utf8.ValidString(got))
	}
	short := testEvents(1, 1)[0]
	short.RawLog = "Failed password for root"
	q.Push(short)
	if q.PopBatch(1)[0].RawLog != short.RawLog {
		t.Fatal("short raw log altered")
	}
}

func TestEventQueueSteadyStateMemory(t *testing.T) {
	q := newEventQueue(100)
	next := 0
	for round := 0; round < 2000; round++ {
		q.Push(testEvents(next, 7)...)
		next += 7
		b := q.PopBatch(5)
		if len(b) == 0 {
			t.Fatal("empty batch")
		}
	}
	if q.Len() > 100 {
		t.Fatalf("len %d over capacity", q.Len())
	}
	if c := cap(q.items); c > 1024 {
		t.Fatalf("backing slice grew to %d", c)
	}
	// Remaining events are the newest, in order.
	ids := eventIDs(q.PopBatch(1000))
	last := fmt.Sprintf("e%d", next-1)
	if ids[len(ids)-1] != last {
		t.Fatalf("last = %s, want %s", ids[len(ids)-1], last)
	}
}

func TestEventQueueConcurrent(t *testing.T) {
	q := newEventQueue(1000)
	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				q.Push(testEvents(w*1000+i, 1)...)
			}
		}(w)
	}
	popped := 0
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	for {
		popped += len(q.PopBatch(50))
		select {
		case <-done:
			popped += len(q.PopBatch(5000))
			if popped+q.TakeDropped() != 2000 {
				t.Fatalf("popped %d: events lost without being counted", popped)
			}
			return
		default:
		}
	}
}

// ── Command loop: writer, event flush, backoff ────────────────────────────────

// pipeSession returns a session writing to one end of an in-memory pipe and a
// wsConn reading the other end (masked client frames are unmasked by ReadFrame).
func pipeSession(t *testing.T) (*cmdSession, *wsConn) {
	t.Helper()
	client, server := net.Pipe()
	s := newCmdSession(&wsConn{conn: client, r: bufio.NewReader(client)})
	writerDone := make(chan struct{})
	go func() { defer close(writerDone); s.writeLoop() }()
	t.Cleanup(func() {
		s.fail(errCmdWSClosed)
		<-writerDone
		client.Close()
		server.Close()
	})
	return s, &wsConn{conn: server, r: bufio.NewReader(server)}
}

func TestFlushEventQueueBatchesWithDroppedCount(t *testing.T) {
	s, peer := pipeSession(t)
	q := newEventQueue(1000)
	q.Push(testEvents(0, 1200)...) // 200 oldest dropped

	frames := make(chan cmdEventsMsg, 8)
	go func() {
		for {
			_, payload, err := peer.ReadFrame()
			if err != nil {
				close(frames)
				return
			}
			var m cmdEventsMsg
			if json.Unmarshal(payload, &m) == nil {
				frames <- m
			}
		}
	}()

	if err := flushEventQueue(s, q); err != nil {
		t.Fatal(err)
	}
	var got []cmdEventsMsg
	for len(got) < 2 {
		select {
		case m := <-frames:
			got = append(got, m)
		case <-time.After(5 * time.Second):
			t.Fatalf("got %d frames", len(got))
		}
	}
	if got[0].Type != "events" || len(got[0].Events) != 500 || got[0].Dropped != 200 {
		t.Fatalf("frame 1: type=%q events=%d dropped=%d", got[0].Type, len(got[0].Events), got[0].Dropped)
	}
	if len(got[1].Events) != 500 || got[1].Dropped != 0 {
		t.Fatalf("frame 2: events=%d dropped=%d", len(got[1].Events), got[1].Dropped)
	}
	if got[0].Events[0].ID != "e200" || got[1].Events[499].ID != "e1199" {
		t.Fatalf("order: first=%s last=%s", got[0].Events[0].ID, got[1].Events[499].ID)
	}
	if q.Len() != 0 {
		t.Fatalf("%d events left", q.Len())
	}

	// The JSON field is omitted when nothing was dropped (older servers).
	data, _ := json.Marshal(cmdEventsMsg{Type: "events", Events: testEvents(0, 1)})
	if strings.Contains(string(data), "dropped") {
		t.Fatalf("dropped sent when zero: %s", data)
	}
}

func TestFlushEventQueueRequeuesOnWriteError(t *testing.T) {
	s, peer := pipeSession(t)
	peer.conn.Close() // writes now fail
	q := newEventQueue(1000)
	q.Push(testEvents(0, 600)...)
	q.Requeue(nil, 3)

	if err := flushEventQueue(s, q); err == nil {
		t.Fatal("flush on a dead connection succeeded")
	}
	if q.Len() != 600 {
		t.Fatalf("len = %d: the failed batch was not requeued", q.Len())
	}
	if d := q.TakeDropped(); d != 3 {
		t.Fatalf("dropped = %d, want 3 kept for the next session", d)
	}
	if first := q.PopBatch(1); first[0].ID != "e0" {
		t.Fatalf("requeued batch not in front: %s", first[0].ID)
	}
	if s.Err() == nil {
		t.Fatal("a write error must end the session")
	}
}

func TestSessionSendAfterClose(t *testing.T) {
	s, _ := pipeSession(t)
	s.fail(errCmdWSServerClosed)
	if err := s.send(0x1, []byte("{}"), nil); !errors.Is(err, errCmdWSClosed) {
		t.Fatalf("send after close: %v", err)
	}
	if err := sessionResult(s.Err()); err != nil {
		t.Fatalf("a server close is a clean end, got %v", err)
	}
}

func TestReconnectBackoff(t *testing.T) {
	var seq []time.Duration
	for d := cmdWSReconnectBase; len(seq) < 8; d = nextBackoff(d) {
		seq = append(seq, d)
	}
	want := []time.Duration{2, 4, 8, 16, 32, 60, 60, 60}
	for i := range want {
		if seq[i] != want[i]*time.Second {
			t.Fatalf("backoff sequence = %v", seq)
		}
	}
	for _, d := range []time.Duration{2 * time.Second, 32 * time.Second, 60 * time.Second} {
		seen := map[time.Duration]bool{}
		for i := 0; i < 200; i++ {
			j := jitterBackoff(d)
			if j < d/2 || j > cmdWSReconnectMax || (d < cmdWSReconnectMax && j >= d+d/2) {
				t.Fatalf("jitter(%s) = %s out of range", d, j)
			}
			seen[j] = true
		}
		if len(seen) < 10 {
			t.Fatalf("jitter(%s) not spread: %d distinct values", d, len(seen))
		}
	}
}

// ── Firewall commands off the read loop ───────────────────────────────────────

type slowRuleManager struct {
	NoOpRuleManager
	release chan struct{}
}

func (m *slowRuleManager) ListRules() ([]FwRule, error) {
	<-m.release
	return []FwRule{{ID: "r1", Name: "late"}}, nil
}
func (m *slowRuleManager) PlatformName() string { return "test" }

func TestRunFirewallCommandTimeout(t *testing.T) {
	m := &slowRuleManager{release: make(chan struct{})}
	old := platformRuleManager
	platformRuleManager = m
	t.Cleanup(func() { platformRuleManager = old })

	start := time.Now()
	ended := make(chan struct{})
	data := runFirewallCommand("firewall_list", "c1", []byte(`{"type":"firewall_list","id":"c1"}`), 50*time.Millisecond, nil, func() { close(ended) })
	var resp FwResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Type != "firewall_response" || resp.ID != "c1" || resp.Success || !strings.Contains(resp.Error, "timed out") {
		t.Fatalf("timeout response = %+v", resp)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("the timeout did not bound the wait")
	}

	// The timed-out command still runs: its slot is not released yet.
	select {
	case <-ended:
		t.Fatal("done called before the command ended")
	case <-time.After(50 * time.Millisecond):
	}

	// Once the backend answers, the slot is released and the next command
	// gets the real result.
	close(m.release)
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("done not called once the command ended")
	}
	data = runFirewallCommand("firewall_list", "c2", []byte(`{"type":"firewall_list","id":"c2"}`), 5*time.Second, nil, nil)
	resp = FwResponse{}
	if err := json.Unmarshal(data, &resp); err != nil || !resp.Success || resp.ID != "c2" || len(resp.Rules) != 1 {
		t.Fatalf("response = %+v (%v)", resp, err)
	}

	// A session that ended discards the answer.
	stop := make(chan struct{})
	close(stop)
	m2 := &slowRuleManager{release: make(chan struct{})}
	platformRuleManager = m2
	if data := runFirewallCommand("firewall_list", "c3", nil, time.Minute, stop, nil); data != nil {
		t.Fatalf("answer after session end: %s", data)
	}
	close(m2.release)
}

// ── Ban delta worker ──────────────────────────────────────────────────────────

// setFirewall is a FirewallManager holding a ban set.
type setFirewall struct {
	NoOpFirewall
	mu      sync.Mutex
	banned  map[string]bool
	flushes int
}

func (f *setFirewall) BanIP(ip string) error {
	f.mu.Lock()
	f.banned[ip] = true
	f.mu.Unlock()
	return nil
}
func (f *setFirewall) UnbanIP(ip string) error {
	f.mu.Lock()
	delete(f.banned, ip)
	f.mu.Unlock()
	return nil
}
func (f *setFirewall) Flush() error {
	f.mu.Lock()
	f.flushes++
	f.mu.Unlock()
	return nil
}
func (f *setFirewall) snapshot() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for k := range f.banned {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestBanDeltaLastOperationWins(t *testing.T) {
	fw := &setFirewall{banned: map[string]bool{"198.51.100.9": true}}
	queueBanDelta(fw, []string{"203.0.113.1", "203.0.113.2"}, []string{"198.51.100.9"})
	queueBanDelta(fw, []string{"203.0.113.3"}, []string{"203.0.113.1"})
	want := []string{"203.0.113.2", "203.0.113.3"}
	deadline := time.Now().Add(5 * time.Second)
	for !reflect.DeepEqual(fw.snapshot(), want) {
		if time.Now().After(deadline) {
			t.Fatalf("banned = %v, want %v", fw.snapshot(), want)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Coalescing: the mailbox keeps one operation per entry.
	banDelta.mu.Lock()
	banDelta.ops = map[string]bool{}
	banDelta.mu.Unlock()
	banDelta.mu.Lock()
	for _, k := range []string{"a", "b"} {
		banDelta.ops[k] = true
	}
	banDelta.ops["a"] = false
	banDelta.mu.Unlock()
	add, remove := takeBanDelta()
	if !reflect.DeepEqual(add, []string{"b"}) || !reflect.DeepEqual(remove, []string{"a"}) {
		t.Fatalf("add=%v remove=%v", add, remove)
	}
}

// ── Uninstall: firewall cleanup and scripts ───────────────────────────────────

func TestCleanupLinuxFirewall(t *testing.T) {
	r := &fakeRunner{}
	var mu sync.Mutex
	attempts := map[string]int{}
	r.handle = func(c fakeCall) (string, error) {
		line := c.line()
		switch {
		case line == "firewall-cmd --permanent --get-ipsets":
			return "obliguard obliguard_net other", nil
		case line == "iptables -D INPUT -j OBLIGUARD":
			// The jump exists twice: removed twice, then "does not exist".
			mu.Lock()
			defer mu.Unlock()
			attempts[line]++
			if attempts[line] <= 2 {
				return "", nil
			}
			return "", errors.New("Bad rule")
		case strings.HasPrefix(line, "iptables -D"):
			return "", errors.New("Bad rule")
		}
		return "", nil
	}
	useFakeRunner(t, r)

	var logged []string
	cleanupLinuxFirewall(func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) })
	lines := r.lines()
	for _, want := range []string{
		"firewall-cmd --permanent --remove-rich-rule=rule family=ipv4 source ipset=obliguard drop",
		"firewall-cmd --permanent --remove-rich-rule=rule family=ipv4 destination ipset=obliguard_net drop",
		"firewall-cmd --permanent --delete-ipset=obliguard",
		"firewall-cmd --permanent --delete-ipset=obliguard_net",
		"firewall-cmd --reload",
		"nft delete table inet obliguard",
		"iptables -D OUTPUT -j OBLIGUARD_OUT",
		"iptables -D DOCKER-USER -j OBLIGUARD_RL",
		"iptables -D INPUT -m set --match-set obliguard src -j DROP",
		"iptables -F OBLIGUARD",
		"iptables -X OBLIGUARD_RL",
		"ipset destroy obliguard",
		"ipset destroy obliguard_rl_bans",
	} {
		mustHaveLine(t, lines, want)
	}
	// Repeated until it fails: 2 removals + the failing attempt.
	n := 0
	for _, l := range lines {
		if l == "iptables -D INPUT -j OBLIGUARD" {
			n++
		}
	}
	if n != 3 {
		t.Fatalf("duplicate jump: %d attempts, want 3", n)
	}
	// Order: firewalld before the raw ipsets, rules before the sets.
	if indexOfLine(lines, "firewall-cmd --reload") > indexOfLine(lines, "ipset destroy obliguard") ||
		indexOfLine(lines, "iptables -X OBLIGUARD") > indexOfLine(lines, "ipset destroy obliguard") {
		t.Fatalf("wrong order:\n%s", strings.Join(lines, "\n"))
	}
	if len(logged) == 0 {
		t.Fatal("nothing logged")
	}

	// No agent ipset in firewalld: no rich-rule change and, above all, no reload.
	r2 := &fakeRunner{handle: func(c fakeCall) (string, error) {
		if c.line() == "firewall-cmd --permanent --get-ipsets" {
			return "docker other", nil
		}
		return "", errors.New("absent")
	}, missing: map[string]bool{"iptables": true}}
	useFakeRunner(t, r2)
	cleanupLinuxFirewall(func(string, ...any) {})
	for _, l := range r2.lines() {
		if strings.HasPrefix(l, "firewall-cmd") && l != "firewall-cmd --permanent --get-ipsets" {
			t.Fatalf("firewalld touched without agent ipsets: %s", l)
		}
		if strings.HasPrefix(l, "iptables") {
			t.Fatalf("missing iptables still run: %s", l)
		}
	}
}

func TestUninstallScripts(t *testing.T) {
	linux := buildLinuxUninstallScript()
	for _, want := range []string{
		"systemctl stop obliguard-agent",
		"/opt/obliguard-agent/obliguard-agent cleanup-firewall",
		"nft delete table inet obliguard",
		"ipset destroy obliguard",
		"rm -rf /opt/obliguard-agent/",
		"rm -rf " + shellQuote(configDir),
	} {
		if !strings.Contains(linux, want) {
			t.Fatalf("linux script lacks %q:\n%s", want, linux)
		}
	}
	// The service is stopped before the firewall cleanup (nothing re-bans).
	if strings.Index(linux, "systemctl stop") > strings.Index(linux, "cleanup-firewall") {
		t.Fatal("cleanup before the service stop")
	}
	scripts := map[string]string{"linux": linux, "darwin": buildDarwinUninstallScript(), "freebsd": buildFreeBSDUninstallScript()}
	for name, s := range []string{scripts["darwin"], scripts["freebsd"]} {
		if !strings.Contains(s, "/usr/local/bin/obliguard-agent pf-cleanup") || !strings.Contains(s, "pfctl -a obliguard") {
			t.Fatalf("pf script %d lacks the pf cleanup:\n%s", name, s)
		}
	}
	if sh, err := exec.LookPath("sh"); err == nil {
		for name, s := range scripts {
			if out, err := exec.Command(sh, "-n", "-c", s).CombinedOutput(); err != nil {
				t.Fatalf("%s script syntax: %v %s", name, err, out)
			}
		}
	}

	win := buildWindowsUninstallScript("{8D56E26E-B218-4788-81B6-4E5088F285F6}",
		`C:\Program Files\ObliguardAgent\obliguard-agent.exe`, `C:\ProgramData\ObliguardAgent\update\u.log`, `C:\ProgramData\ObliguardAgent`)
	for _, want := range []string{
		"msiexec /x {8D56E26E-B218-4788-81B6-4E5088F285F6} /qn",
		`"C:\Program Files\ObliguardAgent\obliguard-agent.exe" cleanup-firewall`,
		`sc delete "%SVC%"`,
		`rd /s /q "C:\ProgramData\ObliguardAgent"`,
	} {
		if !strings.Contains(win, want) {
			t.Fatalf("windows script lacks %q:\n%s", want, win)
		}
	}
	if strings.Contains(win, "timeout ") || !strings.HasSuffix(strings.TrimRight(win, "\r\n"), `rd /s /q "C:\ProgramData\ObliguardAgent" >nul 2>&1`) {
		t.Fatalf("windows script must avoid timeout.exe and remove its own directory last:\n%s", win)
	}
	noMSI := buildWindowsUninstallScript("", `C:\a\obliguard-agent.exe`, `C:\d\u.log`, `C:\d`)
	if strings.Contains(noMSI, "msiexec") {
		t.Fatalf("msiexec without a ProductCode:\n%s", noMSI)
	}
	// Never remove the directory of a binary outside the MSI install directory.
	if strings.Contains(noMSI, `rd /s /q "C:\a"`) {
		t.Fatalf("foreign directory removed:\n%s", noMSI)
	}
	if runtime.GOOS == "windows" && !strings.Contains(win, `rd /s /q "C:\Program Files\ObliguardAgent"`) {
		t.Fatalf("install directory not removed:\n%s", win)
	}
	if !productCodeRe.MatchString("{8D56E26E-B218-4788-81B6-4E5088F285F6}") || productCodeRe.MatchString(`{x" & calc}`) {
		t.Fatal("ProductCode validation")
	}
}
