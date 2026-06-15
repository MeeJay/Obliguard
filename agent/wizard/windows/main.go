// Obliguard Agent — Install Wizard (Windows)
//
// A standalone .exe distributed alongside the MSI for "offline" / hostile
// Windows boxes that can't (or shouldn't) pull files via Invoke-WebRequest /
// BitsTransfer. The MSI is embedded directly into this binary via //go:embed,
// so a single file copy + double-click is enough to trigger an interactive
// enrolment — no internet needed on the target to GET the installer.
//
// Flow:
//  1. Wizard starts, reads its own .exe tail for an optional pre-baked config
//     (server URL + API key the admin picked at download time). The server's
//     /api/agent/installer/wizard.exe?keyId=N endpoint appends that blob.
//     Empty tail → fields stay blank for manual entry.
//  2. Operator validates / fills the two fields, clicks Install.
//  3. The embedded MSI is dumped to %TEMP%\obliguard-agent.msi and msiexec is
//     invoked with SERVERURL=... APIKEY=.... msiexec handles the UAC prompt
//     itself, so the wizard stays at asInvoker rights.
//
// GUI: github.com/lxn/walk (pure win32 bindings). walk REQUIRES an embedded
// manifest declaring Common Controls v6 — the build script runs
//   rsrc -manifest obliguard-installer-wizard.exe.manifest -o rsrc_windows.syso
// before `go build` so the linker picks it up. Without it the runtime crashes
// on the first widget with "TTM_ADDTOOL failed".

//go:build windows

package main

import (
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative" //nolint:revive // declarative DSL is the canonical walk pattern
)

// Embedded MSI — copied next to this file by build-wizard.bat before `go build`,
// then removed afterwards. Without that copy this directive fails at compile
// time with "no matching files found" — that's intentional.
//
//go:embed obliguard-agent.msi
var msiData []byte

// version is injected at link-time via -ldflags="-X main.version=...".
var version = "dev"

var (
	colorBrand     = walk.RGB(0x25, 0x63, 0xeb)
	colorText      = walk.RGB(0x1a, 0x1a, 0x1a)
	colorTextMuted = walk.RGB(0x66, 0x66, 0x66)
	colorBg        = walk.RGB(0xff, 0xff, 0xff)
	colorBgHeader  = walk.RGB(0xfa, 0xfa, 0xfa)
)

func main() {
	cfg := readEmbeddedConfig()

	var mw *walk.MainWindow
	var serverEdit, keyEdit *walk.LineEdit
	var logEdit *walk.TextEdit
	var installBtn *walk.PushButton

	err := MainWindow{
		AssignTo:   &mw,
		Title:      "Obliguard Agent — Install Wizard",
		MinSize:    Size{Width: 600, Height: 470},
		Size:       Size{Width: 600, Height: 470},
		Background: SolidColorBrush{Color: colorBg},
		Layout:     VBox{MarginsZero: true, SpacingZero: true},
		Children: []Widget{
			// Header — brand on the left, title + version on the right.
			Composite{
				Background: SolidColorBrush{Color: colorBgHeader},
				Layout:     HBox{Margins: Margins{Left: 22, Top: 14, Right: 22, Bottom: 14}, Spacing: 14},
				Children: []Widget{
					Label{
						Text:      "Obliguard",
						TextColor: colorBrand,
						Font:      Font{Family: "Segoe UI", PointSize: 18, Bold: true},
					},
					HSpacer{},
					Composite{
						Layout: VBox{MarginsZero: true, Spacing: 2},
						Children: []Widget{
							VSpacer{},
							Label{Text: "Install Wizard", TextColor: colorText, Font: Font{Family: "Segoe UI", PointSize: 10, Bold: true}},
							Label{Text: "v" + version, TextColor: colorTextMuted, Font: Font{Family: "Segoe UI", PointSize: 8}},
							VSpacer{},
						},
					},
				},
			},
			// Brand rule under the header.
			Composite{
				Background: SolidColorBrush{Color: colorBrand},
				MinSize:    Size{Height: 2},
				MaxSize:    Size{Height: 2},
				Layout:     HBox{MarginsZero: true},
			},
			// Body — form + log.
			Composite{
				Background: SolidColorBrush{Color: colorBg},
				Layout:     VBox{Margins: Margins{Left: 22, Top: 18, Right: 22, Bottom: 18}, Spacing: 6},
				Children: []Widget{
					Label{Text: "Server URL", TextColor: colorText, Font: Font{Family: "Segoe UI", PointSize: 9, Bold: true}},
					LineEdit{AssignTo: &serverEdit, Text: cfg.ServerURL, CueBanner: "https://obliguard.example.com"},
					VSpacer{Size: 6},
					Label{Text: "API Key", TextColor: colorText, Font: Font{Family: "Segoe UI", PointSize: 9, Bold: true}},
					LineEdit{AssignTo: &keyEdit, Text: cfg.APIKey, CueBanner: "your-api-key"},
					VSpacer{Size: 12},
					Composite{
						Layout: HBox{MarginsZero: true, Spacing: 8},
						Children: []Widget{
							HSpacer{},
							PushButton{
								AssignTo: &installBtn,
								Text:     "Install Agent",
								MinSize:  Size{Width: 170, Height: 34},
								OnClicked: func() {
									serverURL := strings.TrimSpace(serverEdit.Text())
									apiKey := strings.TrimSpace(keyEdit.Text())
									if serverURL == "" || apiKey == "" {
										walk.MsgBox(mw, "Missing fields", "Server URL and API Key are required.", walk.MsgBoxIconExclamation)
										return
									}
									installBtn.SetEnabled(false)
									_ = logEdit.SetText("")
									go func() {
										err := runInstall(serverURL, apiKey, logEdit, mw)
										mw.Synchronize(func() {
											installBtn.SetEnabled(true)
											if err != nil {
												walk.MsgBox(mw, "Install failed", err.Error(), walk.MsgBoxIconError)
											} else {
												walk.MsgBox(mw, "Done",
													"The Obliguard agent has been installed.\nIt will appear in the admin panel after a few seconds.",
													walk.MsgBoxIconInformation)
											}
										})
									}()
								},
							},
						},
					},
					VSpacer{Size: 12},
					Label{Text: "Install log", TextColor: colorTextMuted, Font: Font{Family: "Segoe UI", PointSize: 8}},
					TextEdit{AssignTo: &logEdit, ReadOnly: true, VScroll: true, MinSize: Size{Height: 130}},
				},
			},
		},
	}.Create()
	if err != nil {
		walk.MsgBox(nil, "Startup error", err.Error(), walk.MsgBoxIconError)
		os.Exit(1)
	}
	mw.Run()
}

// runInstall extracts the embedded MSI to %TEMP% and launches msiexec.exe with
// the URL/key on the command line. msiexec triggers the UAC prompt itself, so
// the wizard only needs asInvoker rights.
func runInstall(serverURL, apiKey string, logEdit *walk.TextEdit, mw *walk.MainWindow) error {
	appendLog := func(s string) { mw.Synchronize(func() { logEdit.AppendText(s + "\r\n") }) }

	msiPath := filepath.Join(os.TempDir(), "obliguard-agent.msi")
	appendLog(fmt.Sprintf("Extracting MSI to %s (%d bytes)…", msiPath, len(msiData)))
	if err := os.WriteFile(msiPath, msiData, 0o644); err != nil {
		return fmt.Errorf("write MSI: %w", err)
	}

	appendLog("Launching msiexec.exe…")
	cmd := exec.Command("msiexec.exe",
		"/i", msiPath,
		fmt.Sprintf("SERVERURL=%s", serverURL),
		fmt.Sprintf("APIKEY=%s", apiKey),
		"/qb",
	)
	out, err := cmd.CombinedOutput()
	if len(out) > 0 {
		appendLog(strings.TrimRight(string(out), "\r\n"))
	}
	if err != nil {
		return fmt.Errorf("msiexec returned an error: %w", err)
	}
	appendLog("Install completed successfully.")
	return nil
}

// ── Embedded config (auto-fill from the download URL) ────────────────────────
//
// The server's wizard.exe endpoint appends a small JSON blob to the end of the
// binary, fenced by a magic + a 4-byte little-endian length:
//
//	[binary bytes ...][json bytes][magic 8B = "OBLI_CFG"][len uint32 LE]
//
// If the magic is absent the wizard starts with empty fields.

const cfgMagic = "OBLI_CFG"
const cfgMaxBytes = 1 << 20

type embeddedConfig struct {
	ServerURL string `json:"serverUrl"`
	APIKey    string `json:"apiKey"`
}

func readEmbeddedConfig() embeddedConfig {
	var empty embeddedConfig
	exe, err := os.Executable()
	if err != nil {
		return empty
	}
	f, err := os.Open(exe)
	if err != nil {
		return empty
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return empty
	}
	size := stat.Size()
	if size < int64(len(cfgMagic)+4) {
		return empty
	}
	tail := make([]byte, len(cfgMagic)+4)
	if _, err := f.ReadAt(tail, size-int64(len(tail))); err != nil {
		return empty
	}
	if string(tail[:len(cfgMagic)]) != cfgMagic {
		return empty
	}
	cfgLen := int64(binary.LittleEndian.Uint32(tail[len(cfgMagic):]))
	if cfgLen <= 0 || cfgLen > cfgMaxBytes {
		return empty
	}
	cfgStart := size - int64(len(tail)) - cfgLen
	if cfgStart < 0 {
		return empty
	}
	buf := make([]byte, cfgLen)
	if _, err := f.ReadAt(buf, cfgStart); err != nil {
		return empty
	}
	var c embeddedConfig
	if err := json.Unmarshal(buf, &c); err != nil {
		return empty
	}
	return c
}
