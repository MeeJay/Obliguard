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
	default:
		return ""
	}
}

func defaultLogPathLinux(serviceType string) string {
	switch serviceType {
	case "ssh":
		// Ubuntu/Debian use auth.log, RHEL/CentOS use secure
		return firstExisting("/var/log/auth.log", "/var/log/secure")
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
