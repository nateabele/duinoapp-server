# Native deployment (no Docker)

The server is plain Node plus `arduino-cli`. Everything it installs lives in one
data directory (`DATA_DIR`, default `./data`).

## Pinned dependencies

| What | Where it's pinned | How it's verified |
|---|---|---|
| Node.js | `.nvmrc`, `deploy/install.sh` | SHA-256 of the official tarball |
| npm packages | `package-lock.json` | `npm ci` (lockfile integrity hashes) |
| arduino-cli | `setup/versions.json` | SHA-256 per OS/CPU build |
| Cores (avr, esp8266, esp32) | `setup/versions.json` | arduino-cli checks each archive against the package index |
| Caddy | `deploy/install.sh` | apt package version, held |

To upgrade one, change the version (and checksum) in that file and re-run setup.

## Run locally (macOS or Linux)

```sh
nvm use                         # Node 24.21.0 from .nvmrc (any Node >= 20 works)
npm ci
CORES=arduino:avr npm run setup # omit CORES for avr + esp8266 + esp32 (~8 GB)
npm start                       # http://localhost:3030
```

On Apple Silicon the AVR toolchain is an x86-64 build and runs under Rosetta.

## Production (Ubuntu on EC2)

```sh
sudo git clone -b production https://github.com/nateabele/duinoapp-server.git /opt/duino-compile/src
sudo /opt/duino-compile/src/deploy/install.sh compiler.example.com
sudoedit /etc/duino-compile.env   # server name/owner shown by /v3/info/server
sudo systemctl restart duino-compile
```

Clone as root into `/opt/duino-compile/src`: install.sh only turns on auto-deploy
for a root-owned git checkout.

## Updates (CI/CD)

1. Push to `native-server`. GitHub Actions (`.github/workflows/promote.yml`) runs
   the unit tests, the auto-deploy tests and a start-up check, then fast-forwards
   `production` to that commit.
2. On the server, `duino-deploy.timer` runs `deploy/auto-deploy.sh` every 5 minutes.
   When `production` has moved, it waits until no compiles are running (at most
   30 minutes), checks out the new commit and runs `install.sh`. If the install
   fails or `/healthz` doesn't come back, it reinstalls the previous commit and
   skips the failed one until a newer commit lands.

A full install takes about 6 minutes (and a ~3 GB memory peak) because setup
re-downloads and pre-processes the board and library indexes. Most deploys skip
that: `setup/install.js` records a stamp (`setup-stamp.json` in the data dir, a
hash of `setup/versions.json`, the setup code, `package-lock.json` and the
`CORES` selection, plus a timestamp) after a successful run and skips the index
work when the stamp matches, the processed files exist and the data is under 7
days old. Such a deploy takes about a minute, mostly `npm ci`. The arduino-cli
checksum check and pinned core installs always run. A rollback to a commit whose
setup inputs differ pays the full cost again.

```sh
sudo FORCE_SETUP=1 /opt/duino-compile/src/deploy/install.sh compiler.example.com   # always redo it
sudo SETUP_MAX_AGE_DAYS=1 ...    # refresh window in days (default 7; 0 = every deploy)
```

The service restarts only near the end.

```sh
journalctl -u duino-deploy -f                  # deploy runs, rollbacks
cat /var/lib/duino-deploy/deployed             # commit that's live
sudo systemctl start duino-deploy              # check for an update now
```

`/etc/duino-compile.env` (server settings) and `/etc/duino-deploy.env` (deploy
settings: `DEPLOY_REPO`, `DEPLOY_BRANCH`, `DEPLOY_HOSTNAME`, `DEPLOY_MAX_WAIT`)
live only on the server; deploys never overwrite them.

The script installs Node to `/opt/duino-compile/node`, the code (root-owned,
read-only to the service) to `/opt/duino-compile/app`, data to
`/var/lib/duino-compile`, the `duino-compile` systemd unit, and Caddy for HTTPS.
Caddy gets its own Let's Encrypt certificate, so ports 80 and 443 must be open and DNS
must already point at the instance.

Health: `curl localhost:3030/healthz` shows running and queued compiles.
Logs: `journalctl -u duino-compile -f`, `/var/log/caddy/duino-compile.log`.

## Crashes, hangs and how to trace them

The service restarts on any exit (no start limit), and `duino-compile-health.timer`
restarts it if `/healthz` stops answering for about 30s.

Each line in the journal is `event key=value ...`. To find out what took the server down:

| What happened | Where to look |
|---|---|
| Which compiles were running | `compile.queued` / `compile.done` pairs share an `id`; a `queued` with no `done` was in flight |
| JS crash | `process.uncaughtException` with stack and `inFlight`, plus a report in `/var/lib/duino-compile/reports/` |
| Stopped by systemd / deploy | `process.signal` with `inFlight` |
| Hang | `journalctl -u duino-compile-health`; the process gets SIGUSR2 first, which writes a report with JS and native stacks |
| Node heap exhausted | a report in `reports/` (`--report-on-fatalerror`) |
| Killed by memory cap / OOM | systemd's `oom-kill` / `status=9/KILL` lines; `cli.killed signal=SIGKILL` for a killed arduino-cli; `process.heartbeat` (every 5 min) shows the memory trend |
| arduino-cli timeout | `cli.timeout` |

```sh
journalctl -u duino-compile -u duino-compile-health --since "-1h" --no-pager
journalctl -u duino-compile | grep -E 'process\.|cli\.(killed|timeout)|oom'
sudo ls -lt /var/lib/duino-compile/reports/
```

## Sandbox (`deploy/duino-compile.service`)

The server compiles untrusted code and downloads library zips from URLs the
client chooses, so it runs with:

- **Its own unprivileged user,** no capabilities, `NoNewPrivileges`, no SUID.
- **A read-only OS and app directory** (`ProtectSystem=strict`), writable `/var/lib/duino-compile`
  only, a private `/tmp`, and no access to `/home`.
- **No access to the EC2 metadata service or private networks** (`IPAddressDeny`), so a
  crafted library URL can't reach instance credentials or the VPC. Library
  hosts are also allow-listed in code (`LIB_ALLOWED_HOSTS`).
- **A syscall filter** (`@system-service`) and kernel, clock and hostname protections.
- **Memory and process caps** (`MemoryMax=3000M`, `TasksMax=512`). A compile burst gets
  killed and restarted instead of freezing the machine. The server itself also
  caps simultaneous compiles (`MAX_CONCURRENT_COMPILES`, default = CPU count)
  and queues the rest.

Caddy gets a matching drop-in (`deploy/caddy-hardening.conf`): it can only bind
ports 80/443, write its own state and logs, and reach the internet and loopback.

`systemd-analyze security duino-compile` (and `caddy`) scores the result.
