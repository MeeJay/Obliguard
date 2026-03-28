package main

import (
	"os/exec"
	"runtime"
	"strings"
)

// OSInfo is sent with every push so the server can display OS details.
type OSInfo struct {
	Platform string  `json:"platform"`
	Distro   *string `json:"distro"`
	Release  *string `json:"release"`
	Arch     string  `json:"arch"`
}

func getOSInfo() OSInfo {
	info := OSInfo{
		Platform: runtime.GOOS,
		Arch:     runtime.GOARCH,
	}

	switch runtime.GOOS {
	case "linux":
		distro, release := linuxOSInfo()
		info.Distro = &distro
		info.Release = &release
	case "darwin":
		rel := darwinRelease()
		d := "macOS"
		info.Distro = &d
		info.Release = &rel
	case "windows":
		rel := windowsRelease()
		d := "Windows"
		info.Distro = &d
		info.Release = &rel
	case "freebsd":
		distro, release := freebsdOSInfo()
		info.Distro = &distro
		info.Release = &release
	}

	return info
}

func linuxOSInfo() (distro, release string) {
	out, err := exec.Command("cat", "/etc/os-release").Output()
	if err != nil {
		return "Linux", ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			distro = strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
		}
		if strings.HasPrefix(line, "VERSION_ID=") {
			release = strings.Trim(strings.TrimPrefix(line, "VERSION_ID="), `"`)
		}
	}
	if distro == "" {
		distro = "Linux"
	}
	return
}

func darwinRelease() string {
	out, err := exec.Command("sw_vers", "-productVersion").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func freebsdOSInfo() (distro, release string) {
	distro = "FreeBSD"
	out, err := exec.Command("freebsd-version").Output()
	if err != nil {
		out, err = exec.Command("uname", "-r").Output()
	}
	if err == nil {
		release = strings.TrimSpace(string(out))
	}
	return
}

func windowsRelease() string {
	out, err := exec.Command("cmd", "/c", "ver").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
