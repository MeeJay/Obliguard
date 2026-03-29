<p align="center">
  <img src="client/public/logo.svg" alt="Obliguard" height="80">
</p>

<h3 align="center">Self-hosted Network Intrusion Prevention System</h3>

<p align="center">
  Automated IP banning, real-time threat visualization, multi-agent firewall enforcement.
  <br>
  Part of the <a href="https://obli.tools"><strong>obli.tools</strong></a> ecosystem.
</p>

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Dashboard" width="100%">
</p>

---

Obliguard detects brute-force attacks across SSH, RDP, Nginx, Apache, IIS, FTP, Mail, and MySQL — then blocks attackers at the firewall level on every agent simultaneously.

## Features at a Glance

- **Automated ban engine** — detects brute-force patterns across all agents, auto-bans attackers globally
- **8 service parsers** — SSH, RDP, Nginx, Apache, IIS, FTP, Mail, MySQL with auto-detected log paths
- **Real-time NetMap** — canvas visualization of agents, attacking IPs, peer links, and live event sparks
- **Multi-platform firewall** — enforces bans via nftables, firewalld, ufw, iptables, Windows netsh, macOS pf
- **IP reputation tracking** — failure counts, affected agents, targeted services, attempted usernames, GeoIP
- **Whitelist system** — CIDR-aware, hierarchical (global/tenant/group/agent), respects exclusions before banning
- **Service templates** — customizable regex, thresholds, time windows, ban or track mode per service
- **10 notification channels** — Telegram, Discord, Slack, Teams, SMTP, Webhook, Gotify, Ntfy, Pushover, Free Mobile
- **Multi-tenant workspaces** — isolated tenants with per-workspace roles
- **Teams & RBAC** — read-only / read-write per group
- **2FA** — TOTP authenticator apps + Email OTP
- **Import / Export** — full config backup as JSON with conflict resolution
- **18 UI languages**
- **Real-time** — Socket.io live updates, live alert toasts, real-time event streaming
- **Desktop tray app** — Windows & macOS, multi-tenant tab bar, auto-update

---

## Screenshots

<table>
  <tr>
    <td><img src="docs/screenshots/netmap.png" alt="Network Map"><br><sub><b>Network Map</b> — Real-time threat visualization</sub></td>
    <td><img src="docs/screenshots/ip-reputation.png" alt="IP Reputation"><br><sub><b>IP Reputation</b> — Per-IP intelligence & GeoIP</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/agent-detail.png" alt="Agent Detail"><br><sub><b>Agent Detail</b> — Events, services, firewall state</sub></td>
    <td><img src="docs/screenshots/service-templates.png" alt="Service Templates"><br><sub><b>Service Templates</b> — Detection rules per service</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/agents.png" alt="Agents"><br><sub><b>Agents</b> — Device management & approval</sub></td>
    <td><img src="docs/screenshots/dashboard.png" alt="Dashboard"><br><sub><b>Dashboard</b> — Active bans, agents, events</sub></td>
  </tr>
</table>

---

## How It Works

1. **Agents** run on your servers and tail service logs (SSH auth.log, Nginx error.log, etc.)
2. Auth failure events are pushed to the Obliguard server in real-time via WebSocket
3. The **Ban Engine** evaluates thresholds every 30 seconds — if an IP exceeds the configured failure count within the time window, it's auto-banned
4. The ban is **distributed to all agents** on their next push — each agent enforces it at the local firewall
5. The **NetMap** visualizes the entire network in real-time: agents, attacking IPs, peer links, and live event particles

---

## Ban Engine

The core of Obliguard. Runs a 30-second evaluation cycle:

- Resolves active service templates per agent (opt-in model)
- Counts `auth_failure` events within configured time windows
- Auto-creates global IP bans when thresholds are exceeded
- Checks whitelist before banning
- Fires attack notifications to affected agents

**Ban scoping:**

| Scope | Effect |
|-------|--------|
| **Global** | All tenants, all agents enforce |
| **Tenant** | Single workspace only |
| **Group** | All agents in the group |
| **Agent** | Single device |

- **Auto bans** (engine-created) vs. **manual bans** (admin action)
- Optional TTL with auto-deactivation on expiry
- Tenant exemptions: exclude from a global ban without revoking it globally

---

## Service Detection & Log Parsing

Agents auto-detect listening services by scanning ports, then tail the corresponding log files.

