/**
 * DuckDB migration runner (plan Phase 1 step 4). Tracks applied versions
 * in `schema_migrations` and runs each pending migration's full SQL
 * script in one call — DuckDB executes a `;`-separated script as a
 * single statement batch, so a whole `NNN_name.sql` file runs atomically
 * per migration (verified against the pinned `@duckdb/node-api`).
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import type { Migration } from './migrations'

export interface MigrationResult {
  appliedVersions: number[]
}

async function ensureMigrationsTable(connection: DuckDBConnection): Promise<void> {
  await connection.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

async function getAppliedVersions(connection: DuckDBConnection): Promise<Set<number>> {
  const reader = await connection.runAndReadAll('SELECT version FROM schema_migrations')
  const rows = reader.getRowObjectsJS()
  return new Set(rows.map((row) => Number(row.version)))
}

/**
 * Applies every migration in `migrations` that hasn't already run against
 * this connection's database, in ascending version order. Safe to call on
 * every startup — a fully migrated database is a no-op.
 */
export async function applyMigrations(
  connection: DuckDBConnection,
  migrations: Migration[]
): Promise<MigrationResult> {
  await ensureMigrationsTable(connection)
  const applied = await getAppliedVersions(connection)

  const pending = migrations
    .filter((migration) => !applied.has(migration.version))
    .sort((a, b) => a.version - b.version)

  const appliedVersions: number[] = []
  for (const migration of pending) {
    await connection.run(migration.sql)
    await connection.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
      migration.version,
      migration.name
    ])
    appliedVersions.push(migration.version)
  }

  return { appliedVersions }
}

/** True if one or more migrations in `migrations` have not yet run. */
export async function hasPendingMigrations(
  connection: DuckDBConnection,
  migrations: Migration[]
): Promise<boolean> {
  await ensureMigrationsTable(connection)
  const applied = await getAppliedVersions(connection)
  return migrations.some((migration) => !applied.has(migration.version))
}
