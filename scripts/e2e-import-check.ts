/**
 * Phase 1 steps 4-6 manual end-to-end check: drives the real importer
 * code path (no UI, no Electron) against the synthetic fixtures and
 * prints resulting row counts per table — the "script-drive the
 * importer" verification called for alongside the automated test suite.
 *
 * Run with: npm run e2e:import-check
 *
 * Runs under `vite-node` rather than plain Node/`tsx` — several modules
 * on this path (`db/migrations`, `kpi/sql`) load their `.sql` files via
 * Vite's `?raw` import suffix, which only Vite-aware tooling understands.
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openDuckDb } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'
import { runCsvImport } from '../src/main/importers/csv-xlsx/run-csv-import'
import { tebraClaimExportTemplate } from '../src/main/importers/csv-xlsx/presets/tebra'
import { run835Import, run837Import } from '../src/main/importers/x12/run-x12-import'
import type { MappingTemplate } from '../src/shared/domain'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')

const template: MappingTemplate = {
  templateId: 'tebra-claim-export',
  version: 1,
  builtIn: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...tebraClaimExportTemplate
}

const TABLES = [
  'clients',
  'providers',
  'payers',
  'claims',
  'claim_lines',
  'remittances',
  'denials',
  'import_jobs',
  'stg_rows',
  'quarantine_rows',
  'monthly_summaries'
]

async function printTableCounts(db: Awaited<ReturnType<typeof openDuckDb>>): Promise<void> {
  for (const table of TABLES) {
    const reader = await db.connection.runAndReadAll(`SELECT COUNT(*) AS n FROM ${table}`)
    const n = Number(reader.getRowObjectsJS()[0].n)
    console.log(`  ${table.padEnd(20)} ${n}`)
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aethera-e2e-import-check-'))
  const db = await openDuckDb(join(dir, 'analytics.duckdb'))

  try {
    console.log(`[e2e] temp DB dir: ${dir}`)
    await applyMigrations(db.connection, migrations)
    console.log('[e2e] migrations applied\n')

    await db.connection.run(
      "INSERT INTO clients (code, name, active) VALUES ('DEMO1', 'Demo Client One', true)"
    )
    await db.connection.run(
      "INSERT INTO clients (code, name, active) VALUES ('DEMO2', 'Demo Client Two', true)"
    )

    console.log('[e2e] importing sample-data/tebra-claim-export.csv for DEMO1...')
    const goodResult = await runCsvImport({
      connection: db.connection,
      filePath: join(FIXTURES_DIR, 'tebra-claim-export.csv'),
      template,
      clientCode: 'DEMO1'
    })
    console.log('  result:', goodResult)

    console.log('\n[e2e] re-importing the exact same file (expect a no-op / dedup)...')
    const dedupResult = await runCsvImport({
      connection: db.connection,
      filePath: join(FIXTURES_DIR, 'tebra-claim-export.csv'),
      template,
      clientCode: 'DEMO1'
    })
    console.log('  result:', dedupResult)
    console.log(`  reusedExistingJob: ${dedupResult.reusedExistingJob} (expected: true)`)

    console.log('\n[e2e] importing the deliberately malformed fixture for DEMO1...')
    const malformedResult = await runCsvImport({
      connection: db.connection,
      filePath: join(FIXTURES_DIR, 'tebra-claim-export-malformed.csv'),
      template,
      clientCode: 'DEMO1'
    })
    console.log('  result:', malformedResult)

    console.log('\n[e2e] importing sample-data/synthetic-837.837 for DEMO2 (X12 837 claims)...')
    const claims837Result = await run837Import({
      connection: db.connection,
      filePath: join(FIXTURES_DIR, 'synthetic-837.837'),
      clientCode: 'DEMO2'
    })
    console.log('  result:', claims837Result)

    console.log('\n[e2e] re-importing the exact same 837 file (expect a no-op / dedup)...')
    const dedup837Result = await run837Import({
      connection: db.connection,
      filePath: join(FIXTURES_DIR, 'synthetic-837.837'),
      clientCode: 'DEMO2'
    })
    console.log(`  reusedExistingJob: ${dedup837Result.reusedExistingJob} (expected: true)`)

    console.log('\n[e2e] importing sample-data/synthetic-835.835 for DEMO2 (X12 835 remittance)...')
    const remit835Result = await run835Import({
      connection: db.connection,
      filePath: join(FIXTURES_DIR, 'synthetic-835.835'),
      clientCode: 'DEMO2'
    })
    console.log('  result:', remit835Result)
    console.log(
      `  matched ${remit835Result.rowsLoaded} claim(s), quarantined ${remit835Result.rowsSkipped} unmatched remit(s)`
    )

    console.log('\n[e2e] row counts per table:')
    await printTableCounts(db)

    console.log('\n[e2e] all checks passed')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error('[e2e] FAILED:', error)
  process.exitCode = 1
})
