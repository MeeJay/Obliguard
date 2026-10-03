package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// agentVersion is injected at build time via:
//   go build -ldflags="-X main.agentVersion=x.y.z"
// The agent/VERSION file is the single source of truth — no need to edit this file.
var agentVersion = "dev"

var (
	configDir  string
	configFile string
)

func init() {
	if runtime.GOOS == "windows" {
		programData := os.Getenv("PROGRAMDATA")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		configDir = filepath.Join(programData, "ObliguardAgent")
	} else {
		configDir = "/etc/obliguard-agent"
	}
	configFile = filepath.Join(configDir, "config.json")
}

// ── Config ────────────────────────────────────────────────────────────────────

type Config struct {
	ServerURL            string                        `json:"serverUrl"`
	APIKey               string                        `json:"apiKey"`
	DeviceUUID           string                        `json:"deviceUuid"`
	CheckIntervalSeconds int                           `json:"checkIntervalSeconds"`
	AgentVersion         string                        `json:"agentVersion"`
	// Opt-in: skip TLS certificate verification on EVERY connection to the
	// server (WS command channel, update download, HTTP calls). Only for
	// self-signed certificates absent from the system trust store. Always
	// written explicitly by this version (nil = config of an older agent).
	TLSInsecureSkipVerify *bool                        `json:"tlsInsecureSkipVerify,omitempty"`
	BackoffUntil         int64                         `json:"-"` // never persisted — in-memory only
	// Cached service configs received from server (restored on restart)
	ServiceConfigs       map[string]AgentServiceConfig `json:"serviceConfigs,omitempty"`
	// Enrolled is set once the server accepted this agent (first config
	// frame). From then on serverUrl / apiKey of this file win over the
	// --url / --key flags (see resolveConfigPrecedence).
	Enrolled bool `json:"enrolled,omitempty"`
	// FirewallBackend is the last Windows backend preference received from
	// the server ("auto", "wfp", "netsh"; empty = auto), applied at start-up.
	FirewallBackend string `json:"firewallBackend,omitempty"`
}

func loadConfig() (*Config, error) {
	data, err := os.ReadFile(configFile)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func saveConfig(cfg *Config) error {
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// config.json holds the agent API key: owner-only (root / SYSTEM). WriteFile
	// keeps the mode of an existing file, so files written 0644 by older agents
	// are tightened too (on Windows Chmod only toggles the read-only bit).
	if err := os.WriteFile(configFile, data, 0600); err != nil {
		return err
	}
	return os.Chmod(configFile, 0600)
}

// setupConfig loads or creates config from file, registry (Windows), or CLI flags.
func setupConfig(urlArg, keyArg string) *Config {
	cfg, err := loadConfig()
	// legacyConfig: config.json written by an older agent, before the TLS
	// policy field existed (evaluated before agentVersion is refreshed below).
	legacyConfig := false
	if err != nil {
		// No config file — try Windows registry as fallback
		regCfg, regErr := loadConfigFromRegistry()
		if regErr == nil {
			cfg = regCfg
		}
	} else {
		legacyConfig = isLegacyConfig(cfg)
	}

	if cfg == nil {
		if urlArg == "" || keyArg == "" {
			fmt.Fprintf(os.Stderr, "First run: provide --url <serverUrl> --key <apiKey>\n")
			fmt.Fprintf(os.Stderr, "Example: obliguard-agent --url https://obliguard.example.com --key your-api-key\n")
			os.Exit(1)
		}
		cfg = &Config{
			ServerURL:            strings.TrimRight(urlArg, "/"),
			APIKey:               keyArg,
			DeviceUUID:           generateUUID(),
			CheckIntervalSeconds: 60,
			AgentVersion:         agentVersion,
		}
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not save config: %v", err)
		} else {
			log.Printf("First run: config saved to %s", configFile)
		}
	}

	// One TLS policy for every server connection (tlsconfig.go). Resolved first
	// so every save below carries the explicit value: later upgrades never
	// re-guess it.
	skip, changed, source := resolveTLSInsecure(cfg, legacyConfig, tlsInsecureFlag)
	if changed {
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not save tlsInsecureSkipVerify in config: %v", err)
		}
	}
	setTLSPolicy(skip)
	logTLSPolicy(skip, source)

	// --url / --key versus config.json: the flags only fill what the file
	// lacks once the agent is enrolled (MSI service arguments and installer
	// re-runs must not re-home an enrolled agent), unless --force-config.
	d := resolveConfigPrecedence(cfg.ServerURL, cfg.APIKey, cfg.Enrolled, urlArg, keyArg, forceConfigFlag)
	for _, line := range d.logLines() {
		log.Printf("Config: %s", line)
	}
	if d.URL != cfg.ServerURL || d.Key != cfg.APIKey {
		cfg.ServerURL, cfg.APIKey = d.URL, d.Key
		// New server or key: enrolment starts over, so the flags keep winning
		// until that server accepts the agent. A mere normalization of the
		// file's URL (trailing slash) keeps the enrolment.
		if d.URLSource == configSourceFlag || d.KeySource == configSourceFlag {
			cfg.Enrolled = false
		}
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not save serverUrl/apiKey in config: %v", err)
		}
	}

	// Resolve the best available device UUID using the shared Obli* cascade:
	// SMBIOS → disk-serial-derived → previously stored → fresh random.
	if resolved := resolveDeviceUUID(cfg.DeviceUUID); resolved != cfg.DeviceUUID {
		if cfg.DeviceUUID != "" {
			log.Printf("Migrating device UUID %s → %s", cfg.DeviceUUID, resolved)
		}
		cfg.DeviceUUID = resolved
		_ = saveConfig(cfg)
	}
	if cfg.CheckIntervalSeconds == 0 {
		cfg.CheckIntervalSeconds = 60
	}
	// Always use the binary's built-in version (overrides stale config.json value).
	// Save back to disk so config.json stays accurate after an update.
	if cfg.AgentVersion != agentVersion {
		cfg.AgentVersion = agentVersion
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not update agentVersion in config: %v", err)
		} else {
			log.Printf("Agent version updated to %s in config", agentVersion)
		}
	}

	return cfg
}

