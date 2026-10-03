package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Tests of the netsh fallback backend (firewall_netsh.go). The command runner
// is faked (firewall_test.go), so they run on every OS.

func noNetshSleep(t *testing.T) *[]time.Duration {
	t.Helper()
	var slept []time.Duration
	old := netshSleep
	netshSleep = func(d time.Duration) { slept = append(slept, d) }
	t.Cleanup(func() { netshSleep = old })
	return &slept
}

func countPrefix(lines []string, prefix string) int {
	n := 0
	for _, l := range lines {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

const netshShowFR = `
Nom de la règle :                     Obliguard-Block-in-1
----------------------------------------------------------------------
Activé :                              Oui
Sens :                                Entrée
Profils :                             Domaine,Privé,Public
Groupement :
IP locale :                           Tout
IP distante :                         1.2.3.4/32,5.6.7.8/32
Protocole :                           Tout
Action :                              Bloquer

Nom de la règle :                     Obliguard-Block-1-2-3-4-in
----------------------------------------------------------------------
Description :                         Obliguard blocked IPs
Nom de la règle :                     Bureau à distance - Obliguard-Block-in (TCP-In)
Description :                         voir Obliguard-Block-in-9 pour les détails
Nom de la règle ：                    Obliguard-Block-out-3
`

func TestParseNetshRuleNamesLocales(t *testing.T) {
	en := "Rule Name:                            Obliguard-Block-in\r\n" +
		"----------------------------------------------------------------------\r\n" +
		"Description:                          Obliguard blocked IPs\r\n" +
		"Rule Name:                            Obliguard-Block-out\r\n" +
		"Rule Name:                            Obliguard-Block-in\r\n"
	if got, want := parseNetshRuleNames(en), []string{"Obliguard-Block-in", "Obliguard-Block-out"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("en = %v want %v", got, want)
	}
	got := parseNetshRuleNames(netshShowFR)
	want := []string{"Obliguard-Block-in-1", "Obliguard-Block-1-2-3-4-in", "Obliguard-Block-out-3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("fr = %v want %v", got, want)
	}
	de := "Regelname:                            Obliguard-Block-in-2\n"
	if got := parseNetshRuleNames(de); !reflect.DeepEqual(got, []string{"Obliguard-Block-in-2"}) {
		t.Fatalf("de = %v", got)
	}
}

func TestNetshUpdatesGroupInPlace(t *testing.T) {
	r := &fakeRunner{}
	useFakeRunner(t, r)
	noNetshSleep(t)
	file := filepath.Join(t.TempDir(), "obliguard-banlist.txt")
	fw := &WindowsFirewall{banlistFile: file}
	fw.BanIP("1.2.3.4")
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	r.reset()

	fw.BanIP("5.6.7.0/24")
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	lines := r.lines()
	mustHaveLine(t, lines, "netsh advfirewall firewall set rule name=Obliguard-Block-in dir=in new remoteip=1.2.3.4,5.6.7.0/24 enable=yes")
	mustHaveLine(t, lines, "netsh advfirewall firewall set rule name=Obliguard-Block-out dir=out new remoteip=1.2.3.4,5.6.7.0/24 enable=yes")
	if n := countPrefix(lines, "netsh advfirewall firewall delete rule"); n != 0 {
		t.Fatalf("an existing group must be updated without deleting it:\n%s", strings.Join(lines, "\n"))
	}

	// A group removed out of band: the update fails, the rule is re-created.
	r.reset()
	r.handle = func(c fakeCall) (string, error) {
		if c.args[2] == "set" {
			return "No rules match the specified criteria.", errors.New("exit status 1")
		}
		return "", nil
	}
	fw.UnbanIP("1.2.3.4")
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	lines = r.lines()
	mustHaveLine(t, lines, "netsh advfirewall firewall add rule name=Obliguard-Block-in dir=in action=block remoteip=5.6.7.0/24 enable=yes description=Obliguard blocked IPs")
}

func TestNetshRetryAndUnapplied(t *testing.T) {
	failAdds := 3 // every attempt of the first add fails
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		if strings.HasPrefix(c.line(), "netsh advfirewall firewall add rule name=Obliguard-Block-in ") && failAdds > 0 {
			failAdds--
			return "An error occurred", errors.New("exit status 1")
		}
		return "", nil
	}}
	useFakeRunner(t, r)
	slept := noNetshSleep(t)
	fw := &WindowsFirewall{banlistFile: filepath.Join(t.TempDir(), "obliguard-banlist.txt")}
	fw.BanIP("192.0.2.1")
	if err := fw.Flush(); err == nil {
		t.Fatal("a group that could not be written must fail the Flush")
	}
	if got := countPrefix(r.lines(), "netsh advfirewall firewall add rule name=Obliguard-Block-in "); got != 1+len(netshRetryDelays) {
		t.Fatalf("add attempts = %d want %d", got, 1+len(netshRetryDelays))
	}
	if !reflect.DeepEqual(*slept, netshRetryDelays) {
		t.Fatalf("retry delays = %v", *slept)
	}
	if got, _ := fw.GetBannedIPs(); len(got) != 0 {
		t.Fatalf("an entry whose rule failed must not be reported as enforced: %v", got)
	}

	// The server re-sends the ban: the next Flush retries and succeeds.
	r.reset()
	fw.BanIP("192.0.2.1")
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	mustHaveLine(t, r.lines(), "netsh advfirewall firewall add rule name=Obliguard-Block-in dir=in action=block remoteip=192.0.2.1 enable=yes description=Obliguard blocked IPs")
	if got, _ := fw.GetBannedIPs(); !reflect.DeepEqual(got, []string{"192.0.2.1"}) {
		t.Fatalf("GetBannedIPs = %v", got)
	}

	// A transient failure that recovers on retry.
	r.reset()
	failAdds = 1
	fw2 := &WindowsFirewall{banlistFile: filepath.Join(t.TempDir(), "obliguard-banlist.txt")}
	fw2.BanIP("192.0.2.2")
	if err := fw2.Flush(); err != nil {
		t.Fatalf("a transient failure must be retried: %v", err)
	}
}

