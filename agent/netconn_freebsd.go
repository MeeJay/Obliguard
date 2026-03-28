//go:build freebsd

package main

import (
	"fmt"
	"log"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// startNetConnMonitor polls sockstat every 5 s and emits auth_success events
// for new inbound TCP connections to known service ports on FreeBSD.
func startNetConnMonitor(lw *LogWatcher) {
	go func() {
		log.Printf("FreeBSD TCP connection monitor started (sockstat)")
		prev := pollFreeBSDTCPConns()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			curr := pollFreeBSDTCPConns()
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

// pollFreeBSDTCPConns uses sockstat to list established TCP connections.
// sockstat -4c output looks like:
//   USER COMMAND PID FD PROTO LOCAL FOREIGN
//   root sshd    1234 4 tcp4  192.168.1.1:22 10.0.0.5:54321
func pollFreeBSDTCPConns() map[tcpConn]struct{} {
	result := map[tcpConn]struct{}{}
	// -4: IPv4 only, -c: connected sockets, -P tcp: TCP protocol
	out, err := exec.Command("sockstat", "-4c", "-P", "tcp").Output()
	if err != nil {
		return result
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		// USER COMMAND PID FD PROTO LOCAL FOREIGN
		if len(fields) < 7 {
			continue
		}
		proto := fields[4]
		if proto != "tcp4" && proto != "tcp46" {
			continue
		}
		localAddr := fields[5]
		foreignAddr := fields[6]

		localPort := extractPort(localAddr)
		remoteIP, remotePort := splitAddrPort(foreignAddr)

		if localPort == 0 || remotePort == 0 || remoteIP == "" {
			continue
		}
		if isFreeBSDLoopback(remoteIP) {
			continue
		}
		result[tcpConn{localPort, remoteIP, remotePort}] = struct{}{}
	}
	return result
}

// splitAddrPort splits "ip:port" handling both IPv4 and bracketed IPv6.
func splitAddrPort(addr string) (string, int) {
	// Handle *:* (listening wildcard)
	if addr == "*:*" {
		return "", 0
	}
	idx := strings.LastIndex(addr, ":")
	if idx < 0 {
		return "", 0
	}
	ip := addr[:idx]
	port, err := strconv.Atoi(addr[idx+1:])
	if err != nil || port == 0 {
		return "", 0
	}
	return ip, port
}

func isFreeBSDLoopback(ip string) bool {
	parsed := net.ParseIP(ip)
	return parsed != nil && (parsed.IsLoopback() || parsed.IsLinkLocalUnicast())
}
