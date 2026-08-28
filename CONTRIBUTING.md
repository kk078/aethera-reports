# Contributing to Aethera Reports

Thanks for your interest in the project. This is a young codebase; the
notes below will grow as more of the app is built.

## Dev setup

Requires Node.js 22 and npm (no other package manager is supported —
lockfile is `package-lock.json`).

```bash
npm install
npm run dev
```

Native modules (`@duckdb/node-api`, `better-sqlite3`) are compiled with
prebuilt N-API binaries and rebuilt for the local Electron version by the
`postinstall` script (`electron-builder install-app-deps`). If you ever
see a native-module load error after switching Node/Electron versions,
re-run `npm run postinstall` (or delete `node_modules` and reinstall).

## Project layout

```
src/
├── shared/       # pure TS + zod, compiled into main, renderer, AND server/
├── main/         # Electron main process: db, ipc, services, importers, kpi, exporters
├── preload/      # contextBridge — the ONLY code with access to both Node and window
└── renderer/     # React app (screens, components, state)
server/           # shared server mode (Phase 3) — Fastify, no Electron; see docs/server-mode.md
test/             # vitest
sample-data/      # synthetic fixtures only — see Data policy below
```

The renderer never touches Node/Electron APIs directly. It calls a single
typed `invoke(channel, payload)` exposed by the preload bridge; every
channel is validated against a zod schema in `src/shared/ipc-contract.ts`
before the main process acts on it.

`src/main/services`, `src/main/importers`, and `src/main/kpi` must stay
free of Electron imports (enforced by an ESLint `no-restricted-imports`
rule) — they are plain TypeScript with a database handle, which is what
lets `server/` import `LocalDataService`, the DuckDB migrations, and the
importers directly, unmodified, with zero code moved or duplicated.
`server/`'s own HTTP surface (`src/shared/rpc-contract.ts`) is a second,
method-keyed map alongside `ipc-contract.ts`'s channel-keyed one — both
build their request/response shapes out of the same `domain.ts` schemas,
so there's one source of truth for a given payload shape regardless of
which transport carries it. `src/main/services/remote-data-service.ts`
is the desktop-side mirror: it implements `IDataService` over HTTP
against `server/`, so Settings' "Data mode: Server" is a drop-in swap for
everything above the `IDataService` seam.

## Commands

```bash
npm run typecheck    # tsc project references, no emit
npm test             # vitest
npm run lint         # eslint
npm run format       # prettier --write
npm run build        # electron-vite build (also typechecks)
npm run lint:secrets # gitleaks detect (see below)
npm run server       # shared server mode (Phase 3) — see docs/server-mode.md
npm run server:user  # -- add/passwd/remove/list staff logins for the server
```

## Data policy — nothing real ever gets committed

This is a public repository developed by a company that handles PHI in
production. To keep it that way:

- **`sample-data/` is synthetic only.** No real payer, provider, or
  patient identifiers, ever — hand-built or clearly-fake-generator fixtures
  only.
- **Never commit local databases or real export files.** `.gitignore`
  excludes `*.duckdb`, `*.db`, `*.sqlite`, `userData/`, `.env*`, and raw
  `*.835`/`*.837` files. Put any real files you're testing against locally
  in `local-data/` (also gitignored) — never in `sample-data/`.
- **X12 835/837 fixtures are the one exception, and only under
  `sample-data/`.** `.gitignore` blocks `*.835`/`*.837` everywhere, then
  negates that with `!sample-data/*.835`/`!sample-data/*.837` — so a
  `.835`/`.837` file is committable if and only if it lives directly in
  `sample-data/` and is a hand-built synthetic fixture (see the ones
  already there for the expected shape, including deliberately malformed
  ones for parser-error-handling tests). Never drop a real ERA/claim file
  in `sample-data/` to "just test something" — use `local-data/` for that,
  even briefly.
- **Secret scanning.** `npm run lint:secrets` runs
  [gitleaks](https://github.com/gitleaks/gitleaks) against the working
  tree using `.gitleaks.toml`. It also runs in CI on every push/PR. A
  local pre-commit hook is provided at `scripts/git-hooks/pre-commit`; it
  is **not installed automatically** (there's no `.git` directory in a
  fresh checkout until you initialize one) — see the header comment in
  that file for the one-line `git config core.hooksPath` to enable it.
- **PR checklist:** before opening a PR, confirm your diff doesn't add
  real hostnames, credentials, or patient/claim data. If you're adding a
  new fixture file, say in the PR description how it was generated.

## Testing

- `npm test` runs vitest. Add unit tests next to the code they cover (or
  under `test/`) as you go.
- Once the KPI engine lands (Phase 1 step 7), golden fixtures under
  `sample-data/golden/` become the source of truth for KPI numbers —
  see `docs/kpi-parity.md` when it exists.

## Pull requests

- Keep PRs scoped to one phase/step where practical — this project is
  being built in ordered phases (see the project plan / issues).
- Run `npm run typecheck && npm test && npm run build` before opening a
  PR; CI will run the same on `ubuntu-latest`, plus a Windows installer
  build.
- Describe _why_, not just _what_, in the PR description.

## License

By contributing, you agree your contributions are licensed under the
Apache License 2.0 (see `LICENSE`), consistent with the rest of the
project.
