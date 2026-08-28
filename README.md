# Aethera Reports

Aethera Reports is an open-source, local-first Windows desktop application
for RCM (revenue-cycle management) client reporting and analytics. Billing
teams use it to import claim data, review KPI dashboards, and produce
branded monthly report packs (PDF / PowerPoint / Excel) for the practices
they bill for.

The application is white-label: everything you see out of the box (name,
colors, sample data) is a neutral placeholder. Your firm's branding lives
in a local, uncommitted configuration file — never in this repository.

> **Status:** early scaffold. The DuckDB + SQLite walking skeleton, the
> hardened Electron shell, and the screen layout exist; importers, the KPI
> engine, and exporters are still being built. See `docs/` (as it grows)
> and the open issues for current progress.

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
(the `IDataService` seam that keeps a future shared/server mode possible
without a rewrite).

## Automation

Aethera Reports is meant to run mostly unattended once configured. The
headless CLI mode ships in Phase 1; a watch-folder auto-import and a
report scheduler UI are Phase 2 roadmap items.

### Headless CLI

The installed app accepts flags and runs with no window at all, so a
script or Windows Task Scheduler can drive it:

```
"Aethera Reports.exe" --generate --period 2026-07 --clients all --formats pdf
"Aethera Reports.exe" --generate --period 2026-07 --clients ACME,BETA --formats pdf --out "D:\Reports"
"Aethera Reports.exe" --import "D:\Inbox" --template tebra-claim-export
"Aethera Reports.exe" --smoke
```

- `--generate` writes one PDF per client to
  `<Documents>\Aethera Reports\<YYYY-MM>\<CLIENT_CODE>\` (Phase 1 supports
  `--formats pdf`; PPTX/XLSX land in Phase 2). Every run is logged to
  `%APPDATA%\aethera-reports\logs\automation-<date>.log`, and the process
  exits non-zero if any client's export failed.
- `--import <file-or-dir> --template <name-or-id>` batch-imports CSV/XLSX
  files using a saved mapping template, following the same
  `<inbox>\<CLIENT_CODE>\` folder convention the future watch-folder
  feature will use: point it at a folder of per-client subfolders, or at
  a single file (its parent folder's name is used as the client code).

**Windows Task Scheduler**, to run the monthly report pack unattended on
the 3rd of every month at 6am (adjust the period and path to your
install):

```
schtasks /create /tn "Aethera Reports - Monthly Generate" ^
  /tr "\"C:\Program Files\Aethera Reports\Aethera Reports.exe\" --generate --period 2026-07 --clients all --formats pdf" ^
  /sc monthly /d 3 /st 06:00
```

(A "copy Task Scheduler command" button that fills in the current month
automatically is planned for the Settings screen in Phase 2.)

## Contributing

Bug reports and pull requests are welcome — see `CONTRIBUTING.md`.

## License

Apache License 2.0 — see `LICENSE` and `NOTICE`.
