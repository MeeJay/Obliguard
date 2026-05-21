//go:build !windows

package main

// WindowsFirewall is defined in firewall.go (compiled on all platforms) but is
// only ever selected on Windows. On non-Windows builds its rate limiting is a
// no-op — the real WinDivert-backed implementation lives in
// firewall_ratelimit_windows.go.

func (f *WindowsFirewall) IsRateLimitSupported() bool              { return false }
func (f *WindowsFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }
