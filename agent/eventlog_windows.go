//go:build windows

package main

import (
	"encoding/xml"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ── Windows Security Event Log watcher ───────────────────────────────────────
//
// Failed logons (4625, any logon type) and successful RDP logons (4624 with
// LogonType 10) are read through a pull-mode wevtapi subscription: no
// PowerShell process per poll, and events come back as raw event XML whose
// EventData field names (IpAddress, TargetUserName, LogonType) are the same on
// every Windows display language — the rendered message text is never parsed.
//
// The RecordId of the last processed event is persisted next to the binary
// (obliguard-eventlog.bookmark), so a restarted agent resumes after it instead
// of dropping the events that happened while it was down. Without a bookmark
// (first start) only new events are read, never the history. If the bookmarked
// record is gone (log cleared or overwritten) the watcher starts from new events.

const (
	secLogChannel = "Security"
	// eventLogPollInterval: how often the subscription is drained.
	eventLogPollInterval = 5 * time.Second
	// eventLogBatch: event handles requested per EvtNext call.
	eventLogBatch = 64
	// eventLogMaxPerPoll bounds one poll; a longer backlog continues on the
	// next tick (the subscription keeps its position).
	eventLogMaxPerPoll = 5000
	// eventLogMaxReplayAge: events older than this (backlog replayed after a
	// restart) are skipped; the server would clamp them to 24 h anyway.
	eventLogMaxReplayAge = 24 * time.Hour
	// eventLogErrorLogEvery throttles repeated error logs.
	eventLogErrorLogEvery = 5 * time.Minute
	eventLogBookmarkName  = "obliguard-eventlog.bookmark"
)

// secEventQuery selects every 4625 and the 4624 of type 10 only, so busy
// domain controllers (thousands of network logons per minute) are not
// rendered for nothing. secEventToAgentEvent checks the logon type again.
const secEventQuery = `<QueryList><Query Id="0" Path="Security">` +
	`<Select Path="Security">*[System[(EventID=4625)]]</Select>` +
	`<Select Path="Security">*[System[(EventID=4624)]] and *[EventData[Data[@Name='LogonType']='10']]</Select>` +
	`</Query></QueryList>`

// ── Event XML parsing (locale independent) ───────────────────────────────────

type winEventXML struct {
	System struct {
		EventID       uint32 `xml:"EventID"`
		EventRecordID uint64 `xml:"EventRecordID"`
		TimeCreated   struct {
			SystemTime string `xml:"SystemTime,attr"`
		} `xml:"TimeCreated"`
		Channel string `xml:"Channel"`
	} `xml:"System"`
	Data []struct {
		Name  string `xml:"Name,attr"`
		Value string `xml:",chardata"`
	} `xml:"EventData>Data"`
}

// secLogonEvent is the part of a Security event the watcher uses.
type secLogonEvent struct {
	EventID  uint32
	RecordID uint64
	Time     time.Time // zero when TimeCreated is missing or unreadable
	Data     map[string]string
}

// parseSecurityEventXML decodes one event as rendered by EvtRender
// (EvtRenderEventXml). Only System fields and the named EventData values are
// read; RenderingInfo (the localized message, present in some exports) is
// ignored.
func parseSecurityEventXML(b []byte) (secLogonEvent, error) {
	var x winEventXML
	if err := xml.Unmarshal(b, &x); err != nil {
		return secLogonEvent{}, err
	}
	if x.System.EventID == 0 {
		return secLogonEvent{}, errors.New("event xml: no EventID")
	}
	ev := secLogonEvent{
		EventID:  x.System.EventID,
		RecordID: x.System.EventRecordID,
		Data:     make(map[string]string, len(x.Data)),
	}
	if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(x.System.TimeCreated.SystemTime)); err == nil {
		ev.Time = t.UTC()
	}
	for _, d := range x.Data {
		if d.Name != "" {
			ev.Data[d.Name] = strings.TrimSpace(d.Value)
		}
	}
	return ev, nil
}

