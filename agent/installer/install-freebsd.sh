#!/bin/sh
# Obliguard Agent Installer for FreeBSD / OPNsense
# Usage: curl -fsSL "https://your-server/api/agent/installer/freebsd?key=<apikey>" | sh
# Or:    sh install-freebsd.sh --url https://your-server --key <apikey>

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

# Parse args (override injected values)
for i in "$@"; do
  case $i in
    --url=*) SERVER_URL="${i#*=}" ;;
    --key=*) API_KEY="${i#*=}" ;;
    --url) SERVER_URL="$2"; shift ;;
    --key) API_KEY="$2"; shift ;;
  esac
done

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
fetch -q -o "${INSTALL_DIR}/${BINARY_NAME}" \
  "${SERVER_URL}/api/agent/download/obliguard-agent-${BINARY_SUFFIX}" 2>/dev/null || \
  curl -fsSL "${SERVER_URL}/api/agent/download/obliguard-agent-${BINARY_SUFFIX}" \
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
  "agentVersion": "1.0.0"
}
EOF

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

if [ "$IS_OPNSENSE" = "1" ]; then
  # OPNsense: use anchor + reload hook (pf.conf is regenerated on each change)
  echo "  OPNsense detected — installing pf anchor + reload hook..."

  # Reload hook script
  mkdir -p /usr/local/opnsense/scripts/filter
  cat > /usr/local/opnsense/scripts/filter/obliguard_reload.sh <<HOOKEOF
#!/bin/sh
# Re-apply Obliguard pf rules after OPNsense filter reload
echo "table <${PF_TABLE}> persist
block in quick from <${PF_TABLE}>
block out quick to <${PF_TABLE}>" | /sbin/pfctl -a obliguard -f -
HOOKEOF
  chmod +x /usr/local/opnsense/scripts/filter/obliguard_reload.sh

  # Configd action
  mkdir -p /usr/local/opnsense/service/conf/actions.d
  cat > /usr/local/opnsense/service/conf/actions.d/actions_obliguard.conf <<ACTEOF
[reload]
command:/usr/local/opnsense/scripts/filter/obliguard_reload.sh
parameters:
type:script
message:Obliguard pf table reload
description:Reload Obliguard IPS pf rules
ACTEOF

  service configd restart 2>/dev/null || true

  # Load anchor immediately
  echo "table <${PF_TABLE}> persist
block in quick from <${PF_TABLE}>
block out quick to <${PF_TABLE}>" | pfctl -a obliguard -f - 2>/dev/null || true

  echo "  pf anchor 'obliguard' loaded."

else
  # Plain FreeBSD: append to /etc/pf.conf
  if grep -q "$PF_TABLE" /etc/pf.conf 2>/dev/null; then
    echo "  pf rules already present in /etc/pf.conf"
  else
    echo "" >> /etc/pf.conf
    echo "# Obliguard IPS — managed automatically, do not edit" >> /etc/pf.conf
    echo "table <${PF_TABLE}> persist" >> /etc/pf.conf
    echo "block in quick from <${PF_TABLE}>" >> /etc/pf.conf
    echo "block out quick to <${PF_TABLE}>" >> /etc/pf.conf
    pfctl -f /etc/pf.conf 2>/dev/null || true
    echo "  pf rules added to /etc/pf.conf"
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
echo ""
echo " The agent will appear in"
echo " the Obliguard admin panel"
echo " once approved."
echo "=============================="
