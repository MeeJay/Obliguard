package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"regexp"
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
	flushCh      chan struct{}
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
		"ssh":            &SSHParser{},
		"rdp":            &RDPParser{},
		"nginx":          &NginxParser{},
		"apache":         &ApacheParser{},
		"iis":            &IISParser{},
		"ftp":            &FTPParser{},
		"mail":           &MailParser{},
		"mysql":          &MySQLParser{},
		"opnsense":       &OPNsenseParser{},
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

	var offset int64 = -1 // -1 = first run: skip to current EOF

	for {
		select {
		case <-lw.stopCh:
			return
		default:
		}

		fi, err := os.Stat(path)
		if err != nil {
			log.Printf("LogWatcher: cannot stat %s: %v — retrying in 30s", path, err)
			time.Sleep(30 * time.Second)
			continue
		}

		size := fi.Size()
		if offset < 0 {
			// First iteration: skip all historical content.
			offset = size
		} else if size < offset {
			// File was rotated or truncated — restart from the beginning.
			log.Printf("LogWatcher: %s rotated/truncated (offset %d → 0)", path, offset)
			offset = 0
		}

		if size > offset {
			f, err := os.Open(path)
			if err != nil {
				log.Printf("LogWatcher: cannot open %s: %v", path, err)
				time.Sleep(1 * time.Second)
				continue
			}
			_, _ = f.Seek(offset, io.SeekStart)
			data, _ := io.ReadAll(f)
			f.Close()
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

// collectSample reads the last 50 lines of a log file.
func (lw *LogWatcher) collectSample(path string) {
	f, err := os.Open(path)
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

		scanner := bufio.NewScanner(stdout)
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

		_ = cmd.Wait()

		select {
		case <-lw.stopCh:
			lw.mu.Lock()
			delete(lw.watchedFiles, watchKey)
			lw.mu.Unlock()
			return
		default:
		}

		log.Printf("LogWatcher: journalctl (%s) exited — restarting in 5s", unit)
		// Remove from watchedFiles so startWatchers() can restart the goroutine cleanly.
		lw.mu.Lock()
		delete(lw.watchedFiles, watchKey)
		lw.mu.Unlock()
		time.Sleep(5 * time.Second)
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

		scanner := bufio.NewScanner(stdout)
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

		_ = cmd.Wait()

		select {
		case <-lw.stopCh:
			lw.mu.Lock()
			delete(lw.watchedFiles, watchKey)
			lw.mu.Unlock()
			return
		default:
		}

		log.Printf("LogWatcher: clog (%s) exited — restarting in 5s", clogFile)
		lw.mu.Lock()
		delete(lw.watchedFiles, watchKey)
		lw.mu.Unlock()
		time.Sleep(5 * time.Second)
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
	if p, ok := lw.parsers[svcKey]; ok {
		return p
	}
	return nil
}

// ── LogParser interface ───────────────────────────────────────────────────────

type LogParser interface {
	Parse(line, svcKey string) []AgentIpEvent
}

// ── SSH parser ────────────────────────────────────────────────────────────────

type SSHParser struct{}

var sshFailRe = regexp.MustCompile(
	`Failed (password|publickey) for (invalid user )?(\S+) from (\d+\.\d+\.\d+\.\d+|[0-9a-f:]+)`)
var sshAcceptRe = regexp.MustCompile(
	`Accepted (password|publickey) for (\S+) from (\d+\.\d+\.\d+\.\d+|[0-9a-f:]+)`)

func (p *SSHParser) Parse(line, svcKey string) []AgentIpEvent {
	if m := sshFailRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[4], m[3], svcKey, "auth_failure", line)}
	}
	if m := sshAcceptRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[3], m[2], svcKey, "auth_success", line)}
	}
	return nil
}

// ── RDP parser (Windows Event Log lines — pre-parsed by agent on Windows) ────

type RDPParser struct{}

var rdpFailRe = regexp.MustCompile(`EventID:4625.*?Account Name:\s+(\S+).*?Source Network Address:\s+([\d.]+)`)

func (p *RDPParser) Parse(line, svcKey string) []AgentIpEvent {
	if m := rdpFailRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[2], m[1], svcKey, "auth_failure", line)}
	}
	return nil
}

// ── Nginx/Apache parser ───────────────────────────────────────────────────────

type NginxParser struct{}
type ApacheParser struct{}

// Match access log lines with HTTP 401 status
var http401Re = regexp.MustCompile(`^(\d+\.\d+\.\d+\.\d+|[0-9a-f:]+) .* " [^"]*" 401 `)

func parseHTTPAuthLine(line, svcKey string) []AgentIpEvent {
	if m := http401Re.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[1], "", svcKey, "auth_failure", line)}
	}
	return nil
}

