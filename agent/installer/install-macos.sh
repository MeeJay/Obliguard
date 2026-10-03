#!/bin/bash
# Obliguard Agent Installer for macOS (Intel + Apple Silicon)
#
# Recommended usage (key pre-injected by server):
#   sudo bash -c "$(curl -fsSL 'https://your-server/api/agent/installer/macos?key=<apikey>')"
#
# Manual usage:
#   sudo bash install-macos.sh --url https://your-server --key <apikey>
#
# Self-signed server certificate (not in the system trust store):
#   sudo TLS_INSECURE=1 bash -c "$(curl -fsSLk '...')"   or add --tls-insecure

set -e

SERVER_URL="__SERVER_URL__"
API_KEY="__API_KEY__"
TMP_BINARY="/tmp/obliguard-agent-install"
TLS_INSECURE="${TLS_INSECURE:-0}"

# ── Parse optional override args ──────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --url)   SERVER_URL="$2"; shift 2 ;;
    --url=*) SERVER_URL="${1#*=}"; shift ;;
    --key)   API_KEY="$2"; shift 2 ;;
    --key=*) API_KEY="${1#*=}"; shift ;;
    --tls-insecure) TLS_INSECURE=1; shift ;;
    --tls-insecure=*) TLS_INSECURE="${1#*=}"; shift ;;
    *) shift ;;
  esac
done

# TLS: verify the server certificate (default). TLS_INSECURE=1 (environment)
# or --tls-insecure skips verification on every agent connection, for a
# self-signed certificate absent from the system trust store; it is written to
# config.json as tlsInsecureSkipVerify.
case "$TLS_INSECURE" in
  1|true|yes|on) TLS_INSECURE_JSON=true; TLS_FLAG="--tls-insecure=1"; DL_INSECURE="-k" ;;
  *)             TLS_INSECURE_JSON=false; TLS_FLAG="--tls-insecure=0"; DL_INSECURE="" ;;
esac

if [ -z "$SERVER_URL" ] || [ "$SERVER_URL" = "__SERVER_URL__" ]; then
  echo "Error: Server URL not set."
  echo "Use the URL provided in the Obliguard admin panel, or pass --url <serverUrl>."
  exit 1
fi
if [ -z "$API_KEY" ] || [ "$API_KEY" = "__API_KEY__" ]; then
  echo "Error: API key not set."
  echo "Use the URL provided in the Obliguard admin panel, or pass --key <apiKey>."
  exit 1
fi

# ── Require root ──────────────────────────────────────────────────────────────

if [ "$EUID" -ne 0 ]; then
  echo "Error: This installer requires administrator privileges."
  echo ""
  echo "Please run:"
  echo "  sudo bash -c \"\$(curl -fsSL '${SERVER_URL}/api/agent/installer/macos?key=${API_KEY}')\""
  exit 1
fi

echo "=============================="
echo " Obliguard Agent Installer"
echo " macOS"
echo "=============================="
echo "Server : $SERVER_URL"
if [ "$TLS_INSECURE_JSON" = "true" ]; then
  echo "TLS    : certificate verification DISABLED (TLS_INSECURE=1)"
fi
echo ""

# ── 1. Detect architecture ────────────────────────────────────────────────────

ARCH=$(uname -m)
case "$ARCH" in
  arm64)  BINARY_SUFFIX="darwin-arm64"  ;;   # Apple Silicon (M1/M2/M3/M4)
  x86_64) BINARY_SUFFIX="darwin-amd64"  ;;   # Intel Mac
  *)
    echo "Unsupported architecture: $ARCH (supported: arm64, x86_64)"
    exit 1
    ;;
esac

echo "[1/3] Architecture: $ARCH → obliguard-agent-${BINARY_SUFFIX}"

# ── 2. Download agent binary ──────────────────────────────────────────────────

echo "[2/3] Downloading binary..."
curl -fsSL $DL_INSECURE "${SERVER_URL}/api/agent/download/obliguard-agent-${BINARY_SUFFIX}" \
  -o "$TMP_BINARY"
chmod +x "$TMP_BINARY"

# ── 3. Install (binary writes config, copies itself, registers launchd service)

echo "[3/3] Installing service..."

# The binary's "install" subcommand:
#   - Writes /etc/obliguard-agent/config.json (generates device UUID,
#     tlsInsecureSkipVerify from --tls-insecure=0|1)
#   - Copies itself to /usr/local/bin/obliguard-agent
#   - Configures pf so bans are really blocked: writes /etc/pf.anchors/obliguard
#     (ban table + block rules), appends 'anchor "obliguard"' and
#     'load anchor "obliguard" from "/etc/pf.anchors/obliguard"' to /etc/pf.conf
#     (backup in /etc/pf.conf.obliguard.bak, validated with pfctl -n first),
#     reloads it and enables pf (pfctl -E), plus a launchd job
#     (/Library/LaunchDaemons/com.obliguard.pf.plist) that re-enables pf at boot
#   - Writes /Library/LaunchDaemons/com.obliguard.agent.plist
#   - Runs: launchctl load <plist>
"$TMP_BINARY" --url "$SERVER_URL" --key "$API_KEY" "$TLS_FLAG" install

# Report whether pf enforces bans (the install above prints the details).
if /sbin/pfctl -s info 2>/dev/null | grep -q 'Status: Enabled' && \
   /sbin/pfctl -s rules 2>/dev/null | grep -q 'anchor "obliguard"'; then
  PF_STATE="enforcing (anchor \"obliguard\")"
else
  PF_STATE="NOT enforcing - see the warnings above, then run: sudo obliguard-agent pf-setup"
fi

# Clean up temp binary (the binary already copied itself to /usr/local/bin/)
rm -f "$TMP_BINARY"

echo ""
echo "=============================="
echo " Installation complete!"
echo ""
echo " The agent is now running and"
echo " will appear in the Obliguard"
echo " admin panel once approved."
echo ""
echo " pf : $PF_STATE"
echo ""
echo " To uninstall:"
echo "   sudo obliguard-agent uninstall"
echo "=============================="