// secEventToAgentEvent maps a 4625 / 4624 (type 10) event to an auth event.
// Skipped: other event ids, 4624 of another logon type, no usable source
// address ("-", empty, loopback, unspecified), machine accounts (name$, normal
// domain traffic) and events older than eventLogMaxReplayAge.
func secEventToAgentEvent(ev secLogonEvent, now time.Time) (AgentIpEvent, bool) {
	logonType := ev.Data["LogonType"]
	var evType string
	switch ev.EventID {
	case 4625:
		evType = "auth_failure"
	case 4624:
		if logonType != "10" {
			return AgentIpEvent{}, false
		}
		evType = "auth_success"
	default:
		return AgentIpEvent{}, false
	}

	// Same address validation as the file parsers: literal IPs only,
	// ::ffff: folded to IPv4.
	ip := ev.Data["IpAddress"]
	if ip = cleanIP(ip); ip == "" {
		return AgentIpEvent{}, false
	}
	if a := net.ParseIP(ip); a == nil || a.IsLoopback() || a.IsUnspecified() {
		return AgentIpEvent{}, false
	}

	user := ev.Data["TargetUserName"]
	if user == "-" {
		user = ""
	}
	if strings.HasSuffix(user, "$") {
		return AgentIpEvent{}, false
	}

	if !ev.Time.IsZero() && now.Sub(ev.Time) > eventLogMaxReplayAge {
		return AgentIpEvent{}, false
	}

	rawLog := fmt.Sprintf("EventID:%d Account Name: %s Source Network Address: %s Logon Type: %s",
		ev.EventID, user, ip, logonType)
	e := makeEvent(ip, user, "rdp", evType, rawLog)
	if !ev.Time.IsZero() {
		// The event's own time: a backlog read after a restart keeps its
		// real position in the ban windows.
		e.Timestamp = ev.Time.Format(time.RFC3339)
	}
	return e, true
}

// ── Bookmark persistence ─────────────────────────────────────────────────────

func eventLogBookmarkPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), eventLogBookmarkName)
}

// loadEventLogBookmark returns the persisted RecordId (0 = none or unreadable).
func loadEventLogBookmark(path string) uint64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	id, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		return 0
	}
	return id
}

func saveEventLogBookmark(path string, id uint64) error {
	return writeFileAtomic(path, []byte(strconv.FormatUint(id, 10)+"\n"), 0644)
}

// eventLogBookmarkXML is the wevtapi bookmark for one record of a channel.
func eventLogBookmarkXML(channel string, recordID uint64) string {
	return fmt.Sprintf(`<BookmarkList><Bookmark Channel='%s' RecordId='%d' IsCurrent='true'/></BookmarkList>`,
		channel, recordID)
}

// ── Poller ───────────────────────────────────────────────────────────────────

// evtSource is a pull subscription (wevtSubscription; fakes in tests).
type evtSource interface {
	// next returns up to max rendered event XMLs; none = nothing new.
	next(max int) ([]string, error)
	close()
}

type winEventLogPoller struct {
	lw           *LogWatcher
	bookmarkFile string
	// open subscribes: after the bookmarked record when afterRecord > 0,
	// to new events otherwise.
	open func(afterRecord uint64) (evtSource, error)

	sub         evtSource
	subResumed  bool // sub was opened from the bookmark
	subDelivery bool // sub delivered at least one event
	// fromBookmark: the next open resumes after lastRecord. Cleared when the
	// bookmark cannot be used, and while the rdp template is disabled.
	fromBookmark bool
	lastRecord   uint64 // last event read (persisted)
	savedRecord  uint64
	lastErrLog   time.Time
	seenEnabled  bool // the rdp template was enabled at least once
}

// startPlatformEventLogWatcher starts the Security Event Log watcher; events
// are injected directly into the LogWatcher. Called once from mainLoop.
func startPlatformEventLogWatcher(lw *LogWatcher) {
	p := newWinEventLogPoller(lw, eventLogBookmarkPath(), openSecuritySubscription)
	go func() {
		log.Printf("Windows Security Event Log watcher started (EventID 4625/4624, bookmark %d)", p.lastRecord)
		t := time.NewTicker(eventLogPollInterval)
		defer t.Stop()
		for range t.C {
			p.tick(time.Now())
		}
	}()
}

func newWinEventLogPoller(lw *LogWatcher, bookmarkFile string, open func(uint64) (evtSource, error)) *winEventLogPoller {
	p := &winEventLogPoller{lw: lw, bookmarkFile: bookmarkFile, open: open, fromBookmark: true}
	p.lastRecord = loadEventLogBookmark(bookmarkFile)
	p.savedRecord = p.lastRecord
	return p
}

