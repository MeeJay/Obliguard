//go:build windows

package main

import (
	"log"
	"net"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Native TCP connection enumeration via the IP Helper API (iphlpapi.dll).
//
// This replaces the previous implementation that shelled out to
//   powershell -Command "Get-NetTCPConnection ..."
// every few seconds. Spawning PowerShell + a CIM cmdlet on each poll was a
// major CPU/RAM hog on busy or low-spec Windows hosts. GetExtendedTcpTable is
// exactly what netstat / Get-NetTCPConnection call underneath — one in-process
// syscall, no subprocess, no PowerShell startup cost.
var (
	modIphlpapi             = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTCPTable = modIphlpapi.NewProc("GetExtendedTcpTable")
)

const (
	afInet              = 2  // AF_INET
	afInet6             = 23 // AF_INET6
	tcpTableOwnerPIDAll = 5  // TCP_TABLE_OWNER_PID_ALL
	mibTCPStateEstab    = 5  // MIB_TCP_STATE_ESTAB
	ephemeralPortBase   = 49152
)

// MIB_TCPROW_OWNER_PID (AF_INET) — six DWORDs, no padding.
type mibTCPRowOwnerPID struct {
	State, LocalAddr, LocalPort, RemoteAddr, RemotePort, OwningPID uint32
}

// MIB_TCP6ROW_OWNER_PID (AF_INET6).
type mibTCP6RowOwnerPID struct {
	LocalAddr     [16]byte
	LocalScopeID  uint32
	LocalPort     uint32
	RemoteAddr    [16]byte
	RemoteScopeID uint32
	RemotePort    uint32
	State         uint32
	OwningPID     uint32
}

// startNetConnMonitor surfaces new inbound TCP connections to known service
// ports on the NetMap. The shared loop skips polling when no monitored service
// is enabled, and each poll is a single native syscall (see file header).
func startNetConnMonitor(lw *LogWatcher) {
	log.Printf("Windows TCP connection monitor started (native GetExtendedTcpTable)")
	go runNetConnLoop(lw, pollWinTCPConns)
}

func pollWinTCPConns() map[tcpConn]struct{} {
	result := map[tcpConn]struct{}{}
	collectTCPTable(result, afInet)
	collectTCPTable(result, afInet6)
	return result
}

// getTCPTable returns the raw MIB_*TCPTABLE_OWNER_PID buffer for an address
// family, or nil on error. Two-call pattern: size query, then fetch.
func getTCPTable(af uintptr) []byte {
	var size uint32
	_, _, _ = procGetExtendedTCPTable.Call(0, uintptr(unsafe.Pointer(&size)), 0, af, tcpTableOwnerPIDAll, 0)
	if size == 0 {
		return nil
	}
	buf := make([]byte, size)
	ret, _, _ := procGetExtendedTCPTable.Call(
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, af, tcpTableOwnerPIDAll, 0,
	)
	if ret != 0 { // NO_ERROR == 0; anything else (incl. table grew) → skip this cycle
		return nil
	}
	return buf
}

// collectTCPTable parses an OWNER_PID table buffer (dwNumEntries DWORD followed
// by a row array) into the result set. Rows are read by slice index so the
// backing array stays GC-reachable and the conversions stay vet-clean.
func collectTCPTable(result map[tcpConn]struct{}, af uintptr) {
	buf := getTCPTable(af)
	if len(buf) < 4 {
		return
	}
	n := int(*(*uint32)(unsafe.Pointer(&buf[0])))

	if af == afInet {
		rowSz := int(unsafe.Sizeof(mibTCPRowOwnerPID{}))
		for i := 0; i < n; i++ {
			off := 4 + i*rowSz
			if off+rowSz > len(buf) {
				break
			}
			row := (*mibTCPRowOwnerPID)(unsafe.Pointer(&buf[off]))
			if row.State != mibTCPStateEstab {
				continue
			}
			ip := net.IPv4(byte(row.RemoteAddr), byte(row.RemoteAddr>>8), byte(row.RemoteAddr>>16), byte(row.RemoteAddr>>24))
			addNetConn(result, decodeMIBPort(row.LocalPort), ip, decodeMIBPort(row.RemotePort))
		}
		return
	}

	rowSz := int(unsafe.Sizeof(mibTCP6RowOwnerPID{}))
	for i := 0; i < n; i++ {
		off := 4 + i*rowSz
		if off+rowSz > len(buf) {
			break
		}
		row := (*mibTCP6RowOwnerPID)(unsafe.Pointer(&buf[off]))
		if row.State != mibTCPStateEstab {
			continue
		}
		ip := make(net.IP, net.IPv6len)
		copy(ip, row.RemoteAddr[:])
		addNetConn(result, decodeMIBPort(row.LocalPort), ip, decodeMIBPort(row.RemotePort))
	}
}

// decodeMIBPort extracts the port from a MIB row port DWORD: the value lives in
// the low 16 bits in network byte order, so we ntohs() it.
func decodeMIBPort(dw uint32) int {
	b := uint16(dw)
	return int(b<<8 | b>>8)
}

// addNetConn applies the same filtering the old PowerShell Where-Object did:
// server-side ports only (< ephemeral range), skip loopback / link-local /
// unspecified peers.
func addNetConn(result map[tcpConn]struct{}, localPort int, remoteIP net.IP, remotePort int) {
	if localPort == 0 || localPort >= ephemeralPortBase || remotePort == 0 || remoteIP == nil {
		return
	}
	if remoteIP.IsLoopback() || remoteIP.IsLinkLocalUnicast() || remoteIP.IsUnspecified() {
		return
	}
	result[tcpConn{localPort, remoteIP.String(), remotePort}] = struct{}{}
}
