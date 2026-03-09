package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
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
	mu         sync.Mutex
	events     []AgentIpEvent
	samples    map[string][]string // logPath → last N lines (when sample requested)
	configs    map[string]AgentServiceConfig
	parsers    map[string]LogParser // serviceType → parser
	watchedFiles map[string]struct{} // paths currently being tailed
	stopCh     chan struct{}
}

func NewLogWatcher(initialConfigs map[string]AgentServiceConfig) *LogWatcher {
	lw := &LogWatcher{
		samples:      map[string][]string{},
		configs:      map[string]AgentServiceConfig{},
		watchedFiles: map[string]struct{}{},
		stopCh:       make(chan struct{}),
	}

	lw.parsers = map[string]LogParser{
		"ssh":    &SSHParser{},
		"rdp":    &RDPParser{},
		"nginx":  &NginxParser{},
		"apache": &ApacheParser{},
		"iis":    &IISParser{},
		"ftp":    &FTPParser{},
		"mail":   &MailParser{},
		"mysql":  &MySQLParser{},
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
	defer lw.mu.Unlock()
	lw.events = append(lw.events, e)
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
			go lw.tailFile(logPath, svcKey, cfg)
		}

		// Handle sample request
		if cfg.SampleRequested {
			go lw.collectSample(logPath)
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