func (p *winEventLogPoller) tick(now time.Time) {
	// Honor the opt-in gate: events from this watcher are tagged
	// service="rdp", so nothing is read unless an enabled RDP template was
	// pushed by the server. Once the template is turned off (after having been
	// on in this process, or once the server pushed a config without it) the
	// bookmark is dropped, so enabling it again never replays what happened
	// while it was off. Before the first server config (configs arrive after
	// the WS connects) the bookmark is kept for the resume.
	if !p.lw.IsServiceEnabled("rdp") {
		p.closeSub()
		if !p.seenEnabled && !p.lw.ConfigsReceived() {
			return
		}
		if p.lastRecord != 0 || p.savedRecord != 0 {
			p.lastRecord, p.savedRecord = 0, 0
			if err := os.Remove(p.bookmarkFile); err != nil && !os.IsNotExist(err) {
				p.logErr(now, "Windows Event Log: cannot remove bookmark: %v", err)
			}
		}
		p.fromBookmark = false
		return
	}

	p.seenEnabled = true
	if p.sub == nil && !p.openSub(now) {
		return
	}

	read := 0
	for read < eventLogMaxPerPoll {
		xmls, err := p.sub.next(eventLogBatch)
		if err != nil {
			p.logErr(now, "Windows Event Log: read failed: %v — resubscribing", err)
			if p.subResumed && !p.subDelivery {
				// The bookmark itself is what fails: start from new events.
				p.fromBookmark = false
			}
			p.closeSub()
			break
		}
		if len(xmls) == 0 {
			break
		}
		p.subDelivery = true
		for _, x := range xmls {
			read++
			ev, err := parseSecurityEventXML([]byte(x))
			if err != nil {
				continue
			}
			// Events come in log order: the last one read is the position
			// to resume from (after a log clear RecordIds restart lower).
			if ev.RecordID > 0 {
				p.lastRecord = ev.RecordID
			}
			if e, ok := secEventToAgentEvent(ev, now); ok {
				p.lw.addEvent(e)
			}
		}
	}

	if p.lastRecord != 0 && p.lastRecord != p.savedRecord {
		if err := saveEventLogBookmark(p.bookmarkFile, p.lastRecord); err != nil {
			p.logErr(now, "Windows Event Log: cannot save bookmark: %v", err)
		} else {
			p.savedRecord = p.lastRecord
		}
	}
}

func (p *winEventLogPoller) openSub(now time.Time) bool {
	if p.fromBookmark && p.lastRecord > 0 {
		sub, err := p.open(p.lastRecord)
		if err == nil {
			p.sub, p.subResumed, p.subDelivery = sub, true, false
			p.fromBookmark = true
			return true
		}
		log.Printf("Windows Event Log: bookmark %d unusable (%v) — reading new events only", p.lastRecord, err)
	}
	sub, err := p.open(0)
	if err != nil {
		p.logErr(now, "Windows Event Log: subscribe failed: %v", err)
		return false
	}
	p.sub, p.subResumed, p.subDelivery = sub, false, false
	// A later resubscription (read error) resumes after what this one read.
	p.fromBookmark = true
	return true
}

func (p *winEventLogPoller) closeSub() {
	if p.sub != nil {
		p.sub.close()
		p.sub = nil
	}
}

func (p *winEventLogPoller) logErr(now time.Time, format string, args ...any) {
	if now.Sub(p.lastErrLog) < eventLogErrorLogEvery {
		return
	}
	p.lastErrLog = now
	log.Printf(format, args...)
}

// ── wevtapi (pull subscription) ──────────────────────────────────────────────

var (
	modWevtapi            = windows.NewLazySystemDLL("wevtapi.dll")
	procEvtSubscribe      = modWevtapi.NewProc("EvtSubscribe")
	procEvtNext           = modWevtapi.NewProc("EvtNext")
	procEvtRender         = modWevtapi.NewProc("EvtRender")
	procEvtClose          = modWevtapi.NewProc("EvtClose")
	procEvtCreateBookmark = modWevtapi.NewProc("EvtCreateBookmark")
)

const (
	evtSubscribeToFutureEvents     = 1
	evtSubscribeStartAtOldest      = 2
	evtSubscribeStartAfterBookmark = 3
	evtSubscribeStrict             = 0x10000
	evtRenderEventXML              = 1
	// errEvtInvalidOperation: EvtNext on a subscription with nothing pending.
	errEvtInvalidOperation = syscall.Errno(4317)
	// evtMaxRenderChars bounds the render buffer (one event is a few KB).
	evtMaxRenderChars = 1 << 20
)

// wevtErr turns the GetLastError value of a failed wevtapi call into an error.
func wevtErr(fn string, e error) error {
	if errno, ok := e.(syscall.Errno); ok && errno != 0 {
		return fmt.Errorf("%s: %w", fn, errno)
	}
	return fmt.Errorf("%s failed", fn)
}

func evtClose(h uintptr) {
	if h != 0 {
		procEvtClose.Call(h)
	}
}

