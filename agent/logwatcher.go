package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ── Auth event accumulated between pushes ─────────────────────────────────────

// LogWatcher tails log files for configured services and accumulates
// auth events to be sent on the next push.
type LogWatcher struct {
	mu           sync.Mutex
	events       []AgentIpEvent
	samples      map[string][]string // logPath → last N lines (when sample requested)
	configs      map[string]AgentServiceConfig
	parsers      map[string]LogParser // serviceType → parser
	watchedFiles map[string]struct{}  // paths currently being tailed
	stopCh       chan struct{}
	// flushCh receives a non-blocking signal whenever a new event is added.
	// The WS loop uses this to debounce real-time event flushes (≤500 ms latency).
	flushCh chan struct{}
	// configsReceived is set by the first UpdateConfigs (a config pushed by
	// the server in this process, not the cached one from config.json).
	configsReceived bool
}

func NewLogWatcher(initialConfigs map[string]AgentServiceConfig) *LogWatcher {
	lw := &LogWatcher{
		samples:      map[string][]string{},
		configs:      map[string]AgentServiceConfig{},
		watchedFiles: map[string]struct{}{},
		stopCh:       make(chan struct{}),
		flushCh:      make(chan struct{}, 1),
	}

	lw.parsers = map[string]LogParser{
		"ssh":             &SSHParser{},
		"rdp":             &RDPParser{},
		"nginx":           &NginxParser{},
		"apache":          &ApacheParser{},
		"iis":             &IISParser{},
		"ftp":             &FTPParser{},
		"mail":            &MailParser{},
		"mysql":           &MySQLParser{},
		"opnsense":        &OPNsenseParser{},
		"opnsense_filter": &OPNsenseFilterParser{},
	}

	if initialConfigs != nil {
		lw.configs = initialConfigs
	}

	return lw
}

// Start begins watching log files for all enabled service configs.
func (lw *LogWatcher) Start() {
	go lw.watchLoop()
}

// Stop signals the watcher to stop.
func (lw *LogWatcher) Stop() {
	close(lw.stopCh)
}

// UpdateConfigs replaces the service configs received from server.
func (lw *LogWatcher) UpdateConfigs(configs map[string]AgentServiceConfig) {
	lw.mu.Lock()
	defer lw.mu.Unlock()
	lw.configs = configs
	lw.configsReceived = true
}

// ConfigsReceived reports whether the server has pushed service configs since
// the agent started (the cached configs of config.json do not count).
func (lw *LogWatcher) ConfigsReceived() bool {
	lw.mu.Lock()
	defer lw.mu.Unlock()
	return lw.configsReceived
}

// IsServiceEnabled reports whether the server has sent an enabled config for
// the given service key. The unconditional pollers (Windows Security Event Log,
// TCP netconn monitor) call this so they honor the SAME opt-in gate as the file
// tailer: no enabled template for a service ⇒ no events emitted for it. Without
// this, those two pollers would surface RDP/Nginx events even when nothing is
// enabled server-side (the file tailer already gates via cfg.Enabled).
func (lw *LogWatcher) IsServiceEnabled(svc string) bool {
	lw.mu.Lock()
	defer lw.mu.Unlock()
	cfg, ok := lw.configs[svc]
	return ok && cfg.Enabled
}

// IsAnyEnabled reports whether ANY of the given service keys has an enabled
// config. Lets a monitor (e.g. the TCP connection poller) skip its work
// entirely when none of the services it watches is active.
func (lw *LogWatcher) IsAnyEnabled(svcs []string) bool {
	lw.mu.Lock()
	defer lw.mu.Unlock()
	for _, s := range svcs {
		if cfg, ok := lw.configs[s]; ok && cfg.Enabled {
			return true
		}
	}
	return false
}

// DrainEvents returns accumulated events and clears the internal buffer.
func (lw *LogWatcher) DrainEvents() []AgentIpEvent {
	lw.mu.Lock()
	defer lw.mu.Unlock()
	if len(lw.events) == 0 {
		return nil
	}
	out := lw.events
	lw.events = nil
	return out
}

// DrainSamples returns pending log samples and clears them.
func (lw *LogWatcher) DrainSamples() map[string][]string {
	lw.mu.Lock()
	defer lw.mu.Unlock()
	if len(lw.samples) == 0 {
		return nil
	}
	out := lw.samples
	lw.samples = map[string][]string{}
	return out
}

func (lw *LogWatcher) addEvent(e AgentIpEvent) {
	lw.mu.Lock()
	lw.events = append(lw.events, e)
	lw.mu.Unlock()

	// Non-blocking signal so the WS loop can debounce and flush quickly.
	select {
	case lw.flushCh <- struct{}{}:
	default: // channel already has a pending signal — no-op
	}
}

// FlushCh returns the channel that receives a signal when new events are available.
// Consumers should read this channel and then call DrainEvents() after a short debounce.
func (lw *LogWatcher) FlushCh() <-chan struct{} {
	return lw.flushCh
}

// watchLoop runs every 10s and ensures each configured log file is being tailed.
func (lw *LogWatcher) watchLoop() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	// Initial start
	lw.startWatchers()

	for {
		select {
		case <-ticker.C:
			lw.startWatchers()
		case <-lw.stopCh:
			return
		}
	}
}

func (lw *LogWatcher) startWatchers() {
	lw.mu.Lock()
	configs := make(map[string]AgentServiceConfig, len(lw.configs))
	for k, v := range lw.configs {
		configs[k] = v
	}
	lw.mu.Unlock()

	for svcKey, cfg := range configs {
		if !cfg.Enabled {
			continue
		}

		logPath := resolveLogPath(svcKey, cfg)
		if logPath == "" {
			continue
		}

		lw.mu.Lock()
		_, alreadyWatching := lw.watchedFiles[logPath]
		if !alreadyWatching {
			lw.watchedFiles[logPath] = struct{}{}
		}
		lw.mu.Unlock()

		if !alreadyWatching {
			if strings.HasPrefix(logPath, "journald:") {
				unit := strings.TrimPrefix(logPath, "journald:")
				go lw.tailJournald(logPath, unit, svcKey, cfg)
			} else if strings.HasPrefix(logPath, "clog:") {
				clogFile := strings.TrimPrefix(logPath, "clog:")
				go lw.tailClog(logPath, clogFile, svcKey, cfg)
			} else {
				go lw.tailFile(logPath, svcKey, cfg)
			}
		}

		// Handle sample request
		if cfg.SampleRequested {
			if strings.HasPrefix(logPath, "journald:") {
				unit := strings.TrimPrefix(logPath, "journald:")
				go lw.collectJournaldSample(logPath, unit)
			} else if strings.HasPrefix(logPath, "clog:") {
				clogFile := strings.TrimPrefix(logPath, "clog:")
				go lw.collectClogSample(logPath, clogFile)
			} else {
				go lw.collectSample(logPath)
			}
		}
	}
}

// resolveLogPath returns the log file path for a service config.
// For built-in services, uses platform defaults if no logPath provided.
// For custom services, the key is "custom:/path/to/log".
func resolveLogPath(svcKey string, cfg AgentServiceConfig) string {
	if strings.HasPrefix(svcKey, "custom:") {
		return strings.TrimPrefix(svcKey, "custom:")
	}
	// Built-in: use default log paths per OS
	return defaultLogPath(svcKey)
}

// tailFile tails a log file for lines written after the watcher starts.
//
// BUG FIX: the original implementation called f.Seek(0, io.SeekEnd) on every
// iteration of the outer loop, so the scanner was always positioned at EOF
// and never read any lines. The corrected version tracks the file offset
// across iterations: it skips historical content only on the very first stat,
// then on each subsequent poll it opens the file, seeks to the last known
// offset, reads all new bytes, and updates the offset.  Log rotation is
// handled by detecting when the file size drops below the stored offset.
//
// A path containing glob characters (IIS "u_ex*.log", MySQL "*.err") follows
// the most recently modified match: a file appearing after the start is read
// from its beginning (it is the rotation target), and each file keeps its own
// offset so a late write to the previous file is never read twice.
func (lw *LogWatcher) tailFile(path, svcKey string, cfg AgentServiceConfig) {
	log.Printf("LogWatcher: tailing %s for %s", path, svcKey)

	parser := lw.getParser(svcKey, cfg.CustomRegex)
	if parser == nil {
		log.Printf("LogWatcher: no parser for %s", svcKey)
		lw.mu.Lock()
		delete(lw.watchedFiles, path)
		lw.mu.Unlock()
		return
	}

	isGlob := isGlobPath(path)
	offsets := map[string]int64{} // per-file read offset (glob mode)
	current := path
	started := false
	var offset int64 = -1 // -1 = first run: skip to current EOF

	for {
		select {
		case <-lw.stopCh:
			return
		default:
		}

		if isGlob {
			match, err := newestMatch(path)
			if err != nil {
				log.Printf("LogWatcher: no file matches %s: %v — retrying in 30s", path, err)
				time.Sleep(30 * time.Second)
				continue
			}
			if match != current {
				if started {
					offsets[current] = offset
					if prev, seen := offsets[match]; seen {
						offset = prev
					} else {
						// New rotation target: read it from the beginning.
						offset = 0
					}
					log.Printf("LogWatcher: %s now follows %s", path, match)
				}
				current = match
				pruneOffsets(offsets, path)
			}
		}

		fi, err := os.Stat(current)
		if err != nil {
			log.Printf("LogWatcher: cannot stat %s: %v — retrying in 30s", current, err)
			time.Sleep(30 * time.Second)
			continue
		}

		size := fi.Size()
		if offset < 0 {
			// First iteration: skip all historical content, but let a
			// header-driven parser learn the file layout from it.
			offset = size
			primeHeaders(current, size, parser)
		} else if size < offset {
			// File was rotated or truncated — restart from the beginning.
			log.Printf("LogWatcher: %s rotated/truncated (offset %d → 0)", current, offset)
			offset = 0
		}
		started = true

		if size > offset {
			f, err := os.Open(current)
			if err != nil {
				log.Printf("LogWatcher: cannot open %s: %v", current, err)
				time.Sleep(1 * time.Second)
				continue
			}
			_, _ = f.Seek(offset, io.SeekStart)
			data, _ := io.ReadAll(f)
			f.Close()
			// Only consume complete lines: a trailing partial line is read
			// again, whole, on the next poll (a runaway line without any
			// newline is dropped once it exceeds maxPartialLine).
			if nl := bytes.LastIndexByte(data, '\n'); nl >= 0 {
				data = data[:nl+1]
			} else if len(data) < maxPartialLine {
				data = nil
			}
			offset += int64(len(data))

			// Process each complete line (split on \n, strip \r).
			remaining := string(data)
			for {
				nl := strings.IndexByte(remaining, '\n')
				if nl < 0 {
					break // incomplete trailing line — wait for next poll
				}
				line := strings.TrimRight(remaining[:nl], "\r")
				remaining = remaining[nl+1:]

				lw.mu.Lock()
				cur, exists := lw.configs[svcKey]
				lw.mu.Unlock()

				if !exists || !cur.Enabled {
					lw.mu.Lock()
					delete(lw.watchedFiles, path)
					lw.mu.Unlock()
					return
				}

				if line == "" {
					continue
				}
				for _, e := range parser.Parse(line, svcKey) {
					lw.addEvent(e)
				}
			}
		}

		time.Sleep(1 * time.Second)
	}
}

// collectSample reads the last 50 lines of a log file (of the newest match
// for a glob path).
func (lw *LogWatcher) collectSample(path string) {
	file := path
	if isGlobPath(path) {
		match, err := newestMatch(path)
		if err != nil {
			return
		}
		file = match
	}
	f, err := os.Open(file)
	if err != nil {
		return
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if len(lines) > 50 {
			lines = lines[len(lines)-50:]
		}
	}

	lw.mu.Lock()
	lw.samples[path] = lines
	lw.mu.Unlock()
}

const (
	// maxPartialLine bounds how long tailFile waits for the newline of a
	// trailing partial line before dropping it.
	maxPartialLine = 1 << 20
	// maxPrimeBytes bounds the header scan of the skipped content on start.
	maxPrimeBytes = 64 << 20
)

// isGlobPath reports whether a configured log path is a glob pattern.
func isGlobPath(path string) bool {
	return strings.ContainsAny(path, "*?[")
}

// newestMatch returns the most recently modified regular file matching the
// pattern (lexically greatest name on a tie).
func newestMatch(pattern string) (string, error) {
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return "", err
	}
	best := ""
	var bestTime time.Time
	for _, m := range matches {
		fi, err := os.Stat(m)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		mt := fi.ModTime()
		if best == "" || mt.After(bestTime) || (mt.Equal(bestTime) && m > best) {
			best, bestTime = m, mt
		}
	}
	if best == "" {
		return "", os.ErrNotExist
	}
	return best, nil
}

// pruneOffsets forgets the offsets of files that no longer match the pattern
// (deleted by log retention), so the map stays bounded.
func pruneOffsets(offsets map[string]int64, pattern string) {
	if len(offsets) == 0 {
		return
	}
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return
	}
	live := make(map[string]struct{}, len(matches))
	for _, m := range matches {
		live[m] = struct{}{}
	}
	for f := range offsets {
		if _, ok := live[f]; !ok {
			delete(offsets, f)
		}
	}
}

// primeHeaders replays the header lines ('#'-prefixed, e.g. IIS "#Fields:")
// of the first upTo bytes of a file to a header-driven parser, so the first
// live line is read with the file's real layout although tailFile skipped the
// historical content. A no-op for other parsers.
func primeHeaders(path string, upTo int64, p LogParser) {
	hp, ok := p.(headerPrimer)
	if !ok || upTo <= 0 {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	if upTo > maxPrimeBytes {
		upTo = maxPrimeBytes
	}
	r := bufio.NewReaderSize(io.LimitReader(f, upTo), 64*1024)
	for {
		line, err := r.ReadString('\n')
		// A line cut by the limit (no newline) is never a usable header.
		if strings.HasPrefix(line, "#") && strings.HasSuffix(line, "\n") {
			hp.PrimeHeader(strings.TrimRight(line, "\r\n"))
		}
		if err != nil {
			return
		}
	}
}

// tailJournald follows a systemd journal unit in real-time using
// "journalctl -fu UNIT --output=short-traditional -n 0".
// The short-traditional format produces lines identical to classic syslog:
//
//	Mar 10 12:34:56 hostname sshd[1234]: Failed password for ...
//
// which the existing parsers (SSHParser etc.) already handle correctly.
// watchKey is the "journald:UNIT" string used as the watchedFiles map key.
func (lw *LogWatcher) tailJournald(watchKey, unit, svcKey string, cfg AgentServiceConfig) {
	log.Printf("LogWatcher: tailing journald unit %s for %s", unit, svcKey)

	parser := lw.getParser(svcKey, cfg.CustomRegex)
	if parser == nil {
		log.Printf("LogWatcher: no parser for %s", svcKey)
		lw.mu.Lock()
		delete(lw.watchedFiles, watchKey)
		lw.mu.Unlock()
		return
	}

	var delay time.Duration
	for {
		select {
		case <-lw.stopCh:
			return
		default:
		}

		// -n 0: start from the current tail (no historical backlog)
		cmd := exec.Command("journalctl", "-fu", unit, "--output=short-traditional", "-n", "0")
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			log.Printf("LogWatcher: journalctl pipe error (%s): %v — retrying in 30s", unit, err)
			time.Sleep(30 * time.Second)
			continue
		}
		if err := cmd.Start(); err != nil {
			log.Printf("LogWatcher: journalctl start error (%s): %v — retrying in 30s", unit, err)
			time.Sleep(30 * time.Second)
			continue
		}

		startedAt := time.Now()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			// Check for shutdown between lines.
			select {
			case <-lw.stopCh:
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				lw.mu.Lock()
				delete(lw.watchedFiles, watchKey)
				lw.mu.Unlock()
				return
			default:
			}

			line := scanner.Text()
			if line == "" {
				continue
			}

			lw.mu.Lock()
			cur, exists := lw.configs[svcKey]
			lw.mu.Unlock()

			if !exists || !cur.Enabled {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				lw.mu.Lock()
				delete(lw.watchedFiles, watchKey)
				lw.mu.Unlock()
				return
			}

			for _, e := range parser.Parse(line, svcKey) {
				lw.addEvent(e)
			}
		}

		// Scan may stop on a read error / oversized line while the child is still
		// running: kill it so Wait always returns and the process is reaped.
		_ = cmd.Process.Kill()
		_ = cmd.Wait()

		select {
		case <-lw.stopCh:
			lw.mu.Lock()
			delete(lw.watchedFiles, watchKey)
			lw.mu.Unlock()
			return
		default:
		}

		// This goroutine keeps ownership of watchKey while it restarts the child
		// itself: releasing the key here let startWatchers() (every 10s) spawn a
		// second tailer for the same unit on every exit, multiplying journalctl
		// processes (thousands after a few hours when journalctl exits quickly).
		delay = nextRestartDelay(delay, time.Since(startedAt))
		log.Printf("LogWatcher: journalctl (%s) exited — restarting in %s", unit, delay)
		if !lw.sleepOrStop(delay) {
			lw.mu.Lock()
			delete(lw.watchedFiles, watchKey)
			lw.mu.Unlock()
			return
		}
	}
}

// collectJournaldSample reads the last 50 lines from a journald unit.
func (lw *LogWatcher) collectJournaldSample(watchKey, unit string) {
	cmd := exec.Command("journalctl", "-u", unit, "-n", "50",
		"--output=short-traditional", "--no-pager")
	out, err := cmd.Output()
	if err != nil {
		log.Printf("LogWatcher: journalctl sample error (%s): %v", unit, err)
		return
	}

	raw := strings.TrimRight(string(out), "\n")
	if raw == "" {
		return
	}
	lines := strings.Split(raw, "\n")

	lw.mu.Lock()
	lw.samples[watchKey] = lines
	lw.mu.Unlock()
}

