package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// withAgentVersion runs the test with a fixed running version.
func withAgentVersion(t *testing.T, v string) {
	t.Helper()
	prev := agentVersion
	agentVersion = v
	t.Cleanup(func() { agentVersion = prev })
}

// withTLSPolicy installs a TLS policy for the test and restores verification.
func withTLSPolicy(t *testing.T, skip bool) {
	t.Helper()
	setTLSPolicy(skip)
	t.Cleanup(func() { setTLSPolicy(false) })
}

func writeArtifact(t *testing.T, content string) (path string, sum string) {
	t.Helper()
	path = filepath.Join(t.TempDir(), "artifact")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte(content))
	return path, hex.EncodeToString(h[:])
}

// ── SHA-256 / download verification ───────────────────────────────────────────

func TestVerifyDownloadAcceptsMatchingHash(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	path, sum := writeArtifact(t, "new agent binary")
	n := int64(len("new agent binary"))
	if err := verifyDownload(path, n, n, sum, "1.2.4"); err != nil {
		t.Fatalf("matching hash refused: %v", err)
	}
	// Header case and an optional "sha256:" prefix are tolerated.
	if err := verifyDownload(path, n, n, "sha256:"+strings.ToUpper(sum), ""); err != nil {
		t.Fatalf("upper-case prefixed hash refused: %v", err)
	}
}

func TestVerifyDownloadRefusesSHA256Mismatch(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	path, _ := writeArtifact(t, "tampered binary")
	_, other := writeArtifact(t, "genuine binary")
	n := int64(len("tampered binary"))
	err := verifyDownload(path, n, n, other, "1.2.4")
	if err == nil || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("mismatch not refused: %v", err)
	}
}

func TestVerifyDownloadRefusesMissingHashFromCurrentServer(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	path, _ := writeArtifact(t, "binary")
	// A current server announces X-Agent-Version and must send the hash too.
	err := verifyDownload(path, 6, 6, "", "1.2.4")
	if err == nil || !strings.Contains(err.Error(), "X-Content-SHA256") {
		t.Fatalf("missing hash header not refused: %v", err)
	}
}

func TestVerifyDownloadOlderServerWithoutHeaders(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	path, _ := writeArtifact(t, "binary")
	// Older servers send neither header: the hash check is skipped (agent
	// TLS transition rule), the length check still applies.
	if err := verifyDownload(path, 6, 6, "", ""); err != nil {
		t.Fatalf("legacy server download refused: %v", err)
	}
}

func TestVerifyDownloadRefusesMalformedHash(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	path, _ := writeArtifact(t, "binary")
	for _, h := range []string{"abc", strings.Repeat("zz", 32)} {
		if err := verifyDownload(path, 6, 6, h, ""); err == nil {
			t.Fatalf("malformed hash %q accepted", h)
		}
	}
}

func TestVerifyDownloadRefusesTruncatedAndEmpty(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	path, sum := writeArtifact(t, "binary")
	if err := verifyDownload(path, 6, 10, sum, ""); err == nil || !strings.Contains(err.Error(), "truncated") {
		t.Fatalf("truncated download accepted: %v", err)
	}
	if err := verifyDownload(path, 0, -1, "", ""); err == nil {
		t.Fatal("empty download accepted")
	}
}

func TestVerifyDownloadRefusesServedVersionNotNewer(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	path, sum := writeArtifact(t, "binary")
	for _, served := range []string{"1.2.3", "1.2.2"} {
		err := verifyDownload(path, 6, 6, sum, served)
		if err == nil || !strings.Contains(err.Error(), "not newer") {
			t.Fatalf("served v%s accepted while running v1.2.3: %v", served, err)
		}
	}
}

// ── TLS policy ────────────────────────────────────────────────────────────────

func TestTLSConfigHonoursFlag(t *testing.T) {
	withTLSPolicy(t, false)
	if c := newTLSConfig("example.org"); c.InsecureSkipVerify || c.ServerName != "example.org" {
		t.Fatalf("default policy must verify with SNI set: %+v", c)
	}
	if tr := newHTTPClient(0).Transport.(*http.Transport); tr.TLSClientConfig == nil || tr.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("HTTP client must verify by default")
	}
	if caps := strings.Join(agentCapabilities(), ","); caps != "update_status,sha256,tls_verify" {
		t.Fatalf("capabilities = %s", caps)
	}

	setTLSPolicy(true)
	if !newTLSConfig("example.org").InsecureSkipVerify {
		t.Fatal("tlsInsecureSkipVerify=true not honoured by the WS TLS config")
	}
	if tr := newHTTPClient(0).Transport.(*http.Transport); !tr.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("tlsInsecureSkipVerify=true not honoured by the HTTP client")
	}
	if caps := agentCapabilities(); caps[len(caps)-1] != "tls_unverified" {
		t.Fatalf("insecure policy must report tls_unverified, got %v", caps)
	}
}

