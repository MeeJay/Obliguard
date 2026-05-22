//go:build windows

package main

// ─────────────────────────────────────────────────────────────────────────────
// Windows per-IP rate limiting via WinDivert.
//
// Windows Firewall (netsh/WFP) is allow/block only — it cannot rate-limit per
// source IP. WinDivert provides a pre-signed kernel driver that lets us divert
// matching packets to user space, decide allow/drop, and reinject.
//
// Two filter modes, chosen by the active rules:
//   - SYN-only (light): when only 'rate' rules exist, we divert just inbound
//     TCP SYNs and count new connections/sec per IP.
//   - all-packets (heavy): when a 'volume' (drop-over-bandwidth) rule exists, we
//     divert every inbound TCP packet to also measure per-IP bytes/sec.
//
// Supported types: 'rate' (new conns/sec) and 'volume'+'drop' (per-IP mbit/s
// cap, drop over limit — the cross-platform "drop over limit" mode). NOT
// supported: 'connection' (needs full conntrack) and 'volume'+'shape' (true
// throttling needs a shaper Windows lacks) — both logged once and skipped.
//
// SAFETY: this whole backend is OFF unless WinDivert.dll sits next to the agent
// binary (see IsRateLimitSupported). Existing Windows agents are unaffected
// until the driver is bundled. NOTHING in this file has been tested on real
// hardware — validate the WinDivert ABI + driver loading before production use.
//
// Escalation: an IP that blows past maxValue × banMultiplier is handed to the
// existing netsh ban machinery (WindowsFirewall.BanIP) with an in-process TTL.
// ─────────────────────────────────────────────────────────────────────────────

import (
	"encoding/binary"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	winDivertLayerNetwork = 0
	// sizeof(WINDIVERT_ADDRESS) in WinDivert 2.x. Treated as an opaque blob:
	// we never parse it, we only hand it back to WinDivertSend on reinjection.
	winDivertAddrSize = 80
	// SYN-only filter — light path used when only rate/connection limits exist.
	winDivertFilterSyn = "inbound and ip and tcp and tcp.Syn and !tcp.Ack"
	// Broad filter — every inbound TCP packet, needed to measure per-IP
	// bandwidth for volume (drop-over-bandwidth) limits. Heavier (all packets
	// traverse user space) so only used when a volume rule is configured.
	winDivertFilterAll = "inbound and ip and tcp"
)

// winRL is the process-wide rate limiter state. There is only ever one
// WindowsFirewall instance, so a singleton avoids leaking Windows-only types
// into the cross-platform WindowsFirewall struct.
var winRL = &winRateLimiter{
	counters: make(map[uint32]*ipCounter),
	bans:     make(map[uint32]time.Time),
}

type ipCounter struct {
	winStart time.Time
	count    int // SYNs this window (rate type)
	bytes    int // bytes this window (volume type)
}

type winRateLimiter struct {
	mu      sync.Mutex
	running bool
	broad   bool // true when the current handle uses the all-packets filter
	handle  uintptr
	stop    chan struct{}

	// resolved config
	portRules    map[int]RateLimitRule // rate: dport → rule
	allRule      *RateLimitRule        // rate: port==nil rule
	volPortRules map[int]RateLimitRule // volume(drop): dport → rule
	volAllRule   *RateLimitRule        // volume(drop): port==nil rule

	cmu      sync.Mutex
	counters map[uint32]*ipCounter // srcIP → current 1s window
	bans     map[uint32]time.Time  // srcIP → ban expiry (zero = permanent)

	fw           *WindowsFirewall
	connTypeWarn sync.Once
	shapeWarn    sync.Once
}

// winDivertDLLPath returns the path to WinDivert.dll if it is bundled next to
// the agent binary, or "" if not present (rate limiting stays disabled).
func winDivertDLLPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	p := filepath.Join(filepath.Dir(exe), "WinDivert.dll")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

func (f *WindowsFirewall) IsRateLimitSupported() bool {
	return winDivertDLLPath() != ""
}

