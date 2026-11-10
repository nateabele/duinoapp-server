#!/usr/bin/env bash
# Tests deploy/auto-deploy.sh against a throwaway git repo, a stub install.sh
# and a fake /healthz. Needs Linux (flock), git, curl and python3.
#   test/auto-deploy.sh
# Checks are strings run with eval, so variables in single quotes are intended.
# shellcheck disable=SC2016,SC2034
set -u
deploy="$(cd "$(dirname "$0")/.." && pwd)/deploy/auto-deploy.sh"
T="$(mktemp -d)"
health_pid=
cleanup() { [ -n "$health_pid" ] && kill "$health_pid" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# Fake health server: $T/mode (ok|down) and $T/busy (running compiles).
echo ok > "$T/mode"; echo 0 > "$T/busy"
port=$(( 20000 + RANDOM % 20000 ))
python3 - "$T" "$port" <<'PY' &
import http.server, json, sys
d, port = sys.argv[1], int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        mode = open(f'{d}/mode').read().strip()
        busy = int(open(f'{d}/busy').read())
        self.send_response(200 if mode == 'ok' else 500)
        self.end_headers()
        self.wfile.write(json.dumps({'compiles': {'active': busy, 'queued': 0}}).encode())
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
PY
health_pid=$!
until curl -fs -o /dev/null "http://127.0.0.1:$port/"; do sleep 0.2; done

git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/work" 2>/dev/null
# commit <name> <ok|down>: a commit whose install leaves the server healthy or not.
commit() {
  mkdir -p "$T/work/deploy"
  printf '#!/bin/sh\necho %s > %s/mode\necho %s >> %s/installs\n' "$2" "$T" "$1" "$T" > "$T/work/deploy/install.sh"
  chmod +x "$T/work/deploy/install.sh"
  git -C "$T/work" add -A && git -C "$T/work" commit -qm "$1" && git -C "$T/work" push -q origin HEAD:production
}
commit c1 ok
git clone -q -b production "$T/origin.git" "$T/repo"
mkdir -p "$T/state"; git -C "$T/repo" rev-parse HEAD > "$T/state/deployed"
export DEPLOY_REPO="$T/repo" DEPLOY_HOSTNAME=test DEPLOY_STATE="$T/state" DEPLOY_HEALTHZ="http://127.0.0.1:$port/healthz"

pass=0; fail=0
run() { "$deploy" > "$T/out" 2>&1; rc=$?; }
check() {
  if eval "$2"; then echo "ok - $1"; pass=$((pass + 1)); else echo "not ok - $1"; sed 's/^/    /' "$T/out"; fail=$((fail + 1)); fi
}
head_is_deployed() { [ "$(git -C "$T/work" rev-parse HEAD)" = "$(cat "$T/state/deployed")" ]; }
last_install() { tail -1 "$T/installs"; }

run
check "no change is a no-op" '[ $rc = 0 ] && [ ! -f "$T/installs" ]'

commit c2 ok; run
check "a new commit deploys" '[ $rc = 0 ] && head_is_deployed && [ "$(last_install)" = c2 ]'

commit c3 ok; echo 2 > "$T/busy"; run
check "waits while compiles are running" '[ $rc = 0 ] && grep -q "pending: 2 compiles" "$T/out" && [ "$(last_install)" = c2 ]'

echo "$(git -C "$T/work" rev-parse HEAD) $(( $(date +%s) - 4000 ))" > "$T/state/pending"; run
check "deploys anyway once the wait passes DEPLOY_MAX_WAIT" '[ $rc = 0 ] && head_is_deployed && [ "$(last_install)" = c3 ]'
echo 0 > "$T/busy"

good="$(git -C "$T/work" rev-parse HEAD)"
commit c4 down; run
check "an unhealthy commit rolls back" '[ $rc = 1 ] && [ "$(cat "$T/state/deployed")" = "$good" ] && [ "$(last_install)" = c3 ] && [ "$(cat "$T/mode")" = ok ] && [ "$(git -C "$T/repo" rev-parse HEAD)" = "$good" ]'

installs="$(wc -l < "$T/installs")"; run
check "a failed commit is not retried" '[ $rc = 0 ] && [ "$(wc -l < "$T/installs")" = "$installs" ]'

commit c5 ok; run
check "the next good commit deploys after a failure" '[ $rc = 0 ] && head_is_deployed && [ "$(last_install)" = c5 ]'

(flock 9; sleep 3) 9> "$T/state/lock" & holder=$!; sleep 0.5
commit c6 ok; run
check "a run is skipped while another holds the lock" '[ $rc = 0 ] && grep -q "another deploy" "$T/out"'
wait "$holder"

echo "# pass $pass, fail $fail"
[ "$fail" = 0 ]
