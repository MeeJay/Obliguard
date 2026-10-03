//go:build !windows

package main

// WindowsFirewall is defined in firewall_netsh.go (compiled on all platforms)
// but is only ever selected on Windows. Rate limiting is not supported there
// either (owner decision 23, see firewall_ratelimit_windows.go): both builds
// report it unsupported and ignore rate-limit frames.

func (f *WindowsFirewall) IsRateLimitSupported() bool              { return false }
func (f *WindowsFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }
