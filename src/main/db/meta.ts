/**
 * Connection management for the SQLite app-metadata store (`meta.db`):
 * settings, branding, mapping templates, connector credentials, export
 * audit log, UI state. No PHI ever lives here (plan §2) — that's what
 * keeps `analytics.duckdb` purely analytical.
 *
 * Phase 1 step 2 (walking skeleton) only needs a real open -> query ->
 * close round trip; the full meta schema lands alongside DuckDB
 * migrations in step 4.
 */
import Database from 'better-sqlite3'

export function openMetaDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  initMetaSchema(db)
  return db
}

/**
 * Creates meta.db's tables if they don't already exist (plan §2 / Phase
 * 1 step 4): settings, branding, mapping templates, export audit log.
 * SQLite's own schema is simple enough that idempotent `CREATE TABLE IF
 * NOT EXISTS` is sufficient — no separate migration-version table like
 * DuckDB's, since every statement here is safe to re-run.
 *
 * No PHI: mapping templates and settings are configuration, not patient
 * data; the export audit log records who/when/client/period, not claim
 * content.
 */
export function initMetaSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS branding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      firm_name TEXT NOT NULL DEFAULT 'Aethera Reports',
      logo_path TEXT,
      primary_color TEXT NOT NULL DEFAULT '#7c93ee',
      secondary_color TEXT NOT NULL DEFAULT '#222222',
      footer_disclaimer TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mapping_templates (
      template_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pm_system TEXT NOT NULL,
      target_entity TEXT NOT NULL,
      grain TEXT NOT NULL,
      columns_json TEXT NOT NULL,
      key_fields_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS export_audit_log (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      client_code TEXT,
      period_month TEXT,
      file_path TEXT,
      performed_at TEXT NOT NULL DEFAULT (datetime('now')),
      performed_by TEXT
    );

    -- Generic RCM Platform REST connector (plan §3 bullet 3, Phase 2
    -- chunk C) — connection config + the encrypted password blob.
    -- password_data/password_encoding are opaque to everything except
    -- src/main/credentials.ts (Electron safeStorage): 'safeStorage' means
    -- password_data is the base64 of safeStorage.encryptString()'s
    -- Buffer; 'plaintext' is the documented fallback for platforms/setups
    -- where safeStorage.isEncryptionAvailable() is false. LocalDataService
    -- never decodes this column itself — it stays Electron-free.
    CREATE TABLE IF NOT EXISTS connector_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_url TEXT,
      username TEXT,
      password_data TEXT,
      password_encoding TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-client sync cursor + status (plan §3: "sync cursor per client
    -- in SQLite"). created_by_connector flags a client the connector
    -- created (vs. one that already existed and was matched by code) —
    -- the Settings screen renders that as a "synced from connector" note.
    CREATE TABLE IF NOT EXISTS connector_sync_state (
      client_code TEXT PRIMARY KEY,
      last_synced_period TEXT,
      last_synced_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_by_connector INTEGER NOT NULL DEFAULT 0
    );

    -- Reference & Benchmark API connector (plan's beacon paragraph,
    -- Phase 2 chunk C) — optional, no credentials (beacon has none).
    CREATE TABLE IF NOT EXISTS reference_api_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:8110',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_health_ok INTEGER,
      last_health_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

/**
 * The walking-skeleton "hello query" for the metadata store — mirrors
 * `helloQueryDuckDb` so `--smoke` and the vitest DB test exercise both
 * native modules through the same shape of real code path.
 */
export function helloQuerySqlite(dbPath: string): number {
  const db = openMetaDb(dbPath)
  try {
    const row = db.prepare('SELECT 1 AS one').get() as { one: number } | undefined
    if (!row || typeof row.one !== 'number') {
      throw new Error(`expected SELECT 1 to return a number, got: ${JSON.stringify(row)}`)
    }
    return row.one
  } finally {
    db.close()
  }
}
