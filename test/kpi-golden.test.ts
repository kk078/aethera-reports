/**
 * Golden KPI tests (plan §4 / Risk 2b). Seeds a temp DuckDB with a small,
 * fully hand-specified claim set, then diffs `buildClientReport()`'s
 * output against the checked-in expected JSON in `sample-data/golden/`.
 *
 * The GOLD1 (claims) fixture uses period 2020-02, deliberately far in
 * the past: A/R aging bucketing depends on `daysBetween(anchor, today)`,
 * where "today" is the actual wall-clock date whenever this test runs.
 * Once an anchor is more than 120 days old it stays in the "120+" bucket
 * forever (day-count only grows), so a fixed 2020 date keeps the
 * expected aging buckets stable no matter when CI runs this test —
 * a fixture anchored a few months before "now" would not have that
 * property.
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDuckDb, type DuckDbHandle } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'
import { buildClientReport } from '../src/main/kpi/client-report'

const GOLDEN_DIR = join(__dirname, '..', 'sample-data', 'golden')

function loadExpected(name: string): unknown {
  const raw = JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf-8')) as Record<string, unknown>
  delete raw._comment
  return raw
}

describe('KPI golden tests', () => {
  let dir: string
  let db: DuckDbHandle

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-kpi-golden-'))
    db = await openDuckDb(join(dir, 'analytics.duckdb'))
    await applyMigrations(db.connection, migrations)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('GOLD1: claim-level data produces the hand-computed report', async () => {
    const c = db.connection
    const clientReader = await c.runAndReadAll(
      `INSERT INTO clients (code, name, contract_type, contract_rate, sla_days_to_submit, active)
       VALUES ('GOLD1', 'Golden Claims Client', 'PERCENT_OF_COLLECTIONS', 0.06, 3, true)
       RETURNING client_id`
    )
    const clientId = Number(clientReader.getRowObjectsJS()[0].client_id)

    // Claim A: open, first-pass (no denial), fully consistent balances.
    const claimA = await c.runAndReadAll(
      `INSERT INTO claims (client_id, patient_key, claim_number, dos, created_at, first_submitted_at,
         submission_count, status, total_charge, total_allowed, total_paid,
         patient_responsibility, patient_paid, balance, source, natural_key)
       VALUES (?, 'ph-a', 'CLM-A', '2020-02-01', '2020-02-05T00:00:00Z', '2020-02-06T00:00:00Z',
         1, 'Paid', 1000, 800, 700, 100, 100, 200, 'manual', 'gold1-nk-a')
       RETURNING claim_id`,
      [clientId]
    )
    const claimAId = Number(claimA.getRowObjectsJS()[0].claim_id)

    // Claim B: open, has a denial (so not first-pass), unpaid.
    const claimB = await c.runAndReadAll(
      `INSERT INTO claims (client_id, patient_key, claim_number, dos, created_at, first_submitted_at,
         submission_count, status, total_charge, total_allowed, total_paid,
         patient_responsibility, patient_paid, balance, source, natural_key)
       VALUES (?, 'ph-b', 'CLM-B', '2020-02-08', '2020-02-10T00:00:00Z', '2020-02-12T00:00:00Z',
         1, 'Denied', 500, 400, 0, 50, 0, 500, 'manual', 'gold1-nk-b')
       RETURNING claim_id`,
      [clientId]
    )
    const claimBId = Number(claimB.getRowObjectsJS()[0].claim_id)
    await c.run(
      `INSERT INTO denials (claim_id, carc_code, root_cause_stage, created_at) VALUES (?, 'CO-45', 'CODING', '2020-02-15T00:00:00Z')`,
      [claimBId]
    )

    // Claim C: closed (excluded from open_ar/aging, but still counted in
    // submitted/first-pass/status per production.py's un-scoped queries).
    const claimC = await c.runAndReadAll(
      `INSERT INTO claims (client_id, patient_key, claim_number, dos, created_at, first_submitted_at,
         submission_count, status, total_charge, total_allowed, total_paid,
         patient_responsibility, patient_paid, balance, closed_at, source, natural_key)
       VALUES (?, 'ph-c', 'CLM-C', '2020-02-18', '2020-02-20T00:00:00Z', '2020-02-25T00:00:00Z',
         1, 'Paid', 300, 300, 300, 0, 0, 0, '2020-02-26T00:00:00Z', 'manual', 'gold1-nk-c')
       RETURNING claim_id`,
      [clientId]
    )
    const claimCId = Number(claimC.getRowObjectsJS()[0].claim_id)

    await c.run(
      'INSERT INTO remittances (claim_id, source, received_at, total_paid) VALUES (?, ?, ?, ?)',
      [claimAId, 'ERA', '2020-02-20T00:00:00Z', 700]
    )
    await c.run(
      'INSERT INTO remittances (claim_id, source, received_at, total_paid) VALUES (?, ?, ?, ?)',
      [claimCId, 'ERA', '2020-02-26T00:00:00Z', 300]
    )
    await c.run(
      'INSERT INTO payments_patient (client_id, claim_id, received_at, amount) VALUES (?, ?, ?, ?)',
      [clientId, claimAId, '2020-02-21T00:00:00Z', 100]
    )

    const report = await buildClientReport(c, clientId, '2020-02')
    expect(report).toEqual(loadExpected('gold1-claims-expected.json'))
  })

  it('GOLD2: no claims, but a monthly_summaries row -> manual fallback', async () => {
    const c = db.connection
    const clientReader = await c.runAndReadAll(
      `INSERT INTO clients (code, name, contract_type, contract_rate, sla_days_to_submit, active)
       VALUES ('GOLD2', 'Golden Manual Client', 'PER_CLAIM', 25, 5, true)
       RETURNING client_id`
    )
    const clientId = Number(clientReader.getRowObjectsJS()[0].client_id)

    await c.run(
      `INSERT INTO monthly_summaries (client_id, period_month, charges, ins_collections, pt_collections,
         adjustments, open_ar, ar_aging_0_30, ar_aging_31_60, ar_aging_61_90, ar_aging_91_120,
         ar_aging_120_plus, claims_submitted, denials_count, notes)
       VALUES (?, '2020-03-01', 5000, 3000, 200, 100, 1200, 300, 400, 200, 200, 100, 10, 2, 'test')`,
      [clientId]
    )

    const report = await buildClientReport(c, clientId, '2020-03')
    expect(report).toEqual(loadExpected('gold2-manual-expected.json'))
  })

  it('GOLD3: no claims, no monthly_summaries -> nulls, not zeros (except the arOver90Pct quirk)', async () => {
    const c = db.connection
    const clientReader = await c.runAndReadAll(
      `INSERT INTO clients (code, name, sla_days_to_submit, active) VALUES ('GOLD3', 'Golden Empty Client', 7, true) RETURNING client_id`
    )
    const clientId = Number(clientReader.getRowObjectsJS()[0].client_id)

    const report = await buildClientReport(c, clientId, '2020-04')
    expect(report).toEqual(loadExpected('gold3-empty-expected.json'))

    // Explicit NULL-vs-0 assertions (plan Risk 2b), spelled out beyond the
    // blanket toEqual above so a future refactor can't silently swap a
    // null for a 0 without a test failure calling it out by name.
    expect(report.financials.netCollectionRatePct).toBeNull()
    expect(report.kpis.daysInAr).toBeNull()
    expect(report.kpis.chargeLagDaysAvg).toBeNull()
    expect(report.kpis.slaMetPct).toBeNull()
    expect(report.kpis.firstPassAcceptancePct).toBeNull()
    expect(report.kpis.denialRatePct).toBeNull()
    // The one documented exception (production.py line 199):
    expect(report.kpis.arOver90Pct).toBe(0)
  })
})
