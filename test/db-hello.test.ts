import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { helloQueryDuckDb } from '../src/main/db/duckdb'
import { helloQuerySqlite } from '../src/main/db/meta'

describe('DB walking skeleton (Phase 1 step 2)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-reports-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs SELECT 1 through the real DuckDB code path and creates a file on disk', async () => {
    const dbPath = join(dir, 'analytics.duckdb')
    const result = await helloQueryDuckDb(dbPath)
    expect(result).toBe(1)
    expect(existsSync(dbPath)).toBe(true)
  })

  it('runs SELECT 1 through the real better-sqlite3 code path and creates a file on disk', () => {
    const dbPath = join(dir, 'meta.db')
    const result = helloQuerySqlite(dbPath)
    expect(result).toBe(1)
    expect(existsSync(dbPath)).toBe(true)
  })
})
