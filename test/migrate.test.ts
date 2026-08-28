import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDuckDb, type DuckDbHandle } from '../src/main/db/duckdb'
import { applyMigrations, hasPendingMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'

describe('DuckDB migration runner', () => {
  let dir: string
  let db: DuckDbHandle

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-migrate-test-'))
    db = await openDuckDb(join(dir, 'analytics.duckdb'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports pending migrations on a fresh database', async () => {
    expect(await hasPendingMigrations(db.connection, migrations)).toBe(true)
  })

  it('applies all migrations and creates the full schema', async () => {
    const result = await applyMigrations(db.connection, migrations)
    expect(result.appliedVersions).toEqual(migrations.map((m) => m.version))

    const reader = await db.connection.runAndReadAll(
      "SELECT table_name FROM duckdb_tables() WHERE table_name = 'claims'"
    )
    expect(reader.getRowObjectsJS()).toHaveLength(1)
  })

  it('is a no-op the second time (idempotent)', async () => {
    await applyMigrations(db.connection, migrations)
    const second = await applyMigrations(db.connection, migrations)
    expect(second.appliedVersions).toEqual([])
    expect(await hasPendingMigrations(db.connection, migrations)).toBe(false)
  })
})
