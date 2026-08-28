import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // portal/test covers the Cloudflare Worker (Phase 3 chunk F) — it
    // runs fine under plain Node/vitest (Hono's `app.request()` needs no
    // Workers runtime/Miniflare), so it shares this one vitest project;
    // only *type-checking* portal/ needs its own tsconfig (see
    // `npm run typecheck:portal`) because `@cloudflare/workers-types`
    // and the desktop's `@types/node` declare conflicting globals.
    include: ['test/**/*.test.ts', 'portal/test/**/*.test.ts'],
    // DB-backed tests (DuckDB migrations + imports) can exceed vitest's 5s
    // default on slower CI runners while passing comfortably locally.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
