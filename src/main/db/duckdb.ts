/**
 * Connection management for the DuckDB analytics store (`analytics.duckdb`).
 *
 * Phase 1 step 2 (walking skeleton) proved a real open -> query -> close
 * round trip on the pinned `@duckdb/node-api` version. Step 4 layers the
 * full schema (plan §2) on top via `applyMigrations` (see `migrate.ts`)
 * — callers that also need Risk 5's backup-before-migrate sequencing
 * (i.e. `LocalDataService`) call `applyMigrations` themselves after
 * checking `hasPendingMigrations`, rather than through a bundled
 * "open + migrate" helper here, so the backup step can sit in between.
 */
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'

export interface DuckDbHandle {
  instance: DuckDBInstance
  connection: DuckDBConnection
  close(): void
}

/**
 * Opens (creating if necessary) a DuckDB database file and returns a
 * ready-to-use connection. Pass `:memory:` for an in-memory database.
 */
export async function openDuckDb(dbPath: string): Promise<DuckDbHandle> {
  const instance = await DuckDBInstance.create(dbPath)
  const connection = await instance.connect()

  return {
    instance,
    connection,
    close(): void {
      connection.closeSync()
      instance.closeSync()
    }
  }
}

/**
 * The walking-skeleton "hello query": proves the native module loads and
 * can round-trip a value through the real connection/read path. Used by
 * both `--smoke` and the vitest DB test.
 */
export async function helloQueryDuckDb(dbPath: string): Promise<number> {
  const db = await openDuckDb(dbPath)
  try {
    const reader = await db.connection.runAndReadAll('SELECT 1 AS one')
    const rows = reader.getRowObjectsJS()
    const value = rows[0]?.one
    if (typeof value !== 'number') {
      throw new Error(`expected SELECT 1 to return a number, got: ${JSON.stringify(value)}`)
    }
    return value
  } finally {
    db.close()
  }
}