// forceConfigFlag (--force-config) lets --url / --key replace the values of an
// enrolled agent's config.json (re-homing an agent on purpose).
var forceConfigFlag bool

// configDecision is the outcome of resolveConfigPrecedence: the values to use
// and, per field, where they come from.
type configDecision struct {
	URL, Key             string
	URLSource, KeySource string // "config.json" | "flag"
	// URLIgnored / KeyIgnored: a flag was given with a different value and
	// config.json won.
	URLIgnored, KeyIgnored bool
	Forced                 bool // --force-config made a flag win
}

const (
	configSourceFile = "config.json"
	configSourceFlag = "flag"
)

// resolveConfigPrecedence decides between config.json and the --url / --key
// flags (decision 25: config.json wins after enrolment):
//   - a flag that is empty, or a config.json field that is empty, leaves the
//     other side;
//   - before the first successful enrolment the flags win (first install,
//     re-install with a corrected key while the agent is still pending);
//   - after it config.json wins, unless force (--force-config).
//
// URLs are compared without their trailing slash. Pure function (tested).
func resolveConfigPrecedence(fileURL, fileKey string, enrolled bool, flagURL, flagKey string, force bool) configDecision {
	d := configDecision{}
	pick := func(file, flag string) (value, source string, ignored, forced bool) {
		switch {
		case flag == "" || flag == file:
			return file, configSourceFile, false, false
		case file == "":
			return flag, configSourceFlag, false, false
		case !enrolled:
			return flag, configSourceFlag, false, false
		case force:
			return flag, configSourceFlag, false, true
		}
		return file, configSourceFile, true, false
	}
	var fu, fk bool
	d.URL, d.URLSource, d.URLIgnored, fu = pick(strings.TrimRight(fileURL, "/"), strings.TrimRight(flagURL, "/"))
	d.Key, d.KeySource, d.KeyIgnored, fk = pick(fileKey, flagKey)
	d.Forced = fu || fk
	return d
}

// logLines describes the decision for the agent log (the key is never
// printed). Empty when no flag played a part.
func (d configDecision) logLines() []string {
	var out []string
	if d.URLIgnored {
		out = append(out, "--url ignored: the agent is enrolled, serverUrl from config.json is kept ("+d.URL+"); pass --force-config to replace it")
	} else if d.URLSource == configSourceFlag {
		out = append(out, "serverUrl from --url ("+d.URL+")"+forcedSuffix(d.Forced))
	}
	if d.KeyIgnored {
		out = append(out, "--key ignored: the agent is enrolled, apiKey from config.json is kept; pass --force-config to replace it")
	} else if d.KeySource == configSourceFlag {
		out = append(out, "apiKey from --key"+forcedSuffix(d.Forced))
	}
	return out
}

func forcedSuffix(forced bool) string {
	if forced {
		return " (--force-config)"
	}
	return ""
}

// applyAgentConfigFrame handles the config-frame parts owned by this file and
// firewall.go, from the config worker (cmd_ws.go applyOGConfig): the first
// frame marks the agent enrolled (the server only sends config to approved
// agents), and the Windows firewallBackend preference is applied.
func applyAgentConfigFrame(cfg *Config, fw FirewallManager, firewallBackend *string) {
	if !cfg.Enrolled {
		cfg.Enrolled = true
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not save the enrolment state in config: %v", err)
		} else {
			log.Printf("Config: enrolment confirmed by the server — config.json now wins over --url/--key")
		}
	}
	applyFirewallBackendFrame(cfg, fw, firewallBackend)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func generateUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant bits
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ── Version comparison ────────────────────────────────────────────────────────

// parseSemver parses a "MAJOR.MINOR.PATCH" string (leading "v" is stripped).
// Returns (0,0,0) on any parse error so malformed versions are treated as
// lower than any real version.
func parseSemver(v string) (int, int, int) {
	v = strings.TrimPrefix(v, "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) != 3 {
		return 0, 0, 0
	}
	major, _ := strconv.Atoi(parts[0])
	minor, _ := strconv.Atoi(parts[1])
	patch, _ := strconv.Atoi(parts[2])
	return major, minor, patch
}

// isStrictlyNewer returns true only when remote is strictly greater than current.
func isStrictlyNewer(remote, current string) bool {
	rMaj, rMin, rPatch := parseSemver(remote)
	cMaj, cMin, cPatch := parseSemver(current)
	if rMaj != cMaj {
		return rMaj > cMaj
	}
	if rMin != cMin {
		return rMin > cMin
	}
	return rPatch > cPatch
}

// ── Auto-update ───────────────────────────────────────────────────────────────

const (
	// updateDownloadTimeout bounds the whole artifact download (MSI ~3 MB,
	// binaries ~7 MB) including slow links.
	updateDownloadTimeout = 5 * time.Minute
	// maxUpdateSize rejects absurd responses before they fill the disk.
	maxUpdateSize = 256 << 20
	// updateHandoverHold keeps the in-progress guard set after the installer
	// took over (Windows), in case this process is still alive meanwhile.
	updateHandoverHold = 15 * time.Minute
)

// updateInProgress serialises update attempts: config frames arrive every
// 30 s and must never start a second download while one is running. Reset on
// failure so the next offer can retry (mirrors Obliance main.go).
var updateInProgress atomic.Bool

// updateVersionRe is the only accepted shape of an update target. The version
// ends up in the Windows update script (run as SYSTEM) and in the
// update_status frames: anything else (e.g. "9.9.9&cmd", which parseSemver
// still reads as 9.9.0) is refused before any download.
var updateVersionRe = regexp.MustCompile(`^v?[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$`)

// checkForUpdate calls GET /api/agent/version once (at startup) and delegates
// to startUpdateIfNewer. Current servers answer an empty version to
// session-less callers (the target is delivered in the policy-gated config
// frame); older servers still return their version here.
func checkForUpdate(cfg *Config) {
	type versionResponse struct {
		Version string `json:"version"`
	}

	client := newHTTPClient(15 * time.Second)
	resp, err := client.Get(cfg.ServerURL + "/api/agent/version")
	if err != nil {
		log.Printf("Auto-update: version check failed: %s", tlsHint(err))
		return
	}
	defer resp.Body.Close()

	var info versionResponse
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || info.Version == "" {
		return
	}

	startUpdateIfNewer(cfg, info.Version)
}

// startUpdateIfNewer runs the update pipeline in a background goroutine when
// remoteVersion is strictly newer than the running agent, so the WS read loop
// (ban deltas, firewall commands) never blocks on a download. Returns false
// when nothing was started (up to date, or an update is already running).
func startUpdateIfNewer(cfg *Config, remoteVersion string) bool {
	if !updateVersionRe.MatchString(remoteVersion) {
		log.Printf("Auto-update: ignoring malformed version %q from the server", remoteVersion)
		return false
	}
	if !isStrictlyNewer(remoteVersion, agentVersion) {
		return false
	}
	if !updateInProgress.CompareAndSwap(false, true) {
		return false
	}
	go func() {
		if applyUpdateIfNewer(cfg, remoteVersion) {
			// The installer owns the rest (this process is normally stopped
			// already); release the guard later in case it is not.
			time.AfterFunc(updateHandoverHold, func() { updateInProgress.Store(false) })
			return
		}
		updateInProgress.Store(false)
	}()
	return true
}

// applyUpdateIfNewer downloads, verifies and installs remoteVersion when it is
// strictly newer than the running agentVersion, reporting every step to the
// server (update_status frames). Returns true when the installer took over;
// on failure the reason is logged and reported, and false is returned.
// Call it through startUpdateIfNewer, which provides the in-progress guard.
func applyUpdateIfNewer(cfg *Config, remoteVersion string) bool {
	if !isStrictlyNewer(remoteVersion, agentVersion) {
		return false
	}

	log.Printf("Auto-update: new version available %s → %s, downloading...", agentVersion, remoteVersion)

	if err := runUpdate(cfg, remoteVersion); err != nil {
		msg := tlsHint(err)
		log.Printf("Auto-update: update to v%s failed: %s", remoteVersion, msg)
		sendUpdateStatus(remoteVersion, updatePhaseFailed, msg)
		return false
	}
	return true
}

// updateArtifactName is the download name of this platform's artifact: the
// full MSI on Windows (the installer handles service registration), the bare
// binary elsewhere.
func updateArtifactName() string {
	if runtime.GOOS == "windows" {
		return "obliguard-agent.msi"
	}
	return fmt.Sprintf("obliguard-agent-%s-%s", runtime.GOOS, runtime.GOARCH)
}

func runUpdate(cfg *Config, target string) error {
	sendUpdateStatus(target, updatePhaseDownloading, "")

	client := newHTTPClient(updateDownloadTimeout)
	dlResp, err := client.Get(cfg.ServerURL + "/api/agent/download/" + updateArtifactName())
	if err != nil {
		return fmt.Errorf("download request failed: %w", err)
	}
	defer dlResp.Body.Close()
	if dlResp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed (HTTP %d)", dlResp.StatusCode)
	}

	// Staging location, never a world-writable temp directory:
	//   Windows: %PROGRAMDATA%\ObliguardAgent\update, ACL SYSTEM + Administrators;
	//   Unix:    next to the executable (root-owned, same filesystem so the
	//            final rename is atomic).
	var (
		stageDir string
		exePath  string
	)
	if runtime.GOOS == "windows" {
		if stageDir, err = prepareUpdateDir(); err != nil {
			return err
		}
	} else {
		if exePath, err = os.Executable(); err != nil {
			return fmt.Errorf("cannot resolve executable path: %w", err)
		}
		if resolved, rErr := filepath.EvalSymlinks(exePath); rErr == nil {
			exePath = resolved
		}
		stageDir = filepath.Dir(exePath)
	}

	pattern := ".obliguard-agent-update-*"
	if runtime.GOOS == "windows" {
		pattern = "obliguard-agent-*.msi"
	}
	f, err := os.CreateTemp(stageDir, pattern) // O_EXCL, mode 0600
	if err != nil {
		return fmt.Errorf("cannot create update file in %s: %w", stageDir, err)
	}
	stagePath := f.Name()
	written, err := io.Copy(f, io.LimitReader(dlResp.Body, maxUpdateSize+1))
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(stagePath)
		return fmt.Errorf("download interrupted after %d bytes: %w", written, err)
	}
	if written > maxUpdateSize {
		os.Remove(stagePath)
		return fmt.Errorf("download larger than %d bytes, refused", maxUpdateSize)
	}

	sendUpdateStatus(target, updatePhaseVerifying, "")
	served := strings.TrimSpace(dlResp.Header.Get("X-Agent-Version"))
	if err := verifyDownload(stagePath, written, dlResp.ContentLength,
		dlResp.Header.Get("X-Content-SHA256"), served); err != nil {
		os.Remove(stagePath)
		return err
	}
	if served != "" && served != target {
		log.Printf("Auto-update: server offered v%s but serves v%s — installing v%s", target, served, served)
	}

	sendUpdateStatus(target, updatePhaseInstalling, "")
	// Tell the server we are about to go offline (UPDATING badge, offline
	// alerts suppressed for up to 10 min). Older servers rely on it.
	notifyServerUpdating(cfg)

	if runtime.GOOS == "windows" {
		if err := applyWindowsMSIUpdate(stageDir, stagePath, cfg.ServerURL, cfg.APIKey, target); err != nil {
			os.Remove(stagePath)
			return fmt.Errorf("install failed: %w", err)
		}
		sendUpdateStatus(target, updatePhaseRestarting, "")
		// The detached script waits for the service to stop, runs msiexec,
		// restarts the previous service on failure and records the exit code
		// (reported by the next start, service_windows.go).
		log.Printf("Auto-update: MSI update to v%s initiated — stopping the service for msiexec...", target)
		restartWithNewBinary("") // stops through the SCM, never returns
		return nil
	}

	// Unix: atomically rename the verified binary over the running one.
	if err := os.Chmod(stagePath, 0755); err != nil {
		os.Remove(stagePath)
		return fmt.Errorf("install failed: chmod: %w", err)
	}
	if err := os.Rename(stagePath, exePath); err != nil {
		os.Remove(stagePath)
		return fmt.Errorf("install failed: rename: %w", err)
	}
	sendUpdateStatus(target, updatePhaseRestarting, "")
	log.Printf("Auto-update: updated to v%s, restarting...", target)
	// Unix: exec into the new binary in-place (same PID, works without a service manager).
	restartWithNewBinary(exePath)
	return nil // not reached; restartWithNewBinary always exits
}