// tailClog follows an OPNsense/FreeBSD circular log using "clog -f FILE".
// clog is the BSD circular-log utility; -f follows in real-time like tail -f.
// watchKey is the "clog:/path" string used as the watchedFiles map key.
func (lw *LogWatcher) tailClog(watchKey, clogFile, svcKey string, cfg AgentServiceConfig) {
	log.Printf("LogWatcher: tailing clog %s for %s", clogFile, svcKey)

	parser := lw.getParser(svcKey, cfg.CustomRegex)
	if parser == nil {
		log.Printf("LogWatcher: no parser for %s", svcKey)
		lw.mu.Lock()
		delete(lw.watchedFiles, watchKey)
		lw.mu.Unlock()
		return
	}

	var delay time.Duration
	for {
		select {
		case <-lw.stopCh:
			return
		default:
		}

		cmd := exec.Command("clog", "-f", clogFile)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			log.Printf("LogWatcher: clog pipe error (%s): %v — retrying in 30s", clogFile, err)
			time.Sleep(30 * time.Second)
			continue
		}
		if err := cmd.Start(); err != nil {
			log.Printf("LogWatcher: clog start error (%s): %v — retrying in 30s", clogFile, err)
			time.Sleep(30 * time.Second)
			continue
		}

		startedAt := time.Now()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			select {
			case <-lw.stopCh:
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				lw.mu.Lock()
				delete(lw.watchedFiles, watchKey)
				lw.mu.Unlock()
				return
			default:
			}

			line := scanner.Text()
			if line == "" {
				continue
			}

			lw.mu.Lock()
			cur, exists := lw.configs[svcKey]
			lw.mu.Unlock()

			if !exists || !cur.Enabled {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				lw.mu.Lock()
				delete(lw.watchedFiles, watchKey)
				lw.mu.Unlock()
				return
			}

			for _, e := range parser.Parse(line, svcKey) {
				lw.addEvent(e)
			}
		}

		// Scan may stop on a read error / oversized line while the child is still
		// running: kill it so Wait always returns and the process is reaped.
		_ = cmd.Process.Kill()
		_ = cmd.Wait()

		select {
		case <-lw.stopCh:
			lw.mu.Lock()
			delete(lw.watchedFiles, watchKey)
			lw.mu.Unlock()
			return
		default:
		}

		// Keep ownership of watchKey while restarting (see tailJournald).
		delay = nextRestartDelay(delay, time.Since(startedAt))
		log.Printf("LogWatcher: clog (%s) exited — restarting in %s", clogFile, delay)
		if !lw.sleepOrStop(delay) {
			lw.mu.Lock()
			delete(lw.watchedFiles, watchKey)
			lw.mu.Unlock()
			return
		}
	}
}

// collectClogSample reads the last 50 lines from a clog circular log file.
func (lw *LogWatcher) collectClogSample(watchKey, clogFile string) {
	cmd := exec.Command("clog", clogFile)
	out, err := cmd.Output()
	if err != nil {
		log.Printf("LogWatcher: clog sample error (%s): %v", clogFile, err)
		return
	}

	raw := strings.TrimRight(string(out), "\n")
	if raw == "" {
		return
	}
	allLines := strings.Split(raw, "\n")
	// Keep last 50
	if len(allLines) > 50 {
		allLines = allLines[len(allLines)-50:]
	}

	lw.mu.Lock()
	lw.samples[watchKey] = allLines
	lw.mu.Unlock()
}

func (lw *LogWatcher) getParser(svcKey string, customRegex *string) LogParser {
	if customRegex != nil && *customRegex != "" {
		return &CustomRegexParser{Regex: *customRegex, ServiceKey: svcKey}
	}
	// The IIS parser keeps the #Fields layout of the file it reads: one
	// instance per tailer.
	if svcKey == "iis" {
		return &IISParser{}
	}
	if p, ok := lw.parsers[svcKey]; ok {
		return p
	}
	return nil
}

// ── LogParser interface ───────────────────────────────────────────────────────

type LogParser interface {
	Parse(line, svcKey string) []AgentIpEvent
}

// headerPrimer is implemented by parsers whose reading of a line depends on
// earlier header lines of the same file (IIS W3C "#Fields:"). tailFile hands
// them the header lines of the content it skips on start.
type headerPrimer interface {
	PrimeHeader(line string)
}

// ── Source address extraction ─────────────────────────────────────────────────
//
// Usernames (and request targets, anonymous FTP passwords...) are chosen by
// the remote party and may contain spaces, quotes or a fake
// "from 198.51.100.66 port 22". Every built-in parser therefore takes the address
// from a position the client cannot write to:
//   - a field written before any client-supplied text (access logs, Apache
//     and Postfix headers, IIS columns, pure-ftpd/proftpd session prefix), or
//   - the LAST "from <ip> port <n>"-style trailer, anchored to the end of the
//     line behind a greedy username capture (sshd, OPNsense, MySQL, RDP).
// On top of that, a line whose username (or body) carries a second copy of the
// marker the address is bound to is dropped: no such account can exist, so the
// attempt cannot succeed and nothing is lost by ignoring it. Every address is
// finally validated with net.ParseIP.

// maxRepeatEvents caps how many events a single line may stand for (rsyslog
// "message repeated N times", Dovecot "auth failed, N attempts").
const maxRepeatEvents = 10

// cleanIP validates an extracted address and returns its canonical form, or ""
// when it is not a literal IP address (hostname, "-", empty...). IPv4-mapped
// IPv6 (dual-stack "::ffff:1.2.3.4") is folded to plain IPv4; brackets and a
// zone suffix are stripped.
func cleanIP(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	if i := strings.IndexByte(s, '%'); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return ""
	}
	ip := net.ParseIP(s)
	if ip == nil {
		return ""
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

// authEvents returns n events (1 ≤ n ≤ maxRepeatEvents) for one log line, or
// nil when ip is not a valid address.
func authEvents(n int, ip, username, svcKey, eventType, line string) []AgentIpEvent {
	addr := cleanIP(ip)
	if addr == "" {
		return nil
	}
	if n < 1 {
		n = 1
	} else if n > maxRepeatEvents {
		n = maxRepeatEvents
	}
	out := make([]AgentIpEvent, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, makeEvent(addr, username, svcKey, eventType, line))
	}
	return out
}

// repeatCount parses a decimal count, defaulting to 1.
func repeatCount(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return 1
	}
	return n
}

// hasInjectedFrom reports a username carrying its own " from " / " from:"
// trailer.
func hasInjectedFrom(username string) bool {
	return strings.Contains(username, " from ") || strings.Contains(username, " from:")
}

