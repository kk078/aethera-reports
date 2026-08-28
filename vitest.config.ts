import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // DB-backed tests (DuckDB migrations + imports) can exceed vitest's 5s
    // default on slower CI runners while passing comfortably locally.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