// wevtSubscription is a pull-mode subscription: EvtNext is called on each
// tick; the signal event is required by the API but not waited on.
type wevtSubscription struct {
	h      uintptr
	signal windows.Handle
	buf    []uint16
}

func openSecuritySubscription(afterRecord uint64) (evtSource, error) {
	return openWevtSubscription(secLogChannel, secEventQuery, afterRecord, false)
}

// openWevtSubscription subscribes to query: after the bookmarked record of
// channel (strict: fails when that record no longer exists) when afterRecord
// > 0, from the oldest record when fromOldest, to new events otherwise.
func openWevtSubscription(channel, query string, afterRecord uint64, fromOldest bool) (*wevtSubscription, error) {
	if err := procEvtSubscribe.Find(); err != nil {
		return nil, err
	}
	q, err := windows.UTF16PtrFromString(query)
	if err != nil {
		return nil, err
	}
	signal, err := windows.CreateEvent(nil, 1, 1, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateEvent: %w", err)
	}

	flags := uintptr(evtSubscribeToFutureEvents)
	var bookmark uintptr
	switch {
	case afterRecord > 0:
		bx, err := windows.UTF16PtrFromString(eventLogBookmarkXML(channel, afterRecord))
		if err != nil {
			windows.CloseHandle(signal)
			return nil, err
		}
		r, _, e := procEvtCreateBookmark.Call(uintptr(unsafe.Pointer(bx)))
		if r == 0 {
			windows.CloseHandle(signal)
			return nil, wevtErr("EvtCreateBookmark", e)
		}
		bookmark = r
		defer evtClose(bookmark)
		flags = evtSubscribeStartAfterBookmark | evtSubscribeStrict
	case fromOldest:
		flags = evtSubscribeStartAtOldest
	}

	h, _, e := procEvtSubscribe.Call(0, uintptr(signal), 0, uintptr(unsafe.Pointer(q)), bookmark, 0, 0, flags)
	if h == 0 {
		windows.CloseHandle(signal)
		return nil, wevtErr("EvtSubscribe", e)
	}
	return &wevtSubscription{h: h, signal: signal}, nil
}

func (s *wevtSubscription) next(max int) ([]string, error) {
	if max <= 0 {
		return nil, nil
	}
	handles := make([]uintptr, max)
	var returned uint32
	r, _, e := procEvtNext.Call(s.h, uintptr(max), uintptr(unsafe.Pointer(&handles[0])), 0, 0,
		uintptr(unsafe.Pointer(&returned)))
	if r == 0 {
		// Nothing pending: NO_MORE_ITEMS, or TIMEOUT for a zero wait. Treated as
		// an empty read, never as a failure (a failure on a resumed
		// subscription would drop the bookmark).
		if errno, ok := e.(syscall.Errno); ok && (errno == windows.ERROR_NO_MORE_ITEMS || errno == windows.ERROR_TIMEOUT || errno == errEvtInvalidOperation) {
			return nil, nil
		}
		return nil, wevtErr("EvtNext", e)
	}
	if int(returned) > max {
		returned = uint32(max)
	}
	out := make([]string, 0, returned)
	for _, h := range handles[:returned] {
		x, err := s.render(h)
		evtClose(h)
		if err == nil {
			out = append(out, x)
		}
	}
	return out, nil
}

// render returns the event XML (EvtRenderEventXml), growing the buffer once.
func (s *wevtSubscription) render(h uintptr) (string, error) {
	if len(s.buf) == 0 {
		s.buf = make([]uint16, 8192)
	}
	for attempt := 0; attempt < 2; attempt++ {
		var used, props uint32
		r, _, e := procEvtRender.Call(0, h, evtRenderEventXML, uintptr(len(s.buf)*2),
			uintptr(unsafe.Pointer(&s.buf[0])), uintptr(unsafe.Pointer(&used)), uintptr(unsafe.Pointer(&props)))
		if r != 0 {
			n := int(used / 2)
			if n > len(s.buf) {
				n = len(s.buf)
			}
			return windows.UTF16ToString(s.buf[:n]), nil
		}
		errno, _ := e.(syscall.Errno)
		need := int(used/2) + 1
		if errno != windows.ERROR_INSUFFICIENT_BUFFER || attempt > 0 || need > evtMaxRenderChars {
			return "", wevtErr("EvtRender", e)
		}
		s.buf = make([]uint16, need)
	}
	return "", errors.New("EvtRender: buffer")
}

func (s *wevtSubscription) close() {
	evtClose(s.h)
	s.h = 0
	if s.signal != 0 {
		windows.CloseHandle(s.signal)
		s.signal = 0
	}
}
