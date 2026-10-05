#!/usr/bin/env bash
# Install or update the native compile server on Ubuntu (24.04 tested).
# Run from a checkout of this repo, as root:
#
#   sudo deploy/install.sh compiler.example.com
#
# Re-running is safe: it re-syncs the code, re-runs `npm ci` and setup
# (already-installed pinned cores are skipped) and restarts the service.
#
# Env options:
#   CORES=arduino:avr   install only these cores (default: all pinned in setup/versions.json)
#   SKIP_PROXY=1        install Caddy but leave it stopped (e.g. while another proxy holds 80/443)
set -euo pipefail

HOSTNAME_ARG="${1:?usage: install.sh <public hostname>}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- Pinned versions -------------------------------------------------------
NODE_VERSION=24.21.0
declare -A NODE_SHA256=(
  [x64]=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
  [arm64]=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
)
CADDY_VERSION=2.11.7

PREFIX=/opt/duino-compile
DATA_DIR=/var/lib/duino-compile
ENV_FILE=/etc/duino-compile.env

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

log() { printf '\n==> %s\n' "$*"; }

log "System packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync xz-utils python3 python3-serial >/dev/null

log "Service user"
id duino >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin duino
install -d -o duino -g duino -m 0750 "$DATA_DIR"

log "Node.js $NODE_VERSION ($ARCH, sha256 pinned)"
if [ "$("$PREFIX/node/bin/node" -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tarball="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$tmp/$tarball"
  echo "${NODE_SHA256[$ARCH]}  $tmp/$tarball" | sha256sum -c -
  rm -rf "$PREFIX/node" && install -d "$PREFIX/node"
  tar -xJf "$tmp/$tarball" -C "$PREFIX/node" --strip-components=1
  rm -rf "$tmp"
fi

log "Application code -> $PREFIX/app (root-owned, read-only to the service)"
install -d "$PREFIX/app"
rsync -a --delete --exclude .git --exclude node_modules --exclude data "$REPO_DIR/" "$PREFIX/app/"
(cd "$PREFIX/app" && PATH="$PREFIX/node/bin:$PATH" npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$PREFIX" && chmod -R a+rX,go-w "$PREFIX"

log "Config $ENV_FILE"
[ -f "$ENV_FILE" ] || install -m 0640 -g duino "$REPO_DIR/deploy/duino-compile.env.example" "$ENV_FILE"

log "arduino-cli, indexes and pinned cores -> $DATA_DIR (as duino)"
sudo -u duino env HOME="$DATA_DIR" DATA_DIR="$DATA_DIR" ${CORES:+CORES="$CORES"} \
  "$PREFIX/node/bin/node" "$PREFIX/app/setup/install.js"

log "systemd unit"
install -m 0644 "$REPO_DIR/deploy/duino-compile.service" /etc/systemd/system/duino-compile.service
systemctl daemon-reload
systemctl enable duino-compile >/dev/null
systemctl restart duino-compile
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:3030/healthz >/dev/null && break; sleep 1; done
curl -fsS http://127.0.0.1:3030/healthz && echo

log "Caddy $CADDY_VERSION (TLS for $HOSTNAME_ARG)"
if ! dpkg -s caddy 2>/dev/null | grep -q "^Version: $CADDY_VERSION"; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-mark unhold caddy >/dev/null 2>&1 || true
  # Don't let the package auto-start Caddy before we decide (80/443 may be taken).
  printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d
  apt-get install -y -qq --allow-downgrades "caddy=$CADDY_VERSION" >/dev/null || { rm -f /usr/sbin/policy-rc.d; exit 1; }
  rm -f /usr/sbin/policy-rc.d
  apt-mark hold caddy >/dev/null
fi
install -d -o caddy -g caddy /var/log/caddy
sed "s/{\$DUINO_HOSTNAME}/$HOSTNAME_ARG/" "$REPO_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

if [ "${SKIP_PROXY:-}" = 1 ]; then
  systemctl disable --now caddy >/dev/null 2>&1 || true
  log "SKIP_PROXY=1: Caddy installed but not started"
else
  systemctl enable caddy >/dev/null
  systemctl restart caddy
  log "Done: https://$HOSTNAME_ARG"
fi
