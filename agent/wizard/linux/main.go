// Obliguard Agent — Linux Install Wizard
//
// Stand-alone Linux executable that mirrors the Windows wizard: drop it on the
// target box (scp / USB / paste), run as root, accept the pre-filled server URL
// + API key (or override them) — the agent binary is embedded, config.json is
// written and the service is installed/started. Designed for "offline" boxes
// where `curl | bash` can't reach the server at all.
//
// It installs the SAME layout as install.sh so the two never diverge:
//   binary  → /opt/obliguard-agent/obliguard-agent
//   config  → /etc/obliguard-agent/config.json
//   service → systemd unit "obliguard-agent" (SysV init fallback)
//
// Pre-filled config uses the same OBLI_CFG tail-blob protocol as the Windows
// wizard: GET /api/agent/installer/wizard-linux-amd64?keyId=N appends
//   [json bytes][magic 8B "OBLI_CFG"][len uint32 LE]
// and the wizard reads its own tail at startup to pre-fill the prompts.

//go:build linux

package main

import (
	"bufio"
	"crypto/rand"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Embedded agent binary — copied next to this file by build-wizard-linux.bat
// before `go build`, removed afterwards.
//
//go:embed obliguard-agent
var agentBinary []byte

// version is injected at link-time via -ldflags="-X main.version=...".
var version = "dev"

const (
	cfgMagic    = "OBLI_CFG"
	cfgMaxBytes = 1 << 20
	binDir      = "/opt/obliguard-agent"
	binPath     = "/opt/obliguard-agent/obliguard-agent"
	cfgDir      = "/etc/obliguard-agent"
	serviceName = "obliguard-agent"
)

type embeddedConfig struct {
	ServerURL string `json:"serverUrl"`
	APIKey    string `json:"apiKey"`
}

func main() {
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "✗ This installer must be run as root.")
		fmt.Fprintln(os.Stderr, "  Try:  sudo ./obliguard-installer-wizard-linux-amd64")
		os.Exit(1)
	}

	cfg := readEmbeddedConfig()

	fmt.Println()
	fmt.Println("  ╔══════════════════════════════════════════════════════╗")
	fmt.Println("  ║                                                      ║")
	fmt.Println("  ║       Obliguard Agent — Install Wizard (Linux)       ║")
	fmt.Printf("  ║                       v%-30s ║\n", version)
	fmt.Println("  ║                                                      ║")
	fmt.Println("  ╚══════════════════════════════════════════════════════╝")
	fmt.Println()
	if cfg.ServerURL != "" || cfg.APIKey != "" {
		fmt.Println("  Pre-filled config detected in this binary (press <Enter> to accept).")
		fmt.Println()
	}

	reader := bufio.NewReader(os.Stdin)
	serverURL := promptDefault(reader, "Server URL", cfg.ServerURL, "https://obliguard.example.com")
	apiKey := promptDefault(reader, "API Key", cfg.APIKey, "your-api-key")

	if serverURL == "" || apiKey == "" {
		fmt.Fprintln(os.Stderr, "✗ Server URL and API Key are required.")
		os.Exit(1)
	}

	fmt.Println()
	fmt.Println("Installing…")
	if err := install(serverURL, apiKey); err != nil {
		fmt.Fprintf(os.Stderr, "✗ Install failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Println()
	fmt.Println("✓ Done. The agent is now running.")
	fmt.Println("  It will appear in the Obliguard admin panel within ~30 seconds.")
	fmt.Println()
}

// ── Install logic ───────────────────────────────────────────────────────────

func install(serverURL, apiKey string) error {
	// Deterministic stop → replace → start so admins don't end up with two
	// generations of the agent running at once.
	if hasSystemd() {
		_ = run("systemctl", "stop", serviceName)
	} else {
		_ = run("service", serviceName, "stop")
	}

	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", binDir, err)
	}
	// Remove first to break the inode (avoids ETXTBSY if still mapped).
	_ = os.Remove(binPath)
	if err := os.WriteFile(binPath, agentBinary, 0o755); err != nil {
		return fmt.Errorf("write agent binary to %s: %w", binPath, err)
	}
	fmt.Printf("  ✓ Wrote %s (%s)\n", binPath, humanSize(len(agentBinary)))

	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", cfgDir, err)
	}
	cfgPath := filepath.Join(cfgDir, "config.json")
	cfgPayload := map[string]any{
		"serverUrl":            serverURL,
		"apiKey":               apiKey,
		"deviceUuid":           genUUID(),
		"checkIntervalSeconds": 60,
		"agentVersion":         version,
	}
	cfgBytes, _ := json.MarshalIndent(cfgPayload, "", "  ")
	if err := os.WriteFile(cfgPath, cfgBytes, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", cfgPath, err)
	}
	fmt.Printf("  ✓ Wrote %s\n", cfgPath)

	if hasSystemd() {
		return installSystemd()
	}
	return installSysV()
}

