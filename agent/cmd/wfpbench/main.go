//go:build windows

// wfpbench — Obliguard WFP RAM benchmark.
//
// Inserts N persistent WFP block filters under its OWN dedicated provider +
// sublayer (DISTINCT from the agent's, so the running agent never adopts these
// benchmark filters as real bans) and reports the process working set
// before/after, so you can compare the WFP-native backend (filters live in the
// kernel/BFE, flat in-proc footprint) against the old netsh backend (rule blobs
// ballooned MpsSvc). It also prints the exact commands to read MpsSvc/BFE memory
// and the WFP filter count, and how to prove fail-closed persistence across a
// reboot.
//
// Build:  GOOS=windows go build -o wfpbench.exe ./cmd/wfpbench
// Run (elevated / SYSTEM):
//
//	wfpbench.exe -n 30000            # insert 30000 v4 block filters
//	wfpbench.exe -n 50000 -v6        # insert 50000 v6 block filters
//	wfpbench.exe -verify             # count wfpbench filters (post-reboot check)
//	wfpbench.exe -cleanup            # delete all wfpbench filters + sublayer + provider
package main

import (
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"net/netip"
	"os"
	"syscall"
	"time"
	"unsafe"

	"github.com/google/uuid"
	"github.com/tailscale/wf"
	"golang.org/x/sys/windows"
)

// DISTINCT identifiers from the agent backend (firewall_wfp_windows.go, which
// uses ...A100-...0001/0002). wfpbench deliberately runs under its OWN provider +
// sublayer so that even if the operator forgets -cleanup (or wfpbench crashes
// mid-run), the agent's reconcile/resync — which filters enumeration by the
// agent's provider ID — will NEVER adopt these benchmark filters as real bans.
// It still measures identical WFP insert cost / kernel working set.
var benchProviderID = wf.ProviderID(windows.GUID{
	Data1: 0x0B11C1A0, Data2: 0x0B11, Data3: 0x4B10,
	Data4: [8]byte{0xBE, 0x11, 0x0B, 0x11, 0xC1, 0xA0, 0xBE, 0x01},
})
var benchSublayerID = wf.SublayerID(windows.GUID{
	Data1: 0x0B11C1A0, Data2: 0x0B11, Data3: 0x4B10,
	Data4: [8]byte{0xBE, 0x11, 0x0B, 0x11, 0xC1, 0xA0, 0xBE, 0x02},
})
var benchRuleNS = uuid.MustParse("0b11c1a0-0b11-4b10-be11-0b11c1a0beba")

const (
	fwpErrFilterNotFound = 0x80320003
	fwpErrNotFound       = 0x80320008
	fwpErrAlreadyExists  = 0x80320009
)

// ── WFP transaction procs (drive Begin/Commit/Abort on the session handle) ───

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

func sessHandle(s *wf.Session) windows.Handle {
	return *(*windows.Handle)(unsafe.Pointer(s))
}

func isAlreadyExists(err error) bool { return errors.Is(err, syscall.Errno(fwpErrAlreadyExists)) }
func isNotFound(err error) bool {
	return errors.Is(err, syscall.Errno(fwpErrFilterNotFound)) || errors.Is(err, syscall.Errno(fwpErrNotFound))
}

func guidFromUUID(u uuid.UUID) windows.GUID {
	return windows.GUID{
		Data1: binary.BigEndian.Uint32(u[0:4]),
		Data2: binary.BigEndian.Uint16(u[4:6]),
		Data3: binary.BigEndian.Uint16(u[6:8]),
		Data4: [8]byte{u[8], u[9], u[10], u[11], u[12], u[13], u[14], u[15]},
	}
}
func ruleID(key string) wf.RuleID {
	return wf.RuleID(guidFromUUID(uuid.NewSHA1(benchRuleNS, []byte(key))))
}

func buildRule(key string, p netip.Prefix) *wf.Rule {
	layer := wf.LayerALEAuthRecvAcceptV6
	if p.Addr().Is4() {
		layer = wf.LayerALEAuthRecvAcceptV4
	}
	return &wf.Rule{
		ID:         ruleID(key),
		Name:       "Obliguard-Bench " + key,
		Layer:      layer,
		Sublayer:   benchSublayerID,
		Provider:   benchProviderID,
		Weight:     ^uint64(0),
		Persistent: true,
		HardAction: true,
		Action:     wf.ActionBlock,
		Conditions: []*wf.Match{{
			Field: wf.FieldIPRemoteAddress,
			Op:    wf.MatchTypeEqual,
			Value: p,
		}},
	}
}

// ── Process working set (GetProcessMemoryInfo / psapi) ───────────────────────

type processMemoryCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

