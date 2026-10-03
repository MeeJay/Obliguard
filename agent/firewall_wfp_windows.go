//go:build windows

package main

// ─────────────────────────────────────────────────────────────────────────────
// WFP-native firewall backend.
//
// Replaces the RAM-hungry "netsh advfirewall" grouped-rule backend with filters
// programmed directly into the Windows Filtering Platform (Base Filtering
// Engine) via github.com/tailscale/wf. One FWP_ACTION_BLOCK filter per banned
// /32 (or /24, /128, /64) at FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4/V6 — a true
// inbound DROP that scales to 30K–100K entries with a flat agent working set
// (filters live in the kernel/BFE, not the Go heap).
//
// FAIL-CLOSED: the provider, sublayer and every filter are PERSISTENT and the
// session is non-dynamic (Dynamic:false). netio.sys keeps enforcing the filters
// across agent crash AND reboot, with no agent running.
//
// SCOPE vs the old netsh backend: netsh created dir=in AND dir=out block rules;
// its inbound rule dropped ALL inbound packets from a banned IP, including
// packets on an already-established TCP connection. This backend blocks only new
// inbound connection *accepts* at ALE_AUTH_RECV_ACCEPT_V4/V6 — a true inbound
// DROP for every new connection attempt (the brute-force case each ban targets),
// but it does NOT block outbound traffic and does NOT tear down a TCP session the
// attacker established before the ban. This is the intended "TRUE inbound DROP"
// decision; if outbound blocking or live-session teardown is ever needed, add a
// companion block filter at FWPM_LAYER_INBOUND_TRANSPORT_V4/V6.
//
// CIDR: a host entry is an address/mask condition (/32, /128); a network is a
// range condition (first..last address, FWP_MATCH_RANGE), the form every
// Windows release accepts at the ALE layers. Filters of networks written as an
// address/mask by older agents are replaced at start.
//
// RESTART: the banlist file (written atomically) is the persisted filter set —
// filter ids are derived from the canonical entry (ruleID), so the file names
// exactly the filters this agent owns. At start every filter of our provider or
// sublayer that is not one of them (entry no longer banned, duplicate,
// unrecognized condition, older CIDR form) is stale and deleted by the first
// Flush. The desired set is capped at wfpMaxFilters entries.
//
// FALLBACK: if WFP cannot be opened, DetectFirewall falls back to the netsh
// backend; this file then arms netshFallbackPurge so the persistent filters of
// an earlier WFP run (invisible to netsh) are removed once netsh enforces.
//
// SWITCH: the server may select the backend ("firewallBackend": auto | wfp |
// netsh, see firewall.go). winBackendSwitcher at the end of this file migrates
// the ban set at runtime in both directions: the new backend enforces and is
// verified first, then the old backend's rules are removed.
//
// Name() stays "windows" so the server keeps keying on firewallBanned +
// firewallName. GetBannedIPs() enumerates the ACTUAL enforced set from WFP.
// Rate limiting is not supported on Windows (owner decision 23, no WinDivert):
// this backend does not advertise the 'ratelimit' capability.
//
// Concurrency: all shared state (desired/applied maps) is guarded by mu; the WFP
// session (which is not goroutine-safe) is serialized by opMu. This fixes the
// unguarded-map race the netsh backend had between the heartbeat goroutine
// (GetBannedIPs) and the ban-delta goroutine (BanIP/UnbanIP/Flush).
// ─────────────────────────────────────────────────────────────────────────────

import (
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/google/uuid"
	"github.com/tailscale/wf"
	"go4.org/netipx"
	"golang.org/x/sys/windows"
)

// ── Fixed identifiers (stable — never change across releases) ────────────────
//
// Provider  0B11C1A0-0B11-4B10-A100-0B11C1A00001
// Sublayer  0B11C1A0-0B11-4B10-A100-0B11C1A00002
// RuleID namespace (UUIDv5 over canonical prefix) 0B11C1A0-0B11-4B10-A100-0B11C1A0BA00

var obliProviderID = wf.ProviderID(windows.GUID{
	Data1: 0x0B11C1A0, Data2: 0x0B11, Data3: 0x4B10,
	Data4: [8]byte{0xA1, 0x00, 0x0B, 0x11, 0xC1, 0xA0, 0x00, 0x01},
})

var obliSublayerID = wf.SublayerID(windows.GUID{
	Data1: 0x0B11C1A0, Data2: 0x0B11, Data3: 0x4B10,
	Data4: [8]byte{0xA1, 0x00, 0x0B, 0x11, 0xC1, 0xA0, 0x00, 0x02},
})

var obliRuleNS = uuid.MustParse("0b11c1a0-0b11-4b10-a100-0b11c1a0ba00")

// Sublayer weight: max so our block-only sublayer is arbitrated last/final and,
// combined with a terminating hard block, wins over other providers' permits.
const obliSublayerWeight uint16 = 0xFFFF

// Max ops per WFP transaction. Steady-state deltas are tiny (one transaction);
// this only bounds the cold-load migration of tens of thousands of filters.
const wfpBatchSize = 4096

// Safety re-enumeration cadence — keeps the applied mirror provably == WFP.
const wfpResyncInterval = 10 * time.Minute

