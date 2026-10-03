package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// ── Sample files (testdata/logs/*.sample) ────────────────────────────────────────
//
// Each file is replayed line by line through ONE parser instance (so IIS
// "#Fields:" headers carry over to the following lines). Grammar:
//
//	@@ parser <svcKey>      selects the parser (first directive of the file)
//	@@ expect {json}        the next log line yields exactly these events:
//	                        {"type":"auth_failure","ip":"…","user":"…","count":1}
//	                        ("type" defaults to auth_failure, "count" to 1)
//	@@ none                 the next log line yields no event
//
// Every other non-empty line is a log line that must yield NO event unless a
// directive precedes it (comments starting with '#' are fed to the parser too,
// which is how IIS header lines get in).

type sampleExpect struct {
	Type  string `json:"type"`
	IP    string `json:"ip"`
	User  string `json:"user"`
	Count int    `json:"count"`
}

type sampleCase struct {
	lineNo int
	line   string
	expect *sampleExpect // nil = no event
}

type sampleFile struct {
	parser string
	cases  []sampleCase
}

func parseSampleFile(t *testing.T, path string) sampleFile {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var sf sampleFile
	var pending *sampleExpect
	directed := false
	for i, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if rest, ok := strings.CutPrefix(line, "@@ "); ok {
			switch {
			case strings.HasPrefix(rest, "parser "):
				sf.parser = strings.TrimSpace(strings.TrimPrefix(rest, "parser "))
			case rest == "none":
				pending, directed = nil, true
			case strings.HasPrefix(rest, "expect "):
				var e sampleExpect
				if err := json.Unmarshal([]byte(strings.TrimPrefix(rest, "expect ")), &e); err != nil {
					t.Fatalf("%s:%d: bad expect directive: %v", path, i+1, err)
				}
				if e.Type == "" {
					e.Type = "auth_failure"
				}
				if e.Count == 0 {
					e.Count = 1
				}
				pending, directed = &e, true
			default:
				t.Fatalf("%s:%d: unknown directive %q", path, i+1, rest)
			}
			continue
		}
		c := sampleCase{lineNo: i + 1, line: line}
		if directed {
			c.expect = pending
		}
		sf.cases = append(sf.cases, c)
		pending, directed = nil, false
	}
	if sf.parser == "" {
		t.Fatalf("%s: missing '@@ parser' directive", path)
	}
	return sf
}

func TestParsersAgainstSamples(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("testdata", "logs", "*.sample"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no sample file in testdata/logs")
	}
	// Every built-in service must be covered by at least one sample file.
	covered := map[string]bool{}
	for _, f := range files {
		f := f
		sf := parseSampleFile(t, f)
		covered[sf.parser] = true
		t.Run(filepath.Base(f), func(t *testing.T) {
			parser := NewLogWatcher(nil).getParser(sf.parser, nil)
			if parser == nil {
				t.Fatalf("no parser for %q", sf.parser)
			}
			positives := 0
			for _, c := range sf.cases {
				got := parser.Parse(c.line, sf.parser)
				where := fmt.Sprintf("%s:%d", filepath.Base(f), c.lineNo)
				if c.expect == nil {
					if len(got) != 0 {
						t.Errorf("%s: expected no event, got %+v\n  line: %s", where, got, c.line)
					}
					continue
				}
				positives++
				if len(got) != c.expect.Count {
					t.Errorf("%s: expected %d event(s), got %d %+v\n  line: %s", where, c.expect.Count, len(got), got, c.line)
					continue
				}
				ids := map[string]bool{}
				for _, e := range got {
					if e.IP != c.expect.IP || e.Username != c.expect.User || e.EventType != c.expect.Type || e.Service != sf.parser {
						t.Errorf("%s: got {ip:%q user:%q type:%q svc:%q}, want {ip:%q user:%q type:%q svc:%q}\n  line: %s",
							where, e.IP, e.Username, e.EventType, e.Service,
							c.expect.IP, c.expect.User, c.expect.Type, sf.parser, c.line)
					}
					if e.RawLog != c.line {
						t.Errorf("%s: rawLog must be the original line, got %q", where, e.RawLog)
					}
					if ids[e.ID] {
						t.Errorf("%s: duplicate event id %s", where, e.ID)
					}
					ids[e.ID] = true
				}
			}
			if positives == 0 {
				t.Errorf("%s has no positive sample", filepath.Base(f))
			}
		})
	}
	for _, svc := range []string{"ssh", "rdp", "nginx", "apache", "iis", "ftp", "mail", "mysql", "opnsense"} {
		if !covered[svc] {
			t.Errorf("no sample file for parser %q", svc)
		}
	}
}

