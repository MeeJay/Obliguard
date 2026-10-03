#!/bin/sh
set -e

REPO="https://raw.githubusercontent.com/MeeJay/obliguard/main"
INSTALL_DIR="${OBLIGUARD_DIR:-./obliguard}"

echo ""
echo "  ╔════════════════════════════════╗"
echo "  ║     Obliguard — Installer      ║"
echo "  ╚════════════════════════════════╝"
echo ""

# Check docker
if ! command -v docker > /dev/null 2>&1; then
  echo "✗ Docker is not installed. Please install Docker first."
  echo "  https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker compose version > /dev/null 2>&1; then
  echo "✗ Docker Compose v2 is required. Please update Docker."
  exit 1
fi

# Create install directory
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "→ Installing in: $(pwd)"
echo ""

# Download compose + env example
echo "→ Downloading docker-compose.yml..."
curl -fsSL "$REPO/docker-compose.yml" -o docker-compose.yml

# random_hex <bytes>: hex string from openssl, else /dev/urandom. Never a fixed
# fallback: the server refuses to start in production with a weak SESSION_SECRET.
random_hex() {
  _hex=$(openssl rand -hex "$1" 2>/dev/null || true)
  if [ -z "$_hex" ] && [ -r /dev/urandom ]; then
    _hex=$(od -An -tx1 -N "$1" /dev/urandom 2>/dev/null | tr -d ' \n')
  fi
  if [ ${#_hex} -lt $(( $1 * 2 )) ]; then
    echo "✗ Cannot generate random secrets (need openssl or /dev/urandom)." >&2
    exit 1
  fi
  printf '%s' "$_hex"
}

ADMIN_PASSWORD=""
if [ ! -f ".env" ]; then
  echo "→ Downloading .env.example..."
  curl -fsSL "$REPO/.env.example" -o .env.example

  # Generate random secrets (hex only: safe inside the sed replacements below)
  SESSION_SECRET=$(random_hex 32)
  DB_PASSWORD=$(random_hex 16)
  ADMIN_PASSWORD=$(random_hex 12)

  # Generate .env with random secrets pre-filled
  sed \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$SESSION_SECRET|" \
    -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$DB_PASSWORD|" \
    -e "s|^DEFAULT_ADMIN_PASSWORD=.*|DEFAULT_ADMIN_PASSWORD=$ADMIN_PASSWORD|" \
    .env.example > .env
  chmod 600 .env

  if ! grep -q "^SESSION_SECRET=$SESSION_SECRET" .env; then
    echo "✗ Could not write SESSION_SECRET to .env — set it manually (openssl rand -hex 32)." >&2
    exit 1
  fi

  echo ""
  echo "  ✓ .env created with generated secrets."
  echo "  → Review and adjust settings if needed: $(pwd)/.env"
  echo ""
else
  echo "  → .env already exists, skipping."
fi

# Create the custom directory mounted at /custom (kept for compatibility)
mkdir -p custom

echo "→ Starting Obliguard..."
echo ""
docker compose pull
docker compose up -d

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║        Obliguard is running!          ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
LISTEN_PORT=$(sed -n 's/^LISTEN_PORT=//p' .env 2>/dev/null | tr -d '\r' | tail -n 1)
echo "  → Open: http://localhost:${LISTEN_PORT:-3001}"
echo "    (production session cookies are HTTPS-only: put a TLS reverse proxy in front)"
if [ -n "$ADMIN_PASSWORD" ]; then
  ADMIN_USERNAME=$(sed -n 's/^DEFAULT_ADMIN_USERNAME=//p' .env 2>/dev/null | tr -d '\r' | tail -n 1)
  echo "  → Admin login: ${ADMIN_USERNAME:-admin} / $ADMIN_PASSWORD"
  echo "    This password is shown only once: write it down, change it after the"
  echo "    first login, then remove DEFAULT_ADMIN_PASSWORD from .env."
else
  echo "  → Log in with the admin account configured in .env."
fi
echo ""
echo "  Useful commands:"
echo "    docker compose -f $(pwd)/docker-compose.yml logs -f"
echo "    docker compose -f $(pwd)/docker-compose.yml down"
echo "    docker compose -f $(pwd)/docker-compose.yml pull && docker compose up -d  # update"
echo ""