func (p *NginxParser) Parse(line, svcKey string) []AgentIpEvent  { return parseHTTPAuthLine(line, svcKey) }
func (p *ApacheParser) Parse(line, svcKey string) []AgentIpEvent { return parseHTTPAuthLine(line, svcKey) }

// ── IIS parser ────────────────────────────────────────────────────────────────

type IISParser struct{}

// W3C log: date time s-ip cs-method cs-uri-stem ... c-ip ... sc-status
var iis401Re = regexp.MustCompile(`^[\d-]+ [\d:]+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\d.]+) .* 401 `)

func (p *IISParser) Parse(line, svcKey string) []AgentIpEvent {
	if m := iis401Re.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[1], "", svcKey, "auth_failure", line)}
	}
	return nil
}

// ── FTP parser ────────────────────────────────────────────────────────────────

type FTPParser struct{}

var ftpFailRe = regexp.MustCompile(`FAIL LOGIN: Client "([\d.]+)"`)

func (p *FTPParser) Parse(line, svcKey string) []AgentIpEvent {
	if m := ftpFailRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[1], "", svcKey, "auth_failure", line)}
	}
	// vsftpd / proftpd format
	if strings.Contains(line, "FAILED LOGIN") || strings.Contains(line, "authentication failure") {
		ipRe := regexp.MustCompile(`(\d+\.\d+\.\d+\.\d+)`)
		if m := ipRe.FindStringSubmatch(line); m != nil {
			return []AgentIpEvent{makeEvent(m[1], "", svcKey, "auth_failure", line)}
		}
	}
	return nil
}

// ── Mail parser (Postfix/Dovecot) ────────────────────────────────────────────

type MailParser struct{}

var dovecotFailRe = regexp.MustCompile(`auth failed .* rip=([\d.]+)`)
var postfixFailRe = regexp.MustCompile(`SASL .* authentication failed.* \[([\d.]+)\]`)

func (p *MailParser) Parse(line, svcKey string) []AgentIpEvent {
	if m := dovecotFailRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[1], "", svcKey, "auth_failure", line)}
	}
	if m := postfixFailRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[1], "", svcKey, "auth_failure", line)}
	}
	return nil
}

// ── MySQL parser ──────────────────────────────────────────────────────────────

type MySQLParser struct{}

var mysqlFailRe = regexp.MustCompile(`Access denied for user '([^']+)'@'([\d.]+)'`)

func (p *MySQLParser) Parse(line, svcKey string) []AgentIpEvent {
	if m := mysqlFailRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[2], m[1], svcKey, "auth_failure", line)}
	}
	return nil
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

type OPNsenseParser struct{}

var opnWebFailRe = regexp.MustCompile(
	`Web GUI authentication error for '([^']*)'.*?from\s+([\d.]+|[0-9a-f:]+)`)
var opnAuthErrorRe = regexp.MustCompile(
	`Authentication error for\s+(\S+).*?from:?\s*([\d.]+|[0-9a-f:]+)`)
var opnSuccessRe = regexp.MustCompile(
	`Successful login for user '([^']*)'.*?from:?\s*([\d.]+|[0-9a-f:]+)`)

func (p *OPNsenseParser) Parse(line, svcKey string) []AgentIpEvent {
	// Web GUI failures
	if m := opnWebFailRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[2], m[1], svcKey, "auth_failure", line)}
	}
	// General auth error (covers SSH + other PAM failures on OPNsense)
	if m := opnAuthErrorRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[2], m[1], svcKey, "auth_failure", line)}
	}
	// SSH failures — already parsed by SSHParser, but since OPNsense puts
	// everything in audit/latest.log, the opnsense parser also handles them.
	if m := sshFailRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[4], m[3], svcKey, "auth_failure", line)}
	}
	// Invalid/Illegal user (SSH brute-force with non-existent usernames)
	if m := opnInvalidUserRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[2], m[1], svcKey, "auth_failure", line)}
	}
	// Successes
	if m := opnSuccessRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[2], m[1], svcKey, "auth_success", line)}
	}
	if m := sshAcceptRe.FindStringSubmatch(line); m != nil {
		return []AgentIpEvent{makeEvent(m[3], m[2], svcKey, "auth_success", line)}
	}
	return nil
}

var opnInvalidUserRe = regexp.MustCompile(
	`(?:Invalid|Illegal) user\s+(\S+)\s+from\s+([\d.]+|[0-9a-f:]+)`)

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
	if len(fields) < 7 {
		return nil
	}

	action := fields[6]  // "block" or "pass"
	dir := fields[7]     // "in" or "out"
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

	return []AgentIpEvent{makeEvent(srcIP, "", service, eventType, raw)}
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

	if ip == "" {
		return nil
	}

	return []AgentIpEvent{makeEvent(ip, username, svcKey, "auth_failure", line)}
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
