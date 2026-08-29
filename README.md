# Aethera Reports

Aethera Reports is an open-source, local-first Windows desktop application
for RCM (revenue-cycle management) client reporting and analytics. Billing
teams use it to import claim data, review KPI dashboards, and produce
branded monthly report packs (PDF / PowerPoint / Excel) for the practices
they bill for.

The application is white-label: everything you see out of the box (name,
colors, sample data) is a neutral placeholder. Your firm's branding lives
in a local, uncommitted configuration file — never in this repository.

> **Status:** functional desktop app (v0.2). Importers (CSV/XLSX, X12,
> RCM REST connector), the KPI engine, exporters (PDF/PPTX/XLSX), optional
> shared server mode, and an optional client portal are implemented. See
> `docs/` for setup guides and `CONTRIBUTING.md` for development notes.

## Why

Most RCM back-office teams cobble monthly client reporting together from
spreadsheets exported out of their practice-management system. Aethera
Reports gives them a single local tool that:

- imports claim/remit data from CSV/XLSX exports (with a mapping wizard),
  X12 835/837 files, or a generic RCM platform REST API;
- computes standard RCM KPIs (days in A/R, denial rate, net collection
  rate, A/R aging, etc.) with well-defined null-vs-zero semantics;
- renders interactive dashboards and exports branded PDF/PPTX/XLSX report
  packs per client, per period;
- can run headlessly (CLI flags) so Windows Task Scheduler can drive
  unattended monthly report generation.

All data stays on the machine that runs the app — there is no server
component, no telemetry, and no client portal in v1. See `SECURITY.md`
for the PHI/HIPAA responsibilities that implies for anyone deploying it.

## Tech stack

