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
 * Adds `column` to `table` if it isn't there yet — meta.db has no
 * migration-version table (unlike DuckDB's `applyMigrations`; see
 * `initMetaSchema`'s doc comment), so a schema addition to an
 * already-created table needs this instead of a plain `CREATE TABLE IF
 * NOT EXISTS` (which only matters for brand-new tables). `ddl` is the
 * column definition after `ADD COLUMN` (e.g. `"foo INTEGER DEFAULT 0"`);
 * `table`/`column`/`ddl` are always literal strings from this file, never
 * user input, so simple string interpolation is fine here.
 */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
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

    -- Watch-folder auto-import (plan §11, Phase 2 chunk D). The inbox
    -- root itself is a plain key in settings (key='automation_inbox_root')
    -- — this table is only the per-client-folder mapping template pin
    -- ("CSV/XLSX files need a template pinned per folder"); X12 files
    -- never need one (routed by the importer registry's detect()).
    CREATE TABLE IF NOT EXISTS automation_folder_templates (
      client_code TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Report scheduler rules (plan §11). clients_json is either the
    -- literal string "all" or a JSON array of client codes; formats_json
    -- is a JSON array of ExportFormat. last_run_period/last_run_at
    -- implement "run at most once per period" + missed-run catch-up:
    -- a rule is due when enabled, today's day-of-month >= day_of_month,
    -- and last_run_period != the period it would run for (see
    -- src/main/automation/scheduler.ts's pure due-logic).
    CREATE TABLE IF NOT EXISTS automation_rules (
      rule_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      day_of_month INTEGER NOT NULL,
      clients_json TEXT NOT NULL DEFAULT '"all"',
      formats_json TEXT NOT NULL DEFAULT '["pdf"]',
      output_dir TEXT,
      deliver TEXT NOT NULL DEFAULT 'none',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_period TEXT,
      last_run_at TEXT,
      last_run_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- SMTP settings (plan §11 email delivery) — singleton, password
    -- encrypted the same way as the RCM connector's (src/main/credentials.ts).
    CREATE TABLE IF NOT EXISTS email_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      host TEXT,
      port INTEGER,
      secure INTEGER NOT NULL DEFAULT 1,
      username TEXT,
      password_data TEXT,
      password_encoding TEXT,
      from_address TEXT,
      subject_template TEXT NOT NULL DEFAULT 'Your {client} report — {period}',
      body_template TEXT NOT NULL DEFAULT 'Attached is the {client} revenue cycle report for {period}.',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Failed/queued report-pack sends (plan §11: "failed sends queue in
    -- meta.db with retry"). file_paths_json/recipients_json are JSON
    -- string arrays. A send starts here as 'pending', flips to 'sent' or
    -- 'failed' — failed rows are retried manually (Automation screen) or
    -- automatically on the next scheduler tick.
    CREATE TABLE IF NOT EXISTS email_send_queue (
      queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_code TEXT NOT NULL,
      period_month TEXT NOT NULL,
      file_paths_json TEXT NOT NULL,
      recipients_json TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_attempt_at TEXT
    );

    -- Hosted client portal settings (Phase 3 chunk F) — singleton, admin
    -- token encrypted the same way as the RCM connector's password / SMTP
    -- password (src/main/credentials.ts).
    CREATE TABLE IF NOT EXISTS portal_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_url TEXT,
      admin_token_data TEXT,
      admin_token_encoding TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Claim-level sync (docs/connectors.md "Claim-level sync") additions to
  // the two tables above — added after both tables already shipped, so
  // `CREATE TABLE IF NOT EXISTS` alone won't backfill them on an existing
  // meta.db; see `ensureColumn`'s doc comment.
  //
  // sync_claim_level: opt-in toggle, default ON (1) — matches
  // `connectorSettingsSchema.syncClaimLevel`'s documented default.
  ensureColumn(
    db,
    'connector_settings',
    'sync_claim_level',
    'sync_claim_level INTEGER NOT NULL DEFAULT 1'
  )
  // last_batch_cursor: the highest platform `SubmissionBatch.id` this
  // client has successfully imported (837.edi -> run837Import) — the
  // claim-level sync's since-cursor, same role as
  // `last_synced_period`/`last_synced_at` play for the summary sync.
  // NULL means "never batch-synced yet."
  ensureColumn(db, 'connector_sync_state', 'last_batch_cursor', 'last_batch_cursor INTEGER')
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
