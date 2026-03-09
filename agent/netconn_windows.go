//go:build windows

package main

import (
	"fmt"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// startNetConnMonitor polls Get-NetTCPConnection every 5 s and emits
// auth_success events for new inbound connections to known service ports.
// Complements the Security Event Log watcher (startPlatformEventLogWatcher)
// which only captures auth-failure/success events — this surfaces all TCP
// connections regardless of authentication outcome.
func startNetConnMonitor(lw *LogWatcher) {
	go func() {
		log.Printf("Windows TCP connection monitor started (Get-NetTCPConnection)")
		prev := pollWinTCPConns()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			curr := pollWinTCPConns()
			for conn := range curr {
				if _, seen := prev[conn]; !seen {
					svc, ok := servicePorts[conn.localPort]
					if !ok {
						continue
					}
					raw := fmt.Sprintf("New connection: %s:%d → :%d (%s)",
						conn.remoteAddr, conn.remotePort, conn.localPort, svc)
					lw.addEvent(makeEvent(conn.remoteAddr, "", svc, "auth_success", raw))
				}
			}
			prev = curr
		}
	}()
}

func pollWinTCPConns() map[tcpConn]struct{} {
	result := map[tcpConn]struct{}{}
	// Only list established connections where the local port is below the
	// ephemeral range (< 49152) — these are server-side listening ports.
	// Omit loopback and link-local peers.
	script := `
Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -lt 49152 -and
                 $_.RemoteAddress -ne '127.0.0.1' -and
                 $_.RemoteAddress -ne '::1' -and
                 $_.RemoteAddress -ne '' } |
  ForEach-Object { "$($_.LocalPort)|$($_.RemoteAddress)|$($_.RemotePort)" }
`
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil || len(strings.TrimSpace(string(out))) == 0 {
		return result
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		parts := strings.SplitN(line, "|", 3)
		if len(parts) != 3 {
			continue
		}
		localPort, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
		remoteAddr := strings.TrimSpace(parts[1])
		remotePort, _ := strconv.Atoi(strings.TrimSpace(parts[2]))
		if localPort == 0 || remotePort == 0 || remoteAddr == "" {
			continue
		}
		result[tcpConn{localPort, remoteAddr, remotePort}] = struct{}{}
	}
	return result
}
