//go:build !windows

package main

// startPlatformEventLogWatcher is a no-op on non-Windows platforms.
// Linux/macOS auth events are captured by the file-based LogWatcher
// (e.g. /var/log/auth.log, /var/log/secure).
func startPlatformEventLogWatcher(_ *LogWatcher) {}