func TestNetshRebuildFromBanlistAndStaleGroups(t *testing.T) {
	// The previous run had 3 groups; the banlist now holds 2 entries.
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		if strings.HasPrefix(c.line(), "netsh advfirewall firewall show rule") {
			return "Rule Name:  Obliguard-Block-in-1\nRule Name:  Obliguard-Block-out-1\n" +
				"Rule Name:  Obliguard-Block-in-3\nRule Name:  Obliguard-Block-out-3\n" +
				"Rule Name:  Some-Other-Rule\n", nil
		}
		return "", nil
	}}
	useFakeRunner(t, r)
	noNetshSleep(t)
	file := filepath.Join(t.TempDir(), "obliguard-banlist.txt")
	os.WriteFile(file, []byte("10.0.0.1\r\n\r\ngarbage\r\n10.0.0.0/24\r\n"), 0644)

	fw := &WindowsFirewall{banlistFile: file}
	// No delta at all: the first Flush rebuilds the rules from the file.
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	lines := r.lines()
	mustHaveLine(t, lines, "netsh advfirewall firewall add rule name=Obliguard-Block-in dir=in action=block remoteip=10.0.0.0/24,10.0.0.1 enable=yes description=Obliguard blocked IPs")
	for _, stale := range []string{"Obliguard-Block-in-1", "Obliguard-Block-out-1", "Obliguard-Block-in-3", "Obliguard-Block-out-3"} {
		mustHaveLine(t, lines, "netsh advfirewall firewall delete rule name="+stale)
	}
	if indexOfLine(lines, "netsh advfirewall firewall delete rule name=Some-Other-Rule") >= 0 {
		t.Fatal("a rule that is not Obliguard's must never be deleted")
	}
	// The file was rewritten canonically and atomically (no temp file left).
	data, _ := os.ReadFile(file)
	if string(data) != "10.0.0.0/24\n10.0.0.1\n" {
		t.Fatalf("banlist = %q", data)
	}
	entries, _ := os.ReadDir(filepath.Dir(file))
	if len(entries) != 1 {
		t.Fatalf("leftover files: %v", entries)
	}
}

