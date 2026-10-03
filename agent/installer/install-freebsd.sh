#!/bin/sh
# Obliguard Agent Installer for FreeBSD / OPNsense
# Usage: curl -fsSL "https://your-server/api/agent/installer/freebsd?key=<apikey>" | sh
# Or:    sh install-freebsd.sh --url https://your-server --key <apikey>
# Self-signed server certificate: download with fetch --no-verify-peer (or
# curl -k), then TLS_INSECURE=1 sh ...  or: sh install-freebsd.sh ... --tls-insecure

set -e

SERVER_URL="__SERVER_URL__"
API_KEY="__API_KEY__"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/obliguard-agent"
BINARY_NAME="obliguard-agent"
SERVICE_NAME="obliguard_agent"
RC_SCRIPT="/usr/local/etc/rc.d/${SERVICE_NAME}"
LOG_FILE="/var/log/obliguard-agent.log"
PF_TABLE="obliguard_blocklist"
PF_ANCHOR="obliguard"
TLS_INSECURE="${TLS_INSECURE:-0}"

# Parse args (override injected values)
for i in "$@"; do
  case $i in
    --url=*) SERVER_URL="${i#*=}" ;;
    --key=*) API_KEY="${i#*=}" ;;
    --url) SERVER_URL="$2"; shift ;;
    --key) API_KEY="$2"; shift ;;
    --tls-insecure) TLS_INSECURE=1 ;;
    --tls-insecure=*) TLS_INSECURE="${i#*=}" ;;
  esac
done

# TLS: verify the server certificate (default). TLS_INSECURE=1 (environment)
# or --tls-insecure skips verification on every agent connection, for a
# self-signed certificate absent from the system trust store; it is written to
# config.json as tlsInsecureSkipVerify.
case "$TLS_INSECURE" in
  1|true|yes|on) TLS_INSECURE_JSON=true; DL_INSECURE="-k"; FETCH_INSECURE="--no-verify-peer --no-verify-hostname" ;;
  *)             TLS_INSECURE_JSON=false; DL_INSECURE=""; FETCH_INSECURE="" ;;
esac

if [ -z "$SERVER_URL" ] || [ "$SERVER_URL" = "__SERVER_URL__" ]; then
  echo "Error: --url is required"; exit 1
fi
if [ -z "$API_KEY" ] || [ "$API_KEY" = "__API_KEY__" ]; then
  echo "Error: --key is required"; exit 1
fi

echo "=============================="
echo " Obliguard Agent Installer"
echo " FreeBSD / OPNsense"
echo "=============================="
echo "Server URL : $SERVER_URL"
if [ "$TLS_INSECURE_JSON" = "true" ]; then
  echo "TLS        : certificate verification DISABLED (TLS_INSECURE=1)"
fi
echo ""

# ── 1. Detect architecture ──────────────────────────────────────────────────

ARCH=$(uname -m)
case "$ARCH" in
  amd64|x86_64) BINARY_SUFFIX="freebsd-amd64" ;;
  *)
    echo "Unsupported architecture: $ARCH (supported: amd64)"
    exit 1
    ;;
esac

echo "[1/6] Architecture: $ARCH"

# ── 2. Download binary ──────────────────────────────────────────────────────

echo "[2/6] Downloading agent binary..."
fetch -q $FETCH_INSECURE -o "${INSTALL_DIR}/${BINARY_NAME}" \
  "${SERVER_URL}/api/agent/download/obliguard-agent-${BINARY_SUFFIX}" 2>/dev/null || \
  curl -fsSL $DL_INSECURE "${SERVER_URL}/api/agent/download/obliguard-agent-${BINARY_SUFFIX}" \
    -o "${INSTALL_DIR}/${BINARY_NAME}"
chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

# ── 3. Write config ─────────────────────────────────────────────────────────

echo "[3/6] Writing configuration..."
mkdir -p "$CONFIG_DIR"

DEVICE_UUID=$(sysctl -n kern.hostuuid 2>/dev/null || \
              python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || \
              cat /dev/urandom | tr -dc 'a-f0-9' | head -c 32 | \
              sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\)/\1-\2-\3-\4-\5/')