// verifyDownload checks a downloaded artifact before it is installed (port of
// Obliance verifyFileSHA256 + Content-Length check):
//   - the byte count matches Content-Length (truncated downloads crash on exec);
//   - when the server announces X-Agent-Version, it must be newer than the
//     running agent (else the update would loop on the same version) and the
//     server must also send X-Content-SHA256 (current servers send both);
//   - when X-Content-SHA256 is present, the file hash must match it. Servers
//     older than the hash header send neither header: the hash check is then
//     skipped so those agents keep updating.
func verifyDownload(path string, written, contentLength int64, expectedSHA, servedVersion string) error {
	if written == 0 {
		return errors.New("verification failed: empty download")
	}
	if contentLength > 0 && written != contentLength {
		return fmt.Errorf("verification failed: download truncated (%d/%d bytes)", written, contentLength)
	}
	if servedVersion != "" && !isStrictlyNewer(servedVersion, agentVersion) {
		return fmt.Errorf("verification failed: server serves v%s, not newer than running v%s (artifact not rebuilt?)", servedVersion, agentVersion)
	}

	expected := strings.ToLower(strings.TrimSpace(expectedSHA))
	expected = strings.TrimPrefix(expected, "sha256:")
	if expected == "" {
		if servedVersion != "" {
			return errors.New("verification failed: server sent no X-Content-SHA256 header")
		}
		log.Printf("Auto-update: server sent no X-Content-SHA256 (older server) — integrity check skipped")
		return nil
	}
	if len(expected) != sha256.Size*2 {
		return fmt.Errorf("verification failed: malformed X-Content-SHA256 %q", expectedSHA)
	}
	if _, err := hex.DecodeString(expected); err != nil {
		return fmt.Errorf("verification failed: malformed X-Content-SHA256 %q", expectedSHA)
	}
	actual, err := fileSHA256(path)
	if err != nil {
		return fmt.Errorf("verification failed: %w", err)
	}
	if actual != expected {
		return fmt.Errorf("verification failed: sha256 mismatch (expected %s, got %s)", expected, actual)
	}
	return nil
}

// fileSHA256 returns the lowercase hex SHA-256 of a file.
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// updateDir is the staging directory of Windows updates (MSI, script, msiexec
// log, result marker).
func updateDir() string { return filepath.Join(configDir, "update") }

// updateResultFile is written by the update script when msiexec fails, and
// read (then deleted) by the next service start.
func updateResultFile() string { return filepath.Join(updateDir(), "update-result.txt") }

