//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ── Captured Security event XML ──────────────────────────────────────────────
//
// Shapes as rendered by EvtRender(EvtRenderEventXml) on Windows Server 2019 /
// 2022 (en-US and fr-FR). The fr-FR export carries a RenderingInfo block with
// the localized message: the parser must only read the EventData names.

const evt4625EN = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4625</EventID><Version>0</Version><Level>0</Level><Task>12544</Task><Opcode>0</Opcode><Keywords>0x8010000000000000</Keywords><TimeCreated SystemTime='2026-10-02T08:15:42.1234567Z'/><EventRecordID>1048577</EventRecordID><Correlation ActivityID='{6a1c3f2e-0000-0000-0000-000000000000}'/><Execution ProcessID='812' ThreadID='4520'/><Channel>Security</Channel><Computer>SRV-RDS01.corp.local</Computer><Security/></System><EventData><Data Name='SubjectUserSid'>S-1-0-0</Data><Data Name='SubjectUserName'>-</Data><Data Name='SubjectDomainName'>-</Data><Data Name='SubjectLogonId'>0x0</Data><Data Name='TargetUserSid'>S-1-0-0</Data><Data Name='TargetUserName'>administrator</Data><Data Name='TargetDomainName'></Data><Data Name='Status'>0xc000006d</Data><Data Name='FailureReason'>%%2313</Data><Data Name='SubStatus'>0xc000006a</Data><Data Name='LogonType'>3</Data><Data Name='LogonProcessName'>NtLmSsp </Data><Data Name='AuthenticationPackageName'>NTLM</Data><Data Name='WorkstationName'>-</Data><Data Name='TransmittedServices'>-</Data><Data Name='LmPackageName'>-</Data><Data Name='KeyLength'>0</Data><Data Name='ProcessId'>0x0</Data><Data Name='ProcessName'>-</Data><Data Name='IpAddress'>203.0.113.45</Data><Data Name='IpPort'>0</Data></EventData></Event>`

const evt4625FR = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4625</EventID><Version>0</Version><Level>0</Level><Task>12544</Task><Opcode>0</Opcode><Keywords>0x8010000000000000</Keywords><TimeCreated SystemTime='2026-10-02T08:16:01.5Z'/><EventRecordID>1048578</EventRecordID><Correlation/><Execution ProcessID='812' ThreadID='4520'/><Channel>Security</Channel><Computer>SRV-RDS01</Computer><Security/></System><EventData><Data Name='SubjectUserSid'>S-1-5-18</Data><Data Name='SubjectUserName'>SRV-RDS01$</Data><Data Name='TargetUserSid'>S-1-0-0</Data><Data Name='TargetUserName'>Frédéric</Data><Data Name='TargetDomainName'>CORP</Data><Data Name='Status'>0xc000006d</Data><Data Name='SubStatus'>0xc0000064</Data><Data Name='LogonType'>10</Data><Data Name='WorkstationName'>ATTAQUANT</Data><Data Name='IpAddress'>::ffff:198.51.100.7</Data><Data Name='IpPort'>51234</Data></EventData><RenderingInfo Culture='fr-FR'><Message>Échec d'ouverture de session d'un compte.

Sujet :
	ID de sécurité :		SYSTEM
Informations sur le réseau :
	Nom de la station de travail :	ATTAQUANT
	Adresse du réseau source :	198.51.100.7
	Port source :		51234</Message><Level>Information</Level><Task>Logon</Task><Keywords><Keyword>Échec de l'audit</Keyword></Keywords></RenderingInfo></Event>`

const evt4624RDP = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing'/><EventID>4624</EventID><TimeCreated SystemTime='2026-10-02T08:20:00.0000000Z'/><EventRecordID>1048590</EventRecordID><Channel>Security</Channel></System><EventData><Data Name='TargetUserName'>jdoe</Data><Data Name='TargetDomainName'>CORP</Data><Data Name='LogonType'>10</Data><Data Name='IpAddress'>2001:db8::25</Data><Data Name='IpPort'>0</Data></EventData></Event>`

func secEvent(id int, record uint64, ip, user, logonType, when string) string {
	return fmt.Sprintf(`<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>%d</EventID><TimeCreated SystemTime='%s'/><EventRecordID>%d</EventRecordID><Channel>Security</Channel></System><EventData><Data Name='TargetUserName'>%s</Data><Data Name='LogonType'>%s</Data><Data Name='IpAddress'>%s</Data></EventData></Event>`,
		id, when, record, user, logonType, ip)
}

var evtNow = time.Date(2026, 10, 2, 8, 30, 0, 0, time.UTC)

// ── Parsing ──────────────────────────────────────────────────────────────────

func TestParseSecurityEventXML(t *testing.T) {
	ev, err := parseSecurityEventXML([]byte(evt4625EN))
	if err != nil {
		t.Fatal(err)
	}
	if ev.EventID != 4625 || ev.RecordID != 1048577 {
		t.Fatalf("ids: %+v", ev)
	}
	if want := time.Date(2026, 10, 2, 8, 15, 42, 123456700, time.UTC); !ev.Time.Equal(want) {
		t.Fatalf("time = %v want %v", ev.Time, want)
	}
	if ev.Data["IpAddress"] != "203.0.113.45" || ev.Data["TargetUserName"] != "administrator" || ev.Data["LogonType"] != "3" {
		t.Fatalf("data: %v", ev.Data)
	}

	for _, bad := range []string{"", "<Event>", "<Event><System></System></Event>", "not xml"} {
		if _, err := parseSecurityEventXML([]byte(bad)); err == nil {
			t.Errorf("parse(%q) must fail", bad)
		}
	}
}

func TestSecEventLocalizedMessageIgnored(t *testing.T) {
	ev, err := parseSecurityEventXML([]byte(evt4625FR))
	if err != nil {
		t.Fatal(err)
	}
	e, ok := secEventToAgentEvent(ev, evtNow)
	if !ok {
		t.Fatal("fr-FR 4625 must give an event")
	}
	if e.IP != "198.51.100.7" || e.Username != "Frédéric" || e.EventType != "auth_failure" || e.Service != "rdp" {
		t.Fatalf("event: %+v", e)
	}
	if e.Timestamp != "2026-10-02T08:16:01Z" {
		t.Fatalf("timestamp = %q (must be the event time)", e.Timestamp)
	}
	if !strings.Contains(e.RawLog, "EventID:4625") || !strings.Contains(e.RawLog, "Logon Type: 10") {
		t.Fatalf("rawLog: %q", e.RawLog)
	}
}

func TestSecEventToAgentEvent(t *testing.T) {
	ev, _ := parseSecurityEventXML([]byte(evt4625EN))
	e, ok := secEventToAgentEvent(ev, evtNow)
	if !ok || e.IP != "203.0.113.45" || e.Username != "administrator" || e.EventType != "auth_failure" {
		t.Fatalf("4625 network logon: %+v %v", e, ok)
	}

	ev, _ = parseSecurityEventXML([]byte(evt4624RDP))
	e, ok = secEventToAgentEvent(ev, evtNow)
	if !ok || e.IP != "2001:db8::25" || e.EventType != "auth_success" || e.Username != "jdoe" {
		t.Fatalf("4624 RDP: %+v %v", e, ok)
	}

	recent := "2026-10-02T08:29:00Z"
	cases := []struct {
		name string
		xml  string
		ok   bool
		ip   string
		user string
	}{
		{"dash address", secEvent(4625, 1, "-", "bob", "3", recent), false, "", ""},
		{"empty address", secEvent(4625, 2, "", "bob", "3", recent), false, "", ""},
		{"ipv6 loopback", secEvent(4625, 3, "::1", "bob", "3", recent), false, "", ""},
		{"ipv4 loopback", secEvent(4625, 4, "127.0.0.1", "bob", "3", recent), false, "", ""},
		{"mapped loopback", secEvent(4625, 5, "::ffff:127.0.0.1", "bob", "3", recent), false, "", ""},
		{"unspecified", secEvent(4625, 6, "0.0.0.0", "bob", "3", recent), false, "", ""},
		{"hostname", secEvent(4625, 7, "ATTACKER-PC", "bob", "3", recent), false, "", ""},
		{"machine account", secEvent(4625, 8, "192.0.2.10", "WS01$", "3", recent), false, "", ""},
		{"4624 network logon", secEvent(4624, 9, "192.0.2.10", "bob", "3", recent), false, "", ""},
		{"other event id", secEvent(4634, 10, "192.0.2.10", "bob", "10", recent), false, "", ""},
		{"too old", secEvent(4625, 11, "192.0.2.10", "bob", "3", "2026-09-30T08:00:00Z"), false, "", ""},
		{"dash user", secEvent(4625, 12, "192.0.2.10", "-", "3", recent), true, "192.0.2.10", ""},
		{"scoped ipv6", secEvent(4625, 13, "fe80::1%12", "bob", "3", recent), true, "fe80::1", "bob"},
		{"mapped ipv4", secEvent(4625, 14, "::ffff:192.0.2.99", "bob", "10", recent), true, "192.0.2.99", "bob"},
		{"4624 rdp", secEvent(4624, 15, "192.0.2.10", "alice", "10", recent), true, "192.0.2.10", "alice"},
	}
	for _, c := range cases {
		ev, err := parseSecurityEventXML([]byte(c.xml))
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		e, ok := secEventToAgentEvent(ev, evtNow)
		if ok != c.ok {
			t.Errorf("%s: ok = %v want %v (%+v)", c.name, ok, c.ok, e)
			continue
		}
		if ok && (e.IP != c.ip || e.Username != c.user) {
			t.Errorf("%s: ip/user = %q/%q want %q/%q", c.name, e.IP, e.Username, c.ip, c.user)
		}
	}
}