func TestSelfSignedServerRejectedUnlessInsecure(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	withTLSPolicy(t, false)
	_, err := newHTTPClient(0).Get(srv.URL)
	if err == nil || !isCertificateError(err) {
		t.Fatalf("self-signed certificate accepted by the HTTP client: %v", err)
	}
	if !strings.Contains(tlsHint(err), "tlsInsecureSkipVerify") {
		t.Fatalf("certificate error without operator hint: %s", tlsHint(err))
	}
	if _, err := wsConnect("wss://"+strings.TrimPrefix(srv.URL, "https://")+"/api/agent/ws", nil); err == nil || !isCertificateError(err) {
		t.Fatalf("self-signed certificate accepted by the WS dial: %v", err)
	}

	setTLSPolicy(true)
	resp, err := newHTTPClient(0).Get(srv.URL)
	if err != nil {
		t.Fatalf("insecure policy still verifies: %v", err)
	}
	resp.Body.Close()
}

func TestOptionalBoolFlag(t *testing.T) {
	cases := map[string]optionalBool{
		"":      {},
		"1":     {set: true, value: true},
		"true":  {set: true, value: true},
		"0":     {set: true, value: false},
		"false": {set: true, value: false},
	}
	for in, want := range cases {
		var o optionalBool
		if err := o.Set(in); err != nil || o != want {
			t.Fatalf("Set(%q) = %+v, %v; want %+v", in, o, err, want)
		}
	}
	var o optionalBool
	if err := o.Set("maybe"); err == nil {
		t.Fatal("invalid value accepted")
	}
}

func TestResolveTLSInsecure(t *testing.T) {
	withAgentVersion(t, "1.8.55")
	yes, no := true, false

	// New install (no field, created now): verify, persisted explicitly.
	cfg := &Config{AgentVersion: "1.8.55"}
	if skip, changed, src := resolveTLSInsecure(cfg, false, optionalBool{}); skip || !changed || src != "default" || cfg.TLSInsecureSkipVerify == nil || *cfg.TLSInsecureSkipVerify {
		t.Fatalf("new install: skip=%v changed=%v src=%s", skip, changed, src)
	}

	// Existing install upgraded from an older agent: keeps skipping, persisted.
	legacy := &Config{AgentVersion: "1.8.54"}
	if !isLegacyConfig(legacy) {
		t.Fatal("config of an older agent without the field must be legacy")
	}
	if skip, changed, src := resolveTLSInsecure(legacy, true, optionalBool{}); !skip || !changed || src != "legacy" || !*legacy.TLSInsecureSkipVerify {
		t.Fatalf("legacy upgrade: skip=%v changed=%v src=%s", skip, changed, src)
	}
	// Config written for this version without the field (offline wizard): not legacy.
	if isLegacyConfig(&Config{AgentVersion: "1.8.55"}) {
		t.Fatal("config of the running version must not be legacy")
	}
	if isLegacyConfig(&Config{AgentVersion: "1.8.54", TLSInsecureSkipVerify: &no}) {
		t.Fatal("explicit field must never be legacy")
	}

	// Explicit config value wins over the legacy rule.
	explicit := &Config{TLSInsecureSkipVerify: &no}
	if skip, changed, src := resolveTLSInsecure(explicit, true, optionalBool{}); skip || changed || src != "config" {
		t.Fatalf("explicit config: skip=%v changed=%v src=%s", skip, changed, src)
	}

	// The flag (installers, MSI TLS_INSECURE) wins over everything and is persisted.
	flagged := &Config{TLSInsecureSkipVerify: &yes}
	if skip, changed, src := resolveTLSInsecure(flagged, true, optionalBool{set: true, value: false}); skip || !changed || src != "flag" || *flagged.TLSInsecureSkipVerify {
		t.Fatalf("flag off: skip=%v changed=%v src=%s", skip, changed, src)
	}
}