func (f *WindowsFirewall) ApplyRateLimits(rules []RateLimitRule) error {
	winRL.fw = f
	return winRL.apply(rules)
}

// apply reconfigures the limiter: rebuilds the rule maps and (re)starts or stops
// the WinDivert capture loop accordingly.
//
// Supported on Windows:
//   - 'rate'             : new connections/sec per IP (SYN counting)
//   - 'volume' + 'drop'  : drop traffic over a per-IP bandwidth cap (mbit/s)
//
// Skipped (logged once): 'connection' (needs full conntrack), 'volume'+'shape'
// (true throttling needs a shaper Windows lacks).
func (rl *winRateLimiter) apply(rules []RateLimitRule) error {
	portRules := make(map[int]RateLimitRule)
	volPortRules := make(map[int]RateLimitRule)
	var allRule *RateLimitRule
	var volAllRule *RateLimitRule

	for _, r := range rules {
		if r.MaxValue < 1 {
			continue
		}
		switch {
		case r.Type == "rate":
			if r.Port != nil {
				portRules[*r.Port] = r
			} else {
				rc := r
				allRule = &rc
			}
		case r.Type == "volume" && r.Action == "drop":
			if r.Port != nil {
				volPortRules[*r.Port] = r
			} else {
				rc := r
				volAllRule = &rc
			}
		case r.Type == "volume": // shape
			rl.shapeWarn.Do(func() {
				log.Printf("Firewall: 'volume' traffic shaping is not available on Windows — use the 'drop over limit' option instead")
			})
		case r.Type == "connection":
			rl.connTypeWarn.Do(func() {
				log.Printf("Firewall: 'connection' limit type is not supported on Windows yet — skipping")
			})
		}
	}

	hasVolume := len(volPortRules) > 0 || volAllRule != nil

	rl.mu.Lock()
	rl.portRules = portRules
	rl.allRule = allRule
	rl.volPortRules = volPortRules
	rl.volAllRule = volAllRule
	hasRules := len(portRules) > 0 || allRule != nil || hasVolume
	running := rl.running
	curBroad := rl.broad
	rl.mu.Unlock()

	switch {
	case hasRules && !running:
		rl.start(hasVolume)
	case !hasRules && running:
		rl.stopLoop()
	case hasRules && running && hasVolume != curBroad:
		// Filter scope changed (volume rules added/removed) — restart the handle.
		rl.stopLoop()
		rl.start(hasVolume)
	}
	return nil
}

// ── WinDivert syscall wrapper (loaded dynamically, no CGO) ───────────────────

type winDivert struct {
	dll       *windows.LazyDLL
	procOpen  *windows.LazyProc
	procRecv  *windows.LazyProc
	procSend  *windows.LazyProc
	procClose *windows.LazyProc
}

func loadWinDivert() (*winDivert, error) {
	dll := windows.NewLazyDLL(winDivertDLLPath())
	if err := dll.Load(); err != nil {
		return nil, err
	}
	return &winDivert{
		dll:       dll,
		procOpen:  dll.NewProc("WinDivertOpen"),
		procRecv:  dll.NewProc("WinDivertRecv"),
		procSend:  dll.NewProc("WinDivertSend"),
		procClose: dll.NewProc("WinDivertClose"),
	}, nil
}

const winDivertInvalidHandle = ^uintptr(0)

func (wd *winDivert) open(filter string) (uintptr, error) {
	fp, err := windows.BytePtrFromString(filter)
	if err != nil {
		return 0, err
	}
	h, _, callErr := wd.procOpen.Call(
		uintptr(unsafe.Pointer(fp)),
		uintptr(winDivertLayerNetwork),
		uintptr(0), // priority
		uintptr(0), // flags (default: divert mode)
	)
	if h == winDivertInvalidHandle {
		return 0, callErr
	}
	return h, nil
}