func TestSecEventNoTimeUsesNow(t *testing.T) {
	ev, err := parseSecurityEventXML([]byte(secEvent(4625, 1, "192.0.2.1", "bob", "3", "garbage")))
	if err != nil {
		t.Fatal(err)
	}
	e, ok := secEventToAgentEvent(ev, evtNow)
	if !ok || e.Timestamp == "" {
		t.Fatalf("missing time must keep the event with the current time: %+v %v", e, ok)
	}
}

// ── Bookmark ─────────────────────────────────────────────────────────────────

func TestEventLogBookmarkFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), eventLogBookmarkName)
	if got := loadEventLogBookmark(path); got != 0 {
		t.Fatalf("missing file = %d", got)
	}
	if err := saveEventLogBookmark(path, 1048590); err != nil {
		t.Fatal(err)
	}
	if got := loadEventLogBookmark(path); got != 1048590 {
		t.Fatalf("reload = %d", got)
	}
	os.WriteFile(path, []byte("garbage\r\n"), 0644)
	if got := loadEventLogBookmark(path); got != 0 {
		t.Fatalf("garbage = %d", got)
	}
	os.WriteFile(path, []byte("42\r\n"), 0644)
	if got := loadEventLogBookmark(path); got != 42 {
		t.Fatalf("crlf = %d", got)
	}
	if got, want := eventLogBookmarkXML("Security", 42), `<BookmarkList><Bookmark Channel='Security' RecordId='42' IsCurrent='true'/></BookmarkList>`; got != want {
		t.Fatalf("bookmark xml = %s", got)
	}
}

// ── Poller ───────────────────────────────────────────────────────────────────

type fakeEvtSource struct {
	batches [][]string
	err     error
	closed  bool
}

func (s *fakeEvtSource) next(max int) ([]string, error) {
	if s.err != nil {
		return nil, s.err
	}
	if len(s.batches) == 0 {
		return nil, nil
	}
	b := s.batches[0]
	s.batches = s.batches[1:]
	return b, nil
}

func (s *fakeEvtSource) close() { s.closed = true }

type fakeEvtOpener struct {
	opens   []uint64 // afterRecord of each open
	sources []*fakeEvtSource
	failAt  map[uint64]error
}

func (o *fakeEvtOpener) open(after uint64) (evtSource, error) {
	o.opens = append(o.opens, after)
	if err := o.failAt[after]; err != nil {
		return nil, err
	}
	if len(o.sources) == 0 {
		return &fakeEvtSource{}, nil
	}
	s := o.sources[0]
	o.sources = o.sources[1:]
	return s, nil
}