var (
	psapiDLL                 = windows.NewLazySystemDLL("psapi.dll")
	procGetProcessMemoryInfo = psapiDLL.NewProc("GetProcessMemoryInfo")
)

func workingSet() (cur, peak uint64) {
	var c processMemoryCounters
	c.CB = uint32(unsafe.Sizeof(c))
	r1, _, _ := procGetProcessMemoryInfo.Call(
		uintptr(windows.CurrentProcess()),
		uintptr(unsafe.Pointer(&c)),
		uintptr(c.CB),
	)
	if r1 == 0 {
		return 0, 0
	}
	return uint64(c.WorkingSetSize), uint64(c.PeakWorkingSetSize)
}

func mb(v uint64) float64 { return float64(v) / (1024 * 1024) }

// ── IP generation ────────────────────────────────────────────────────────────

func genPrefix(base netip.Addr, v6 bool, i int) (string, netip.Prefix) {
	if v6 {
		b := base.As16()
		lo := binary.BigEndian.Uint64(b[8:16]) + uint64(i)
		binary.BigEndian.PutUint64(b[8:16], lo)
		a := netip.AddrFrom16(b)
		return a.String(), netip.PrefixFrom(a, 128)
	}
	b := base.As4()
	u := binary.BigEndian.Uint32(b[:]) + uint32(i)
	var nb [4]byte
	binary.BigEndian.PutUint32(nb[:], u)
	a := netip.AddrFrom4(nb)
	return a.String(), netip.PrefixFrom(a, 32)
}

// ── Provider/sublayer + enumeration ──────────────────────────────────────────

func ensureInfra(s *wf.Session) error {
	err := s.AddProvider(&wf.Provider{ID: benchProviderID, Name: "Obliguard-wfpbench", Persistent: true})
	if err != nil && !isAlreadyExists(err) {
		return fmt.Errorf("add provider: %w", err)
	}
	err = s.AddSublayer(&wf.Sublayer{
		ID: benchSublayerID, Name: "Obliguard-wfpbench-Block", Provider: benchProviderID,
		Persistent: true, Weight: 0xFFFF,
	})
	if err != nil && !isAlreadyExists(err) {
		return fmt.Errorf("add sublayer: %w", err)
	}
	return nil
}

func countFilters(s *wf.Session) (int, error) {
	rules, err := s.Rules()
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range rules {
		if r.Provider == benchProviderID {
			n++
		}
	}
	return n, nil
}

func cleanup(s *wf.Session) error {
	rules, err := s.Rules()
	if err != nil {
		return err
	}
	handle := sessHandle(s)
	deleted := 0
	_ = txnBegin(handle)
	for _, r := range rules {
		if r.Provider != benchProviderID {
			continue
		}
		if e := s.DeleteRule(r.ID); e != nil && !isNotFound(e) {
			// tolerate and continue
			continue
		}
		deleted++
	}
	if e := txnCommit(handle); e != nil {
		_ = txnAbort(handle)
		// best-effort fallback: delete individually
		for _, r := range rules {
			if r.Provider == benchProviderID {
				_ = s.DeleteRule(r.ID)
			}
		}
	}
	if e := s.DeleteSublayer(benchSublayerID); e != nil && !isNotFound(e) {
		fmt.Printf("  warn: delete sublayer: %v\n", e)
	}
	if e := s.DeleteProvider(benchProviderID); e != nil && !isNotFound(e) {
		fmt.Printf("  warn: delete provider: %v\n", e)
	}
	fmt.Printf("  deleted %d filters + sublayer + provider\n", deleted)
	return nil
}

