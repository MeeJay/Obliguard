package main

import (
	"os"
	"runtime"
)

// defaultLogPath returns the default log file path for a known service type
// on the current OS. Returns "" if not applicable / unknown.
func defaultLogPath(serviceType string) string {
	switch runtime.GOOS {
	case "linux":
		return defaultLogPathLinux(serviceType)
	case "darwin":
		return defaultLogPathDarwin(serviceType)
	case "windows":
		return defaultLogPathWindows(serviceType)
	case "freebsd":
		return defaultLogPathFreeBSD(serviceType)
	default:
		return ""
	}
}

func defaultLogPathLinux(serviceType string) string {
	switch serviceType {
	case "ssh":
		// Prefer file-based logs (systems with rsyslog installed).
		for _, p := range []string{"/var/log/auth.log", "/var/log/secure"} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
		// Pure journald system (Debian 9+, Ubuntu 20.04+ without rsyslog, etc.).
		// Detect which SSH service unit name systemd uses on this distro.
		for _, p := range []string{
			"/lib/systemd/system/ssh.service",
			"/usr/lib/systemd/system/ssh.service",
		} {
			if _, err := os.Stat(p); err == nil {
				return "journald:ssh.service" // Debian / Ubuntu
			}
		}
		return "journald:sshd.service" // RHEL / CentOS / Arch
	case "nginx":
		return firstExisting("/var/log/nginx/error.log", "/var/log/nginx/access.log")
	case "apache":
		return firstExisting(
			"/var/log/apache2/error.log",
			"/var/log/apache2/access.log",
			"/var/log/httpd/error_log",
		)
	case "ftp":
		return firstExisting("/var/log/vsftpd.log", "/var/log/pure-ftpd/pure-ftpd.log")
	case "mail":
		return firstExisting("/var/log/mail.log", "/var/log/maillog")
	case "mysql":
		return firstExisting("/var/log/mysql/error.log", "/var/log/mysqld.log")
	default:
		return ""
	}
}

func defaultLogPathDarwin(serviceType string) string {
	switch serviceType {
	case "ssh":
		return "/var/log/system.log"
	case "nginx":
		return firstExisting("/usr/local/var/log/nginx/error.log", "/opt/homebrew/var/log/nginx/error.log")
	case "apache":
		return firstExisting("/private/var/log/apache2/error_log", "/usr/local/var/log/apache2/error_log")
	case "mysql":
		return firstExisting(
			"/usr/local/var/mysql/error.log",
			"/opt/homebrew/var/mysql/error.log",
		)
	default:
		return ""
	}
}

func defaultLogPathWindows(serviceType string) string {
	// On Windows, SSH/RDP use Event Log (parsed via wevtutil or Win32 API)
	// For now, return empty — Windows-specific log reading is handled separately
	// via the Windows Event Log reader goroutine.
	switch serviceType {
	case "iis":
		return `C:\inetpub\logs\LogFiles\W3SVC1\u_ex*.log`
	case "mysql":
		return `C:\ProgramData\MySQL\MySQL Server 8.0\Data\*.err`
	default:
		return ""
	}
}

func defaultLogPathFreeBSD(serviceType string) string {
	switch serviceType {
	case "ssh":
		return firstExistingFreeBSD(
			// OPNsense 22.x+ (syslog-ng): SSH goes to audit via facility(auth)
			"/var/log/audit/latest.log",
			// OPNsense <22.1 (clog circular log)
			"/var/log/auth.log",
			// Plain FreeBSD
			"/var/log/auth.log",
			"/var/log/security",
		)
	case "nginx":
		return firstExisting("/var/log/nginx/error.log", "/usr/local/var/log/nginx/error.log")
	case "apache":
		return firstExisting(
			"/var/log/httpd-error.log",
			"/usr/local/var/log/apache24/error.log",
		)
	case "ftp":
		return firstExisting("/var/log/xferlog", "/var/log/vsftpd.log")
	case "mail":
		return firstExistingFreeBSD(
			"/var/log/mail/latest.log",
			"/var/log/maillog",
			"/var/log/mail.log",
		)
	case "mysql":
		return firstExisting("/var/db/mysql/error.log", "/var/log/mysql/error.log")
	case "opnsense":
		// OPNsense web UI + SSH auth events (all in audit via facility(auth)):
		//   22.x–25.x+: /var/log/audit/latest.log (syslog-ng, plain text)
		//   <22.1:       /var/log/system.log (clog)
		// Log lines matched: "Web GUI authentication error", "Authentication error for"
		return firstExistingFreeBSD(
			"/var/log/audit/latest.log",
			"/var/log/system.log",
		)
	case "opnsense_filter":
		// OPNsense pf filterlog — blocked connections and NAT pass-throughs:
		//   22.x–25.x+: /var/log/filter/latest.log (syslog-ng, plain text)
		//   <22.1:       /var/log/filter.log (clog)
		return firstExistingFreeBSD(
			"/var/log/filter/latest.log",
			"/var/log/filter.log",
		)
	default:
		return ""
	}
}

// firstExistingFreeBSD returns the first path that exists. If a path is a
// clog circular log (OPNsense <22.1), it is returned with the "clog:" prefix
// so the logwatcher uses `clog -f` instead of plain file tailing.
func firstExistingFreeBSD(paths ...string) string {
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			if isClogFile(p) {
				return "clog:" + p
			}
			return p
		}
	}
	if len(paths) > 0 {
		return paths[0]
	}
	return ""
}

// isClogFile returns true if the file appears to be a BSD clog (circular log).
// clog files start with a specific magic header (0x49ee) and cannot be read
// as plain text — they require the `clog` utility.
func isClogFile(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	magic := make([]byte, 2)
	if _, err := f.Read(magic); err != nil {
		return false
	}
	return magic[0] == 0x49 && magic[1] == 0xEE
}

func firstExisting(paths ...string) string {
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	// Return first as default even if not found yet
	if len(paths) > 0 {
		return paths[0]
	}
	return ""
}