// rsyslog folds identical lines: "message repeated 3 times: [ Failed password ...]".
var repeatedRe = regexp.MustCompile(`message repeated (\d+) times: \[ ?(.*)\]\s*$`)

// unwrapRepeated returns the folded message and how many times it repeated.
func unwrapRepeated(line string) (string, int) {
	if m := repeatedRe.FindStringSubmatch(line); m != nil {
		return m[2], repeatCount(m[1])
	}
	return line, 1
}

// ── SSH parser ────────────────────────────────────────────────────────────────

type SSHParser struct{}

// sshd (auth.c): "Failed password for [invalid user ]NAME from IP port N ssh2"
// optionally followed by ": KEYTYPE FINGERPRINT" for publickey. NAME may hold
// spaces; the greedy capture binds IP to the trailer sshd appended itself.
var sshFailRe = regexp.MustCompile(
	`Failed (?:password|publickey|keyboard-interactive/pam|none) for (invalid user )?(.*) from (\S+) port \d+(?: ssh\d?)?(?:: .*)?$`)
var sshAcceptRe = regexp.MustCompile(
	`Accepted (?:password|publickey|keyboard-interactive/pam|gssapi-with-mic|hostbased) for (.*) from (\S+) port \d+(?: ssh\d?)?(?:: .*)?$`)

func (p *SSHParser) Parse(line, svcKey string) []AgentIpEvent {
	evs, _ := parseSSHLine(line, svcKey)
	return evs
}

// parseSSHLine is shared by the SSH and OPNsense parsers. matched reports an
// sshd Failed/Accepted line, including one dropped as an injection attempt,
// so a caller never re-reads such a line with a looser pattern.
func parseSSHLine(line, svcKey string) (evs []AgentIpEvent, matched bool) {
	body, n := unwrapRepeated(line)
	if m := sshFailRe.FindStringSubmatch(body); m != nil {
		if hasInjectedFrom(m[2]) {
			return nil, true
		}
		return authEvents(n, m[3], m[2], svcKey, "auth_failure", line), true
	}
	if m := sshAcceptRe.FindStringSubmatch(body); m != nil {
		if hasInjectedFrom(m[1]) {
			return nil, true
		}
		return authEvents(1, m[2], m[1], svcKey, "auth_success", line), true
	}
	return nil, false
}

// ── RDP parser (Windows Event Log lines — pre-parsed by agent on Windows) ────

type RDPParser struct{}

// Lines built by the Windows Security log poller (eventlog_windows.go):
// "EventID:4625 Account Name: NAME Source Network Address: IP". The address is
// the last token of the line.
var rdpEventRe = regexp.MustCompile(
	`EventID:(4625|4624)\b.*?Account Name:[ \t]*(.*?)[ \t]+Source Network Address:[ \t]*(\S+)\s*$`)

func (p *RDPParser) Parse(line, svcKey string) []AgentIpEvent {
	m := rdpEventRe.FindStringSubmatch(line)
	if m == nil || strings.Contains(m[2], "Source Network Address:") {
		return nil
	}
	eventType := "auth_failure"
	if m[1] == "4624" {
		eventType = "auth_success"
	}
	user := m[2]
	if user == "-" {
		user = ""
	}
	return authEvents(1, m[3], user, svcKey, eventType, line)
}

// ── Nginx/Apache parser ───────────────────────────────────────────────────────

type NginxParser struct{}
type ApacheParser struct{}

// Access log (common/combined, nginx default and Apache "%h %l %u %t \"%r\" %>s"):
// the client address is the first field, the status follows the quoted request.
// Both servers escape '"' inside the request and the user field (\" or \x22),
// so the escape-aware request match cannot be closed early by a crafted URL.
var httpAccess401Re = regexp.MustCompile(
	`^(\S+) \S+ (.*?) \[[^\]]*\] "[A-Z]+ (?:[^"\\]|\\.)*" 401(?: |$)`)

// Apache vhost_combined prefixes the line with "vhost:port ".
var httpVhostPrefixRe = regexp.MustCompile(`^[^\s:]+:\d+ `)

// Apache error log (mod_auth_basic / mod_auth_digest):
//
//	2.4: [time] [auth_basic:error] [pid N:tid M] [client IP:PORT] AH01617: user NAME: authentication failure for "/": Password Mismatch
//	2.4: [time] [auth_basic:error] [pid N:tid M] [client IP:PORT] AH01618: user NAME not found: /
//	2.2: [time] [error] [client IP] user NAME: authentication failure for "/": Password Mismatch
//
// The [client] field is written before the message, at a fixed position.
var apacheAuthErrRe = regexp.MustCompile(
	`^\[[^\]]*\] (?:\[[^\]]*\] )*?\[client ([^\]\s]+)\] (AH\d+: )?user (.*?)(?:: authentication failure for |: password mismatch| not found)`)

// nginx error log (auth_basic):
//
//	2024/01/15 10:20:30 [error] 1234#1234: *5 user "NAME": password mismatch, client: IP, server: S, request: "...", host: "..."
//	2024/01/15 10:20:30 [error] 1234#1234: *5 user "NAME" was not found in "/etc/nginx/.htpasswd", client: IP, server: S, ...
//
// NAME and the request are both client text around "client:", so a line with
// more than one ", client: " is ambiguous and dropped.
var nginxAuthErrRe = regexp.MustCompile(
	`^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d \[\w+\] \d+#\d+: \*\d+ user "(.*)"(?:: password mismatch| was not found in "[^"]*"), client: ([^,\s]+), server: `)

func parseHTTPAuthLine(line, svcKey string) []AgentIpEvent {
	if m := apacheAuthErrRe.FindStringSubmatch(line); m != nil {
		return authEvents(1, apacheClientIP(m[1], m[2] != ""), m[3], svcKey, "auth_failure", line)
	}
	if m := nginxAuthErrRe.FindStringSubmatch(line); m != nil {
		if strings.Count(line, ", client: ") != 1 {
			return nil
		}
		return authEvents(1, m[2], m[1], svcKey, "auth_failure", line)
	}
	body := line
	if loc := httpVhostPrefixRe.FindStringIndex(line); loc != nil {
		body = line[loc[1]:]
	}
	m := httpAccess401Re.FindStringSubmatch(body)
	if m == nil {
		return nil
	}
	user := m[2]
	if user == "-" {
		user = ""
	}
	return authEvents(1, m[1], user, svcKey, "auth_failure", line)
}

