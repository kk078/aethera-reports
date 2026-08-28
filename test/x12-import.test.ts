import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDuckDb, type DuckDbHandle } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'
import { run835Import, run837Import } from '../src/main/importers/x12/run-x12-import'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')
const GOOD_837 = join(FIXTURES_DIR, 'synthetic-837.837')
const GOOD_835 = join(FIXTURES_DIR, 'synthetic-835.835')
const TRUNCATED_835 = join(FIXTURES_DIR, 'malformed-835-truncated-isa.835')
const WRONG_DELIMITERS_837 = join(FIXTURES_DIR, 'malformed-837-wrong-delimiters.837')

async function countRows(db: DuckDbHandle, sql: string): Promise<number> {
  const reader = await db.connection.runAndReadAll(sql)
  return Number(reader.getRowObjectsJS()[0].n)
}

describe('X12 835/837 import (end to end against a real DuckDB)', () => {
  let dir: string
  let db: DuckDbHandle

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-x12-import-test-'))
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

  describe('837 claim import', () => {
    it('upserts claims + claim_lines with source=x12 and natural_key dedup', async () => {
      const result = await run837Import({
        connection: db.connection,
        filePath: GOOD_837,
        clientCode: 'DEMO1'
      })

      expect(result.status).toBe('succeeded')
      expect(result.reusedExistingJob).toBe(false)
      expect(result.rowsRead).toBe(2)
      expect(result.rowsLoaded).toBe(2)
      expect(result.rowsSkipped).toBe(0)

      expect(await countRows(db, 'SELECT COUNT(*) AS n FROM claims')).toBe(2)
      expect(await countRows(db, 'SELECT COUNT(*) AS n FROM claim_lines')).toBe(2)

      const claimReader = await db.connection.runAndReadAll(
        "SELECT * FROM claims WHERE claim_number = 'CLAIM1001'"
      )
      const claim = claimReader.getRowObjectsJS()[0]
      expect(claim.source).toBe('x12')
      expect(Number(claim.total_charge)).toBe(500)
      const dos =
        claim.dos instanceof Date ? claim.dos.toISOString().slice(0, 10) : String(claim.dos)
      expect(dos).toBe('2026-01-05')
      expect(Number(claim.import_job_id)).toBe(result.jobId)
    })

    it('is a no-op the second time it imports the exact same file (dedup via file_sha256)', async () => {
      const first = await run837Import({
        connection: db.connection,
        filePath: GOOD_837,
        clientCode: 'DEMO1'
      })
      const second = await run837Import({
        connection: db.connection,
        filePath: GOOD_837,
        clientCode: 'DEMO1'
      })

      expect(second.reusedExistingJob).toBe(true)
      expect(second.jobId).toBe(first.jobId)
      expect(
        await countRows(db, "SELECT COUNT(*) AS n FROM import_jobs WHERE source_type = 'x12-837'")
      ).toBe(1)
      expect(await countRows(db, 'SELECT COUNT(*) AS n FROM claims')).toBe(2)
      expect(await countRows(db, 'SELECT COUNT(*) AS n FROM claim_lines')).toBe(2)
    })

    it('quarantines claims instead of failing the job when a wrong-delimiter file yields zero parseable claims', async () => {
      const result = await run837Import({
        connection: db.connection,
        filePath: WRONG_DELIMITERS_837,
        clientCode: 'DEMO1'
      })
      expect(result.status).toBe('succeeded_with_warnings')
      expect(result.rowsRead).toBe(0)
      expect(result.rowsLoaded).toBe(0)
      expect(result.warnings.length).toBeGreaterThan(0)

      const quarantined = await db.connection.runAndReadAll(
        'SELECT * FROM quarantine_rows WHERE import_job_id = ?',
        [result.jobId]
      )
      expect(quarantined.getRowObjectsJS().length).toBeGreaterThan(0)
    })
  })

  describe('835 remittance import', () => {
    it('matches CLAIM1001 (imported via 837 above), updates its paid/allowed/balance, and quarantines the unmatched claim', async () => {
      await run837Import({ connection: db.connection, filePath: GOOD_837, clientCode: 'DEMO1' })

      const result = await run835Import({
        connection: db.connection,
        filePath: GOOD_835,
        clientCode: 'DEMO1'
      })

      expect(result.status).toBe('succeeded_with_warnings') // one unmatched claim
      expect(result.rowsRead).toBe(2)
      expect(result.rowsLoaded).toBe(1)
      expect(result.rowsSkipped).toBe(1)

      // Matched claim was updated.
      const claimReader = await db.connection.runAndReadAll(
        "SELECT total_paid, total_allowed, patient_responsibility, balance FROM claims WHERE claim_number = 'CLAIM1001'"
      )
      const claim = claimReader.getRowObjectsJS()[0]
      expect(Number(claim.total_paid)).toBe(400)
      expect(Number(claim.total_allowed)).toBe(400)
      expect(Number(claim.patient_responsibility)).toBe(50)
      expect(Number(claim.balance)).toBe(100) // 500 charge - 400 paid - 0 patient paid

      // Both remits recorded: one matched (claim_id set), one unmatched (claim_id NULL).
      expect(await countRows(db, 'SELECT COUNT(*) AS n FROM remittances')).toBe(2)
      const unmatchedRemit = await db.connection.runAndReadAll(
        'SELECT claim_id FROM remittances WHERE payer_icn = ?',
        ['PAYERICN0002']
      )
      expect(unmatchedRemit.getRowObjectsJS()[0].claim_id).toBeNull()

      // Denials created from CAS on the matched claim (claim-level: none; line-level CO*45*100).
      const denials = await db.connection.runAndReadAll(
        'SELECT carc_code, category FROM denials WHERE claim_id = (SELECT claim_id FROM claims WHERE claim_number = ?)',
        ['CLAIM1001']
      )
      const denialRows = denials.getRowObjectsJS()
      expect(denialRows).toHaveLength(1)
      expect(denialRows[0].carc_code).toBe('45')
      expect(denialRows[0].category).toBe('contractual_obligation')

      // Unmatched remit surfaced like quarantine, same as an invalid CSV row.
      const quarantined = await db.connection.runAndReadAll(
        'SELECT reasons, target_entity FROM quarantine_rows WHERE import_job_id = ?',
        [result.jobId]
      )
      const quarantineRows = quarantined.getRowObjectsJS()
      expect(quarantineRows).toHaveLength(1)
      expect(quarantineRows[0].target_entity).toBe('remittances')
      const reasons = JSON.parse(String(quarantineRows[0].reasons)) as string[]
      expect(reasons[0]).toContain('CLAIM_UNMATCHED')
    })

    it('is a no-op the second time it imports the exact same file (dedup via file_sha256)', async () => {
      await run837Import({ connection: db.connection, filePath: GOOD_837, clientCode: 'DEMO1' })
      const first = await run835Import({
        connection: db.connection,
        filePath: GOOD_835,
        clientCode: 'DEMO1'
      })
      const second = await run835Import({
        connection: db.connection,
        filePath: GOOD_835,
        clientCode: 'DEMO1'
      })

      expect(second.reusedExistingJob).toBe(true)
      expect(second.jobId).toBe(first.jobId)
      expect(
        await countRows(db, "SELECT COUNT(*) AS n FROM import_jobs WHERE source_type = 'x12-835'")
      ).toBe(1)
      expect(await countRows(db, 'SELECT COUNT(*) AS n FROM remittances')).toBe(2)
    })

    it('records unmatched remits even with no prior claims at all', async () => {
      const result = await run835Import({
        connection: db.connection,
        filePath: GOOD_835,
        clientCode: 'DEMO1'
      })

      expect(result.status).toBe('succeeded_with_warnings')
      expect(result.rowsLoaded).toBe(0)
      expect(result.rowsSkipped).toBe(2)
      expect(
        await countRows(db, 'SELECT COUNT(*) AS n FROM remittances WHERE claim_id IS NULL')
      ).toBe(2)
      expect(await countRows(db, 'SELECT COUNT(*) AS n FROM denials')).toBe(0) // never attributed without a claim_id
    })

    it('fails the job cleanly (not a crash) on a truncated ISA', async () => {
      await expect(
        run835Import({ connection: db.connection, filePath: TRUNCATED_835, clientCode: 'DEMO1' })
      ).rejects.toThrow()

      const jobs = await db.connection.runAndReadAll(
        "SELECT status, error FROM import_jobs WHERE source_type = 'x12-835'"
      )
      const rows = jobs.getRowObjectsJS()
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('failed')
      expect(rows[0].error).not.toBeNull()
    })

    it('throws for an unknown client code', async () => {
      await expect(
        run835Import({ connection: db.connection, filePath: GOOD_835, clientCode: 'NOPE' })
      ).rejects.toThrow(/Unknown client code/)
    })
  })
})