func main() {
	n := flag.Int("n", 30000, "number of block filters to insert")
	baseStr := flag.String("base", "10.0.0.0", "start IPv4 address (ignored with -v6)")
	base6Str := flag.String("base6", "fd00::", "start IPv6 address (with -v6)")
	v6 := flag.Bool("v6", false, "generate IPv6 filters instead of IPv4")
	batch := flag.Int("batch", 4096, "filters per WFP transaction")
	verify := flag.Bool("verify", false, "only enumerate + count Obliguard filters, then exit")
	doCleanup := flag.Bool("cleanup", false, "delete all Obliguard filters + sublayer + provider, then exit")
	flag.Parse()

	fmt.Println("wfpbench — Obliguard WFP RAM benchmark")

	sess, err := wf.New(&wf.Options{Name: "Obliguard-wfpbench", Dynamic: false})
	if err != nil {
		fmt.Printf("  FATAL: open BFE engine failed (need admin/SYSTEM?): %v\n", err)
		os.Exit(1)
	}
	defer sess.Close()

	if *doCleanup {
		if err := cleanup(sess); err != nil {
			fmt.Printf("  cleanup failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if *verify {
		c, err := countFilters(sess)
		if err != nil {
			fmt.Printf("  enumerate failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("  enumerate (verify) : %d filters under Obliguard provider\n", c)
		return
	}

	fam := "v4"
	base, perr := netip.ParseAddr(*baseStr)
	if *v6 {
		fam = "v6"
		base, perr = netip.ParseAddr(*base6Str)
	}
	if perr != nil {
		fmt.Printf("  FATAL: bad base address: %v\n", perr)
		os.Exit(1)
	}

	fmt.Printf("  target filters : %d (family %s, base %s, batch %d)\n", *n, fam, base, *batch)
	if err := ensureInfra(sess); err != nil {
		fmt.Printf("  FATAL: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("  provider/sublayer ensured (%s / %s)\n",
		windows.GUID(benchProviderID).String(), windows.GUID(benchSublayerID).String())

	curBase, _ := workingSet()
	fmt.Printf("\n  agent working set (baseline) : %.1f MB\n", mb(curBase))
	fmt.Printf("  inserting %d persistent block filters ...\n", *n)

	handle := sessHandle(sess)
	start := time.Now()
	txns := 0
	inserted := 0
	for off := 0; off < *n; off += *batch {
		end := off + *batch
		if end > *n {
			end = *n
		}
		txnOK := txnBegin(handle) == nil
		for i := off; i < end; i++ {
			key, p := genPrefix(base, *v6, i)
			if e := sess.AddRule(buildRule(key, p)); e != nil && !isAlreadyExists(e) {
				fmt.Printf("    add %s failed: %v\n", key, e)
			} else {
				inserted++
			}
		}
		if txnOK {
			if e := txnCommit(handle); e != nil {
				_ = txnAbort(handle)
				fmt.Printf("    commit failed at %d: %v\n", end, e)
			} else {
				txns++
			}
		}
		rate := float64(end) / time.Since(start).Seconds()
		fmt.Printf("    [ %d / %d ]  t=%.2fs   (%.1fK filters/s)\n", end, *n, time.Since(start).Seconds(), rate/1000)
	}
	dur := time.Since(start)
	fmt.Printf("  commit complete: %d filters in %.2fs  (%.1fK filters/s, %d transactions)\n",
		inserted, dur.Seconds(), float64(*n)/dur.Seconds()/1000, txns)

	c, err := countFilters(sess)
	if err != nil {
		fmt.Printf("  enumerate failed: %v\n", err)
	} else {
		mark := "OK"
		if c != *n {
			mark = "MISMATCH"
		}
		fmt.Printf("\n  enumerate (verify) : %d filters under our provider  [%s] (== N? %v)\n", c, mark, c == *n)
	}

	curAfter, peak := workingSet()
	fmt.Printf("\n  agent working set (after)    : %.1f MB   (delta %+.1f MB", mb(curAfter), mb(curAfter)-mb(curBase))
	if *n > 0 {
		fmt.Printf(", ~%d bytes/filter in-proc", int64(curAfter-curBase)/int64(*n))
	}
	fmt.Printf(")\n")
	fmt.Printf("  agent working set (peak)     : %.1f MB\n", mb(peak))

	printGuidance()
}

func printGuidance() {
	fmt.Print(`
  -- Kernel/service memory — read these MANUALLY (this process cannot) --
  Compare BEFORE vs AFTER this run, and again AFTER a reboot:
    powershell "Get-Process mpssvc,svchost | Sort WS -desc | Select -First 8 Name,Id,@{n='WS_MB';e={[math]::Round($_.WS/1MB,1)}}"
    # BFE runs in a svchost; find its PID:
    powershell "Get-CimInstance Win32_Service -Filter \"Name='BFE'\" | Select ProcessId"
    powershell "Get-Process -Id <BFE_PID> | Select Name,@{n='WS_MB';e={[math]::Round($_.WS/1MB,1)}}"
    # confirm the filters exist in the kernel engine and count them
    # (wfpbench filters are named "Obliguard-Bench" — a DISTINCT provider from the
    #  agent's "Obliguard-Ban" filters, so the agent never adopts them):
    netsh wfp show state file=- | findstr /c:"Obliguard-Bench" | find /c "Obliguard-Bench"

  -- Persistence check (fail-closed proof) --
    1. leave these filters in place
    2. REBOOT
    3. run:  wfpbench -verify     -> expect: same N (survived reboot, no agent running)
    4. run:  wfpbench -cleanup    -> removes all Obliguard filters + sublayer + provider

  SUCCESS if: enumerate == N, agent WS delta stays flat (few MB, not GB),
              BFE WS grows modestly/linearly, and -verify still == N after reboot.
`)
}