func rdpWatcher(enabled bool) *LogWatcher {
	return NewLogWatcher(map[string]AgentServiceConfig{"rdp": {Enabled: enabled}})
}

func TestEventLogPollerResumesFromBookmark(t *testing.T) {
	path := filepath.Join(t.TempDir(), eventLogBookmarkName)
	if err := saveEventLogBookmark(path, 100); err != nil {
		t.Fatal(err)
	}
	lw := rdpWatcher(true)
	src := &fakeEvtSource{batches: [][]string{{
		secEvent(4625, 101, "192.0.2.1", "bob", "3", "2026-10-02T08:29:00Z"),
		secEvent(4625, 102, "127.0.0.1", "bob", "3", "2026-10-02T08:29:01Z"),
		"<broken",
		secEvent(4624, 103, "192.0.2.2", "alice", "10", "2026-10-02T08:29:02Z"),
	}}}
	op := &fakeEvtOpener{sources: []*fakeEvtSource{src}}
	p := newWinEventLogPoller(lw, path, op.open)
	p.tick(evtNow)

	if len(op.opens) != 1 || op.opens[0] != 100 {
		t.Fatalf("opens = %v (must resume after record 100)", op.opens)
	}
	evs := lw.DrainEvents()
	if len(evs) != 2 || evs[0].IP != "192.0.2.1" || evs[1].EventType != "auth_success" {
		t.Fatalf("events = %+v", evs)
	}
	if got := loadEventLogBookmark(path); got != 103 {
		t.Fatalf("bookmark = %d want 103", got)
	}

	// A read error resubscribes after the last record read.
	src.err = errors.New("rpc server unavailable")
	p.tick(evtNow)
	if !src.closed || p.sub != nil {
		t.Fatal("a failed subscription must be closed")
	}
	p.tick(evtNow)
	if got := op.opens[len(op.opens)-1]; got != 103 {
		t.Fatalf("resubscribe after = %d want 103", got)
	}
}

func TestEventLogPollerBookmarkGone(t *testing.T) {
	path := filepath.Join(t.TempDir(), eventLogBookmarkName)
	saveEventLogBookmark(path, 5000)
	lw := rdpWatcher(true)
	op := &fakeEvtOpener{
		failAt:  map[uint64]error{5000: errors.New("The specified bookmark was not found")},
		sources: []*fakeEvtSource{{batches: [][]string{{secEvent(4625, 7, "192.0.2.3", "x", "3", "2026-10-02T08:29:00Z")}}}},
	}
	p := newWinEventLogPoller(lw, path, op.open)
	p.tick(evtNow)
	if len(op.opens) != 2 || op.opens[0] != 5000 || op.opens[1] != 0 {
		t.Fatalf("opens = %v (bookmark, then new events)", op.opens)
	}
	// After a cleared log the record ids restart lower: the bookmark follows.
	if got := loadEventLogBookmark(path); got != 7 {
		t.Fatalf("bookmark = %d want 7", got)
	}
}

func TestEventLogPollerGate(t *testing.T) {
	path := filepath.Join(t.TempDir(), eventLogBookmarkName)
	saveEventLogBookmark(path, 100)
	lw := rdpWatcher(false)
	op := &fakeEvtOpener{}
	p := newWinEventLogPoller(lw, path, op.open)

	// No enabled rdp config yet (configs arrive after the WS connects): no
	// subscription, bookmark kept for the resume.
	p.tick(evtNow)
	if len(op.opens) != 0 || loadEventLogBookmark(path) != 100 {
		t.Fatalf("before the first config: opens=%v bookmark=%d", op.opens, loadEventLogBookmark(path))
	}

	lw.UpdateConfigs(map[string]AgentServiceConfig{"rdp": {Enabled: true}})
	p.tick(evtNow)
	if len(op.opens) != 1 || op.opens[0] != 100 {
		t.Fatalf("opens = %v", op.opens)
	}

	// Turned off: subscription closed, bookmark dropped.
	lw.UpdateConfigs(map[string]AgentServiceConfig{"rdp": {Enabled: false}})
	p.tick(evtNow)
	if p.sub != nil {
		t.Fatal("subscription must be closed while rdp is disabled")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("bookmark must be removed when rdp is disabled")
	}

	// Turned on again: new events only.
	lw.UpdateConfigs(map[string]AgentServiceConfig{"rdp": {Enabled: true}})
	p.tick(evtNow)
	if got := op.opens[len(op.opens)-1]; got != 0 {
		t.Fatalf("re-enable must read new events only, opened after %d", got)
	}
}