// apacheClientIP strips the ":PORT" Apache 2.4 appends to the client address
// (unbracketed, also for IPv6); Apache 2.2 logs the bare address.
func apacheClientIP(field string, v24 bool) string {
	if v24 {
		if i := strings.LastIndexByte(field, ':'); i > 0 {
			if _, err := strconv.Atoi(field[i+1:]); err == nil {
				if ip := cleanIP(field[:i]); ip != "" {
					return ip
				}
			}
		}
	}
	return field
}

func (p *NginxParser) Parse(line, svcKey string) []AgentIpEvent {
	return parseHTTPAuthLine(line, svcKey)
}
func (p *ApacheParser) Parse(line, svcKey string) []AgentIpEvent {
	return parseHTTPAuthLine(line, svcKey)
}

// ── IIS parser ────────────────────────────────────────────────────────────────

// IISParser reads W3C extended logs. Columns are located by name from the
// file's "#Fields:" header (IIS replaces spaces inside values with '+', so a
// value never shifts the columns); before any header has been seen, the IIS
// default layout (15 columns, or 14 without cs(Referer) on IIS 7.x) is
// assumed. A line whose column count differs from the layout is ignored.
type IISParser struct {
	mu     sync.Mutex
	layout *iisLayout // from the last "#Fields:" header; nil = default layout
}

type iisLayout struct {
	idx map[string]int // lower-cased field name → column
	n   int
}

func newIISLayout(names []string) *iisLayout {
	l := &iisLayout{idx: make(map[string]int, len(names)), n: len(names)}
	for i, name := range names {
		l.idx[strings.ToLower(name)] = i
	}
	return l
}

var (
	iisDefaultLayout = newIISLayout(strings.Fields(
		"date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status time-taken"))
	iisDefaultLayoutNoReferer = newIISLayout(strings.Fields(
		"date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) sc-status sc-substatus sc-win32-status time-taken"))
)

// iisNoCredentialsWin32 is SEC_E_NO_CREDENTIALS (0x8009030E): the
// Negotiate/NTLM challenge step of a normal Windows-auth handshake.
const iisNoCredentialsWin32 = "2148074254"

func (p *IISParser) PrimeHeader(line string) {
	rest, ok := strings.CutPrefix(line, "#Fields:")
	if !ok {
		return
	}
	names := strings.Fields(rest)
	if len(names) == 0 {
		return
	}
	l := newIISLayout(names)
	p.mu.Lock()
	p.layout = l
	p.mu.Unlock()
}

func (p *IISParser) Parse(line, svcKey string) []AgentIpEvent {
	if strings.HasPrefix(line, "#") {
		p.PrimeHeader(line)
		return nil
	}
	cols := strings.Fields(line)
	p.mu.Lock()
	l := p.layout
	p.mu.Unlock()
	if l == nil {
		switch len(cols) {
		case iisDefaultLayout.n:
			l = iisDefaultLayout
		case iisDefaultLayoutNoReferer.n:
			l = iisDefaultLayoutNoReferer
		default:
			return nil
		}
	}
	if len(cols) != l.n {
		return nil
	}
	col := func(name string) string {
		if i, ok := l.idx[name]; ok {
			return cols[i]
		}
		return ""
	}
	if col("sc-status") != "401" {
		return nil
	}
	// 401.2 is the anonymous challenge every browser receives first, and the
	// no-credentials Win32 status is the NTLM/Negotiate handshake: neither
	// carries a credential.
	if col("sc-substatus") == "2" || col("sc-win32-status") == iisNoCredentialsWin32 {
		return nil
	}
	user := col("cs-username")
	if user == "-" {
		user = ""
	}
	return authEvents(1, col("c-ip"), user, svcKey, "auth_failure", line)
}

// ── FTP parser ────────────────────────────────────────────────────────────────

type FTPParser struct{}

// vsftpd: "[pid 1234] [NAME] FAIL LOGIN: Client "IP"" (OK LOGIN on success);
// anonymous logins append `, anon password "..."`. IP may be IPv6 or
// IPv4-mapped ("::ffff:1.2.3.4") on a dual-stack listener. NAME and the
// anonymous password are client text on both sides of the marker, so a line
// holding the marker more than once is dropped.
var vsftpdLoginRe = regexp.MustCompile(
	`\[pid \d+\] (?:\[(.*?)\] )?(OK|FAIL) LOGIN: Client "([0-9A-Fa-f:.]+)"`)

// pure-ftpd: "(?@IP) [WARNING] Authentication failed for user [NAME]".
var pureFtpdFailRe = regexp.MustCompile(
	`\(\?@([0-9A-Fa-f:.]+)\) \[WARNING\] Authentication failed for user \[(.*)\]`)

// proftpd: "host (IP[IP]) - USER NAME (Login failed): ..." and
// "host (IP[IP]) - USER NAME: no such user found from ...".
var proftpdFailRe = regexp.MustCompile(
	`\([^\s()\[\]]*\[([0-9A-Fa-f:.]+)\]\) - USER (.*?)(?: \(Login failed\)|: no such user found)`)

// PAM (vsftpd/proftpd with pam_unix; FTP PAM services only, so an sshd/su
// failure in a shared auth log is never attributed to FTP): "pam_unix(vsftpd:auth): authentication
// failure; logname= uid=0 euid=0 tty=ftp ruser=NAME rhost=IP  user=NAME".
var pamFailRe = regexp.MustCompile(
	`pam_unix\((?:vsftpd|proftpd|pure-ftpd|ftp)\b[^)]*\): authentication failure;.*? ruser=(.*?) rhost=(\S*)`)

func (p *FTPParser) Parse(line, svcKey string) []AgentIpEvent {
	if m := vsftpdLoginRe.FindStringSubmatch(line); m != nil {
		if strings.Count(line, ` LOGIN: Client "`) != 1 {
			return nil
		}
		eventType := "auth_failure"
		if m[2] == "OK" {
			eventType = "auth_success"
		}
		return authEvents(1, m[3], m[1], svcKey, eventType, line)
	}
	if m := pureFtpdFailRe.FindStringSubmatch(line); m != nil {
		return authEvents(1, m[1], m[2], svcKey, "auth_failure", line)
	}
	if m := proftpdFailRe.FindStringSubmatch(line); m != nil {
		return authEvents(1, m[1], m[2], svcKey, "auth_failure", line)
	}
	if m := pamFailRe.FindStringSubmatch(line); m != nil {
		if strings.Count(line, " rhost=") != 1 {
			return nil
		}
		return authEvents(1, m[2], m[1], svcKey, "auth_failure", line)
	}
	return nil
}

