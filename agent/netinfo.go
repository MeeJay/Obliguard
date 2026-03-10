package main

import "net"

// getLanIPs returns all RFC-1918 (private/LAN) IPv4 addresses currently
// assigned to non-loopback, up network interfaces on this machine.
//
// These are reported to the server on every push so the server can build
// agent-to-agent peer links on the NetMap without relying on hostname
// resolution (which may differ across tenants/VLANs).
func getLanIPs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	var ips []string
	for _, iface := range ifaces {
		// Skip loopback and interfaces that are down.
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if iface.Flags&net.FlagUp == 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}

		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}

			if ip == nil {
				continue
			}
			// IPv4 only
			if ip.To4() == nil {
				continue
			}
			// Skip loopback and link-local (169.254.x.x)
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			// Only RFC-1918 ranges
			if isRFC1918(ip) {
				ips = append(ips, ip.String())
			}
		}
	}
	return ips
}

// isRFC1918 reports whether ip is in a private (RFC-1918) address range:
//   - 10.0.0.0/8
//   - 172.16.0.0/12
//   - 192.168.0.0/16
func isRFC1918(ip net.IP) bool {
	ip4 := ip.To4()
	if ip4 == nil {
		return false
	}
	switch {
	case ip4[0] == 10:
		return true
	case ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31:
		return true
	case ip4[0] == 192 && ip4[1] == 168:
		return true
	}
	return false
}