func TestNetshGroupCountTransitions(t *testing.T) {
	r := &fakeRunner{}
	useFakeRunner(t, r)
	noNetshSleep(t)
	fw := &WindowsFirewall{banlistFile: filepath.Join(t.TempDir(), "obliguard-banlist.txt")}
	for i := 0; i < maxIPsPerRule+1; i++ {
		fw.BanIP(fmt.Sprintf("10.%d.%d.1", i/250, i%250))
	}
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	r.reset()

	// Back to a single group: the numbered groups go, the base names come back.
	fw.UnbanIP("10.0.0.1")
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	lines := r.lines()
	for _, name := range []string{"Obliguard-Block-in-1", "Obliguard-Block-out-1", "Obliguard-Block-in-2", "Obliguard-Block-out-2"} {
		mustHaveLine(t, lines, "netsh advfirewall firewall delete rule name="+name)
	}
	if countPrefix(lines, "netsh advfirewall firewall add rule name=Obliguard-Block-in dir=in") != 1 {
		t.Fatalf("base group not created:\n%s", strings.Join(lines, "\n"))
	}

	// Everything lifted: the groups are deleted, nothing re-created.
	r.reset()
	got, _ := fw.GetBannedIPs()
	for _, ip := range got {
		fw.UnbanIP(ip)
	}
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	lines = r.lines()
	mustHaveLine(t, lines, "netsh advfirewall firewall delete rule name=Obliguard-Block-in")
	mustHaveLine(t, lines, "netsh advfirewall firewall delete rule name=Obliguard-Block-out")
	if countPrefix(lines, "netsh advfirewall firewall add rule") != 0 {
		t.Fatal("no rule may be created for an empty list")
	}
}

func TestNetshStaleWalkWhenListFails(t *testing.T) {
	// The rule list cannot be read: stale numbered groups are deleted by
	// name until 8 consecutive numbers are absent.
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		line := c.line()
		if strings.HasPrefix(line, "netsh advfirewall firewall show rule") {
			return "", errors.New("timeout")
		}
		if strings.HasPrefix(line, "netsh advfirewall firewall delete rule name=Obliguard-Block-in-") ||
			strings.HasPrefix(line, "netsh advfirewall firewall delete rule name=Obliguard-Block-out-") {
			n := line[strings.LastIndex(line, "-")+1:]
			if n == "1" || n == "2" || n == "5" {
				return "", nil
			}
			return "No rules match the specified criteria.", errors.New("exit status 1")
		}
		return "", nil
	}}
	useFakeRunner(t, r)
	noNetshSleep(t)
	fw := &WindowsFirewall{banlistFile: filepath.Join(t.TempDir(), "obliguard-banlist.txt")}
	fw.BanIP("192.0.2.1")
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	lines := r.lines()
	mustHaveLine(t, lines, "netsh advfirewall firewall delete rule name=Obliguard-Block-in-5")
	if n := countPrefix(lines, "netsh advfirewall firewall delete rule name=Obliguard-Block-in-"); n != 13 {
		t.Fatalf("walk length = %d want 13 (1..5, then 8 misses)", n)
	}
}

func TestNetshStaleWalkEmptyListDeletesBaseNames(t *testing.T) {
	// Everything lifted before the first Flush and the rule list unreadable:
	// the single-group base names of the previous run must go as well.
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		if strings.HasPrefix(c.line(), "netsh advfirewall firewall show rule") {
			return "", errors.New("timeout")
		}
		return "", nil
	}}
	useFakeRunner(t, r)
	noNetshSleep(t)
	file := filepath.Join(t.TempDir(), "obliguard-banlist.txt")
	os.WriteFile(file, []byte("192.0.2.1\n"), 0644)
	fw := &WindowsFirewall{banlistFile: file}
	fw.UnbanIP("192.0.2.1")
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	lines := r.lines()
	mustHaveLine(t, lines, "netsh advfirewall firewall delete rule name=Obliguard-Block-in")
	mustHaveLine(t, lines, "netsh advfirewall firewall delete rule name=Obliguard-Block-out")
	if countPrefix(lines, "netsh advfirewall firewall add rule") != 0 {
		t.Fatal("no rule may be created for an empty list")
	}
}

func TestNetshFallbackPurgeOnce(t *testing.T) {
	r := &fakeRunner{}
	useFakeRunner(t, r)
	noNetshSleep(t)
	calls := 0
	old := netshFallbackPurge
	netshFallbackPurge = func() { calls++ }
	t.Cleanup(func() { netshFallbackPurge = old })

	fw := &WindowsFirewall{banlistFile: filepath.Join(t.TempDir(), "obliguard-banlist.txt")}
	fw.BanIP("192.0.2.1")
	fw.Flush()
	fw.BanIP("192.0.2.2")
	fw.Flush()
	if calls != 1 {
		t.Fatalf("WFP purge calls = %d want 1", calls)
	}
}

func TestWriteFileAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "obliguard-banlist.txt")
	if err := writeFileAtomic(path, []byte("a\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, []byte("b\n"), 0644); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "b\n" {
		t.Fatalf("content = %q", data)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temp file left behind: %v", entries)
	}
	if err := writeFileAtomic(filepath.Join(dir, "missing", "x"), []byte("x"), 0644); err == nil {
		t.Fatal("a missing directory must fail")
	}
}
