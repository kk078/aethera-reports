# Architecture

Aethera Reports is a local-first Electron desktop app with optional shared
server and client portal surfaces. This document summarizes the layering
decisions; see inline comments in `src/shared/` for contract details.

## Process model (desktop)

```
Renderer (React)  →  Preload (contextBridge)  →  Main (Node/Electron)
                           ↑                           ↑
                    window.aethera.invoke       IPC handlers + IDataService
```

The renderer never imports Node or Electron APIs. Every cross-boundary
message is validated with Zod (`src/shared/ipc-contract.ts`).

## Data seam

`IDataService` (`src/main/services/data-service.ts`) is the single business
logic boundary. The UI, importers, and KPI engine sit above local DuckDB +
SQLite (metadata) or, in server mode, the same interface over HTTP RPC.

Directories `services/`, `importers/`, and `kpi/` must stay Electron-free
(enforced by ESLint) so `server/` can import them unchanged.

## Three transports, one domain

| Transport | Contract | Keys |
|-----------|----------|------|
| IPC | `ipc-contract.ts` | Channel names (`reports:portfolio`) |
| HTTP RPC | `rpc-contract.ts` | `IDataService` method names |
| Domain types | `domain.ts` | Zod schemas shared by both |

## UI scope (Phase A)

Global reporting scope (period + optional client filter) lives in
`src/renderer/src/lib/app-scope.tsx` and renders in the app shell
`ScopeBar`. Analytics screens read scope instead of local pickers.
Portfolio uses scope period only; Client Detail syncs client selection
back into scope for cross-screen consistency.

## Optional surfaces

- **Server mode** (`server/`) — Fastify + JWT; reuses `LocalDataService`.
- **Client portal** (`portal/`) — Cloudflare Worker; aggregate report JSON
  only, no PHI.

Exports (PDF/PPTX/XLSX) remain desktop-side because they require Electron
rendering windows.
