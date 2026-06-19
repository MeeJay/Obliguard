//go:build linux

package main

import (
	"bufio"
	"encoding/hex"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
)

// startNetConnMonitor surfaces new inbound TCP connections (read cheaply from
// /proc/net/tcp[6]) on the NetMap. The shared loop gates polling on whether any
// monitored service is enabled.
func startNetConnMonitor(lw *LogWatcher) {
	log.Printf("Linux TCP connection monitor started (/proc/net/tcp)")
	go runNetConnLoop(lw, readProcNetTCP)
}

func readProcNetTCP() map[tcpConn]struct{} {
	result := map[tcpConn]struct{}{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		parseProcNetFile(path, result)
	}
	return result
}

func parseProcNetFile(path string, result map[tcpConn]struct{}) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Scan() // skip header
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			continue
		}
		// fields[3] = connection state; "01" = ESTABLISHED
		if fields[3] != "01" {
			continue
		}
		localIP, localPort := parseHexAddrPort(fields[1])
		remoteIP, remotePort := parseHexAddrPort(fields[2])
		if localPort == 0 || remotePort == 0 {
			continue
		}
		_ = localIP
		if isLoopbackIP(remoteIP) {
			continue
		}
		result[tcpConn{localPort, remoteIP, remotePort}] = struct{}{}
	}
}

// parseHexAddrPort decodes a hex "ADDR:PORT" entry from /proc/net/tcp[6].
//   - IPv4 (/proc/net/tcp):  ADDR = 8 hex chars, little-endian u32
//   - IPv6 (/proc/net/tcp6): ADDR = 32 hex chars, 4 little-endian u32 groups
func parseHexAddrPort(addrPort string) (string, int) {
	parts := strings.SplitN(addrPort, ":", 2)
	if len(parts) != 2 {
		return "", 0
	}
	port, err := strconv.ParseInt(parts[1], 16, 32)
	if err != nil {
		return "", 0
	}
	hexAddr := parts[0]
	switch len(hexAddr) {
	case 8: // IPv4
		b, err := hex.DecodeString(hexAddr)
		if err != nil || len(b) != 4 {
			return "", 0
		}
		// /proc/net/tcp stores the 32-bit address in host (little-endian) byte order.
		ip := net.IP{b[3], b[2], b[1], b[0]}
		return ip.String(), int(port)
	case 32: // IPv6
		b, err := hex.DecodeString(hexAddr)
		if err != nil || len(b) != 16 {
			return "", 0
		}
		// Each 4-byte group is stored in little-endian order — reverse each group.
		for i := 0; i < 16; i += 4 {
			b[i], b[i+3] = b[i+3], b[i]
			b[i+1], b[i+2] = b[i+2], b[i+1]
		}
		return net.IP(b).String(), int(port)
	}
	return "", 0
}

func isLoopbackIP(ip string) bool {
	parsed := net.ParseIP(ip)
	return parsed != nil && (parsed.IsLoopback() || parsed.IsLinkLocalUnicast())
}
