# Shared server mode

Aethera Reports is local-first by default: each install keeps its own
`analytics.duckdb` + `meta.db`. **Shared server mode** (Phase 3) is an
optional alternative for a team that wants several staff machines
looking at the same data — one small server (`server/`) owns the
database, and each desktop install talks to it over HTTP instead of
opening its own files.

Everything else about the app stays the same either way: the renderer,
the exporters (PDF/PPTX/XLSX), and the automation suite (watch-folder
import, the scheduler, email delivery) are all written against the
`IDataService` interface, not a concrete class — they cannot tell
whether they're talking to `LocalDataService` or `RemoteDataService`.
Only exports themselves stay desktop-side even in Server mode (they need
a real Electron `BrowserWindow` to render charts/print-to-PDF) — they
just read their data over the network first.

## 1. Running the server

The server is plain Node (no Electron) and reuses the desktop app's own
Electron-free code directly — `LocalDataService`, the DuckDB migrations,
the CSV/XLSX/X12 importers, and the KPI engine — with zero code moved or
duplicated (they're already Electron-free by the project's own
`no-restricted-imports` ESLint rule, which exists specifically so this
was possible without a rewrite).

```bash
# From the repo root, after `npm install`:
npm run server
```

This opens `<data dir>/analytics.duckdb` + `meta.db` (the same schema and
shape a desktop install would have) plus a server-only `users.db`, and
listens on `127.0.0.1:8787` by default. On first run it also generates
and persists a random JWT signing secret into the data dir.

### Config (env vars, or a JSON config file)

| Env var                         | Default         | Notes                                                                                                                                                                                                  |
| ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AETHERA_SERVER_DATA_DIR`       | `./server-data` | Everything the server persists lives here — `analytics.duckdb`, `meta.db`, `users.db`, `jwt-secret.txt`, `uploads/`, `backups/`. Back this directory up like you would a desktop install's `userData`. |
| `AETHERA_SERVER_HOST`           | `127.0.0.1`     | Bind address. Only change this deliberately — see [§4 Network exposure](#4-network-exposure-lantailscale).                                                                                             |
| `AETHERA_SERVER_PORT`           | `8787`          |                                                                                                                                                                                                        |
| `AETHERA_SERVER_JWT_SECRET`     | _(generated)_   | Set this explicitly if you want a reproducible secret across restarts/redeploys instead of relying on the generated `jwt-secret.txt` persisting.                                                       |
| `AETHERA_SERVER_JWT_EXPIRES_IN` | `30m`           | How long a login stays valid before the desktop client has to log in again (it does this automatically — see §3).                                                                                      |
| `AETHERA_SERVER_CONFIG_FILE`    | _(none)_        | Optional path to a JSON file (`{"dataDir": "...", "host": "...", "port": 8787, "jwtExpiresIn": "30m"}`) — any env var above still wins over the file if both are set.                                  |

## 2. Seeding staff users

There's no self-service sign-up — an operator adds accounts via the CLI,
against the same `users.db` the running server reads (no restart
needed):

```bash
npm run server:user -- add <username> <password>
npm run server:user -- list
npm run server:user -- passwd <username> <new-password>
npm run server:user -- remove <username>
```

Passwords are hashed with bcrypt; nothing is ever stored or logged in
plaintext.

## 3. Pointing a desktop install at the server

In the desktop app: **Settings → Data mode**, enter the server's URL,
your username, and password, then **Test connection** before
**Switch to Server**. Switching modes only takes effect after a restart
(the Settings screen prompts for one) — which `IDataService`
implementation to build is decided once, at launch.

Under the hood, the desktop's `RemoteDataService`:

- logs in once (`POST /api/auth/login`) and attaches the resulting JWT
  as a `Bearer` token to every request;
- transparently logs in again and retries, exactly once, if a call ever
  comes back `401` (the token expired mid-session — this is why the
  server default is a short-lived 30-minute token rather than something
  that never needs refreshing);
- uploads CSV/XLSX/X12 files via `POST /api/import/upload` (multipart)
  rather than sending a local file _path_ to the server — the server
  can't read the desktop machine's disk;
- still detects a file's kind (CSV/XLSX/X12 835/837) and previews an X12
  file's contents **locally**, without any network call, so the
  mapping-wizard preview is instant and works even if the server is
  briefly unreachable.

Your server password is stored the same way the RCM Platform
connector's is — encrypted via the OS-level credential store
(`safeStorage`) where available, with a clear warning in Settings if it
had to fall back to plaintext.

## 4. Network exposure (LAN/Tailscale)

The server binds `127.0.0.1` by default — reachable only from the same
machine. To let other staff machines reach it, bind to an address other
machines can route to:

- **LAN**: bind to this host's normal LAN IP (`AETHERA_SERVER_HOST=<LAN IP>`,
  or the docker-compose port mapping's host address). Anyone on the same
  network segment can reach it — fine on a trusted office LAN, not
  something to expose past your router.
- **Tailscale** (recommended if the team isn't all on one LAN): bind to
  this host's Tailscale IP (`tailscale ip -4`). Traffic between machines
  is already encrypted and authenticated by Tailscale itself, so this is
  a reasonable way to reach the server from home/another office without
  opening anything on your router — the same pattern this project's
  other self-hosted services (`aethera-cc`, `beacon`) already use.

The server's own HTTP is plain (unencrypted) HTTP — it relies on the
transport (LAN trust boundary, or Tailscale's own encryption) for
confidentiality in transit. Don't bind it to `0.0.0.0` on a machine with
a public IP, and don't put it directly on the public internet without a
TLS-terminating reverse proxy in front of it.

## 5. Docker

`server/Dockerfile` + `server/docker-compose.yml` are committed and
ready to use, but **not built or run as part of shipping this feature**
— that's on you, when you're ready:

```bash
# From the repo root (the build needs src/ and server/ both):
docker compose -f server/docker-compose.yml build
docker compose -f server/docker-compose.yml up -d

