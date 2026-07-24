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
// Name() stays "windows" so the server keeps keying on firewallBanned +
// firewallName. GetBannedIPs() enumerates the ACTUAL enforced set from WFP.
// Rate limiting still runs through WinDivert (firewall_ratelimit_windows.go);
// escalation bans land here via BanIP/Flush.
//
// Concurrency: all shared state (desired/applied maps) is guarded by mu; the WFP
// session (which is not goroutine-safe) is serialized by opMu. This fixes the
// unguarded-map race the netsh backend had between the heartbeat goroutine
// (GetBannedIPs), the ban-delta goroutine (BanIP/UnbanIP/Flush) and the
// WinDivert escalation goroutines.
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
}

// WFPFirewall enforces bans as persistent WFP block filters.
type WFPFirewall struct {
	sess *wf.Session // one non-dynamic (persistent) session for process lifetime

	mu      sync.Mutex              // guards desired + applied (held only briefly)
	desired map[string]netip.Prefix // canonical key → masked prefix (what SHOULD be enforced)
	applied map[string]wf.RuleID    // canonical key → RuleID currently in WFP (mirror of enforced set)

	opMu sync.Mutex // serializes slow WFP engine ops (Flush txn, enumerate)
}

// newWFPFirewall opens the BFE engine and ensures the persistent provider +
// sublayer exist, then launches the background reconcile/resync loop. It returns
// quickly; the (potentially heavy) migration runs in the background because the
// persistent filters already enforce, so there is no coverage gap.
func newWFPFirewall() (FirewallManager, error) {
	sess, err := wf.New(&wf.Options{
		Name:        "Obliguard",
		Description: "Obliguard IPS ban enforcement",
		Dynamic:     false, // persistent objects survive process exit
	})
	if err != nil {
		return nil, err
	}
	f := &WFPFirewall{
		sess:    sess,
		desired: make(map[string]netip.Prefix),
		applied: make(map[string]wf.RuleID),
	}
	if err := f.ensureInfra(); err != nil {
		sess.Close()
		return nil, err
	}

	// Seed applied+desired SYNCHRONOUSLY from the live WFP filters before
	// returning. Persistent filters from a prior boot/crash are already
	// dropping traffic before the agent even started, so GetBannedIPs() must
	// reflect that enforced set from t=0 — otherwise the first heartbeat would
	// report firewallBanned=[] and the server could not see stale filters to
	// remove until a later cycle. The heavier banlist/netsh merge + verify runs
	// in the background (backgroundLoop → reconcile), where a delay is harmless
	// (it can only cause re-adds, never a coverage gap).
	f.opMu.Lock()
	existing, eerr := f.enumerate()
	if eerr != nil {
		log.Printf("Firewall(WFP): initial enumerate failed: %v", eerr)
		existing = map[string]wf.RuleID{}
	}
	f.mu.Lock()
	for k, id := range existing {
		f.applied[k] = id
		if _, p, e := canon(k); e == nil {
			f.desired[k] = p
		}
	}
	f.mu.Unlock()
	f.opMu.Unlock()

	go f.backgroundLoop()
	return f, nil
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

func (f *WFPFirewall) BanIP(ip string) error {
	key, p, err := canon(ip)
	if err != nil {
		return fmt.Errorf("wfp ban: parse %q: %w", ip, err)
	}
	f.mu.Lock()
	f.desired[key] = p
	f.mu.Unlock()
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

	f.mu.Lock()
	want := make(map[string]netip.Prefix, len(f.desired))
	for k, v := range f.desired {
		want[k] = v
	}
	have := make(map[string]wf.RuleID, len(f.applied))
	for k, v := range f.applied {
		have[k] = v
	}
	f.mu.Unlock()

	ops := make([]wfpOp, 0)
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
	totalAdd, totalDel := 0, 0
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

	f.persistBanlist()
	if totalAdd > 0 || totalDel > 0 {
		log.Printf("Firewall(WFP): committed +%d / -%d filters (%d enforced)", totalAdd, totalDel, f.appliedCount())
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
		if o.add {
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

// buildRule constructs a persistent terminating BLOCK filter for one prefix at
// the matching inbound ALE layer. The tailscale/wf library marshals the
// netip.Prefix to FWP_V4_ADDR_AND_MASK or FWP_V6_ADDR_AND_MASK itself.
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
		Conditions: []*wf.Match{{
			Field: wf.FieldIPRemoteAddress,
			Op:    wf.MatchTypeEqual,
			Value: p,
		}},
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
	if err := os.WriteFile(wfpBanlistPath(), []byte(data), 0644); err != nil {
		log.Printf("Firewall(WFP): failed to save banlist: %v", err)
	}
}

func (f *WFPFirewall) appliedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.applied)
}

// ── Enumeration (authoritative read from WFP) ────────────────────────────────

// enumerate reads all filters under our provider straight from the engine.
// Caller must hold opMu.
func (f *WFPFirewall) enumerate() (map[string]wf.RuleID, error) {
	rules, err := f.sess.Rules()
	if err != nil {
		return nil, err
	}
	out := make(map[string]wf.RuleID)
	for _, r := range rules {
		if r.Provider != obliProviderID || len(r.Conditions) != 1 {
			continue
		}
		c := r.Conditions[0]
		if c.Field != wf.FieldIPRemoteAddress {
			continue
		}
		switch v := c.Value.(type) {
		case netip.Prefix:
			key, _ := canonFromPrefix(v)
			out[key] = r.ID
		case netip.Addr:
			key, _ := canonFromPrefix(netip.PrefixFrom(v, v.BitLen()))
			out[key] = r.ID
		}
	}
	return out, nil
}

// ── Startup reconcile + non-destructive netsh migration ──────────────────────

func (f *WFPFirewall) backgroundLoop() {
	f.reconcile()
	t := time.NewTicker(wfpResyncInterval)
	defer t.Stop()
	for range t.C {
		f.resync()
	}
}

func (f *WFPFirewall) reconcile() {
	// (Step 1 — adopting persistent filters already in WFP from a prior
	// boot/crash — was done synchronously in newWFPFirewall so GetBannedIPs is
	// correct from t=0. applied+desired are already seeded here.)

	// 2. Merge the shared banlist file (v4/v6/CIDR via netip, not the v4-only
	//    ipPattern). This also covers IPs held in the old grouped netsh rules,
	//    since the netsh backend wrote them to this same file.
	if data, rerr := os.ReadFile(wfpBanlistPath()); rerr == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			if k, p, e := canon(line); e == nil {
				f.mu.Lock()
				f.desired[k] = p
				f.mu.Unlock()
			}
		}
	}

	// 3. Merge legacy per-IP netsh rules (Obliguard-Block-A-B-C-D-*, IPv4 only)
	//    into desired so those IPs get WFP filters before we remove the netsh
	//    rules below.
	legacy := &WindowsFirewall{}
	for _, ip := range legacy.getLegacyIPs() {
		if k, p, e := canon(ip); e == nil {
			f.mu.Lock()
			f.desired[k] = p
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
	verify, verr := f.enumLocked()
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
			legacy.deleteGroupedRules()
			legacy.cleanupLegacyRules()
			log.Printf("Firewall(WFP): migration — cleared any legacy netsh ban rules")
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
	applied, err := f.enumerate()
	if err != nil {
		f.opMu.Unlock()
		log.Printf("Firewall(WFP): resync enumerate failed: %v", err)
		return
	}
	f.mu.Lock()
	f.applied = applied
	// Converge if desired and applied differ in EITHER direction (pending add
	// or pending delete). Equal length + desired ⊆ applied ⇒ the sets are equal.
	needFlush := len(f.desired) != len(applied)
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
func (f *WFPFirewall) enumLocked() (map[string]wf.RuleID, error) {
	f.opMu.Lock()
	defer f.opMu.Unlock()
	return f.enumerate()
}

// ── Rate limiting (delegates to the WinDivert path) ──────────────────────────
//
// WinDivert stays the rate limiter; WFP is the ban enforcer. Escalation bans
// call BanIP/Flush on this backend (see firewall_ratelimit_windows.go), which
// buffers into desired and commits as a WFP filter.

func (f *WFPFirewall) IsRateLimitSupported() bool {
	return winDivertDLLPath() != ""
}

func (f *WFPFirewall) ApplyRateLimits(rules []RateLimitRule) error {
	winRL.setFW(f)
	return winRL.apply(rules)
}