// ── systemd ─────────────────────────────────────────────────────────────────

func hasSystemd() bool {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false
	}
	// /run/systemd/system exists only when systemd is actually PID 1
	// (some base images ship a systemctl stub).
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return false
	}
	return true
}

// Matches agent/installer/install.sh's unit so the two install paths converge.
const systemdUnit = `[Unit]
Description=Obliguard Monitoring Agent
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
Restart=always
RestartSec=10
User=root
ExecStart=/opt/obliguard-agent/obliguard-agent
StandardOutput=journal
StandardError=journal
SyslogIdentifier=obliguard-agent

[Install]
WantedBy=multi-user.target
`

func installSystemd() error {
	unitPath := "/etc/systemd/system/" + serviceName + ".service"
	if err := os.WriteFile(unitPath, []byte(systemdUnit), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", unitPath, err)
	}
	fmt.Printf("  ✓ Installed systemd unit %s\n", unitPath)

	if err := run("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	if err := run("systemctl", "enable", "--now", serviceName); err != nil {
		return fmt.Errorf("systemctl enable --now %s: %w", serviceName, err)
	}
	fmt.Println("  ✓ Service started (systemd)")
	return nil
}

// ── SysV init fallback (CentOS 6 / very old RHEL) ───────────────────────────

const sysVInitScript = `#!/bin/bash
# chkconfig: 2345 80 20
# description: Obliguard Monitoring Agent
DAEMON="/opt/obliguard-agent/obliguard-agent"
PIDFILE=/var/run/obliguard-agent.pid
case "$1" in
  start)   $DAEMON & echo $! > $PIDFILE; echo "Started" ;;
  stop)    kill $(cat $PIDFILE) 2>/dev/null; rm -f $PIDFILE; echo "Stopped" ;;
  restart) $0 stop; $0 start ;;
  status)  [ -f $PIDFILE ] && kill -0 $(cat $PIDFILE) 2>/dev/null && echo "Running" || echo "Stopped" ;;
esac
`

func installSysV() error {
	path := "/etc/init.d/" + serviceName
	if err := os.WriteFile(path, []byte(sysVInitScript), 0o755); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	fmt.Printf("  ✓ Installed init.d script %s\n", path)
	_ = run("chkconfig", "--add", serviceName)
	if err := run("service", serviceName, "start"); err != nil {
		return fmt.Errorf("service %s start: %w", serviceName, err)
	}
	fmt.Println("  ✓ Service started (SysV init)")
	return nil
}

// ── Tail-blob pre-fill (same wire format as the Windows wizard) ─────────────

func readEmbeddedConfig() embeddedConfig {
	var empty embeddedConfig
	exe, err := os.Executable()
	if err != nil {
		return empty
	}
	f, err := os.Open(exe)
	if err != nil {
		return empty
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return empty
	}
	size := stat.Size()
	if size < int64(len(cfgMagic)+4) {
		return empty
	}
	tail := make([]byte, len(cfgMagic)+4)
	if _, err := f.ReadAt(tail, size-int64(len(tail))); err != nil {
		return empty
	}
	if string(tail[:len(cfgMagic)]) != cfgMagic {
		return empty
	}
	cfgLen := int64(binary.LittleEndian.Uint32(tail[len(cfgMagic):]))
	if cfgLen <= 0 || cfgLen > cfgMaxBytes {
		return empty
	}
	cfgStart := size - int64(len(tail)) - cfgLen
	if cfgStart < 0 {
		return empty
	}
	buf := make([]byte, cfgLen)
	if _, err := f.ReadAt(buf, cfgStart); err != nil {
		return empty
	}
	var c embeddedConfig
	if err := json.Unmarshal(buf, &c); err != nil {
		return empty
	}
	return c
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func promptDefault(reader *bufio.Reader, label, defaultVal, hint string) string {
	if defaultVal != "" {
		fmt.Printf("  %s [%s]: ", label, defaultVal)
	} else {
		fmt.Printf("  %s (e.g. %s): ", label, hint)
	}
	line, _ := reader.ReadString('\n')
	line = strings.TrimSpace(line)
	if line == "" {
		return defaultVal
	}
	return line
}

func run(name string, args ...string) error {
	return exec.Command(name, args...).Run()
}

func genUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func humanSize(n int) string {
	const KB, MB = 1024, 1024 * 1024
	switch {
	case n >= MB:
		return fmt.Sprintf("%.1f MB", float64(n)/float64(MB))
	case n >= KB:
		return fmt.Sprintf("%.1f KB", float64(n)/float64(KB))
	}
	return fmt.Sprintf("%d B", n)
}
