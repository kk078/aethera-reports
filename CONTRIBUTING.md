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
├── shared/       # pure TS + zod, compiled into both main and renderer
├── main/         # Electron main process: db, ipc, services, importers, kpi, exporters
├── preload/      # contextBridge — the ONLY code with access to both Node and window
└── renderer/     # React app (screens, components, state)
test/             # vitest
sample-data/      # synthetic fixtures only — see Data policy below
```

The renderer never touches Node/Electron APIs directly. It calls a single
typed `invoke(channel, payload)` exposed by the preload bridge; every
channel is validated against a zod schema in `src/shared/ipc-contract.ts`
before the main process acts on it.

`src/main/services`, `src/main/importers`, and `src/main/kpi` must stay
free of Electron imports (enforced by an ESLint `no-restricted-imports`
rule) — they are plain TypeScript with a database handle, so an eventual
server package can reuse them unchanged behind a `RemoteDataService`.

## Commands

```bash
npm run typecheck    # tsc project references, no emit
npm test             # vitest
npm run lint         # eslint
npm run format       # prettier --write
npm run build        # electron-vite build (also typechecks)
npm run lint:secrets # gitleaks detect (see below)
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
- Describe *why*, not just *what*, in the PR description.

## License

By contributing, you agree your contributions are licensed under the
Apache License 2.0 (see `LICENSE`), consistent with the rest of the
project.