// ── Async update guard ────────────────────────────────────────────────────────

func TestStartUpdateGuard(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	if startUpdateIfNewer(&Config{}, "1.2.3") || startUpdateIfNewer(&Config{}, "1.2.2") {
		t.Fatal("update started for a version that is not newer")
	}
	updateInProgress.Store(true)
	t.Cleanup(func() { updateInProgress.Store(false) })
	if startUpdateIfNewer(&Config{}, "9.9.9") {
		t.Fatal("second update started while one is in progress")
	}
}

func TestStartUpdateRefusesMalformedVersion(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	t.Cleanup(func() { updateInProgress.Store(false) })
	// parseSemver reads these as newer; they must never reach the update script.
	for _, v := range []string{"9.9.9&calc", `9.9.9" & del x`, "9.9.9\r\nrc=0", "10.0.0-rc1", "9.9"} {
		if startUpdateIfNewer(&Config{}, v) {
			t.Fatalf("update started for malformed version %q", v)
		}
		if updateInProgress.Load() {
			t.Fatalf("guard taken for malformed version %q", v)
		}
	}
}

// ── Windows update script and failure marker ──────────────────────────────────

func TestWindowsUpdateScriptRecoversOnFailure(t *testing.T) {
	s := buildWindowsUpdateScript(`C:\PD\update\a.msi`, `C:\PD\update\u.log`, `C:\PD\update\update-result.txt`,
		"https://srv.example/%x", "key", "1.2.4")
	for _, want := range []string{
		`set "RC=%ERRORLEVEL%"`,
		`echo rc=%RC%`,
		`echo target=1.2.4`,
		`if errorlevel 1 sc start "%SVC%"`,
		`SERVERURL="https://srv.example/%%x"`, // percent escaped for cmd
		"\r\n",
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("update script lacks %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "timeout /t") {
		t.Fatal("timeout.exe fails without a console (service context)")
	}
}

func TestUpdateFailureMarkerQueuesFailedStatus(t *testing.T) {
	withAgentVersion(t, "1.2.3")
	prevDir := configDir
	configDir = t.TempDir()
	t.Cleanup(func() { configDir = prevDir; pendingUpdateStatus = nil })

	if err := os.MkdirAll(updateDir(), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(updateResultFile(), []byte("target=1.2.4\r\nrc=1618\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	loadUpdateFailureMarker()
	if _, err := os.Stat(updateResultFile()); !os.IsNotExist(err) {
		t.Fatal("marker not deleted after read")
	}
	msg := pendingUpdateStatus
	if msg == nil || msg.Type != "update_status" || msg.Phase != "failed" || msg.TargetVersion != "1.2.4" || !strings.Contains(msg.Error, "1618") {
		t.Fatalf("failed status not queued: %+v", msg)
	}

	// Stale marker (target already reached) is ignored.
	pendingUpdateStatus = nil
	_ = os.WriteFile(updateResultFile(), []byte("target=1.2.3\nrc=1603\n"), 0600)
	loadUpdateFailureMarker()
	if pendingUpdateStatus != nil {
		t.Fatalf("stale marker reported: %+v", pendingUpdateStatus)
	}
}

func TestUpdateStatusQueuedWhenDisconnected(t *testing.T) {
	t.Cleanup(func() { pendingUpdateStatus = nil })
	setCurrentCmdWS(nil)
	sendUpdateStatus("1.2.4", updatePhaseDownloading, "")
	if pendingUpdateStatus != nil {
		t.Fatal("progress steps must not be queued")
	}
	sendUpdateStatus("1.2.4", updatePhaseFailed, strings.Repeat("x", 2000))
	if pendingUpdateStatus == nil || len(pendingUpdateStatus.Error) != updateStatusMaxError {
		t.Fatalf("failure not queued or not truncated: %+v", pendingUpdateStatus)
	}
	// Truncation never splits a multi-byte rune.
	msg := newUpdateStatusMsg("1.2.4", updatePhaseFailed, "x"+strings.Repeat("é", 400))
	if !utf8.ValidString(msg.Error) || len(msg.Error) > updateStatusMaxError {
		t.Fatalf("bad truncation: len=%d valid=%v", len(msg.Error), utf8.ValidString(msg.Error))
	}
}
