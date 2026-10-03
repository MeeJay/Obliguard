//go:build windows

package main

// ─────────────────────────────────────────────────────────────────────────────
// Windows per-IP rate limiting: not supported.
//
// Windows Firewall (netsh/WFP) is allow/block only — it cannot rate-limit per
// source IP. The WinDivert prototype that used to live here was never shipped
// (the driver was not bundled) nor validated, and owner decision 23 rules it
// out: Windows agents do not advertise the 'ratelimit' capability and the UI
// shows network limits as unsupported on them. Rate-limit frames are ignored
// (see applyRateLimitsFrame in cmd_ws.go).
// ─────────────────────────────────────────────────────────────────────────────

func (f *WindowsFirewall) IsRateLimitSupported() bool              { return false }
func (f *WindowsFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }
