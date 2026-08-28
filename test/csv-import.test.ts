import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDuckDb, type DuckDbHandle } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'
import { runCsvImport } from '../src/main/importers/csv-xlsx/run-csv-import'
import { tebraClaimExportTemplate } from '../src/main/importers/csv-xlsx/presets/tebra'
import type { MappingTemplate } from '../src/shared/domain'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')
const GOOD_FIXTURE = join(FIXTURES_DIR, 'tebra-claim-export.csv')
const MALFORMED_FIXTURE = join(FIXTURES_DIR, 'tebra-claim-export-malformed.csv')

const template: MappingTemplate = {
  templateId: 'tebra-claim-export',
  version: 1,
  builtIn: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...tebraClaimExportTemplate
}

describe('runCsvImport (preset vs fixture)', () => {
  let dir: string
  let db: DuckDbHandle

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-csv-import-test-'))
    db = await openDuckDb(join(dir, 'analytics.duckdb'))
    await applyMigrations(db.connection, migrations)
    await db.connection.run(
      "INSERT INTO clients (code, name, active) VALUES ('DEMO1', 'Demo Client One', true)"
    )
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('imports the synthetic Tebra fixture end to end with no quarantined rows', async () => {
    const result = await runCsvImport({
      connection: db.connection,
      filePath: GOOD_FIXTURE,
      template,
      clientCode: 'DEMO1'
    })

    expect(result.status).toBe('succeeded')
    expect(result.rowsSkipped).toBe(0)
    expect(result.rowsLoaded).toBeGreaterThan(150)
    expect(result.rowsLoaded).toBe(result.rowsRead)

    const claims = await db.connection.runAndReadAll('SELECT COUNT(*) AS n FROM claims')
    const lines = await db.connection.runAndReadAll('SELECT COUNT(*) AS n FROM claim_lines')
    const denials = await db.connection.runAndReadAll('SELECT COUNT(*) AS n FROM denials')
    const claimCount = Number(claims.getRowObjectsJS()[0].n)
    const lineCount = Number(lines.getRowObjectsJS()[0].n)
    const denialCount = Number(denials.getRowObjectsJS()[0].n)

    expect(claimCount).toBeGreaterThan(0)
    expect(lineCount).toBe(result.rowsLoaded) // one CSV row = one claim_lines row
    expect(claimCount).toBeLessThanOrEqual(lineCount) // some claims have >1 line
    expect(denialCount).toBeGreaterThan(0) // fixture includes denied claims

    // Claim totals should reflect the sum of their lines, not zero/garbage.
    const sample = await db.connection.runAndReadAll(
      'SELECT total_charge FROM claims WHERE total_charge > 0 LIMIT 1'
    )
    expect(sample.getRowObjectsJS()).toHaveLength(1)
  })

  it('is a no-op the second time it imports the exact same file (dedup via file_sha256)', async () => {
    const first = await runCsvImport({
      connection: db.connection,
      filePath: GOOD_FIXTURE,
      template,
      clientCode: 'DEMO1'
    })
    const second = await runCsvImport({
      connection: db.connection,
      filePath: GOOD_FIXTURE,
      template,
      clientCode: 'DEMO1'
    })

    expect(second.reusedExistingJob).toBe(true)
    expect(second.jobId).toBe(first.jobId)
    expect(second.rowsLoaded).toBe(first.rowsLoaded)

    const jobs = await db.connection.runAndReadAll('SELECT COUNT(*) AS n FROM import_jobs')
    expect(Number(jobs.getRowObjectsJS()[0].n)).toBe(1) // no second job row was created

    const claims = await db.connection.runAndReadAll('SELECT COUNT(*) AS n FROM claims')
    expect(Number(claims.getRowObjectsJS()[0].n)).toBeGreaterThan(0)
  })

  it('quarantines invalid rows without failing the job (Risk 3)', async () => {
    const result = await runCsvImport({
      connection: db.connection,
      filePath: MALFORMED_FIXTURE,
      template,
      clientCode: 'DEMO1'
    })

    expect(result.status).toBe('succeeded_with_warnings')
    expect(result.rowsRead).toBe(5)
    expect(result.rowsLoaded).toBe(2)
    expect(result.rowsSkipped).toBe(3)

    const quarantined = await db.connection.runAndReadAll(
      'SELECT reasons FROM quarantine_rows WHERE import_job_id = ? ORDER BY source_row_num',
      [result.jobId]
    )
    const rows = quarantined.getRowObjectsJS()
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      const reasons = JSON.parse(String(row.reasons)) as string[]
      expect(reasons.length).toBeGreaterThan(0)
    }

    // Every raw row still landed in staging, valid or not (plan §2).
    const staged = await db.connection.runAndReadAll(
      'SELECT COUNT(*) AS n FROM stg_rows WHERE import_job_id = ?',
      [result.jobId]
    )
    expect(Number(staged.getRowObjectsJS()[0].n)).toBe(5)
  })
})