// prepareUpdateDir recreates the staging directory, empty and readable only
// by SYSTEM and Administrators: %PROGRAMDATA% lets BUILTIN\Users create files
// in its subfolders, so the inherited ACL would let a local user tamper with
// an MSI that is about to be installed as SYSTEM.
func prepareUpdateDir() (string, error) {
	dir := updateDir()
	// Keep an unread failure marker (the service was not restarted since).
	marker, _ := os.ReadFile(updateResultFile())
	if err := os.RemoveAll(dir); err != nil {
		return "", fmt.Errorf("cannot clean update directory: %w", err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("cannot create update directory: %w", err)
	}
	if runtime.GOOS == "windows" {
		// Protected DACL (inheritance removed): SYSTEM + Administrators, full
		// control, inherited by the files created below. SIDs, not names, so
		// it works on every display language.
		out, err := exec.Command("icacls", dir, "/inheritance:r",
			"/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F").CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("cannot restrict update directory ACL: %v (%s)", err, strings.TrimSpace(string(out)))
		}
	} else if err := os.Chmod(dir, 0700); err != nil {
		return "", fmt.Errorf("cannot restrict update directory: %w", err)
	}
	// Between MkdirAll and the ACL change the directory still had the
	// inherited (user-writable) ACL: a local user could have planted an entry
	// there (e.g. a hard link at the fixed script / log / marker path, which
	// stays under the user's control as its owner). Nobody but SYSTEM and
	// Administrators can create entries now, so empty it once more.
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", fmt.Errorf("cannot list update directory: %w", err)
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return "", fmt.Errorf("cannot clean update directory: %w", err)
		}
	}
	if len(marker) > 0 {
		_ = os.WriteFile(updateResultFile(), marker, 0600)
	}
	return dir, nil
}

// batQuote escapes a value for use inside a double-quoted batch argument.
func batQuote(s string) string {
	s = strings.ReplaceAll(s, "%", "%%")
	return strings.ReplaceAll(s, `"`, "")
}

// buildWindowsUpdateScript returns the batch script that installs the MSI.
// It outlives the service process:
//  1. waits (≤ 60 s) for the service to be STOPPED (the agent stops itself
//     through the SCM right after launching the script, restart_windows.go);
//  2. runs msiexec and captures its exit code;
//  3. on failure (anything but 0 / 3010 / 1641) records target + code in the
//     result marker, reported by the next start as update_status failed;
//  4. starts the service if it is not running (the previous version after a
//     failure; a no-op after success, the MSI already started the new one);
//  5. deletes the MSI and itself.
//
// "ping" is used as the delay: "timeout" fails without a console (services).
func buildWindowsUpdateScript(msiPath, logPath, resultPath, serverURL, apiKey, target string) string {
	lines := []string{
		"@echo off",
		"setlocal",
		`set "SVC=ObliguardAgent"`,
		"set /a WAITED=0",
		":waitstop",
		`sc query "%SVC%" | find "STOPPED" >nul`,
		"if not errorlevel 1 goto install",
		"if %WAITED% GEQ 60 goto install",
		"ping -n 3 127.0.0.1 >nul",
		"set /a WAITED+=2",
		"goto waitstop",
		":install",
		`msiexec /i "` + batQuote(msiPath) + `" /quiet /norestart SERVERURL="` + batQuote(serverURL) +
			`" APIKEY="` + batQuote(apiKey) + `" /l*v "` + batQuote(logPath) + `"`,
		`set "RC=%ERRORLEVEL%"`,
		`if "%RC%"=="0" goto restart`,
		`if "%RC%"=="3010" goto restart`,
		`if "%RC%"=="1641" goto restart`,
		`> "` + batQuote(resultPath) + `" echo target=` + batQuote(target),
		`>> "` + batQuote(resultPath) + `" echo rc=%RC%`,
		":restart",
		"ping -n 3 127.0.0.1 >nul",
		`sc query "%SVC%" | find "RUNNING" >nul`,
		`if errorlevel 1 sc start "%SVC%" >nul 2>&1`,
		`del /q "` + batQuote(msiPath) + `"`,
		`del /q "%~f0"`,
	}
	return strings.Join(lines, "\r\n") + "\r\n"
}

