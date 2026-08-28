/**
 * `buildClientReport`'s `options.benchmark` injection (plan's beacon
 * paragraph, Phase 2 chunk C) — the benchmark block is assembled OUTSIDE
 * the KPI engine (by `LocalDataService`, which owns the Reference &
 * Benchmark connector's settings/health state) and passed in here, so
 * `buildClientReport` itself stays network-free. This is what keeps the
 * rcm-prototype parity crosscheck (`scripts/crosscheck-rcm.ts`, which
 * calls `buildClientReport` with no options) unaffected — see
 * docs/kpi-parity.md's benchmark-exclusion note.
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDuckDb, type DuckDbHandle } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'
import { buildClientReport } from '../src/main/kpi/client-report'
import type { BenchmarkBlock } from '../src/shared/domain'

describe('buildClientReport benchmark option', () => {
  let dir: string
  let db: DuckDbHandle
  let clientId: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-client-report-benchmark-test-'))
    db = await openDuckDb(join(dir, 'analytics.duckdb'))
    await applyMigrations(db.connection, migrations)
    const client = await db.connection.runAndReadAll(
      `INSERT INTO clients (code, name, active) VALUES ('BMKRPT', 'Benchmark Report Co', true) RETURNING client_id`
    )
    clientId = Number(client.getRowObjectsJS()[0].client_id)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults to benchmark: null when no options are passed (the empty-report path)', async () => {
    const report = await buildClientReport(db.connection, clientId, '2026-04')
    expect(report.benchmark).toBeNull()
  })

  it('carries through a pre-computed benchmark block when supplied', async () => {
    const benchmark: BenchmarkBlock = {
      state: 'NY',
      asOf: new Date().toISOString(),
      cpts: [
        {
          cptCode: '99213',
          description: 'Office o/p est low 20 min',
          avgAllowed: 120,
          claimsCount: 4,
          stateMedian: 168.75,
          statePercentile25: 70.6,
          statePercentile75: 231.0
        }
      ]
    }
    const report = await buildClientReport(db.connection, clientId, '2026-04', { benchmark })
    expect(report.benchmark).toEqual(benchmark)
  })

  it('also carries the benchmark option through the manual-entry fallback path', async () => {
    await db.connection.run(
      `INSERT INTO monthly_summaries (client_id, period_month, charges, source) VALUES (?, '2026-05-01', 1000, 'manual')`,
      [clientId]
    )
    const benchmark: BenchmarkBlock = { state: 'CA', asOf: new Date().toISOString(), cpts: [] }
    const report = await buildClientReport(db.connection, clientId, '2026-05', { benchmark })
    expect(report.source).toBe('manual')
    expect(report.benchmark).toEqual(benchmark)
  })

  it('reads source=synced from a connector-written monthly_summaries row', async () => {
    await db.connection.run(
      `INSERT INTO monthly_summaries (client_id, period_month, charges, source) VALUES (?, '2026-06-01', 2000, 'synced')`,
      [clientId]
    )
    const report = await buildClientReport(db.connection, clientId, '2026-06')
    expect(report.source).toBe('synced')
  })
})
