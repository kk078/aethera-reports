# Aethera Reports — shared server mode (Phase 3 chunk E).
#
# This image runs ONLY `server/` — the Fastify HTTP API over the exact
# same `LocalDataService`/importers/KPI engine the desktop app uses (plan
# §1's server-mode seam). It is deliberately NOT built from the top-level
# `package.json`'s full dependency set: `electron`/`electron-builder`
# (devDependencies, ~200MB+ of Electron binaries) have nothing to do with
# a headless Node server and are skipped via `--omit=dev`.
#
# `server/src/index.ts` runs under `vite-node` rather than a compiled JS
# build (see that file's — and `db/migrations/index.ts`'s — comments):
# the DuckDB migrations and KPI SQL are loaded via Vite's `?raw` import
# suffix, which only Vite-aware tooling understands. `vite`/`vite-node`
# are real (non-dev) `dependencies` for exactly this reason.
#
# Build (from the repo root, NOT this directory — it needs the whole
# tree: `src/`, `server/`, `package*.json`):
#   docker build -f server/Dockerfile -t aethera-reports-server .
# Run: see server/docker-compose.yml (or docs/server-mode.md for a plain
# `docker run` example). Not built or run as part of this change — see
# docs/server-mode.md for the exact commands and what they do.

FROM node:22-bookworm-slim AS base

# better-sqlite3 and @duckdb/node-api are native modules; both ship
# prebuilt binaries for linux/x64 and linux/arm64 on Node 22, so no
# compiler toolchain should be needed here in the common case. If a
# platform ever lacks a prebuild, uncomment the next line to fall back to
# building from source:
# RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching) — production deps
# only, and `--ignore-scripts` skips the root `postinstall`
# (`electron-builder install-app-deps`), which needs Electron and has no
# business running in this image at all.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Now the actual source. `server/` imports directly from `src/main/` and
# `src/shared/` (plan's Phase 3 addendum: "sharing code with src/main's
# Electron-free modules") — nothing was moved or duplicated for this
# image, so both trees have to come along.
COPY tsconfig.json tsconfig.node.json ./
COPY src ./src
COPY server ./server

# Where the server's own analytics.duckdb / meta.db / users.db / JWT
# secret / uploaded files / backups live — mount a volume here (see
# docker-compose.yml) so they survive a container recreate.
ENV AETHERA_SERVER_DATA_DIR=/data
ENV AETHERA_SERVER_HOST=0.0.0.0
ENV AETHERA_SERVER_PORT=8787
RUN mkdir -p /data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AETHERA_SERVER_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "vite-node", "server/src/index.ts"]
