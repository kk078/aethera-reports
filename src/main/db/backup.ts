/**
 * DB safety (plan Risk 5): startup integrity check + timestamped backups
 * of both database files before every migration and once per day on
 * first launch, retaining the last 7. Backups are plain file copies —
 * DuckDB and SQLite are both single-file-ish formats (DuckDB may also
 * have a `.wal` sidecar), so a checkpoint-then-copy is safe as long as no
 * writer is mid-transaction, which holds at the startup/pre-migration
 * points this module is called from.
 */
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmdirSync
} from 'fs'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'
import type { DuckDBConnection } from '@duckdb/node-api'
import type Database from 'better-sqlite3'

export const BACKUP_RETENTION_COUNT = 7

export interface BackupResult {
  timestampDir: string
  filesBackedUp: string[]
}

export interface IntegrityCheckResult {
  duckdb: { ok: boolean; error?: string }
  sqlite: { ok: boolean; error?: string }
}

function timestampForFilename(date: Date): string {
  // e.g. 2026-08-27T18-40-00-000Z-a1b2c3 — filesystem-safe, sortable, and
  // suffixed with a few random hex chars so two backups triggered within
  // the same millisecond (e.g. a double-clicked "back up now") never
  // collide into a single directory.
  const iso = date.toISOString().replace(/[:.]/g, '-')
  return `${iso}-${randomBytes(3).toString('hex')}`
}

/**
 * Copies `analytics.duckdb` (+ its `.wal` sidecar, if present) and
 * `meta.db` into `<backupsDir>/<timestamp>/`, then prunes older backup
 * directories beyond `BACKUP_RETENTION_COUNT`.
 *
 * Callers should checkpoint open connections (see `checkpointDuckDb`
 * below) before calling this, and must not have an open write
 * transaction in flight.
 */
export function backupDatabases(
  backupsDir: string,
  duckdbPath: string,
  metaDbPath: string
): BackupResult {
  mkdirSync(backupsDir, { recursive: true })

  const dirName = timestampForFilename(new Date())
  const destDir = join(backupsDir, dirName)
  mkdirSync(destDir, { recursive: true })

  const filesBackedUp: string[] = []
  const candidates = [duckdbPath, `${duckdbPath}.wal`, metaDbPath]
  for (const src of candidates) {
    if (existsSync(src)) {
      const dest = join(destDir, basename(src))
      copyFileSync(src, dest)
      filesBackedUp.push(dest)
    }
  }

  pruneOldBackups(backupsDir)

  return { timestampDir: destDir, filesBackedUp }
}

function pruneOldBackups(backupsDir: string): void {
  if (!existsSync(backupsDir)) return

  const entries = readdirSync(backupsDir)
    .map((name) => ({ name, path: join(backupsDir, name) }))
    .filter((entry) => statSync(entry.path).isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name)) // newest first (ISO names sort lexically)

  const stale = entries.slice(BACKUP_RETENTION_COUNT)
  for (const entry of stale) {
    for (const file of readdirSync(entry.path)) {
      unlinkSync(join(entry.path, file))
    }
    try {
      rmdirSync(entry.path)
    } catch {
      // non-fatal — an empty stale dir left behind isn't worth failing over
    }
  }
}

/** Flushes DuckDB's WAL into the main file so a file-copy backup is consistent. */
export async function checkpointDuckDb(connection: DuckDBConnection): Promise<void> {
  await connection.run('CHECKPOINT')
}

/**
 * Startup integrity check (Risk 5): a cheap real query against each
 * database. SQLite has a dedicated `PRAGMA integrity_check`; DuckDB has
 * no direct equivalent, so a successful catalog query is the practical
 * proxy — a corrupted DuckDB file fails to open or fails any query.
 */
export async function checkDuckDbIntegrity(
  connection: DuckDBConnection
): Promise<{ ok: boolean; error?: string }> {
  try {
    await connection.runAndReadAll('SELECT * FROM duckdb_tables()')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function checkSqliteIntegrity(db: Database.Database): { ok: boolean; error?: string } {
  try {
    const row = db.pragma('integrity_check', { simple: true }) as string
    return row === 'ok' ? { ok: true } : { ok: false, error: row }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