// wfpMaxFilters bounds the desired set (one kernel filter per entry, and the
// maps that mirror it in the agent). Bans beyond it are refused and reported
// as not enforced, so the server keeps them pending instead of losing them.
const wfpMaxFilters = 100000

// wf.New is retried while the Base Filtering Engine is still starting (boot).
const (
	wfpOpenAttempts = 3
	wfpOpenRetry    = 2 * time.Second
)

// FWP_E_* result codes (returned by wf as syscall.Errno).
const (
	fwpErrFilterNotFound = 0x80320003
	fwpErrNotFound       = 0x80320008
	fwpErrAlreadyExists  = 0x80320009
)

// ── DLL procs for WFP transactions ───────────────────────────────────────────
//
// tailscale/wf's AddRule/DeleteRule each auto-commit. To wrap a whole delta in
// ONE transaction we drive Begin/Commit/Abort on the session's engine handle
// ourselves (the handle is the Session's first field). Add/Delete calls made on
// that handle between Begin and Commit join the transaction and commit
// atomically.

var (
	fwpuclntDLL   = windows.NewLazySystemDLL("fwpuclnt.dll")
	procTxnBegin  = fwpuclntDLL.NewProc("FwpmTransactionBegin0")
	procTxnCommit = fwpuclntDLL.NewProc("FwpmTransactionCommit0")
	procTxnAbort  = fwpuclntDLL.NewProc("FwpmTransactionAbort0")
)

func wfpProc(p *windows.LazyProc, args ...uintptr) error {
	r1, _, _ := p.Call(args...)
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func txnBegin(h windows.Handle) error  { return wfpProc(procTxnBegin, uintptr(h), 0) }
func txnCommit(h windows.Handle) error { return wfpProc(procTxnCommit, uintptr(h)) }
func txnAbort(h windows.Handle) error  { return wfpProc(procTxnAbort, uintptr(h)) }

// sessHandle reads the engine handle out of a *wf.Session. As of the pinned
// version github.com/tailscale/wf v0.0.0-20240214030419-6fbb0a674ee6, Session's
// first field is `handle windows.Handle` (see firewall.go:22-23 in that module),
// so reading the first field via unsafe.Pointer yields the BFE engine handle.
// This is defensively guarded: if a future `go get -u` of wf reorders Session's
// fields, sessHandle returns a wrong/zero handle, txnBegin fails, and Flush
// transparently falls back to the per-op auto-committed path (bans still land,
// just without batching). Keep the go.mod pin in lockstep with this assumption.
func sessHandle(s *wf.Session) windows.Handle {
	return *(*windows.Handle)(unsafe.Pointer(s))
}

func isAlreadyExists(err error) bool {
	return errors.Is(err, syscall.Errno(fwpErrAlreadyExists))
}

func isNotFound(err error) bool {
	return errors.Is(err, syscall.Errno(fwpErrFilterNotFound)) ||
		errors.Is(err, syscall.Errno(fwpErrNotFound))
}

// ── Identifier helpers ───────────────────────────────────────────────────────

// guidFromUUID maps an RFC-4122 (network byte order) UUID to a windows.GUID.
func guidFromUUID(u uuid.UUID) windows.GUID {
	return windows.GUID{
		Data1: binary.BigEndian.Uint32(u[0:4]),
		Data2: binary.BigEndian.Uint16(u[4:6]),
		Data3: binary.BigEndian.Uint16(u[6:8]),
		Data4: [8]byte{u[8], u[9], u[10], u[11], u[12], u[13], u[14], u[15]},
	}
}

// ruleID deterministically derives a filter GUID from a canonical key, so the
// same ban always maps to the same filter (idempotent add, delete-by-recompute).
func ruleID(key string) wf.RuleID {
	return wf.RuleID(guidFromUUID(uuid.NewSHA1(obliRuleNS, []byte(key))))
}

// canon normalizes an IP or CIDR string into a round-trip-stable key + masked
// prefix. Used by BanIP/UnbanIP, banlist parsing and WFP enumeration so
// GetBannedIPs() emits exactly the strings the server sent.
//
//   - host route (/32, /128) → bare address string ("1.2.3.4", "2001:db8::1")
//   - subnet route           → masked prefix string ("1.2.3.0/24")
func canon(s string) (key string, p netip.Prefix, err error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", netip.Prefix{}, errors.New("empty")
	}
	if strings.Contains(s, "/") {
		p, err = netip.ParsePrefix(s)
		if err != nil {
			return "", netip.Prefix{}, err
		}
		p = p.Masked()
	} else {
		a, aerr := netip.ParseAddr(s)
		if aerr != nil {
			return "", netip.Prefix{}, aerr
		}
		a = a.Unmap().WithZone("")
		p = netip.PrefixFrom(a, a.BitLen())
	}
	return keyForPrefix(p), p, nil
}

// canonFromPrefix normalizes a prefix already obtained from WFP enumeration.
func canonFromPrefix(p netip.Prefix) (key string, out netip.Prefix) {
	p = p.Masked()
	return keyForPrefix(p), p
}

func keyForPrefix(p netip.Prefix) string {
	a := p.Addr()
	if p.Bits() == a.BitLen() {
		return a.String() // host route → bare IP
	}
	return p.String()
}

