//go:build !linux && !windows && !freebsd

package main

// startNetConnMonitor is a no-op on platforms other than Linux and Windows.
func startNetConnMonitor(_ *LogWatcher) {}
