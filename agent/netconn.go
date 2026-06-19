package main

import (
	"fmt"
	"time"
)

// tcpConn identifies a unique TCP connection by its local service port and
// the remote peer's address+port.  Used by platform-specific monitors to
// detect *new* inbound connections between polls.
type tcpConn struct {
	localPort  int
	remoteAddr string
	remotePort int
}

// servicePorts maps well-known server port numbers to Obliguard service names.
// A connection whose local port is in this map is considered "interesting" and
// will be emitted as an auth_success event to show up on the NetMap.
var servicePorts = map[int]string{
	21:   "ftp",
	22:   "ssh",
	25:   "mail",
	80:   "nginx",
	110:  "mail",
	143:  "mail",
	443:  "nginx",
	465:  "mail",
	587:  "mail",
	993:  "mail",
	995:  "mail",
	3306: "mysql",
	3389: "rdp",
	8080: "nginx",
	8443: "nginx",
}

// netconnServices returns the distinct service names covered by servicePorts.
func netconnServices() []string {
	seen := make(map[string]struct{}, len(servicePorts))
	out := make([]string, 0, len(servicePorts))
	for _, svc := range servicePorts {
		if _, ok := seen[svc]; ok {
			continue
		}
		seen[svc] = struct{}{}
		out = append(out, svc)
	}
	return out
}

// netConnInterval is the poll cadence for the TCP-connection monitors. Kept
// deliberately modest: this is best-effort NetMap enrichment, not security
// enforcement, so there's no value in hammering the OS connection table.
const netConnInterval = 10 * time.Second

// runNetConnLoop drives a platform TCP-connection monitor. Every netConnInterval
// it calls `poll` (a cheap OS connection-table read) and emits an auth_success
// event for each NEW inbound connection to a known service port whose template
// is enabled.
//
// IMPORTANT: the poll is skipped entirely when none of the monitored services
// is enabled — so an agent with no active templates does ZERO work here (no
// syscall, no subprocess). This is what keeps idle agents cheap; the per-event
// IsServiceEnabled check below is a second, finer gate once we do poll.
func runNetConnLoop(lw *LogWatcher, poll func() map[tcpConn]struct{}) {
	svcs := netconnServices()
	ticker := time.NewTicker(netConnInterval)
	defer ticker.Stop()

	var prev map[tcpConn]struct{}
	for range ticker.C {
		if !lw.IsAnyEnabled(svcs) {
			// Nothing to watch — reset the baseline so re-enabling later doesn't
			// replay the whole current table as "new" connections.
			prev = nil
			continue
		}
		curr := poll()
		if prev != nil {
			for conn := range curr {
				if _, seen := prev[conn]; seen {
					continue
				}
				svc, ok := servicePorts[conn.localPort]
				if !ok || !lw.IsServiceEnabled(svc) {
					continue
				}
				raw := fmt.Sprintf("New connection: %s:%d → :%d (%s)",
					conn.remoteAddr, conn.remotePort, conn.localPort, svc)
				lw.addEvent(makeEvent(conn.remoteAddr, "", svc, "auth_success", raw))
			}
		}
		prev = curr
	}
}