// wfpBanlistPath returns the shared banlist file next to the agent binary —
// the same path the netsh backend uses, so the two share one file.
func wfpBanlistPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "obliguard-banlist.txt")
}

// ── Backend ──────────────────────────────────────────────────────────────────

type wfpOp struct {
	add bool
	key string
	// staleID: delete this filter id (stale filter, see enumerate).
	staleID *wf.RuleID
}

// WFPFirewall enforces bans as persistent WFP block filters.
type WFPFirewall struct {
	sess *wf.Session // one non-dynamic (persistent) session for process lifetime

	mu      sync.Mutex              // guards desired + applied (held only briefly)
	desired map[string]netip.Prefix // canonical key → masked prefix (what SHOULD be enforced)
	applied map[string]wf.RuleID    // canonical key → RuleID currently in WFP (mirror of enforced set)
	stale   []wf.RuleID             // filters of ours to delete (see enumerate)

	opMu sync.Mutex // serializes slow WFP engine ops (Flush txn, enumerate)
	// closed is set (under opMu) when the backend is retired after a switch to
	// netsh: the session is closed, every later engine op is refused.
	closed bool
	// stop ends backgroundLoop (closed by retire).
	stop     chan struct{}
	stopOnce sync.Once

	// handover is set while a switch to netsh builds the netsh rules: the
	// startup reconcile must not delete them meanwhile. Guarded by handoverMu,
	// held across reconcile's check-and-delete.
	handoverMu sync.Mutex
	handover   bool
}

// newWFPFirewall opens the BFE engine and ensures the persistent provider +
// sublayer exist, then launches the background reconcile/resync loop. It returns
// quickly; the (potentially heavy) migration runs in the background because the
// persistent filters already enforce, so there is no coverage gap.
func newWFPFirewall() (FirewallManager, error) {
	f, err := openWFPFirewall()
	if err != nil {
		// DetectFirewall falls back to netsh: let it drop the filters of an
		// earlier WFP run once it enforces the banlist itself.
		netshFallbackPurge = purgeWFPAfterNetshFallback
		return nil, err
	}
	go f.backgroundLoop()
	return f, nil
}

func openWFPFirewall() (*WFPFirewall, error) {
	var sess *wf.Session
	var err error
	for attempt := 1; attempt <= wfpOpenAttempts; attempt++ {
		sess, err = wf.New(&wf.Options{
			Name:        "Obliguard",
			Description: "Obliguard IPS ban enforcement",
			Dynamic:     false, // persistent objects survive process exit
		})
		if err == nil || errors.Is(err, windows.ERROR_ACCESS_DENIED) || attempt == wfpOpenAttempts {
			break
		}
		log.Printf("Firewall(WFP): open failed (%v) — retrying in %s", err, wfpOpenRetry)
		time.Sleep(wfpOpenRetry)
	}
	if err != nil {
		return nil, err
	}
	f := &WFPFirewall{
		sess:    sess,
		desired: make(map[string]netip.Prefix),
		applied: make(map[string]wf.RuleID),
		stop:    make(chan struct{}),
	}
	if err := f.ensureInfra(); err != nil {
		sess.Close()
		return nil, err
	}

	// Seed applied SYNCHRONOUSLY from the live WFP filters before returning.
	// Persistent filters from a prior boot/crash are already dropping traffic
	// before the agent even started, so GetBannedIPs() must reflect that
	// enforced set from t=0 — otherwise the first heartbeat would report
	// firewallBanned=[] and the server could not see stale filters to remove
	// until a later cycle.
	//
	// desired comes from the banlist file (the persisted filter set): filters
	// that are not in it are stale and deleted by the first Flush. Without a
	// banlist (first WFP start, file removed) or with an empty one, the live
	// filters are adopted instead (fail-closed: never drop bans on missing
	// information). The legacy netsh merge + verify runs in the background
	// (backgroundLoop → reconcile), where a delay is harmless.
	f.opMu.Lock()
	existing, stale, eerr := f.enumerate()
	if eerr != nil {
		log.Printf("Firewall(WFP): initial enumerate failed: %v", eerr)
		existing, stale = map[string]wf.RuleID{}, nil
	}
	banlist, hasBanlist := readWFPBanlist(wfpBanlistPath())
	f.mu.Lock()
	for k, id := range existing {
		f.applied[k] = id
	}
	f.stale = stale
	if hasBanlist && len(banlist) > 0 {
		for k, p := range banlist {
			f.addDesiredLocked(k, p)
		}
	} else {
		for k := range existing {
			if _, p, e := canon(k); e == nil {
				f.addDesiredLocked(k, p)
			}
		}
	}
	removed := 0
	for k := range f.applied {
		if _, ok := f.desired[k]; !ok {
			removed++
		}
	}
	f.mu.Unlock()
	f.opMu.Unlock()
	if removed > 0 || len(stale) > 0 {
		log.Printf("Firewall(WFP): %d filter(s) not in the banlist and %d stale filter(s) will be removed", removed, len(stale))
	}
	// The caller starts backgroundLoop once this backend enforces
	// (newWFPFirewall at start, winBackendSwitcher.activate after a switch).
	return f, nil
}

// readWFPBanlist parses the banlist file (CRLF, blanks and garbage tolerated).
func readWFPBanlist(path string) (map[string]netip.Prefix, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	out := make(map[string]netip.Prefix)
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if k, p, e := canon(line); e == nil {
			out[k] = p
		}
	}
	return out, true
}

// addDesiredLocked adds an entry unless the cap is reached. Caller holds mu.
func (f *WFPFirewall) addDesiredLocked(key string, p netip.Prefix) bool {
	if _, ok := f.desired[key]; ok {
		return true
	}
	if len(f.desired) >= wfpMaxFilters {
		return false
	}
	f.desired[key] = p
	return true
}

// purgeWFPAfterNetshFallback removes our WFP objects once the netsh fallback
// enforces the banlist (see netshFallbackPurge).
func purgeWFPAfterNetshFallback() {
	cleanupWFP(func(format string, args ...any) {
		log.Printf("Firewall(netsh): purge of earlier WFP filters — "+format, args...)
	})
}

func (f *WFPFirewall) ensureInfra() error {
	err := f.sess.AddProvider(&wf.Provider{
		ID:          obliProviderID,
		Name:        "Obliguard",
		Description: "Obliguard IPS ban provider",
		Persistent:  true,
	})
	if err != nil && !isAlreadyExists(err) {
		return fmt.Errorf("add provider: %w", err)
	}
	err = f.sess.AddSublayer(&wf.Sublayer{
		ID:          obliSublayerID,
		Name:        "Obliguard-Block",
		Description: "Obliguard IPS block sublayer",
		Provider:    obliProviderID,
		Persistent:  true,
		Weight:      obliSublayerWeight,
	})
	if err != nil && !isAlreadyExists(err) {
		return fmt.Errorf("add sublayer: %w", err)
	}
	return nil
}

// ── FirewallManager interface ────────────────────────────────────────────────

func (f *WFPFirewall) Name() string      { return "windows" }
func (f *WFPFirewall) IsAvailable() bool { return f != nil && f.sess != nil }

// BackendKind reports the WFP-native backend (capability 'wfp', firewall.go).
func (f *WFPFirewall) BackendKind() string { return fwBackendWFP }

func (f *WFPFirewall) BanIP(ip string) error {
	key, p, err := canon(ip)
	if err != nil {
		return fmt.Errorf("wfp ban: parse %q: %w", ip, err)
	}
	f.mu.Lock()
	ok := f.addDesiredLocked(key, p)
	f.mu.Unlock()
	if !ok {
		return fmt.Errorf("wfp ban %s: filter limit reached (%d)", key, wfpMaxFilters)
	}
	return nil
}

func (f *WFPFirewall) UnbanIP(ip string) error {
	key, _, err := canon(ip)
	if err != nil {
		return fmt.Errorf("wfp unban: parse %q: %w", ip, err)
	}
	f.mu.Lock()
	delete(f.desired, key)
	f.mu.Unlock()
	return nil
}

// GetBannedIPs returns the ACTUAL enforced set (the applied mirror of our
// provider's WFP filters), as the canonical strings the server sent.
func (f *WFPFirewall) GetBannedIPs() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.applied))
	for k := range f.applied {
		out = append(out, k)
	}
	return out, nil
}

// Flush commits the diff between desired and applied in one WFP transaction per
// batch, then persists the banlist file.
func (f *WFPFirewall) Flush() error {
	f.opMu.Lock()
	defer f.opMu.Unlock()
	if f.closed {
		return errWFPClosed
	}

	f.mu.Lock()
	want := make(map[string]netip.Prefix, len(f.desired))
	for k, v := range f.desired {
		want[k] = v
	}
	have := make(map[string]wf.RuleID, len(f.applied))
	for k, v := range f.applied {
		have[k] = v
	}
	stale := append([]wf.RuleID(nil), f.stale...)
	f.mu.Unlock()

	// Stale deletes first: a CIDR filter in the older address/mask form has
	// the same id as its range replacement, which is added further down.
	ops := make([]wfpOp, 0, len(stale))
	for i := range stale {
		ops = append(ops, wfpOp{staleID: &stale[i]})
	}
	for k := range want {
		if _, ok := have[k]; !ok {
			ops = append(ops, wfpOp{add: true, key: k})
		}
	}
	for k := range have {
		if _, ok := want[k]; !ok {
			ops = append(ops, wfpOp{add: false, key: k})
		}
	}
	if len(ops) == 0 {
		return nil
	}

	handle := sessHandle(f.sess)
	totalAdd, totalDel, staleDel := 0, 0, 0
	staleDone := make(map[wf.RuleID]bool)
	for start := 0; start < len(ops); start += wfpBatchSize {
		end := start + wfpBatchSize
		if end > len(ops) {
			end = len(ops)
		}
		committed := f.commitBatch(handle, ops[start:end], want, have)
		if len(committed) == 0 {
			continue
		}
		f.mu.Lock()
		for _, o := range committed {
			if o.staleID != nil {
				staleDone[*o.staleID] = true
				staleDel++
				continue
			}
			if o.add {
				f.applied[o.key] = ruleID(o.key)
				totalAdd++
			} else {
				delete(f.applied, o.key)
				totalDel++
			}
		}
		f.mu.Unlock()
	}

	if len(stale) > 0 {
		// Keep the stale ids that could not be deleted for the next Flush
		// (f.stale may have been replaced by a resync meanwhile: filter it).
		f.mu.Lock()
		left := f.stale[:0]
		for _, id := range f.stale {
			if !staleDone[id] {
				left = append(left, id)
			}
		}
		f.stale = left
		f.mu.Unlock()
	}

	f.persistBanlist()
	if totalAdd > 0 || totalDel > 0 || staleDel > 0 {
		log.Printf("Firewall(WFP): committed +%d / -%d filters, %d stale removed (%d enforced)", totalAdd, totalDel, staleDel, f.appliedCount())
	}
	return nil
}

