package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// ── Known service definitions ─────────────────────────────────────────────────

type knownService struct {
	ServiceType string
	Ports       []int
}

var knownServices = []knownService{
	{"ssh", []int{22}},
	{"rdp", []int{3389}},
	{"ftp", []int{21}},
	{"mail", []int{25, 587, 465, 143, 993, 110, 995}},
	{"mysql", []int{3306}},
	{"nginx", []int{80, 443, 8080, 8443}},
	{"apache", []int{80, 443, 8080, 8443}},
	{"iis", []int{80, 443, 8080}},
}

// ── detectServices scans for listening services ───────────────────────────────
// Returns a list of services currently listening on this machine.
// On Linux: uses `ss -tlnp` or `netstat -tlnp`.
// On Windows: uses `netstat -anp TCP`.
// On macOS: uses `netstat -anp tcp`.

func detectServices() []AgentDetectedService {
	listeningPorts := getListeningPorts()
	portToService := resolvePortsToServices(listeningPorts)

	seen := map[string]bool{}
	var services []AgentDetectedService

	for port, svcType := range portToService {
		if seen[svcType] {
			continue
		}
		seen[svcType] = true
		p := port
		services = append(services, AgentDetectedService{
			Type:   svcType,
			Port:   &p,
			Active: true,
		})
	}

	return services
}

// getListeningPorts returns TCP ports currently in LISTEN state.
func getListeningPorts() []int {
	switch runtime.GOOS {
	case "linux":
		return getListeningPortsLinux()
	case "windows":
		return getListeningPortsWindows()
	case "darwin":
		return getListeningPortsDarwin()
	default:
		return nil
	}
}

func getListeningPortsLinux() []int {
	// Try ss first (modern), fall back to netstat
	out, err := exec.Command("ss", "-tlnp").Output()
	if err != nil {
		out, err = exec.Command("netstat", "-tlnp").Output()
		if err != nil {
			return nil
		}
	}
	return parseSSOutput(string(out))
}

func getListeningPortsWindows() []int {
	out, err := exec.Command("netstat", "-anp", "TCP").Output()
	if err != nil {
		return nil
	}
	return parseNetstatWindows(string(out))
}

func getListeningPortsDarwin() []int {
	out, err := exec.Command("netstat", "-anp", "tcp").Output()
	if err != nil {
		return nil
	}
	return parseNetstatDarwin(string(out))
}

// parseSSOutput parses `ss -tlnp` or `netstat -tlnp` output to extract ports.
func parseSSOutput(output string) []int {
	var ports []int
	seen := map[int]bool{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "LISTEN") {
			continue
		}
		// Extract the local address field — columns: State RecvQ SendQ LocalAddr PeerAddr
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		localAddr := fields[3]
		port := extractPort(localAddr)
		if port > 0 && !seen[port] {
			seen[port] = true
			ports = append(ports, port)
		}
	}
	return ports
}

func parseNetstatWindows(output string) []int {
	var ports []int
	seen := map[int]bool{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(strings.ToUpper(line), "LISTENING") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		port := extractPort(fields[1])
		if port > 0 && !seen[port] {
			seen[port] = true
			ports = append(ports, port)
		}
	}
	return ports
}

func parseNetstatDarwin(output string) []int {
	var ports []int
	seen := map[int]bool{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "LISTEN") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		port := extractPort(fields[3])
		if port > 0 && !seen[port] {
			seen[port] = true
			ports = append(ports, port)
		}
	}
	return ports
}

func extractPort(addr string) int {
	// Handle IPv6 like [::]:22 or *:22 or 0.0.0.0:22 or 127.0.0.1:22
	if strings.HasPrefix(addr, "[") {
		// IPv6: [::1]:22
		idx := strings.LastIndex(addr, "]:")
		if idx < 0 {
			return 0
		}
		addr = addr[idx+2:]
	} else if strings.Contains(addr, ":") {
		parts := strings.Split(addr, ":")
		addr = parts[len(parts)-1]
	}
	port := 0
	fmt.Sscanf(addr, "%d", &port)
	return port
}

// resolvePortsToServices maps listening ports to known service types.
func resolvePortsToServices(ports []int) map[int]string {
	result := map[int]string{}
	portSet := map[int]bool{}
	for _, p := range ports {
		portSet[p] = true
	}

	for _, svc := range knownServices {
		for _, p := range svc.Ports {
			if portSet[p] {
				// Prefer the first match for multi-port services
				if _, exists := result[p]; !exists {
					result[p] = svc.ServiceType
				}
			}
		}
	}

	// De-duplicate: for nginx/apache both listening on 80/443, pick one
	svcFirst := map[string]int{}
	deduped := map[int]string{}
	for port, svcType := range result {
		if _, seen := svcFirst[svcType]; !seen {
			svcFirst[svcType] = port
			deduped[port] = svcType
		}
	}
	return deduped
}

// ── Quick port probe (used as fallback) ──────────────────────────────────────

func probePort(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// ── getHostname ───────────────────────────────────────────────────────────────

func getHostname() string {
	// Use the OS hostname directly — avoids DNS/PTR lookups that can return
	// Docker Desktop artifacts like "kubernetes.docker.internal" on Windows.
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	out, _ := exec.Command("hostname").Output()
	return strings.TrimSpace(string(out))
}