# Seed the first user:
docker compose -f server/docker-compose.yml exec aethera-reports-server \
  npx vite-node server/src/cli.ts -- user add <username> <password>

# Health check:
curl http://127.0.0.1:8787/health
```

The container persists `/data` (its data dir) in a named Docker volume,
so `docker compose down` (without `-v`) never loses data. The compose
file's `ports:` mapping defaults to `127.0.0.1:8787:8787` — see the
comments in that file for the LAN/Tailscale variants from §4.

## 6. Security notes

- **JWT secret**: generated once and persisted to `<data dir>/jwt-secret.txt`
  (mode `0600`) if you don't set `AETHERA_SERVER_JWT_SECRET` yourself.
  Anyone who can read that file can mint valid tokens — protect the data
  dir/volume the same way you'd protect a database file.
- **Login is rate-limited** (5 attempts/minute per client) to slow down
  password guessing; every other endpoint is capped at a generous
  300 requests/minute as a basic abuse guard, not a real quota system.
- **Disk encryption applies here too**: the plan's PHI-minimization
  section already asks desktop users to check BitLocker status because
  DuckDB has no native encryption — the exact same reasoning applies to
  wherever the server's data dir/Docker volume physically lives. If it's
  a bare Linux host, that's your OS-level disk encryption (LUKS, etc.);
  the app can't check that for you the way it probes `manage-bde` on
  Windows.
- **No telemetry, no auto-update** — same as the desktop app. The server
  never phones home.
- **CSV/XLSX/X12 uploads are kept**, not deleted after import (under
  `<data dir>/uploads/<CLIENT_CODE>/`) — same rationale as the
  watch-folder's `processed/` convention: a human should be able to see
  what was actually imported. Factor that into your disk-space planning
  and backup scope.
