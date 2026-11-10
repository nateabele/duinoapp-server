#!/usr/bin/env bash
# Pull-based deploy, run every few minutes by duino-deploy.timer (as root).
# If origin/$DEPLOY_BRANCH has moved, check it out and run deploy/install.sh;
# if the install fails or /healthz doesn't come back, reinstall the previous
# commit. CI only advances the `production` branch after the tests pass.
#
# Settings: /etc/duino-deploy.env (written by install.sh)
#   DEPLOY_REPO      checkout to deploy from (default /opt/duino-compile/src)
#   DEPLOY_BRANCH    branch to follow (default production)
#   DEPLOY_HOSTNAME  public hostname passed to install.sh
#   DEPLOY_MAX_WAIT  seconds to wait for an idle server before deploying anyway (default 1800)
# Overrides for testing: DEPLOY_INSTALL, DEPLOY_STATE, DEPLOY_HEALTHZ

# Everything runs inside main(): bash reads a script as it executes it, and the
# install below replaces this file.
main() {
  set -euo pipefail
  local repo="${DEPLOY_REPO:-/opt/duino-compile/src}"
  local branch="${DEPLOY_BRANCH:-production}"
  local host="${DEPLOY_HOSTNAME:?DEPLOY_HOSTNAME not set in /etc/duino-deploy.env}"
  local max_wait="${DEPLOY_MAX_WAIT:-1800}"
  local install="${DEPLOY_INSTALL:-deploy/install.sh}"
  local state="${DEPLOY_STATE:-/var/lib/duino-deploy}"
  local port
  port="$(sed -n 's/^PORT=//p' /etc/duino-compile.env 2>/dev/null | tail -1 || true)"
  local healthz="${DEPLOY_HEALTHZ:-http://127.0.0.1:${port:-3030}/healthz}"
  mkdir -p "$state"

  exec 9>"$state/lock"
  flock -n 9 || { echo "another deploy is running"; return 0; }

  cd "$repo"
  git fetch -q origin "$branch"
  local target current
  target="$(git rev-parse "origin/$branch")"
  current="$(cat "$state/deployed" 2>/dev/null || git rev-parse HEAD)"
  if [ "$target" = "$current" ]; then rm -f "$state/pending"; return 0; fi
  # A commit that failed and was rolled back is skipped until a new one lands.
  [ "$target" = "$(cat "$state/failed" 2>/dev/null)" ] && return 0

  # Restarting drops in-flight compiles, so wait for a quiet moment, but not
  # forever. $state/pending holds "<commit> <first seen, epoch seconds>".
  local pending_commit pending_since
  read -r pending_commit pending_since < "$state/pending" 2>/dev/null || true
  if [ "${pending_commit:-}" != "$target" ]; then
    pending_since="$(date +%s)"
    echo "$target $pending_since" > "$state/pending"
  fi
  local waited=$(( $(date +%s) - pending_since ))
  local busy
  busy="$(curl -fsS -m 5 "$healthz" 2>/dev/null | python3 -c 'import json,sys; c=json.load(sys.stdin)["compiles"]; print(c["active"]+c["queued"])' 2>/dev/null || echo 0)"
  if [ "$busy" != 0 ] && [ "$waited" -lt "$max_wait" ]; then
    echo "update ${target:0:7} pending: $busy compiles running, waited ${waited}s"
    return 0
  fi

  echo "deploying ${target:0:7} (was ${current:0:7})"
  if deploy_commit "$target" && healthy; then
    echo "$target" > "$state/deployed"
    rm -f "$state/pending"
    echo "deployed ${target:0:7}"
    return 0
  fi

  echo "DEPLOY FAILED for ${target:0:7}; rolling back to ${current:0:7}" >&2
  if deploy_commit "$current" && healthy; then
    echo "$current" > "$state/deployed"
    # Don't retry the bad commit every few minutes; wait for a new one.
    echo "$target" > "$state/failed"
    echo "rolled back to ${current:0:7}" >&2
  else
    echo "ROLLBACK FAILED: service may be down" >&2
  fi
  return 1
}

deploy_commit() {
  git -c advice.detachedHead=false checkout -q --force "$1"
  "$install" "$host"
}

healthy() {
  local _
  for _ in $(seq 1 30); do
    curl -fsS -m 5 -o /dev/null "$healthz" && return 0
    sleep 2
  done
  return 1
}

# shellcheck source=/dev/null
[ -f /etc/duino-deploy.env ] && . /etc/duino-deploy.env
main "$@"
exit $?