// No sample may ever produce the address an attacker planted in a username.
func TestSamplesNeverYieldInjectedAddress(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join("testdata", "logs", "*.sample"))
	for _, f := range files {
		sf := parseSampleFile(t, f)
		parser := NewLogWatcher(nil).getParser(sf.parser, nil)
		for _, c := range sf.cases {
			for _, e := range parser.Parse(c.line, sf.parser) {
				if e.IP == "198.51.100.66" {
					t.Errorf("%s:%d: injected address extracted\n  line: %s", filepath.Base(f), c.lineNo, c.line)
				}
			}
		}
	}
}

// ── Address validation ────────────────────────────────────────────────────────

func TestCleanIP(t *testing.T) {
	cases := map[string]string{
		"203.0.113.1":                "203.0.113.1",
		" 203.0.113.1 ":              "203.0.113.1",
		"::ffff:203.0.113.1":         "203.0.113.1",
		"2001:DB8::1":                "2001:db8::1",
		"[2001:db8::1]":              "2001:db8::1",
		"fe80::1%eth0":               "fe80::1",
		"":                           "",
		"-":                          "",
		"localhost":                  "",
		"host.example.com":           "",
		"203.0.113.1/24":             "",
		"203.0.113.256":              "",
		"203.0.113":                  "",
		"0203.0.113.1":               "",
		"203.0.113.1:22":             "",
		"203.0.113.1 198.51.100.66":  "",
		"198.51.100.66\n203.0.113.1": "",
	}
	for in, want := range cases {
		if got := cleanIP(in); got != want {
			t.Errorf("cleanIP(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCustomRegexParserValidatesAddress(t *testing.T) {
	p := &CustomRegexParser{Regex: `bad login (?P<username>\S+) from (?P<ip>\S+)`}
	if got := p.Parse("bad login bob from 203.0.113.9", "custom:/x"); len(got) != 1 || got[0].IP != "203.0.113.9" || got[0].Username != "bob" {
		t.Fatalf("valid address: got %+v", got)
	}
	if got := p.Parse("bad login bob from evil.example.com", "custom:/x"); len(got) != 0 {
		t.Fatalf("host name must be rejected: got %+v", got)
	}
	if got := p.Parse("bad login bob from ::ffff:203.0.113.9", "custom:/x"); len(got) != 1 || got[0].IP != "203.0.113.9" {
		t.Fatalf("mapped address must be folded: got %+v", got)
	}
}

func TestOPNsenseFilterParserShortLines(t *testing.T) {
	p := &OPNsenseFilterParser{}
	// Exactly 7 CSV fields used to index fields[7] out of range.
	for _, line := range []string{
		"Jan 15 10:20:30 fw filterlog[1]: 5,,,0,em0,match,block",
		"Jan 15 10:20:30 fw filterlog[1]: 5,,,0,em0,match,block,in",
		"Jan 15 10:20:30 fw filterlog[1]: 5,,,0,em0,match",
	} {
		if got := p.Parse(line, "opnsense_filter"); len(got) != 0 {
			t.Errorf("short line %q yielded %+v", line, got)
		}
	}
	line := "Jan 15 10:20:30 fw filterlog[1]: 5,,,0,em0,match,block,in,4,0x0,,64,1234,0,DF,6,tcp,60,203.0.113.200,10.0.0.1,51234,22,0,S,1,,64240,,mss"
	got := p.Parse(line, "opnsense_filter")
	if len(got) != 1 || got[0].IP != "203.0.113.200" || got[0].EventType != "auth_failure" {
		t.Fatalf("block line: got %+v", got)
	}
}

// ── Glob following and IIS header priming (tailFile) ─────────────────────────

func TestNewestMatch(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "u_ex240114.log")
	cur := filepath.Join(dir, "u_ex240115.log")
	for _, f := range []string{old, cur} {
		if err := os.WriteFile(f, []byte("x\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	_ = os.Chtimes(old, now.Add(-time.Hour), now.Add(-time.Hour))
	_ = os.Chtimes(cur, now, now)
	pattern := filepath.Join(dir, "u_ex*.log")
	if got, err := newestMatch(pattern); err != nil || got != cur {
		t.Fatalf("newestMatch = %q, %v; want %q", got, err, cur)
	}
	if !isGlobPath(pattern) || isGlobPath(cur) {
		t.Fatal("isGlobPath misclassifies paths")
	}
	if _, err := newestMatch(filepath.Join(dir, "none*.log")); err == nil {
		t.Fatal("no match must be an error")
	}
	offsets := map[string]int64{old: 1, filepath.Join(dir, "u_ex240101.log"): 5}
	pruneOffsets(offsets, pattern)
	if _, ok := offsets[old]; !ok || len(offsets) != 1 {
		t.Fatalf("pruneOffsets kept %v", offsets)
	}
}

func TestPrimeHeadersReadsSkippedIISHeader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "u_ex240115.log")
	content := "#Software: Microsoft Internet Information Services 10.0\r\n" +
		"#Fields: c-ip sc-status cs-username\r\n" +
		"203.0.113.1 200 -\r\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	p := &IISParser{}
	primeHeaders(path, int64(len(content)), p)
	got := p.Parse("203.0.113.210 401 admin", "iis")
	if len(got) != 1 || got[0].IP != "203.0.113.210" || got[0].Username != "admin" {
		t.Fatalf("primed layout not used: %+v", got)
	}
	// Other parsers are left alone.
	primeHeaders(path, int64(len(content)), &SSHParser{})
}

func waitEvents(t *testing.T, lw *LogWatcher, n int, timeout time.Duration) []AgentIpEvent {
	t.Helper()
	var out []AgentIpEvent
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out = append(out, lw.DrainEvents()...)
		if len(out) >= n {
			return out
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out: got %d event(s) %+v, want %d", len(out), out, n)
	return nil
}

func appendFile(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
	f.Close()
}

// tailFile on an IIS glob: the header of the skipped content is honoured, a
// partial line is not lost, and the next day's file is followed from its start.
func TestTailFileFollowsIISGlob(t *testing.T) {
	if testing.Short() {
		t.Skip("polls the file system")
	}
	dir := t.TempDir()
	day1 := filepath.Join(dir, "u_ex240115.log")
	header1 := "#Version: 1.0\r\n#Fields: c-ip sc-status cs-username\r\n"
	if err := os.WriteFile(day1, []byte(header1+"203.0.113.1 401 old\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	_ = os.Chtimes(day1, past, past)

	cfg := AgentServiceConfig{Enabled: true}
	lw := NewLogWatcher(map[string]AgentServiceConfig{"iis": cfg})
	t.Cleanup(lw.Stop)
	go lw.tailFile(filepath.Join(dir, "u_ex*.log"), "iis", cfg)
	time.Sleep(1500 * time.Millisecond) // first poll: skip to EOF

	// A line written in two parts must be parsed once, whole.
	appendFile(t, day1, "203.0.113.2 4")
	time.Sleep(1500 * time.Millisecond)
	appendFile(t, day1, "01 alice\r\n")
	got := waitEvents(t, lw, 1, 5*time.Second)
	if got[0].IP != "203.0.113.2" || got[0].Username != "alice" {
		t.Fatalf("day 1: got %+v", got)
	}

	// Rotation: a new file with another layout, read from its beginning.
	day2 := filepath.Join(dir, "u_ex240116.log")
	if err := os.WriteFile(day2, []byte("#Fields: date time cs-username c-ip sc-status\r\n2024-01-16 00:00:01 bob 203.0.113.3 401\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Minute)
	_ = os.Chtimes(day2, future, future)
	got = waitEvents(t, lw, 1, 5*time.Second)
	if got[0].IP != "203.0.113.3" || got[0].Username != "bob" {
		t.Fatalf("day 2: got %+v", got)
	}
	time.Sleep(1200 * time.Millisecond)
	if extra := lw.DrainEvents(); len(extra) != 0 {
		ips := make([]string, 0, len(extra))
		for _, e := range extra {
			ips = append(ips, e.IP)
		}
		sort.Strings(ips)
		t.Fatalf("unexpected extra events: %v", ips)
	}
}
