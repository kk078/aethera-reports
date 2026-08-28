import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  BACKUP_RETENTION_COUNT,
  backupDatabases,
  checkSqliteIntegrity
} from '../src/main/db/backup'

describe('backupDatabases', () => {
  let dir: string
  let duckdbPath: string
  let metaDbPath: string
  let backupsDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-backup-test-'))
    duckdbPath = join(dir, 'analytics.duckdb')
    metaDbPath = join(dir, 'meta.db')
    backupsDir = join(dir, 'backups')
    writeFileSync(duckdbPath, 'fake duckdb bytes')
    writeFileSync(metaDbPath, 'fake sqlite bytes')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('copies both database files into a new timestamped directory', () => {
    const result = backupDatabases(backupsDir, duckdbPath, metaDbPath)
    expect(existsSync(result.timestampDir)).toBe(true)
    expect(result.filesBackedUp).toHaveLength(2)
    for (const file of result.filesBackedUp) {
      expect(existsSync(file)).toBe(true)
    }
  })

  it('retains only the last N backups', () => {
    for (let i = 0; i < BACKUP_RETENTION_COUNT + 3; i++) {
      backupDatabases(backupsDir, duckdbPath, metaDbPath)
    }
    const remaining = readdirSync(backupsDir)
    expect(remaining.length).toBeLessThanOrEqual(BACKUP_RETENTION_COUNT)
  })
})

describe('checkSqliteIntegrity', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-integrity-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports ok for a healthy database', () => {
    const db = new Database(join(dir, 'meta.db'))
    db.exec('CREATE TABLE t (id INTEGER)')
    const result = checkSqliteIntegrity(db)
    db.close()
    expect(result.ok).toBe(true)
  })
})