| Service | Default Log Paths |
|---------|-------------------|
| **SSH** | `/var/log/auth.log`, `/var/log/secure`, `journald:sshd.service` |
| **RDP** | Windows Security Event Log (EventID 4625/4624) |
| **Nginx** | `/var/log/nginx/error.log` |
| **Apache** | `/var/log/apache2/error.log`, `/var/log/httpd/error_log` |
| **IIS** | `C:\inetpub\logs\LogFiles\` |
| **FTP** | `/var/log/vsftpd.log`, `/var/log/proftpd/proftpd.log` |
| **Mail** | `/var/log/mail.log`, `/var/log/maillog` |
| **MySQL** | `/var/log/mysql/error.log` |

- Regex extraction with named groups (`?P<ip>`, `?P<username>`)
- Custom regex overrides per service template
- On-demand log sampling for debugging

---

## Service Templates

Define detection rules per service type, then assign them at any level of the hierarchy.

| Field | Description |
|-------|-------------|
| **Threshold** | Number of failures before triggering (e.g., 5) |
| **Window** | Time window in seconds (e.g., 300 = 5 minutes) |
| **Mode** | `ban` (auto-create IP ban) or `track` (log only) |
| **Custom regex** | Override the built-in log parser |
| **Log path** | Override auto-detected path per agent |

**Resolution priority:** Agent-level > Group-level > Template default.

---

## IP Reputation

Tracks every IP that touches your infrastructure:

- Total failure/success counts
- Number of affected agents and services
- Attempted usernames (deduped)
- GeoIP: country, city, ASN
- Status: `clean` | `suspicious` | `whitelisted` | `banned`
- Lookup integrations: AbuseIPDB, Shodan, VirusTotal, WHOIS, MXToolbox

---

## Whitelist

- CIDR notation support (e.g., `10.0.0.0/8`, `192.168.1.0/24`)
- Same hierarchical scoping as bans (global / tenant / group / agent)
- Pre-ban check: whitelisted IPs are never auto-banned, even if threshold is met
- Per-tenant overrides: whitelist a globally-banned IP at tenant level

---

## NetMap (Real-Time Threat Visualization)

A full-screen canvas rendering your network security posture in real-time:

- **Agents** at the center, force-repelled to avoid overlap
- **IP nodes** in arcs around each agent, sorted by activity
- **Color coding:** red (banned), orange (suspicious), yellow (whitelisted), gray (clean)
- **Peer links:** directed edges when an IP matches another agent's LAN IP (compromised peer detection)
- **Live particles:** event sparks on auth_success / auth_failure
- **Ripples:** expanding shock waves on auto-ban events
- **Country flags** from GeoIP data
- **Interactive:** drag agents, hover for stats, click for IP details

---

## Native Agent

A lightweight Go binary that runs on monitored hosts. No inbound ports required — agents push to the server via persistent WebSocket.

**Capabilities:**
- Auto-detect listening services (port scan)
- Tail service logs and parse auth events in real-time
- Enforce firewall bans locally (add/remove rules)
- Report current firewall state for delta sync
- Report LAN IPs for peer-link detection on the NetMap

**Firewall backends (auto-detected):**

| Platform | Backend |
|----------|---------|
| **Linux** | nftables > firewalld > ufw > iptables (priority order) |
| **Windows** | Windows Defender Firewall (`netsh`) |
| **macOS** | BSD `pf` |

**Installation:**
- Windows: MSI installer (WiX v4)
- Linux / macOS: native binary, systemd / launchctl service
- Auto-update: agent downloads and reinstalls silently when a new version is available
- Auto-uninstall command via server

**Device management:**
- Approval workflow (auto or manual)
- Suspend / resume without deletion
- Bulk approve, suspend, or uninstall
- Auto-delete 10 minutes after uninstall command

---

## Notification Channels

Bind channels at **global**, **group**, or **agent** level with **merge**, **replace**, or **exclude** inheritance modes.

| Channel | Notes |
|---------|-------|
| **Telegram** | Bot token + chat ID |
| **Discord** | Webhook URL |
| **Slack** | Incoming webhook |
| **Microsoft Teams** | Webhook URL |
| **Email (SMTP)** | Custom SMTP server or platform SMTP |
| **Webhook** | Generic HTTP — GET / POST / PUT / PATCH, custom headers |
| **Gotify** | Self-hosted push (server URL + token) |
| **Ntfy** | Self-hosted or ntfy.sh push |
| **Pushover** | Mobile push via Pushover app |
| **Free Mobile** | SMS via French mobile operator API |

Test messages can be sent directly from the UI to validate channel configuration.

---

## Multi-Tenant Workspaces

Create isolated workspaces within a single Obliguard instance.

- Each workspace has its own agents, groups, bans, whitelist, service templates, notification channels, and settings
- Users can belong to multiple workspaces with independent **admin** or **member** roles
- Platform admins have cross-workspace visibility
- Workspace switching from the UI without re-login

---

## Teams & RBAC

- Create **teams** per workspace
- Assign users to teams
- Grant teams **read-only** or **read-write** access per group
- Access cascades through the group hierarchy
- `canCreate` flag per team: allows non-admins to create groups
- Platform admins always have full access

---

## Hierarchical Groups

Organize agents into nested groups with unlimited depth using a **closure table**.

- Settings cascade: configure once at a parent group, override where needed
- Notification channels cascade with merge / replace / exclude modes
- Service template overrides per group (thresholds, log paths, enabled state)
- **General groups** are visible to all users regardless of team permissions

---

## Settings Inheritance

| Level | Scope |
|-------|-------|
| Global | Applies to everything in the workspace |
| Group | Applies to the group and all subgroups |
| Agent | Device-specific override |

Settings include: push interval, max missed pushes (offline grace), service template overrides, notification channels.

---

## Two-Factor Authentication

- **TOTP** — any authenticator app (Google Authenticator, Authy, 1Password, etc.)
- **Email OTP** — one-time code sent via SMTP
- Optional system-wide enforcement (all users must enroll 2FA)

---

## Import / Export

Full configuration backup and restore as JSON.

**Exportable sections:** groups, settings, notification channels, agent configurations, teams, service templates, bans, whitelist.

**Conflict resolution strategies:**
- **Update** — overwrite the existing record
- **Generate new** — create a duplicate with a fresh UUID
- **Skip** — leave the existing record untouched

---

## Live Alerts

Real-time notifications delivered via Socket.io.

- Floating toast notifications (bottom-right, auto-dismiss)
- Top-center banner for the latest alert
- Click to navigate to the affected agent
- Per-workspace filtering
- Desktop app: unread badge per workspace tab, optional auto-switch to alerting workspace

---

## Desktop App

A lightweight system tray application (Go) for quick access without keeping a browser tab open.

- **Windows** (MSI installer) and **macOS** (DMG)
- Per-workspace tab bar
- Unread alert badge per tab
- **Auto-cycle mode** — rotate through workspaces every N seconds
- **Follow alerts mode** — auto-switch to the workspace with the latest alert
- Auto-update with in-tray prompt

---

## Deployment

### Docker Compose (built-in PostgreSQL)

```bash
docker compose up -d
```

### Docker Compose (external PostgreSQL)

```bash
docker compose -f docker-compose.external-db.yml up -d
```

Set `DATABASE_URL` in your `.env` to point at your existing PostgreSQL instance.

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://obliguard:changeme@localhost:5432/obliguard` |
| `SESSION_SECRET` | Session signing secret | — |
| `PORT` | Server port | `3001` |
| `NODE_ENV` | `production` or `development` | `production` |
| `CLIENT_ORIGIN` | CORS origin for the client | `http://localhost` |
| `APP_NAME` | Prefix for notification messages | `Obliguard` |
| `DEFAULT_ADMIN_USERNAME` | Admin account created on first run | `admin` |
| `DEFAULT_ADMIN_PASSWORD` | Admin password on first run | `admin123` |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Server** | Node.js 24 LTS, TypeScript, Express |
| **Database** | PostgreSQL 16, Knex (migrations + query builder) |
| **Real-time** | Socket.io + native WebSocket (agent channel) |
| **Client** | React 18, Vite, Tailwind CSS, Zustand |
| **Agent** | Go (cross-platform binary) |
| **Desktop app** | Go (systray) |
| **Monorepo** | npm workspaces (`shared/`, `server/`, `client/`) |

---

> **An experiment with Claude Code**
>
> This project was built as an experiment to see how far Claude Code could be pushed as a development tool. Claude was used as a coding assistant throughout the entire development process.

<p align="center">
  <a href="https://obli.tools">obli.tools</a>
</p>