// applyWindowsMSIUpdate writes the update script next to the MSI (protected
// staging directory) and starts it detached.
//
// SERVERURL and APIKEY are forwarded so that the service arguments in the MSI
// are populated even when config.json already exists (belt-and-suspenders).
// TLS_INSECURE is deliberately not passed: the MSI then leaves the value
// already persisted in config.json untouched.
func applyWindowsMSIUpdate(dir, msiPath, serverURL, apiKey, target string) error {
	logPath := filepath.Join(dir, "obliguard-update.log")
	scriptPath := filepath.Join(dir, "obliguard-msi-update.bat")
	script := buildWindowsUpdateScript(msiPath, logPath, updateResultFile(), serverURL, apiKey, target)
	if err := os.WriteFile(scriptPath, []byte(script), 0600); err != nil {
		return fmt.Errorf("write MSI update script: %w", err)
	}
	// Start the batch script detached; it will outlive the current service process.
	return exec.Command("cmd", "/c", scriptPath).Start()
}

// msiexecCodeHint explains the most common msiexec exit codes.
func msiexecCodeHint(rc string) string {
	switch rc {
	case "1603":
		return " (fatal error during installation)"
	case "1618":
		return " (another installation was already in progress)"
	case "1619":
		return " (installation package could not be opened)"
	case "1625":
		return " (installation forbidden by system policy)"
	case "1638":
		return " (another version of this product is already installed)"
	}
	return ""
}

// loadUpdateFailureMarker reads the result marker left by a failed Windows
// update and queues an update_status "failed" frame for the next WS session.
// The marker is deleted once read. A marker for a version this agent already
// runs (or exceeds) is stale and only logged.
func loadUpdateFailureMarker() {
	path := updateResultFile()
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	_ = os.Remove(path)

	var target, rc string
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "target":
			target = strings.TrimSpace(v)
		case "rc":
			rc = strings.TrimSpace(v)
		}
	}
	if target == "" || !isStrictlyNewer(target, agentVersion) {
		log.Printf("Auto-update: ignoring stale update result (target=%q rc=%q, running v%s)", target, rc, agentVersion)
		return
	}
	msg := fmt.Sprintf("msiexec failed with exit code %s%s; previous version v%s restarted", rc, msiexecCodeHint(rc), agentVersion)
	log.Printf("Auto-update: previous update to v%s failed: %s", target, msg)
	queueUpdateStatus(target, updatePhaseFailed, msg)
}

// ── Main loop ─────────────────────────────────────────────────────────────────

// backoffSteps / backoffLevel are referenced by applyBackoff() in push.go.
var backoffSteps = []int{5 * 60, 10 * 60, 30 * 60, 60 * 60}
var backoffLevel = 0

func mainLoop(cfg *Config) {
	log.Printf("Obliguard Agent v%s starting", cfg.AgentVersion)
	log.Printf("Server: %s", cfg.ServerURL)
	log.Printf("Device UUID: %s", cfg.DeviceUUID)

	// Detect and initialise the local firewall backend (Windows: with the
	// backend preference last received from the server).
	fw := DetectFirewallFor(cfg.FirewallBackend)
	log.Printf("Firewall backend: %s", fw.Name())

	// Start log watcher with any cached service configs
	lw := NewLogWatcher(cfg.ServiceConfigs)
	lw.Start()
	defer lw.Stop()

	// On Windows, start the Security Event Log poller (reads RDP/auth failures
	// from EventID 4625/4624 — no log file path needed).
	// On Linux/macOS this is a no-op; those platforms use file-based tailing.
	startPlatformEventLogWatcher(lw)

	// Poll the OS TCP connection table every 5 s and emit auth_success events
	// for every new inbound connection to a known service port.
	startNetConnMonitor(lw)

	// Run the persistent WS command channel (replaces old push loop).
	// Reconnects automatically with exponential backoff.
	runCmdWS(cfg, lw, fw)
}

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	urlFlag := flag.String("url", "", "Server URL (required on first run)")
	keyFlag := flag.String("key", "", "API key (required on first run)")
	flag.Var(&tlsInsecureFlag, "tls-insecure",
		"Skip TLS certificate verification on every server connection (persisted as tlsInsecureSkipVerify; =0 turns it off, empty leaves config.json unchanged)")
	flag.BoolVar(&forceConfigFlag, "force-config", false,
		"Let --url / --key replace the values of config.json once the agent is enrolled (by default config.json wins after enrolment)")
	flag.Parse()

	// On Windows: detect service mode and hand off to SCM handler.
	// On Linux: runAsService is a no-op that returns immediately.
	if runAsService(urlFlag, keyFlag) {
		return
	}

	// Interactive / Linux mode
	cfg := setupConfig(*urlFlag, *keyFlag)
	mainLoop(cfg)
}