cat > "$CONFIG_DIR/config.json" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "apiKey": "$API_KEY",
  "deviceUuid": "$DEVICE_UUID",
  "checkIntervalSeconds": 60,
  "agentVersion": "1.0.0",
  "tlsInsecureSkipVerify": $TLS_INSECURE_JSON
}
EOF
chmod 600 "$CONFIG_DIR/config.json"

# ── 4. Install rc.d service ─────────────────────────────────────────────────

echo "[4/6] Installing rc.d service..."

cat > "$RC_SCRIPT" <<'RCEOF'
#!/bin/sh

# PROVIDE: obliguard_agent
# REQUIRE: NETWORKING
# KEYWORD: shutdown

. /etc/rc.subr

name="obliguard_agent"
rcvar="obliguard_agent_enable"

pidfile="/var/run/${name}.pid"

start_cmd="${name}_start"
stop_cmd="${name}_stop"
status_cmd="${name}_status"

obliguard_agent_start()
{
    echo "Starting ${name}."
    /usr/sbin/daemon -p ${pidfile} -o /var/log/obliguard-agent.log /usr/local/bin/obliguard-agent
}

obliguard_agent_stop()
{
    if [ -f ${pidfile} ]; then
        echo "Stopping ${name}."
        kill $(cat ${pidfile}) 2>/dev/null
        rm -f ${pidfile}
    else
        echo "${name} is not running."
    fi
}

obliguard_agent_status()
{
    if [ -f ${pidfile} ] && kill -0 $(cat ${pidfile}) 2>/dev/null; then
        echo "${name} is running as pid $(cat ${pidfile})."
    else
        echo "${name} is not running."
        return 1
    fi
}

load_rc_config $name
: ${obliguard_agent_enable:="NO"}
run_rc_command "$1"
RCEOF

chmod +x "$RC_SCRIPT"
sysrc obliguard_agent_enable=YES

# ── 5. Configure pf firewall ────────────────────────────────────────────────

echo "[5/6] Configuring pf firewall rules..."

IS_OPNSENSE=0
if [ -f /usr/local/opnsense/version/core ]; then
  IS_OPNSENSE=1
fi

# Bans go to the table <${PF_TABLE}> of the pf anchor "${PF_ANCHOR}". The agent
# binary installs what makes the main ruleset evaluate that anchor:
#   - plain FreeBSD: /etc/pf.anchors/obliguard plus 'anchor "obliguard"' and
#     'load anchor' lines appended to pf.conf (backup first, validated with
#     pfctl -n), replacing the main-ruleset table rules of older installs;
#   - OPNsense (pf.conf is generated): plugin hook
#     /usr/local/etc/inc/plugins.inc.d/obliguard.inc registering the anchor at
#     the head of the filter rules, then 'configctl filter reload'.
# The agent re-checks this at every start and logs a warning while bans are
# not enforced.
if [ "$IS_OPNSENSE" = "1" ]; then
  echo "  OPNsense detected — installing the pf anchor plugin hook..."
else
  echo "  Adding the pf anchor to pf.conf..."
fi
if "${INSTALL_DIR}/${BINARY_NAME}" pf-setup; then
  PF_STATE="enforcing (anchor \"${PF_ANCHOR}\")"
else
  PF_STATE="NOT enforcing - see the messages above, then run: ${INSTALL_DIR}/${BINARY_NAME} pf-setup"
  echo "  Warning: pf does not enforce bans yet."
  if [ "$IS_OPNSENSE" != "1" ]; then
    echo "  If pf is disabled: sysrc pf_enable=YES && service pf start"
  fi
fi

# ── 6. Start service ────────────────────────────────────────────────────────

echo "[6/6] Starting service..."
service obliguard_agent start

echo ""
echo "=============================="
echo " Installation complete!"
echo ""
echo " Service : $RC_SCRIPT"
echo " Config  : $CONFIG_DIR/config.json"
echo " Logs    : $LOG_FILE"
echo " pf      : $PF_STATE"
echo ""
echo " The agent will appear in"
echo " the Obliguard admin panel"
echo " once approved."
echo "=============================="
