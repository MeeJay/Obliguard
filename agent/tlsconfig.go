package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ── Single TLS policy ─────────────────────────────────────────────────────────
//
// Every connection the agent opens to the Obliguard server (WSS command
// channel, update download, notifying-update, legacy push, uninstall MSI
// download) builds its TLS settings from newTLSConfig, so the WS channel and
// the HTTP clients can never disagree again: an agent that can talk to the
// server over WS can also download its updates, and vice versa.
//
// Verification is ON by default. It is skipped only when config.json carries
// "tlsInsecureSkipVerify": true or the agent is started with --tls-insecure
// (the installers expose it as TLS_INSECURE=1).
//
// Transition: earlier agents always skipped verification on the WS
// channel. An existing install upgrading (config.json written by an older
// agent, no tlsInsecureSkipVerify field) keeps that behaviour so the update
// never cuts it off from its server; the decision is persisted explicitly and
// the heartbeat reports the "tls_unverified" capability so the UI can warn.

const (
	capUpdateStatus  = "update_status"  // agent sends update_status frames
	capSHA256        = "sha256"         // agent verifies X-Content-SHA256 on downloads
	capTLSVerify     = "tls_verify"     // server certificate verified on every channel
	capTLSUnverified = "tls_unverified" // verification skipped (tlsInsecureSkipVerify)
)

var (
	tlsPolicyMu   sync.RWMutex
	tlsSkipVerify bool
	tlsTransport  *http.Transport
)

// optionalBool is a tri-state flag value: unset, true or false. It accepts the
// bare form (--tls-insecure), explicit values (--tls-insecure=1 / =0 /
// =true / =false) and an empty value (--tls-insecure=), which leaves it unset.
// The empty form is what the MSI produces when TLS_INSECURE is not given, so a
// silent MSI upgrade never overrides the value already in config.json.
type optionalBool struct {
	set   bool
	value bool
}

func (o *optionalBool) String() string {
	if o == nil || !o.set {
		return ""
	}
	if o.value {
		return "true"
	}
	return "false"
}

func (o *optionalBool) Set(s string) error {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "":
		o.set, o.value = false, false
	case "1", "true", "yes", "on":
		o.set, o.value = true, true
	case "0", "false", "no", "off":
		o.set, o.value = true, false
	default:
		return fmt.Errorf("invalid boolean %q (use 1/0, true/false)", s)
	}
	return nil
}

// IsBoolFlag lets "--tls-insecure" be given without a value.
func (o *optionalBool) IsBoolFlag() bool { return true }

// tlsInsecureFlag is bound to --tls-insecure in main().
var tlsInsecureFlag optionalBool

// resolveTLSInsecure decides the effective tlsInsecureSkipVerify for cfg and
// writes it into cfg so it is persisted explicitly. legacyConfig is true when
// cfg comes from a config.json written by an older agent. It returns the
// effective value, whether cfg changed, and where the value came from.
func resolveTLSInsecure(cfg *Config, legacyConfig bool, flagVal optionalBool) (skip bool, changed bool, source string) {
	switch {
	case flagVal.set:
		changed = cfg.TLSInsecureSkipVerify == nil || *cfg.TLSInsecureSkipVerify != flagVal.value
		v := flagVal.value
		cfg.TLSInsecureSkipVerify = &v
		return v, changed, "flag"
	case cfg.TLSInsecureSkipVerify != nil:
		return *cfg.TLSInsecureSkipVerify, false, "config"
	case legacyConfig:
		// Upgrade of an install whose WS channel never verified certificates:
		// keep the previous effective behaviour (now on every channel).
		v := true
		cfg.TLSInsecureSkipVerify = &v
		return true, true, "legacy"
	default:
		v := false
		cfg.TLSInsecureSkipVerify = &v
		return false, true, "default"
	}
}

// isLegacyConfig reports whether a config.json loaded from disk was written by
// an agent older than this binary and predates the tlsInsecureSkipVerify field.
// A config written for this very version without the field (offline wizard)
// is a new install and gets the secure default.
func isLegacyConfig(cfg *Config) bool {
	return cfg.TLSInsecureSkipVerify == nil && isStrictlyNewer(agentVersion, cfg.AgentVersion)
}

// setTLSPolicy installs the process-wide TLS policy and rebuilds the shared
// HTTP transport.
func setTLSPolicy(skip bool) {
	t := cloneDefaultTransport()
	t.TLSClientConfig = buildTLSConfig(skip, "")
	tlsPolicyMu.Lock()
	tlsSkipVerify = skip
	tlsTransport = t
	tlsPolicyMu.Unlock()
}

// tlsVerificationSkipped reports whether certificate verification is disabled.
func tlsVerificationSkipped() bool {
	tlsPolicyMu.RLock()
	defer tlsPolicyMu.RUnlock()
	return tlsSkipVerify
}

// newTLSConfig returns the client TLS config of the current policy. serverName
// sets SNI and the verified host name; "" lets net/http derive it from the URL.
func newTLSConfig(serverName string) *tls.Config {
	return buildTLSConfig(tlsVerificationSkipped(), serverName)
}

func buildTLSConfig(skip bool, serverName string) *tls.Config {
	return &tls.Config{
		ServerName:         serverName,
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: skip, // #nosec G402 -- explicit opt-in (tlsInsecureSkipVerify / --tls-insecure)
	}
}

// newHTTPClient returns an http.Client that follows the agent TLS policy.
func newHTTPClient(timeout time.Duration) *http.Client {
	tlsPolicyMu.RLock()
	t := tlsTransport
	tlsPolicyMu.RUnlock()
	if t == nil {
		// Policy not initialised yet (should not happen after setupConfig):
		// fall back to full verification, never to the insecure mode.
		t = cloneDefaultTransport()
		t.TLSClientConfig = buildTLSConfig(false, "")
	}
	return &http.Client{Timeout: timeout, Transport: t}
}

func cloneDefaultTransport() *http.Transport {
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		return base.Clone()
	}
	return &http.Transport{Proxy: http.ProxyFromEnvironment}
}

// tlsServerName extracts the SNI host from a "host:port" dial address.
func tlsServerName(hostport string) string {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	return strings.Trim(host, "[]")
}

// isCertificateError reports whether err is a TLS certificate verification
// failure (self-signed, unknown CA, host name mismatch, expired).
func isCertificateError(err error) bool {
	if err == nil {
		return false
	}
	var ua x509.UnknownAuthorityError
	var hn x509.HostnameError
	var ci x509.CertificateInvalidError
	var cv *tls.CertificateVerificationError
	if errors.As(err, &ua) || errors.As(err, &hn) || errors.As(err, &ci) || errors.As(err, &cv) {
		return true
	}
	return strings.Contains(err.Error(), "x509:")
}

// tlsHint appends an operator hint to certificate errors so the agent log (and
// the update_status error) says how to fix it instead of looping silently.
func tlsHint(err error) string {
	if !isCertificateError(err) {
		return err.Error()
	}
	return err.Error() + " (server certificate not trusted: install a valid certificate, add its CA to the system trust store, or set \"tlsInsecureSkipVerify\": true in config.json / reinstall with TLS_INSECURE=1)"
}

// agentCapabilities lists the optional protocol features this agent supports.
// Sent in every heartbeat; older servers ignore the field.
func agentCapabilities() []string {
	tlsCap := capTLSVerify
	if tlsVerificationSkipped() {
		tlsCap = capTLSUnverified
	}
	return []string{capUpdateStatus, capSHA256, tlsCap}
}

// logTLSPolicy prints the effective policy at startup (warning when insecure).
func logTLSPolicy(skip bool, source string) {
	if !skip {
		log.Printf("TLS: server certificate verification enabled (source=%s)", source)
		return
	}
	log.Printf("[WARN] TLS: certificate verification is DISABLED for all server connections (tlsInsecureSkipVerify=true, source=%s)", source)
	if source == "legacy" {
		log.Printf("[WARN] TLS: kept from the previous agent version for this existing install; set \"tlsInsecureSkipVerify\": false in %s (or reinstall without TLS_INSECURE) once the server certificate is trusted", configFile)
	}
}