// commitBatch applies one batch atomically in a WFP transaction. On any hard
// error it aborts (nothing applied) and replays the batch non-transactionally
// so one poison entry cannot stall the rest. Returns the ops that took effect.
func (f *WFPFirewall) commitBatch(handle windows.Handle, batch []wfpOp, want map[string]netip.Prefix, have map[string]wf.RuleID) []wfpOp {
	if handle != 0 {
		if err := txnBegin(handle); err == nil {
			applied, opErr := f.runOps(batch, want, have, true)
			if opErr == nil {
				if cErr := txnCommit(handle); cErr == nil {
					return applied
				} else {
					// A failed FwpmTransactionCommit0 does NOT reliably
					// auto-abort — the read-write transaction stays OPEN on the
					// session handle. Without this explicit abort, the
					// non-transactional replay below would ENLIST into the still
					// open transaction (staged-success, never committed) and every
					// later Flush's txnBegin would return FWP_E_TXN_IN_PROGRESS —
					// a permanent, self-propagating silent fail-open. Aborting an
					// already-finished txn just returns FWP_E_TXN_NOT_IN_PROGRESS
					// (harmless), leaving the session clean so the replay
					// auto-commits per op.
					_ = txnAbort(handle)
					log.Printf("Firewall(WFP): transaction commit failed: %v — retrying individually", cErr)
				}
			} else {
				_ = txnAbort(handle)
				log.Printf("Firewall(WFP): transaction aborted (%v) — retrying individually", opErr)
			}
		} else {
			log.Printf("Firewall(WFP): begin transaction failed: %v — applying individually", err)
		}
	}
	applied, _ := f.runOps(batch, want, have, false)
	return applied
}

// runOps executes the ops against the session. AlreadyExists (add) and
// NotFound (delete) are idempotent successes. With stopOnErr, it returns at the
// first hard error (used inside a transaction so the caller can abort); without
// it, it skips failures and continues (best-effort replay).
func (f *WFPFirewall) runOps(batch []wfpOp, want map[string]netip.Prefix, have map[string]wf.RuleID, stopOnErr bool) (applied []wfpOp, firstErr error) {
	for _, o := range batch {
		var err error
		if o.staleID != nil {
			err = f.sess.DeleteRule(*o.staleID)
			if isNotFound(err) {
				err = nil
			}
		} else if o.add {
			err = f.sess.AddRule(buildRule(o.key, want[o.key]))
			if isAlreadyExists(err) {
				err = nil
			}
		} else {
			err = f.sess.DeleteRule(have[o.key])
			if isNotFound(err) {
				err = nil
			}
		}
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			if stopOnErr {
				return applied, firstErr
			}
			continue
		}
		applied = append(applied, o)
	}
	return applied, firstErr
}

// wfpRemoteMatch is the remote-address condition for one entry: a host is an
// address/mask (/32, /128 — the form older agents wrote, kept so their
// filters stay valid), a network is a range of its first..last address
// (FWP_MATCH_RANGE).
func wfpRemoteMatch(p netip.Prefix) *wf.Match {
	p = p.Masked()
	if p.IsSingleIP() {
		return &wf.Match{Field: wf.FieldIPRemoteAddress, Op: wf.MatchTypeEqual, Value: p}
	}
	return &wf.Match{Field: wf.FieldIPRemoteAddress, Op: wf.MatchTypeRange, Value: netipx.RangeOfPrefix(p)}
}

// wfpMatchPrefix maps a remote-address condition read back from WFP to the
// entry it enforces. current is false for a valid but outdated form (network
// as address/mask), which is replaced. ok is false for anything else.
func wfpMatchPrefix(m *wf.Match) (p netip.Prefix, current, ok bool) {
	if m == nil || m.Field != wf.FieldIPRemoteAddress {
		return netip.Prefix{}, false, false
	}
	switch v := m.Value.(type) {
	case netip.Prefix:
		if m.Op != wf.MatchTypeEqual || !v.IsValid() {
			return netip.Prefix{}, false, false
		}
		v = v.Masked()
		return v, v.IsSingleIP(), true
	case netip.Addr:
		if m.Op != wf.MatchTypeEqual || !v.IsValid() {
			return netip.Prefix{}, false, false
		}
		v = v.Unmap()
		return netip.PrefixFrom(v, v.BitLen()), true, true
	case netipx.IPRange:
		if m.Op != wf.MatchTypeRange {
			return netip.Prefix{}, false, false
		}
		pr, isPrefix := v.Prefix()
		if !isPrefix {
			return netip.Prefix{}, false, false
		}
		return pr.Masked(), !pr.IsSingleIP(), true
	}
	return netip.Prefix{}, false, false
}

// buildRule constructs a persistent terminating BLOCK filter for one prefix at
// the matching inbound ALE layer (see wfpRemoteMatch for the condition).
func buildRule(key string, p netip.Prefix) *wf.Rule {
	layer := wf.LayerALEAuthRecvAcceptV6
	if p.Addr().Is4() {
		layer = wf.LayerALEAuthRecvAcceptV4
	}
	return &wf.Rule{
		ID:          ruleID(key),
		Name:        "Obliguard-Ban " + key,
		Description: "Obliguard IPS block",
		Layer:       layer,
		Sublayer:    obliSublayerID,
		Provider:    obliProviderID,
		Weight:      ^uint64(0),
		Persistent:  true,
		HardAction:  true, // FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT — non-overridable
		Action:      wf.ActionBlock,
		Conditions:  []*wf.Match{wfpRemoteMatch(p)},
	}
}

func (f *WFPFirewall) persistBanlist() {
	f.mu.Lock()
	keys := make([]string, 0, len(f.applied))
	for k := range f.applied {
		keys = append(keys, k)
	}
	f.mu.Unlock()
	sort.Strings(keys)
	data := strings.Join(keys, "\n")
	if len(keys) > 0 {
		data += "\n"
	}
	if err := writeFileAtomic(wfpBanlistPath(), []byte(data), 0644); err != nil {
		log.Printf("Firewall(WFP): failed to save banlist: %v", err)
	}
}

func (f *WFPFirewall) appliedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.applied)
}

// ── Enumeration (authoritative read from WFP) ────────────────────────────────

// errWFPClosed: the backend was retired by a switch to netsh.
var errWFPClosed = errors.New("wfp: backend retired")

// enumerate reads all filters of our provider or sublayer straight from the
// engine. Caller must hold opMu.
func (f *WFPFirewall) enumerate() (map[string]wf.RuleID, []wf.RuleID, error) {
	if f.closed {
		return nil, nil, errWFPClosed
	}
	rules, err := f.sess.Rules()
	if err != nil {
		return nil, nil, err
	}
	cur, stale := classifyWFPRules(rules)
	return cur, stale, nil
}

// classifyWFPRules splits our filters into the enforced entries (canonical
// key → filter id) and the stale filter ids to delete: an unrecognized
// condition, a network in the older address/mask form, an id that is not
// ruleID(key) (so the add/delete-by-recompute bookkeeping cannot track it), or
// a second filter for the same entry. Filters of other providers are ignored.
func classifyWFPRules(rules []*wf.Rule) (map[string]wf.RuleID, []wf.RuleID) {
	cur := make(map[string]wf.RuleID)
	var stale []wf.RuleID
	for _, r := range rules {
		if r == nil || (r.Provider != obliProviderID && r.Sublayer != obliSublayerID) {
			continue
		}
		if len(r.Conditions) != 1 {
			stale = append(stale, r.ID)
			continue
		}
		p, current, ok := wfpMatchPrefix(r.Conditions[0])
		if !ok || !current {
			stale = append(stale, r.ID)
			continue
		}
		key, _ := canonFromPrefix(p)
		if r.ID != ruleID(key) {
			stale = append(stale, r.ID)
			continue
		}
		if _, dup := cur[key]; dup {
			stale = append(stale, r.ID)
			continue
		}
		cur[key] = r.ID
	}
	return cur, stale
}

// ── Startup reconcile + non-destructive netsh migration ──────────────────────

func (f *WFPFirewall) backgroundLoop() {
	f.reconcile()
	t := time.NewTicker(wfpResyncInterval)
	defer t.Stop()
	for {
		select {
		case <-f.stop:
			return
		case <-t.C:
			f.resync()
		}
	}
}

func (f *WFPFirewall) reconcile() {
	// (Steps 1 and 2 — adopting the live filters and loading the banlist
	// file, which also holds the IPs of the old grouped netsh rules since the
	// netsh backend wrote the same file — were done synchronously in
	// openWFPFirewall so GetBannedIPs is correct from t=0.)

	// 3. Merge legacy per-IP netsh rules (Obliguard-Block-A-B-C-D-*, IPv4 only)
	//    into desired so those IPs get WFP filters before we remove the netsh
	//    rules below.
	legacy := &WindowsFirewall{}
	for _, ip := range legacy.getLegacyIPs() {
		if k, p, e := canon(ip); e == nil {
			f.mu.Lock()
			f.addDesiredLocked(k, p)
			f.mu.Unlock()
		}
	}

	// 4. Converge WFP to desired (adds everything not yet enforced).
	if err := f.Flush(); err != nil {
		log.Printf("Firewall(WFP): reconcile flush: %v", err)
	}

	// 5. Verify by re-reading WFP, then — and ONLY then — remove netsh rules.
	//    If verification is incomplete we keep netsh (double-enforced, never
	//    under-enforced) and retry on the next start.
	verify, _, verr := f.enumLocked()
	if verr == nil {
		f.mu.Lock()
		missing := 0
		for k := range f.desired {
			if _, ok := verify[k]; !ok {
				missing++
			}
		}
		f.mu.Unlock()
		if missing == 0 {
			// WFP now enforces the full set → unconditionally clear the old netsh
			// backend's rules. We do NOT gate on a `netsh show rule` probe:
			// on a large ruleset that probe errors/truncates and returned false,
			// which left ~70 grouped rules (and their MpsSvc/BFE cost) in place
			// alongside the WFP filters. Both deleters are idempotent no-ops.
			// Skipped once a switch to netsh started (those rules are the new
			// backend's).
			f.handoverMu.Lock()
			if !f.handover && !f.isClosed() {
				legacy.deleteGroupedRules()
				legacy.cleanupLegacyRules()
				log.Printf("Firewall(WFP): migration — cleared any legacy netsh ban rules")
			}
			f.handoverMu.Unlock()
		} else {
			log.Printf("Firewall(WFP): verify incomplete (%d desired filters missing) — keeping netsh rules, will retry next start", missing)
		}
	} else {
		log.Printf("Firewall(WFP): verify enumerate failed: %v — keeping netsh rules", verr)
	}

	log.Printf("Firewall(WFP): ready — %d filters enforced", f.appliedCount())
}