// ── Mail parser (Postfix/Dovecot) ────────────────────────────────────────────

type MailParser struct{}

// Dovecot login process:
//
//	imap-login: Disconnected (auth failed, 3 attempts in 12 secs): user=<NAME>, method=PLAIN, rip=IP, lip=IP, TLS, session=<...>
//	imap-login: Login aborted: Connection closed (auth failed, 1 attempts in 2 secs) (auth_failed): user=<NAME>, method=PLAIN, rip=IP, ...
//
// One event per failed attempt (capped). NAME precedes rip=, so a line with
// more than one ", rip=" is dropped.
var dovecotFailRe = regexp.MustCompile(
	`auth failed, (\d+) attempts?\b.*, rip=([0-9A-Fa-f:.]+)(?:,|\s*$)`)
var dovecotUserRe = regexp.MustCompile(`: user=<(.*?)>`)

// Postfix smtpd: "warning: HOST[IP]: SASL LOGIN authentication failed: ..."
// with an optional trailing ", sasl_username=NAME". HOST[IP] is written by
// smtpd before any client text (HOST is a validated reverse name or "unknown").
// "Connection lost to authentication server" is a server-side outage (Dovecot
// auth down), not a client failure: legitimate users must not be banned for it.
var postfixFailRe = regexp.MustCompile(
	`warning: [^\s\[\]]+\[([0-9A-Fa-f:.]+)\]: SASL [\w-]+ authentication failed\b(?:: (Connection lost to authentication server))?`)
var postfixUserRe = regexp.MustCompile(`, sasl_username=(.*)$`)

func (p *MailParser) Parse(line, svcKey string) []AgentIpEvent {
	if m := dovecotFailRe.FindStringSubmatch(line); m != nil {
		if strings.Count(line, ", rip=") != 1 {
			return nil
		}
		user := ""
		if u := dovecotUserRe.FindStringSubmatch(line); u != nil {
			user = u[1]
		}
		return authEvents(repeatCount(m[1]), m[2], user, svcKey, "auth_failure", line)
	}
	if m := postfixFailRe.FindStringSubmatch(line); m != nil {
		if m[2] != "" {
			return nil // the SASL backend failed, not the client
		}
		user := ""
		if u := postfixUserRe.FindStringSubmatch(line); u != nil {
			user = u[1]
		}
		return authEvents(1, m[1], user, svcKey, "auth_failure", line)
	}
	return nil
}

// ── MySQL parser ──────────────────────────────────────────────────────────────

type MySQLParser struct{}

// "Access denied for user 'NAME'@'HOST' (using password: YES)" (MySQL 5.x/8.x,
// MariaDB). HOST is an address unless name resolution is on (then ignored).
var mysqlFailRe = regexp.MustCompile(
	`Access denied for user '(.*)'@'([^']*)' \(using password: (?:YES|NO)\)`)

func (p *MySQLParser) Parse(line, svcKey string) []AgentIpEvent {
	m := mysqlFailRe.FindStringSubmatch(line)
	if m == nil || strings.Contains(m[1], "'@'") {
		return nil
	}
	return authEvents(1, m[2], m[1], svcKey, "auth_failure", line)
}

// ── OPNsense auth parser (Web UI + SSH) ─────────────────────────────────────
// Parses /var/log/audit/latest.log for authentication events.
// This file receives all facility(auth) messages via syslog-ng on OPNsense 22.x+.
//
// Failure patterns (from OPNsense's own sshlockout syslog-ng config):
//   "Web GUI authentication error for 'admin' from 10.0.0.5"
//   "Authentication error for admin from: 10.0.0.5"
//   sshd: "Failed password for admin from 10.0.0.5 port 22 ssh2"
//   sshd: "Invalid user test from 10.0.0.5 port 22"
//   sshd: "Illegal user test from 10.0.0.5"
//
// Success patterns:
//   "Successful login for user 'admin' from: 10.0.0.5"
//   "Accepted publickey for admin from 10.0.0.5 port 22 ssh2"
//
// The address is always the last "from" trailer of the line (an optional
// "(Local Database)"-style suffix is allowed after it).

type OPNsenseParser struct{}

var opnWebFailRe = regexp.MustCompile(
	`Web GUI authentication error for '(.*)' from:?\s*(\S+)(?: \([^()]*\))?\s*$`)
var opnAuthErrorRe = regexp.MustCompile(
	`Authentication error for\s+(.*) from:?\s*(\S+)(?: \([^()]*\))?\s*$`)
var opnSuccessRe = regexp.MustCompile(
	`Successful login for user '(.*)' from:?\s*(\S+)(?: \([^()]*\))?\s*$`)
var opnInvalidUserRe = regexp.MustCompile(
	`(?:Invalid|Illegal) user (.*) from (\S+)(?: port \d+)?\s*$`)

func (p *OPNsenseParser) Parse(line, svcKey string) []AgentIpEvent {
	// Web GUI failures
	if m := opnWebFailRe.FindStringSubmatch(line); m != nil {
		return opnEvent(m, svcKey, "auth_failure", line)
	}
	// General auth error (covers SSH + other PAM failures on OPNsense)
	if m := opnAuthErrorRe.FindStringSubmatch(line); m != nil {
		return opnEvent(m, svcKey, "auth_failure", line)
	}
	// SSH failures/successes — already parsed by SSHParser, but since OPNsense
	// puts everything in audit/latest.log, the opnsense parser also handles them.
	if strings.Contains(line, "Failed ") || strings.Contains(line, "Accepted ") {
		if evs, matched := parseSSHLine(line, svcKey); matched {
			return evs
		}
	}
	// Invalid/Illegal user (SSH brute-force with non-existent usernames)
	if m := opnInvalidUserRe.FindStringSubmatch(line); m != nil {
		return opnEvent(m, svcKey, "auth_failure", line)
	}
	// Web GUI successes
	if m := opnSuccessRe.FindStringSubmatch(line); m != nil {
		return opnEvent(m, svcKey, "auth_success", line)
	}
	return nil
}