func (wd *winDivert) recv(handle uintptr, buf []byte, addr *[winDivertAddrSize]byte) (uint, bool) {
	var recvLen uint32
	r1, _, _ := wd.procRecv.Call(
		handle,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(len(buf)),
		uintptr(unsafe.Pointer(&recvLen)),
		uintptr(unsafe.Pointer(&addr[0])),
	)
	return uint(recvLen), r1 != 0
}

func (wd *winDivert) send(handle uintptr, buf []byte, n uint, addr *[winDivertAddrSize]byte) {
	var sendLen uint32
	wd.procSend.Call(
		handle,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(n),
		uintptr(unsafe.Pointer(&sendLen)),
		uintptr(unsafe.Pointer(&addr[0])),
	)
}

func (wd *winDivert) close(handle uintptr) {
	wd.procClose.Call(handle)
}

// ── Capture loop ─────────────────────────────────────────────────────────────

func (rl *winRateLimiter) start(broad bool) {
	wd, err := loadWinDivert()
	if err != nil {
		log.Printf("Firewall: WinDivert load failed, rate limiting disabled: %v", err)
		return
	}
	filter := winDivertFilterSyn
	if broad {
		filter = winDivertFilterAll
	}
	handle, err := wd.open(filter)
	if err != nil {
		log.Printf("Firewall: WinDivertOpen failed (driver not loaded / not admin?): %v", err)
		return
	}

	rl.mu.Lock()
	rl.handle = handle
	rl.broad = broad
	rl.stop = make(chan struct{})
	rl.running = true
	stop := rl.stop
	rl.mu.Unlock()

	log.Printf("Firewall: WinDivert network limiting active (mode=%s)", map[bool]string{true: "all-packets", false: "syn"}[broad])
	go rl.loop(wd, handle, stop)
	go rl.janitor(stop)
}

func (rl *winRateLimiter) stopLoop() {
	rl.mu.Lock()
	if !rl.running {
		rl.mu.Unlock()
		return
	}
	rl.running = false
	close(rl.stop)
	handle := rl.handle
	rl.handle = 0
	rl.mu.Unlock()

	// Closing the handle unblocks the recv loop.
	if wd, err := loadWinDivert(); err == nil && handle != 0 {
		wd.close(handle)
	}
	log.Printf("Firewall: WinDivert rate limiting stopped")
}

func (rl *winRateLimiter) loop(wd *winDivert, handle uintptr, stop chan struct{}) {
	// Never let a syscall mishap take down the agent.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Firewall: WinDivert loop panic recovered: %v", r)
		}
	}()

	buf := make([]byte, 65535)
	var addr [winDivertAddrSize]byte

	for {
		select {
		case <-stop:
			return
		default:
		}

		n, ok := wd.recv(handle, buf, &addr)
		if !ok {
			// Handle closed (stop) or transient error — bail if stopping.
			select {
			case <-stop:
				return
			default:
				continue
			}
		}
		if n == 0 {
			continue
		}

		allow := rl.evaluate(buf[:n])
		if allow {
			wd.send(handle, buf, n, &addr) // reinject = allow the packet through
		}
		// drop = simply do not reinject
	}
}