// resync re-reads WFP into the applied mirror and, if it diverges from desired,
// converges via Flush. enumerate + mirror swap are done under opMu so they are
// atomic w.r.t. any Flush.
//
// IMPORTANT: desired is authoritative here — we deliberately do NOT re-adopt
// applied-not-in-desired keys back into desired. Doing so caused a lost-unban
// race: if the tick fired after the server's UnbanIP(X) removed X from desired
// but before the paired Flush deleted X from the kernel, re-adoption would put X
// back into desired and revert the operator's lift. Any filter present in WFP
// but absent from desired is a pending delete (or an out-of-band filter under
// our provider) and is converged away by the Flush below.
func (f *WFPFirewall) resync() {
	f.opMu.Lock()
	applied, stale, err := f.enumerate()
	if err != nil {
		f.opMu.Unlock()
		log.Printf("Firewall(WFP): resync enumerate failed: %v", err)
		return
	}
	f.mu.Lock()
	f.applied = applied
	f.stale = stale
	// Converge if desired and applied differ in EITHER direction (pending add
	// or pending delete), or a stale filter appeared. Equal length + desired ⊆
	// applied ⇒ the sets are equal.
	needFlush := len(stale) > 0 || len(f.desired) != len(applied)
	if !needFlush {
		for k := range f.desired {
			if _, ok := applied[k]; !ok {
				needFlush = true
				break
			}
		}
	}
	f.mu.Unlock()
	f.opMu.Unlock()

	if needFlush {
		if err := f.Flush(); err != nil {
			log.Printf("Firewall(WFP): resync flush: %v", err)
		}
	}
}

// enumLocked runs enumerate under opMu.
func (f *WFPFirewall) enumLocked() (map[string]wf.RuleID, []wf.RuleID, error) {
	f.opMu.Lock()
	defer f.opMu.Unlock()
	return f.enumerate()
}

// ── Rate limiting (not supported) ────────────────────────────────────────────
//
// WFP is allow/block only and the WinDivert prototype is gone (owner decision
// 23): rate limiting is reported unsupported and rate-limit frames are ignored
// (see applyRateLimitsFrame in cmd_ws.go).

func (f *WFPFirewall) IsRateLimitSupported() bool { return false }

func (f *WFPFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }

// ── Backend switch (server "firewallBackend", firewall.go) ───────────────────
//
// A switch runs under the switchableFirewall write lock: no ban delta reaches
// either backend meanwhile, and the heartbeat keeps reporting the old backend,
// which keeps enforcing until the new one is verified. The banlist file is
// shared by both backends; on a failed switch it is rewritten from the old
// backend's set, so a restart never loads the partial set of an aborted switch.

func init() { fwSwitchOps = winBackendSwitcher{} }

type winBackendSwitcher struct{}

func (winBackendSwitcher) kindOf(fw FirewallManager) string {
	switch fw.(type) {
	case *WFPFirewall:
		return fwBackendWFP
	case *WindowsFirewall:
		return fwBackendNetsh
	}
	return "none"
}

func (winBackendSwitcher) armWFPPurge() { netshFallbackPurge = purgeWFPAfterNetshFallback }

func (winBackendSwitcher) activate(fw FirewallManager) {
	if f, ok := fw.(*WFPFirewall); ok {
		go f.backgroundLoop()
	}
}

func (winBackendSwitcher) migrate(old FirewallManager, to string) (FirewallManager, error) {
	// Commit the pending deltas first: the set to move is what the old
	// backend was asked to enforce.
	if err := old.Flush(); err != nil {
		log.Printf("Firewall: switch — flush of the current backend: %v", err)
	}
	want := switchBanSet(old)
	switch to {
	case fwBackendWFP:
		return migrateToWFP(old, want)
	case fwBackendNetsh:
		return migrateToNetsh(old, want)
	}
	return nil, fmt.Errorf("unknown backend %q", to)
}

// switchBanSet returns the canonical entries a backend is asked to enforce
// (desired set, including entries a failed apply left pending).
func switchBanSet(fw FirewallManager) map[string]netip.Prefix {
	out := make(map[string]netip.Prefix)
	add := func(s string) {
		if k, p, err := canon(s); err == nil {
			out[k] = p
		}
	}
	switch f := fw.(type) {
	case *WFPFirewall:
		f.mu.Lock()
		for k := range f.desired {
			add(k)
		}
		f.mu.Unlock()
	case *WindowsFirewall:
		f.mu.Lock()
		f.loadCache()
		for k := range f.cache {
			add(k)
		}
		f.mu.Unlock()
	default:
		cur, _ := fw.GetBannedIPs()
		for _, k := range cur {
			add(k)
		}
	}
	return out
}

