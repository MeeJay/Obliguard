package main

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