- [Electron](https://www.electronjs.org/) + React + TypeScript, scaffolded
  with [electron-vite](https://electron-vite.org/).
- [DuckDB](https://duckdb.org/) (`@duckdb/node-api`) as the embedded
  analytics store for claim-level data.
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for local
  application metadata (settings, branding, mapping templates, audit log).
- [Zod](https://zod.dev/) for validating every IPC message crossing the
  main/renderer boundary.
- [electron-builder](https://www.electron.build/) producing Windows NSIS
  `.exe` and `.msi` installers via GitHub Actions.

## Quickstart

Requires Node.js 22 (see `.github/workflows/build.yml` for the pinned CI
version) and npm.

```bash
npm install
npm run dev
```

This launches the app in development mode with hot reload. On first run,
Electron will rebuild the native modules (`@duckdb/node-api`,
`better-sqlite3`) for the local Electron version automatically via
`postinstall`.

Useful scripts:

```bash
npm run typecheck   # TypeScript project references, no emit
npm test            # vitest unit tests
npm run build       # electron-vite production build
npm run lint:secrets # gitleaks scan (see CONTRIBUTING.md)
```

### Headless smoke check

The packaged app supports a `--smoke` flag that opens a temporary DuckDB
database and SQLite metadata database, runs a trivial query against each,
and exits `0` on success without opening a window. This is what CI uses to
confirm the native modules survived packaging:

```bash
npm run build
node ./out/main/index.js --smoke   # or the packaged executable, e.g.
# ./dist/win-unpacked/Aethera Reports.exe --smoke   (Windows)
```

### Downloads

Once releases are published, signed(-eventually) Windows installers
(`.exe` via NSIS and `.msi`) will be attached to each
[GitHub Release](../../releases). Until code signing is configured
(tracked as a TODO in `electron-builder.yml`), Windows SmartScreen will
warn on first run — see the note in that file and the release notes for
the "More info → Run anyway" workaround plus published checksums.

## Project layout

See `CONTRIBUTING.md` for the full directory map and architectural notes
(the `IDataService` seam that lets `server/` reuse the desktop app's
importers/KPI engine unmodified — see "Shared server mode" below).

## Automation

Aethera Reports is meant to run mostly unattended once configured, two
ways: a headless CLI mode for Task Scheduler, or leaving the app open,
in which case its own watch-folder importer and report scheduler do the
work in the background. Manage all of it from the **Automation** screen
(rule CRUD, run history, dry-run, "copy Task Scheduler command") and the
**Settings** screen's "Watch folder" and "Email" sections.

### Watch-folder auto-import

Point Settings → Watch folder at an inbox directory laid out as
`<inbox>\<CLIENT_CODE>\` (one subfolder per client). While the app is
open it:

- runs a catch-up scan of the whole inbox on launch (so files dropped
  while the app was closed aren't missed), then
- watches it live for new files for as long as the app stays open.

Every file is auto-detected — X12 835/837 need no template; CSV/XLSX use
that client folder's pinned mapping template (set per client in
Settings → Watch folder), falling back to a default template only for
the CLI's `--import <dir>` (see below). A successfully imported file
moves to `<CLIENT_CODE>\processed\`; a failed one moves to
`<CLIENT_CODE>\failed\` alongside a `<file>.error.txt` explaining why.
Every attempt is recorded in Import History (Imports screen) regardless
of outcome. Click "Scan now" in Settings to run the catch-up scan
on demand instead of waiting for the next file drop.

### Report scheduler

Create a rule on the Automation screen: a day of the month, which
clients (`all` or a specific list), which export formats, and whether to
just write the files or also email them. A rule generates the **prior**
month's report — a rule set to fire on the 3rd generates last month's
pack. Rules stay "due" every day from their scheduled day through
month-end until they've actually run (missed-run catch-up for a laptop
that was closed on the scheduled day), and never run twice for the same
period once they have. While the app is open, a due rule fires on
launch and then on a periodic background check; "Run now" on the
Automation screen runs it immediately regardless of due-ness, and "Dry
run" previews which clients/recipients/period it would use without
exporting or sending anything.

### Email delivery

Configure SMTP once in Settings → Email (host/port/credentials — the
password is encrypted via the OS credential store when available, with
a clear warning when it falls back to plaintext) and a subject/body
template using `{client}`/`{period}` placeholders. Each client's
`report_recipients` (editable on the Clients screen) is who a rule with
delivery set to "email" sends to, and ClientDetail's "Send pack" button
sends/queues one client's pack on demand. If SMTP isn't configured yet,
or a send fails, it lands in a retryable send queue instead of being
dropped — the Automation screen's run-history tab lists it with a
"Retry" action, and it's retried automatically on the next scheduler
tick once SMTP is configured. One client's email failure never aborts a
multi-client run.

### Headless CLI

The installed app also accepts flags and runs with no window at all, so
a script or Windows Task Scheduler can drive it without leaving the app
open:

```
"Aethera Reports.exe" --generate --period 2026-07 --clients all --formats pdf
"Aethera Reports.exe" --generate --period 2026-07 --clients ACME,BETA --formats pdf,pptx,xlsx --out "D:\Reports"
"Aethera Reports.exe" --import "D:\Inbox"
"Aethera Reports.exe" --import "D:\Inbox\ACME\claims.csv" --template tebra-claim-export
"Aethera Reports.exe" --smoke
```

- `--generate` writes the requested format(s) per client to
  `<Documents>\Aethera Reports\<YYYY-MM>\<CLIENT_CODE>\`. Every run is
  logged to `%APPDATA%\aethera-reports\logs\automation-<date>.log`, and
  the process exits non-zero if any client's export failed.
- `--import <dir>` reuses the exact same watch-folder catch-up scan the
  app runs at launch: X12 vs CSV/XLSX is auto-detected per file, each
  `<dir>\<CLIENT_CODE>\` folder's pinned template applies when set, and
  `--template` (optional here) is only the fallback default for folders
  with no pin. Files move to `processed\`/`failed\` exactly as the live
  watcher does.
- `--import <file> --template <name-or-id>` imports one CSV/XLSX file
  using a saved mapping template (its parent folder's name is used as
  the client code) — `--template` is required for a single file, and the
  file is left in place, unchanged from Phase 1 behavior.

**Windows Task Scheduler**: the Automation screen's "Copy Task Scheduler
command" button generates the `schtasks` command for a given rule
(current month, correct clients/formats/day) ready to paste — for
example:

```
schtasks /create /tn "Aethera Reports - Monthly Generate" ^
  /tr "\"C:\Program Files\Aethera Reports\Aethera Reports.exe\" --generate --period 2026-07 --clients all --formats pdf" ^
  /sc monthly /d 3 /st 06:00
```

## Shared server mode

Aethera Reports is local-first by default (each install keeps its own
database), but a small optional server (`server/`) lets several staff
machines share one dataset instead — same importers, same KPI engine,
same `IDataService` interface, just reached over HTTP instead of opened
as local files. The desktop app's **Settings → Data mode** switches
between them; nothing else in the app changes.

```bash
npm run server                                       # run the server (default: 127.0.0.1:8787)
npm run server:user -- add <username> <password>      # seed a staff login
```

See **`docs/server-mode.md`** for full setup, Docker
(`server/Dockerfile` and `server/docker-compose.yml`), and LAN/Tailscale
network-exposure guidance.

## Hosted client portal

An optional Cloudflare Worker (`portal/`, Hono + D1) publishes a
client's report as a mobile-friendly, read-only web page and emails each
recipient a private, expiring link — no patient-level data, ever, only
the same aggregate `ClientReport` JSON the dashboards/exports already
use. Also entirely optional; the app works the same without it.

```bash
cd portal && npx wrangler dev    # local dev, once you've deployed a D1 database (see docs/portal.md)
```

Connect it from **Settings → Hosted client portal**, then use
ClientDetail's **"Publish to portal"** button or a scheduler rule with
Delivery set to "Publish to portal + email links". See
**`docs/portal.md`** for the full deploy walkthrough, link lifecycle,
and security notes.

## Contributing

Bug reports and pull requests are welcome — see `CONTRIBUTING.md`.

## License

Apache License 2.0 — see `LICENSE` and `NOTICE`.