// opnEvent builds the event of an OPNsense match (m[1] = user, m[2] = address).
func opnEvent(m []string, svcKey, eventType, line string) []AgentIpEvent {
	if hasInjectedFrom(m[1]) {
		return nil
	}
	return authEvents(1, m[2], m[1], svcKey, eventType, line)
}

// ── OPNsense filterlog parser (blocked connections + NAT) ───────────────────
// Parses /var/log/filter.log (clog) for pf filterlog CSV entries.
// OPNsense filterlog format (comma-separated):
//   rulenr,subrulenr,anchorname,ridentifier,interface,reason,action,dir,ipver,...
// For IPv4 (ipver=4):
//   ...,tos,ecn,ttl,id,offset,flags,proto_id,proto_name,length,src_ip,dst_ip,...
// For TCP (proto_name=tcp), after dst_ip:
//   ...,src_port,dst_port,datalen,tcp_flags,...
//
// We emit auth_failure for "block" actions (potential attacks) and
// auth_success for "pass" actions on well-known ports (NATed traffic).

type OPNsenseFilterParser struct{}

func (p *OPNsenseFilterParser) Parse(line, svcKey string) []AgentIpEvent {
	// filterlog lines look like: "Mar 28 12:00:00 fw filterlog[123]: 5,,,..."
	// Find the filterlog CSV payload after the syslog prefix.
	idx := strings.Index(line, "filterlog")
	if idx < 0 {
		return nil
	}
	colonIdx := strings.Index(line[idx:], ": ")
	if colonIdx < 0 {
		return nil
	}
	csv := line[idx+colonIdx+2:]
	fields := strings.Split(csv, ",")
	if len(fields) < 8 { // fields[7] (direction) is read below
		return nil
	}

	action := fields[6] // "block" or "pass"
	dir := fields[7]    // "in" or "out"
	if dir != "in" {
		return nil // Only care about inbound connections
	}

	// Parse based on IP version
	ipVer := ""
	if len(fields) > 8 {
		ipVer = fields[8]
	}

	var srcIP, dstIP, protoName, srcPort, dstPort string

	switch ipVer {
	case "4":
		// IPv4: fields[9..17] = tos,ecn,ttl,id,offset,flags,proto_id,proto_name,length
		// fields[18]=src_ip, fields[19]=dst_ip
		if len(fields) < 20 {
			return nil
		}
		protoName = fields[16]
		srcIP = fields[18]
		dstIP = fields[19]
		if protoName == "tcp" || protoName == "udp" {
			if len(fields) < 22 {
				return nil
			}
			srcPort = fields[20]
			dstPort = fields[21]
		}
	case "6":
		// IPv6: fields[9..13] = class,flowlabel,hlim,proto_name,proto_id
		// fields[14]=length, fields[15]=src_ip, fields[16]=dst_ip
		if len(fields) < 17 {
			return nil
		}
		protoName = fields[12]
		srcIP = fields[15]
		dstIP = fields[16]
		if protoName == "tcp" || protoName == "udp" {
			if len(fields) < 19 {
				return nil
			}
			srcPort = fields[17]
			dstPort = fields[18]
		}
	default:
		return nil
	}

	_ = dstIP
	_ = srcPort

	// Determine event type based on action
	eventType := "auth_failure"
	if action == "pass" {
		eventType = "auth_success"
	} else if action != "block" {
		return nil
	}

	// Build a human-readable summary
	proto := protoName
	if proto == "" {
		proto = "unknown"
	}
	raw := fmt.Sprintf("pf %s %s %s:%s → %s:%s (%s)",
		action, dir, srcIP, srcPort, dstIP, dstPort, proto)

	// For "pass" (NAT), map dst_port to a service name if known
	service := svcKey
	if dstPort != "" {
		dPort := 0
		fmt.Sscanf(dstPort, "%d", &dPort)
		if svcName, ok := servicePorts[dPort]; ok && action == "pass" {
			service = svcName
		}
	}

	return authEvents(1, srcIP, "", service, eventType, raw)
}

// ── Custom regex parser ───────────────────────────────────────────────────────

type CustomRegexParser struct {
	Regex      string
	ServiceKey string
	compiled   *regexp.Regexp
}

func (p *CustomRegexParser) Parse(line, svcKey string) []AgentIpEvent {
	if p.compiled == nil {
		re, err := regexp.Compile(p.Regex)
		if err != nil {
			log.Printf("CustomRegexParser: invalid regex for %s: %v", svcKey, err)
			return nil
		}
		p.compiled = re
	}

	m := p.compiled.FindStringSubmatch(line)
	if m == nil {
		return nil
	}

	// Extract named groups
	ip := ""
	username := ""
	names := p.compiled.SubexpNames()
	for i, name := range names {
		if i == 0 || i >= len(m) {
			continue
		}
		switch name {
		case "ip":
			ip = m[i]
		case "username":
			username = m[i]
		}
	}

	// Same address validation as the built-in parsers.
	return authEvents(1, ip, username, svcKey, "auth_failure", line)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func makeEvent(ip, username, service, eventType, rawLog string) AgentIpEvent {
	id := fmt.Sprintf("%s-%d", uuid.New().String(), time.Now().UnixNano())
	return AgentIpEvent{
		ID:        id,
		IP:        ip,
		Username:  username,
		Service:   service,
		EventType: eventType,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		RawLog:    rawLog,
	}
}

// nextRestartDelay backs off when a followed child (journalctl / clog) dies
// quickly: 5s, doubling up to 5 min; a run that lasted over a minute resets it.
func nextRestartDelay(prev, ran time.Duration) time.Duration {
	if ran > time.Minute || prev <= 0 {
		return 5 * time.Second
	}
	next := prev * 2
	if next > 5*time.Minute {
		next = 5 * time.Minute
	}
	return next
}

// sleepOrStop waits d, returning false if the watcher is stopped meanwhile.
func (lw *LogWatcher) sleepOrStop(d time.Duration) bool {
	select {
	case <-lw.stopCh:
		return false
	case <-time.After(d):
		return true
	}
}
