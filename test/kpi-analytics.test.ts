/**
 * Aggregate-query tests for the Denials/AR/Payers cross-client analytics
 * (plan §5, Phase 2 chunk B) — a small hand-built fixture across TWO
 * clients so every nullable-`clientId` ("all active clients") code path
 * gets exercised alongside the single-client scoped path.
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDuckDb, type DuckDbHandle } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'
import * as analytics from '../src/main/kpi/analytics'

describe('kpi/analytics (cross-client aggregates)', () => {
  let dir: string
  let db: DuckDbHandle
  let clientAId: number
  let clientBId: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aethera-kpi-analytics-'))
    db = await openDuckDb(join(dir, 'analytics.duckdb'))
    await applyMigrations(db.connection, migrations)
    const c = db.connection

    const clientA = await c.runAndReadAll(
      `INSERT INTO clients (code, name, active) VALUES ('ANLYA', 'Analytics Client A', true) RETURNING client_id`
    )
    clientAId = Number(clientA.getRowObjectsJS()[0].client_id)
    const clientB = await c.runAndReadAll(
      `INSERT INTO clients (code, name, active) VALUES ('ANLYB', 'Analytics Client B', true) RETURNING client_id`
    )
    clientBId = Number(clientB.getRowObjectsJS()[0].client_id)

    const payerX = await c.runAndReadAll(
      `INSERT INTO payers (name, payer_class) VALUES ('Payer X', 'Commercial') RETURNING payer_id`
    )
    const payerXId = Number(payerX.getRowObjectsJS()[0].payer_id)
    const payerY = await c.runAndReadAll(
      `INSERT INTO payers (name, payer_class) VALUES ('Payer Y', 'Medicare') RETURNING payer_id`
    )
    const payerYId = Number(payerY.getRowObjectsJS()[0].payer_id)

    // Client A: one open claim (Payer X), 40 days old, with a denial.
    const claimA1 = await c.runAndReadAll(
      `INSERT INTO claims (client_id, payer_id, patient_key, claim_number, dos, created_at, first_submitted_at,
         status, total_charge, total_allowed, total_paid, patient_responsibility, patient_paid, balance, source, natural_key)
       VALUES (?, ?, 'ph-a1', 'A-CLM-1', '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
         'Open', 1000, 800, 300, 100, 20, 700, 'manual', 'anly-a1')
       RETURNING claim_id`,
      [clientAId, payerXId]
    )
    const claimA1Id = Number(claimA1.getRowObjectsJS()[0].claim_id)
    await c.run(
      `INSERT INTO denials (claim_id, carc_code, category, root_cause_stage, created_at) VALUES (?, 'CO-45', 'contractual_obligation', 'CODING', '2026-01-05T00:00:00Z')`,
      [claimA1Id]
    )
    await c.run(
      `INSERT INTO remittances (claim_id, source, received_at, total_paid) VALUES (?, 'ERA', '2026-01-10T00:00:00Z', 300)`,
      [claimA1Id]
    )

    // Client A: a second, closed claim (Payer X) — excluded from open-A/R aggregates.
    const claimA2 = await c.runAndReadAll(
      `INSERT INTO claims (client_id, payer_id, patient_key, claim_number, dos, created_at, first_submitted_at,
         status, total_charge, total_allowed, total_paid, patient_responsibility, patient_paid, balance, closed_at, source, natural_key)
       VALUES (?, ?, 'ph-a2', 'A-CLM-2', '2026-01-03', '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z',
         'Paid', 500, 500, 500, 0, 0, 0, '2026-01-20T00:00:00Z', 'manual', 'anly-a2')
       RETURNING claim_id`,
      [clientAId, payerXId]
    )
    void claimA2

    // Client B: one open claim (Payer Y), no denial, no remittance (payment lag insufficient data for Payer Y).
    await c.run(
      `INSERT INTO claims (client_id, payer_id, patient_key, claim_number, dos, created_at, first_submitted_at,
         status, total_charge, total_allowed, total_paid, patient_responsibility, patient_paid, balance, source, natural_key)
       VALUES (?, ?, 'ph-b1', 'B-CLM-1', '2026-01-06', '2026-01-06T00:00:00Z', '2026-01-07T00:00:00Z',
         'Open', 400, 0, 0, 50, 0, 400, 'manual', 'anly-b1')`,
      [clientBId, payerYId]
    )
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('listDenials', () => {
    it('scopes to one client when given a clientId', async () => {
      const rows = await analytics.listDenials(db.connection, clientAId, '2026-01')
      expect(rows).toHaveLength(1)
      expect(rows[0].clientCode).toBe('ANLYA')
      expect(rows[0].claimNumber).toBe('A-CLM-1')
      expect(rows[0].carcCode).toBe('CO-45')
      expect(rows[0].category).toBe('contractual_obligation')
      expect(rows[0].payerName).toBe('Payer X')
    })

    it('returns denials across all clients when clientId is null', async () => {
      const rows = await analytics.listDenials(db.connection, null, '2026-01')
      expect(rows).toHaveLength(1) // only client A has a denial in this fixture
      expect(rows[0].clientCode).toBe('ANLYA')
    })

    it('returns nothing for a period with no denials', async () => {
      const rows = await analytics.listDenials(db.connection, null, '2026-06')
      expect(rows).toEqual([])
    })
  })

  describe('denialRateTrend', () => {
    it('computes a NULL-not-zero rate per month, scoped by client', async () => {
      const points = await analytics.denialRateTrend(db.connection, clientAId, '2026-01', 2)
      expect(points).toHaveLength(2)
      const jan = points.find((p) => p.month === '2026-01')
      expect(jan?.ratePct).toBe(50) // 1 denial / 2 submitted claims for client A
      const dec = points.find((p) => p.month === '2025-12')
      expect(dec?.ratePct).toBeNull() // no submitted claims that month -> null, not 0
    })

    it('aggregates across all clients when clientId is null', async () => {
      const points = await analytics.denialRateTrend(db.connection, null, '2026-01', 1)
      // 1 denial / 3 submitted claims total (2 for client A, 1 for client B)
      expect(points[0].ratePct).toBeCloseTo(33.3, 1)
    })
  })

  describe('arAgingByClient', () => {
    it('buckets open claims per client, excluding closed claims', async () => {
      const rows = await analytics.arAgingByClient(db.connection)
      const codes = rows.map((r) => r.clientCode)
      expect(codes).toEqual(['ANLYA', 'ANLYB']) // sorted, closed A-CLM-2 excluded

      const clientA = rows.find((r) => r.clientCode === 'ANLYA')!
      // balance 700 + max(100-20,0)=80 -> 780, aged from 2026-01-02 (first_submitted_at)
      const totalA = Object.values(clientA.aging).reduce((a, b) => a + b, 0)
      expect(totalA).toBeCloseTo(780, 2)

      const clientB = rows.find((r) => r.clientCode === 'ANLYB')!
      // balance 400 + max(50-0,0)=50 -> 450
      const totalB = Object.values(clientB.aging).reduce((a, b) => a + b, 0)
      expect(totalB).toBeCloseTo(450, 2)
    })
  })

  describe('arPayerVsPatientSplit', () => {
    it('splits open A/R into insurance-owed vs. patient-owed, scoped by client', async () => {
      const split = await analytics.arPayerVsPatientSplit(db.connection, clientAId)
      expect(split.insurancePortion).toBeCloseTo(700, 2) // balance
      expect(split.patientPortion).toBeCloseTo(80, 2) // max(100-20,0)
    })

    it('aggregates across all clients when clientId is null', async () => {
      const split = await analytics.arPayerVsPatientSplit(db.connection, null)
      expect(split.insurancePortion).toBeCloseTo(1100, 2) // 700 + 400
      expect(split.patientPortion).toBeCloseTo(130, 2) // 80 + 50
    })
  })

  describe('topAgedClaims', () => {
    it('sorts open claims oldest-first across the scope and respects the limit', async () => {
      const rows = await analytics.topAgedClaims(db.connection, null, 1)
      expect(rows).toHaveLength(1)
      // Client A's claim is anchored earlier (2026-01-02) than client B's (2026-01-07) -> more days open.
      expect(rows[0].clientCode).toBe('ANLYA')
      expect(rows[0].amount).toBeCloseTo(780, 2)
    })
  })

  describe('payerAnalysis', () => {
    it('reports per-payer claim/charge/allowed/denial/lag metrics for a scope + period', async () => {
      const rows = await analytics.payerAnalysis(db.connection, null, '2026-01')
      const payerX = rows.find((r) => r.payerName === 'Payer X')!
      expect(payerX.claimsCount).toBe(2) // A-CLM-1 and A-CLM-2, both created in Jan
      expect(payerX.denialCount).toBe(1)
      expect(payerX.denialRatePct).toBe(50)
      expect(payerX.avgLagDays).toBe(8) // 2026-01-02 -> 2026-01-10
      expect(payerX.lagSampleCount).toBe(1)

      const payerY = rows.find((r) => r.payerName === 'Payer Y')!
      expect(payerY.claimsCount).toBe(1)
      expect(payerY.denialCount).toBe(0)
      expect(payerY.denialRatePct).toBe(0)
      // No remittances for Payer Y -> "insufficient data", never a fabricated lag.
      expect(payerY.avgLagDays).toBeNull()
      expect(payerY.lagSampleCount).toBe(0)
    })

    it('scopes to one client when given a clientId', async () => {
      const rows = await analytics.payerAnalysis(db.connection, clientBId, '2026-01')
      expect(rows).toHaveLength(1)
      expect(rows[0].payerName).toBe('Payer Y')
    })
  })

  describe('payerMixTrend', () => {
    it('returns charges-by-payer points for the trailing months, capped to the top payers', async () => {
      const points = await analytics.payerMixTrend(db.connection, null, '2026-01', 1)
      const jan = points.filter((p) => p.month === '2026-01')
      const payerX = jan.find((p) => p.payerName === 'Payer X')
      expect(payerX?.charges).toBeCloseTo(1500, 2) // 1000 + 500
      const payerY = jan.find((p) => p.payerName === 'Payer Y')
      expect(payerY?.charges).toBeCloseTo(400, 2)
    })
  })

  describe('daysInArTrend', () => {
    it('returns a NULL-not-zero days-in-AR series scoped by client', async () => {
      const points = await analytics.daysInArTrend(db.connection, clientAId, '2026-01', 2)
      const jan = points.find((p) => p.month === '2026-01')
      expect(jan?.daysInAr).not.toBeNull()
      expect(typeof jan?.daysInAr).toBe('number')
      const dec = points.find((p) => p.month === '2025-12')
      expect(dec?.daysInAr).toBeNull() // no charges that month -> null, not a fabricated ratio
    })
  })
})