// A restart while rdp is disabled: the first server config without rdp drops
// the bookmark, so enabling rdp later never replays the backlog.
func TestEventLogPollerFirstConfigDisabledDropsBookmark(t *testing.T) {
	path := filepath.Join(t.TempDir(), eventLogBookmarkName)
	saveEventLogBookmark(path, 100)
	lw := rdpWatcher(false)
	op := &fakeEvtOpener{}
	p := newWinEventLogPoller(lw, path, op.open)

	lw.UpdateConfigs(map[string]AgentServiceConfig{"ssh": {Enabled: true}})
	p.tick(evtNow)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("bookmark must be removed once the server config arrives without rdp")
	}
	lw.UpdateConfigs(map[string]AgentServiceConfig{"rdp": {Enabled: true}})
	p.tick(evtNow)
	if len(op.opens) != 1 || op.opens[0] != 0 {
		t.Fatalf("enable after a disabled start must read new events only, opens=%v", op.opens)
	}
}

func TestEventLogPollerBoundedPerTick(t *testing.T) {
	path := filepath.Join(t.TempDir(), eventLogBookmarkName)
	lw := rdpWatcher(true)
	src := &fakeEvtSource{}
	batch := make([]string, eventLogBatch)
	for i := range batch {
		batch[i] = secEvent(4625, uint64(i+1), "-", "x", "3", "2026-10-02T08:29:00Z")
	}
	for i := 0; i < eventLogMaxPerPoll/eventLogBatch+5; i++ {
		src.batches = append(src.batches, batch)
	}
	op := &fakeEvtOpener{sources: []*fakeEvtSource{src}}
	p := newWinEventLogPoller(lw, path, op.open)
	p.tick(evtNow)
	if len(src.batches) == 0 {
		t.Fatal("one tick must stop at eventLogMaxPerPoll")
	}
}

// ── wevtapi smoke test ───────────────────────────────────────────────────────

// TestWevtSubscriptionSystemLog drives the real wevtapi calls against the
// System log (readable without elevation): read from the oldest record, then
// resume strictly after a bookmark. Skipped when the log cannot be read.
func TestWevtSubscriptionSystemLog(t *testing.T) {
	const q = `<QueryList><Query Id="0" Path="System"><Select Path="System">*</Select></Query></QueryList>`
	sub, err := openWevtSubscription("System", q, 0, true)
	if err != nil {
		t.Skipf("System log not readable: %v", err)
	}
	xmls, err := sub.next(4)
	sub.close()
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if len(xmls) < 2 {
		t.Skipf("System log has %d event(s)", len(xmls))
	}
	first, err := parseSecurityEventXML([]byte(xmls[0]))
	if err != nil || first.RecordID == 0 || first.Time.IsZero() {
		t.Fatalf("rendered xml not parsed: %v %+v\n%s", err, first, xmls[0])
	}
	second, _ := parseSecurityEventXML([]byte(xmls[1]))

	resumed, err := openWevtSubscription("System", q, first.RecordID, false)
	if err != nil {
		t.Fatalf("resume after %d: %v", first.RecordID, err)
	}
	defer resumed.close()
	next, err := resumed.next(1)
	if err != nil || len(next) != 1 {
		t.Fatalf("resumed next: %v (%d)", err, len(next))
	}
	got, _ := parseSecurityEventXML([]byte(next[0]))
	if got.RecordID != second.RecordID {
		t.Fatalf("resumed at record %d want %d", got.RecordID, second.RecordID)
	}

	if _, err := openWevtSubscription("System", q, 1<<62, false); err == nil {
		t.Fatal("a bookmark on a missing record must fail (strict)")
	}
}