// switchMissing lists the entries of want that fw does not report enforced.
func switchMissing(want map[string]netip.Prefix, fw FirewallManager) []string {
	got := make(map[string]bool)
	cur, _ := fw.GetBannedIPs()
	for _, s := range cur {
		if k, _, err := canon(s); err == nil {
			got[k] = true
		}
	}
	var missing []string
	for k := range want {
		if !got[k] {
			missing = append(missing, k)
		}
	}
	sort.Strings(missing)
	return missing
}

// writeSwitchBanlist rewrites the shared banlist file with a ban set.
func writeSwitchBanlist(want map[string]netip.Prefix) {
	keys := make([]string, 0, len(want))
	for k := range want {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	data := strings.Join(keys, "\n")
	if len(keys) > 0 {
		data += "\n"
	}
	if err := writeFileAtomic(wfpBanlistPath(), []byte(data), 0644); err != nil {
		log.Printf("Firewall: switch — failed to restore the banlist: %v", err)
	}
}

// migrateToWFP: WFP filters for the whole set, verified by enumeration, then
// the netsh rules are removed.
func migrateToWFP(old FirewallManager, want map[string]netip.Prefix) (FirewallManager, error) {
	nw, err := openWFPFirewall()
	if err != nil {
		return nil, fmt.Errorf("WFP init: %w", err)
	}
	// Enforce exactly the old backend's set (not what the banlist file or
	// filters of an earlier WFP run hold).
	nw.mu.Lock()
	nw.desired = make(map[string]netip.Prefix, len(want))
	for k, p := range want {
		nw.addDesiredLocked(k, p)
	}
	nw.mu.Unlock()
	if err := nw.Flush(); err != nil {
		nw.retire(true)
		writeSwitchBanlist(want)
		return nil, fmt.Errorf("WFP flush: %w", err)
	}
	// Re-read the engine: the applied mirror must be what WFP holds.
	nw.resync()
	if missing := switchMissing(want, nw); len(missing) > 0 {
		nw.retire(true)
		writeSwitchBanlist(want)
		return nil, fmt.Errorf("%d of %d entries not enforced by WFP (first: %s)", len(missing), len(want), missing[0])
	}
	if nf, ok := old.(*WindowsFirewall); ok {
		nf.deleteGroupedRules()
		nf.cleanupLegacyRules()
		log.Printf("Firewall: switch — netsh ban rules removed, WFP enforces %d entries", len(want))
	}
	return nw, nil
}

// migrateToNetsh: netsh grouped rules for the whole set, verified (no group
// left unapplied), then the WFP filters are removed.
func migrateToNetsh(old FirewallManager, want map[string]netip.Prefix) (FirewallManager, error) {
	nf := &WindowsFirewall{}
	if !nf.IsAvailable() {
		return nil, errors.New("netsh not available")
	}
	oldWFP, _ := old.(*WFPFirewall)
	if oldWFP != nil {
		oldWFP.setHandover(true)
	}
	nf.mu.Lock()
	nf.loadCache()
	nf.cache = make(map[string]bool, len(want))
	for k := range want {
		nf.cache[k] = true
	}
	nf.dirty = true
	// The WFP filters are removed below, once netsh is verified, not by the
	// first Flush (netshFallbackPurge).
	nf.wfpPurged = true
	nf.mu.Unlock()

	err := nf.Flush()
	missing := switchMissing(want, nf)
	if err != nil || len(missing) > 0 {
		nf.deleteGroupedRules()
		if oldWFP != nil {
			oldWFP.setHandover(false)
			oldWFP.persistBanlist()
		} else {
			writeSwitchBanlist(want)
		}
		if err == nil {
			err = fmt.Errorf("%d of %d entries not enforced by netsh (first: %s)", len(missing), len(want), missing[0])
		}
		return nil, err
	}
	if oldWFP != nil {
		oldWFP.retire(true)
		log.Printf("Firewall: switch — WFP filters removed, netsh enforces %d entries", len(want))
	}
	return nf, nil
}

// setHandover marks a switch to netsh in progress (see WFPFirewall.handover).
func (f *WFPFirewall) setHandover(on bool) {
	f.handoverMu.Lock()
	f.handover = on
	f.handoverMu.Unlock()
}

func (f *WFPFirewall) isClosed() bool {
	f.opMu.Lock()
	defer f.opMu.Unlock()
	return f.closed
}

// retire stops the background loop and closes the session; with purge, every
// filter of the Obliguard provider/sublayer is removed (the other backend
// enforces the set by then, or the switch was aborted before it began).
func (f *WFPFirewall) retire(purge bool) {
	if f.stop != nil {
		f.stopOnce.Do(func() { close(f.stop) })
	}
	f.opMu.Lock()
	if !f.closed {
		f.closed = true
		if f.sess != nil {
			f.sess.Close()
		}
	}
	f.opMu.Unlock()
	if purge {
		cleanupWFP(func(format string, args ...any) {
			log.Printf("Firewall: switch — WFP cleanup: "+format, args...)
		})
	}
}
