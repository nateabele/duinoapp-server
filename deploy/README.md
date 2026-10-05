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
git clone -b native-server https://github.com/nateabele/duinoapp-server.git
cd duinoapp-server
sudo deploy/install.sh compiler.example.com
sudoedit /etc/duino-compile.env   # server name/owner shown by /v3/info/server
sudo systemctl restart duino-compile
```

The script installs Node to `/opt/duino-compile/node`, the code (root-owned,
read-only to the service) to `/opt/duino-compile/app`, data to
`/var/lib/duino-compile`, the `duino-compile` systemd unit, and Caddy for HTTPS.
Caddy gets its own Let's Encrypt certificate, so ports 80 and 443 must be open and DNS
must already point at the instance.

Health: `curl localhost:3030/healthz` shows running and queued compiles.
Logs: `journalctl -u duino-compile -f`, `/var/log/caddy/duino-compile.log`.

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