// evaluate parses an inbound IPv4 TCP packet and decides whether to allow it,
// applying both the rate (SYN/sec) and volume (bytes/sec) limits per source IP.
func (rl *winRateLimiter) evaluate(pkt []byte) bool {
	if len(pkt) < 20 || pkt[0]>>4 != 4 {
		return true // not IPv4 — let it through
	}
	ihl := int(pkt[0]&0x0f) * 4
	if pkt[9] != 6 || len(pkt) < ihl+14 { // protocol 6 = TCP, need TCP flags byte
		return true
	}
	srcIP := binary.BigEndian.Uint32(pkt[12:16])
	dport := int(binary.BigEndian.Uint16(pkt[ihl+2 : ihl+4]))
	flags := pkt[ihl+13]
	isSyn := flags&0x02 != 0 && flags&0x10 == 0 // SYN set, ACK clear
	pktLen := len(pkt)

	// Resolve applicable rules (most specific port wins, else the all-ports rule).
	rl.mu.Lock()
	var rateRule *RateLimitRule
	if r, ok := rl.portRules[dport]; ok {
		rc := r
		rateRule = &rc
	} else if rl.allRule != nil {
		rc := *rl.allRule
		rateRule = &rc
	}
	var volRule *RateLimitRule
	if r, ok := rl.volPortRules[dport]; ok {
		rc := r
		volRule = &rc
	} else if rl.volAllRule != nil {
		rc := *rl.volAllRule
		volRule = &rc
	}
	rl.mu.Unlock()

	if rateRule == nil && volRule == nil {
		return true
	}

	rl.cmu.Lock()
	defer rl.cmu.Unlock()

	// Already banned → drop (netsh also blocks it; this is belt-and-suspenders).
	if exp, ok := rl.bans[srcIP]; ok {
		if exp.IsZero() || time.Now().Before(exp) {
			return false
		}
		delete(rl.bans, srcIP)
	}

	now := time.Now()
	c := rl.counters[srcIP]
	if c == nil || now.Sub(c.winStart) >= time.Second {
		c = &ipCounter{winStart: now}
		rl.counters[srcIP] = c
	}

	drop := false

	// Rate limit: count new-connection SYNs this second.
	if rateRule != nil && isSyn {
		c.count++
		if rateRule.BanMultiplier != nil && *rateRule.BanMultiplier >= 2 && c.count > rateRule.MaxValue*(*rateRule.BanMultiplier) {
			rl.escalateBan(srcIP, rateRule)
			return false
		}
		if c.count > rateRule.MaxValue {
			drop = true
		}
	}

	// Volume limit: count bytes this second against the per-IP bandwidth cap.
	if volRule != nil {
		c.bytes += pktLen
		limitBytes := volRule.MaxValue * 125000 // mbit/s → bytes/s (1 mbit = 125000 bytes)
		if volRule.BanMultiplier != nil && *volRule.BanMultiplier >= 2 && c.bytes > limitBytes*(*volRule.BanMultiplier) {
			rl.escalateBan(srcIP, volRule)
			return false
		}
		if c.bytes > limitBytes {
			drop = true
		}
	}

	return !drop
}

// escalateBan hands the IP to the netsh ban machinery and records its TTL.
// Called with cmu held.
func (rl *winRateLimiter) escalateBan(srcIP uint32, r *RateLimitRule) {
	if _, already := rl.bans[srcIP]; already {
		return
	}
	var exp time.Time
	if r.BanTTLSeconds != nil && *r.BanTTLSeconds > 0 {
		exp = time.Now().Add(time.Duration(*r.BanTTLSeconds) * time.Second)
	}
	rl.bans[srcIP] = exp

	ipStr := net.IPv4(byte(srcIP>>24), byte(srcIP>>16), byte(srcIP>>8), byte(srcIP)).String()
	if rl.fw != nil {
		if err := rl.fw.BanIP(ipStr); err == nil {
			_ = rl.fw.Flush()
			log.Printf("Firewall: rate limit escalated → banned %s", ipStr)
		}
	}
}

// janitor evicts stale rate windows and lifts expired escalation bans.
func (rl *winRateLimiter) janitor(stop chan struct{}) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			now := time.Now()
			rl.cmu.Lock()
			for ip, c := range rl.counters {
				if now.Sub(c.winStart) >= 2*time.Second {
					delete(rl.counters, ip)
				}
			}
			var lift []uint32
			for ip, exp := range rl.bans {
				if !exp.IsZero() && now.After(exp) {
					lift = append(lift, ip)
				}
			}
			rl.cmu.Unlock()

			for _, ip := range lift {
				ipStr := net.IPv4(byte(ip>>24), byte(ip>>16), byte(ip>>8), byte(ip)).String()
				if rl.fw != nil {
					_ = rl.fw.UnbanIP(ipStr)
					_ = rl.fw.Flush()
				}
				rl.cmu.Lock()
				delete(rl.bans, ip)
				rl.cmu.Unlock()
				log.Printf("Firewall: rate limit ban expired → unbanned %s", ipStr)
			}
		}
	}
}
