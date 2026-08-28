/**
 * Cross-client analytics aggregates for the Denials/AR/Payers screens
 * (plan §5, Phase 2 chunk B). Unlike `client-report.ts` (always exactly
 * one client), every function here takes a nullable `clientId` — `null`
 * means "all active clients", the default these screens open with.
 * Reuses `kpi/aging.ts`'s bucket/amount helpers so this can never drift
 * from the single-client A/R aging math in `client-report.ts` (Risk 2,
 * extended to these screens).
 *
 * No Electron imports (enforced by `eslint.config.mjs`'s
 * `no-restricted-imports` rule for `kpi/`).
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { kpiSql } from './sql'
import { ratePercent, round2 } from './rate'
import { AGING_BUCKET_ORDER, EMPTY_AGING, bucketForDays, openClaimAmount } from './aging'
import {
  daysBetween,
  daysBetweenInclusive,
  monthPeriod,
  trailing12Months
} from '../../shared/periods'
import type {
  ArAgingBuckets,
  ArAgingByClientRow,
  DaysInArTrendPoint,
  DenialListRow,
  MonthlyRateTrendPoint,
  PayerAnalysisRow,
  PayerMixTrendPoint,
  PayerVsPatientSplit,
  TopAgedClaimRow
} from '../../shared/domain'

function num(value: unknown): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value)
}

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
}

function isoDateTime(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

// ---------------------------------------------------------------------
// Denials
// ---------------------------------------------------------------------

/**
 * Flat denial rows for a scope + period. The Denials screen derives its
 * CARC pareto, denials-by-payer table, and root-cause breakdown all from
 * THIS same result set (grouped client-side by `carcCode`/`payerName`/
 * `rootCauseStage`) rather than three separate aggregate queries — one
 * round trip, one source of truth for "what counts as a denial in this
 * scope+period."
 */
export async function listDenials(
  connection: DuckDBConnection,
  clientId: number | null,
  periodMonth: string
): Promise<DenialListRow[]> {
  const period = monthPeriod(periodMonth)
  const start = `${period.start}T00:00:00.000Z`
  const end = `${period.end}T23:59:59.999Z`
  const reader = await connection.runAndReadAll(kpiSql.denialsList, [
    clientId,
    clientId,
    start,
    end
  ])
  return reader.getRowObjectsJS().map((row) => ({
    denialId: num(row.denial_id),
    clientCode: String(row.client_code),
    claimNumber: (row.claim_number as string | null) ?? null,
    externalRef: (row.external_ref as string | null) ?? null,
    dos: isoDate(row.dos),
    payerName: String(row.payer_name),
    carcCode: (row.carc_code as string | null) ?? null,
    rarcCode: (row.rarc_code as string | null) ?? null,
    category: String(row.category),
    rootCauseStage: (row.root_cause_stage as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    recoveredAmount: nullableNum(row.recovered_amount),
    createdAt: isoDateTime(row.created_at),
    resolvedAt: row.resolved_at ? isoDateTime(row.resolved_at) : null
  }))
}

/** Trailing-month denial-rate series (NULL-not-zero for a month with no submitted claims). */
export async function denialRateTrend(
  connection: DuckDBConnection,
  clientId: number | null,
  endPeriodMonth: string,
  monthsBack = 6
): Promise<MonthlyRateTrendPoint[]> {
  const months = trailing12Months(endPeriodMonth).slice(-monthsBack)
  const points: MonthlyRateTrendPoint[] = []
  for (const month of months) {
    const period = monthPeriod(month)
    const start = `${period.start}T00:00:00.000Z`
    const end = `${period.end}T23:59:59.999Z`
    const reader = await connection.runAndReadAll(kpiSql.denialRateTrendInputs, [
      clientId,
      clientId,
      start,
      end,
      clientId,
      clientId,
      start,
      end
    ])
    const row = reader.getRowObjectsJS()[0]
    const submitted = num(row?.submitted_count)
    const denied = num(row?.denial_count)
    points.push({ month, ratePct: submitted ? ratePercent(denied, submitted) : null })
  }
  return points
}

// ---------------------------------------------------------------------
// A/R
// ---------------------------------------------------------------------

interface OpenClaimDetailRow {
  clientCode: string
  claimNumber: string | null
  externalRef: string | null
  dos: string | null
  payerName: string
  balance: number
  patientResponsibility: number
  patientPaid: number
  anchor: string
}

async function fetchOpenClaimsDetail(
  connection: DuckDBConnection,
  clientId: number | null
): Promise<OpenClaimDetailRow[]> {
  const reader = await connection.runAndReadAll(kpiSql.openClaimsAgingDetail, [clientId, clientId])
  return reader.getRowObjectsJS().map((row) => ({
    clientCode: String(row.client_code),
    claimNumber: (row.claim_number as string | null) ?? null,
    externalRef: (row.external_ref as string | null) ?? null,
    dos: isoDate(row.dos),
    payerName: String(row.payer_name),
    balance: num(row.balance),
    patientResponsibility: num(row.patient_responsibility),
    patientPaid: num(row.patient_paid),
    anchor: isoDateTime(row.anchor)
  }))
}

/** Open A/R aging, one bucket set per client (plan §5 AR screen's stacked-by-client chart). */
export async function arAgingByClient(connection: DuckDBConnection): Promise<ArAgingByClientRow[]> {
  const rows = await fetchOpenClaimsDetail(connection, null)
  const nowIso = new Date().toISOString()
  const byClient = new Map<string, ArAgingBuckets>()

  for (const row of rows) {
    const amount = openClaimAmount(row.balance, row.patientResponsibility, row.patientPaid)
    const bucket = bucketForDays(daysBetween(row.anchor, nowIso))
    const aging = byClient.get(row.clientCode) ?? { ...EMPTY_AGING }
    aging[bucket] += amount
    byClient.set(row.clientCode, aging)
  }

  return Array.from(byClient.entries())
    .map(([clientCode, aging]) => ({
      clientCode,
      aging: AGING_BUCKET_ORDER.reduce<ArAgingBuckets>(
        (acc, bucket) => ({ ...acc, [bucket]: round2(aging[bucket]) }),
        { ...EMPTY_AGING }
      )
    }))
    .sort((a, b) => a.clientCode.localeCompare(b.clientCode))
}

/** Open A/R split between the insurance-owed and patient-owed portions (plan §5 AR screen). */
export async function arPayerVsPatientSplit(
  connection: DuckDBConnection,
  clientId: number | null
): Promise<PayerVsPatientSplit> {
  const rows = await fetchOpenClaimsDetail(connection, clientId)
  let insurancePortion = 0
  let patientPortion = 0
  for (const row of rows) {
    insurancePortion += row.balance
    patientPortion += Math.max(row.patientResponsibility - row.patientPaid, 0)
  }
  return { insurancePortion: round2(insurancePortion), patientPortion: round2(patientPortion) }
}

/** The N oldest-by-days open claims across the scope, for the AR screen's drill-down table. */
export async function topAgedClaims(
  connection: DuckDBConnection,
  clientId: number | null,
  limit = 25
): Promise<TopAgedClaimRow[]> {
  const rows = await fetchOpenClaimsDetail(connection, clientId)
  const nowIso = new Date().toISOString()
  return rows
    .map((row) => ({
      clientCode: row.clientCode,
      claimNumber: row.claimNumber,
      externalRef: row.externalRef,
      payerName: row.payerName,
      dos: row.dos,
      amount: round2(openClaimAmount(row.balance, row.patientResponsibility, row.patientPaid)),
      daysOpen: daysBetween(row.anchor, nowIso)
    }))
    .sort((a, b) => b.daysOpen - a.daysOpen)
    .slice(0, limit)
}

/**
 * Best-effort trailing days-in-AR trend. There is no historical A/R
 * snapshot table populated yet (`kpi_snapshots` — see `kpi-trends.ts`),
 * so a past month's "open AR" is reconstructed from claims that were
 * still open as of that month-end (`closed_at IS NULL OR closed_at >
 * monthEnd`, anchored `<= monthEnd`), using each claim's CURRENT
 * balance/patient-responsibility/patient-paid as a stand-in for their
 * value as of that date (claims don't carry a balance history either).
 * Exact for a claim still open today; reads slightly low for one paid
 * down further since. Documented approximation, not silently wrong —
 * the alternative (nothing at all) is a worse trend chart.
 */
export async function daysInArTrend(
  connection: DuckDBConnection,
  clientId: number | null,
  endPeriodMonth: string,
  monthsBack = 6
): Promise<DaysInArTrendPoint[]> {
  const months = trailing12Months(endPeriodMonth).slice(-monthsBack)
  const points: DaysInArTrendPoint[] = []

  for (const month of months) {
    const period = monthPeriod(month)
    const start = `${period.start}T00:00:00.000Z`
    const end = `${period.end}T23:59:59.999Z`
    const [chargesReader, openReader] = await Promise.all([
      connection.runAndReadAll(kpiSql.createdClaimsScoped, [clientId, clientId, start, end]),
      connection.runAndReadAll(kpiSql.openClaimsAsOfDate, [clientId, clientId, end, end])
    ])

    const charges = chargesReader
      .getRowObjectsJS()
      .reduce((sum, row) => sum + num(row.total_charge), 0)
    const avgDailyCharge = charges / Math.max(1, daysBetweenInclusive(period.start, period.end))

    let openAr = 0
    for (const row of openReader.getRowObjectsJS()) {
      openAr += openClaimAmount(
        num(row.balance),
        num(row.patient_responsibility),
        num(row.patient_paid)
      )
    }

    points.push({
      month,
      daysInAr: avgDailyCharge ? Math.round((openAr / avgDailyCharge) * 10) / 10 : null
    })
  }

  return points
}

// ---------------------------------------------------------------------
// Payers
// ---------------------------------------------------------------------

/** Per-payer snapshot for a scope + period: mix, avg allowed vs. charge, denial rate, payment lag. */
export async function payerAnalysis(
  connection: DuckDBConnection,
  clientId: number | null,
  periodMonth: string
): Promise<PayerAnalysisRow[]> {
  const period = monthPeriod(periodMonth)
  const start = `${period.start}T00:00:00.000Z`
  const end = `${period.end}T23:59:59.999Z`
  const reader = await connection.runAndReadAll(kpiSql.payerAnalysis, [
    clientId,
    clientId,
    start,
    end,
    clientId,
    clientId,
    start,
    end,
    clientId,
    clientId,
    start,
    end
  ])

  return reader.getRowObjectsJS().map((row) => {
    const claimsCount = num(row.claims_count)
    const denialCount = num(row.denial_count)
    const totalCharge = num(row.total_charge)
    const totalAllowed = num(row.total_allowed)
    return {
      payerName: String(row.payer_name),
      claimsCount,
      totalCharge: round2(totalCharge),
      totalAllowed: round2(totalAllowed),
      avgCharge: claimsCount ? round2(totalCharge / claimsCount) : 0,
      avgAllowed: claimsCount ? round2(totalAllowed / claimsCount) : 0,
      denialCount,
      denialRatePct: claimsCount ? ratePercent(denialCount, claimsCount) : null,
      avgLagDays: row.avg_lag_days === null ? null : Math.round(num(row.avg_lag_days) * 10) / 10,
      lagSampleCount: num(row.lag_sample_count)
    }
  })
}

const PAYER_MIX_TREND_TOP_N = 5

/** Charges-by-payer over the trailing months, capped to the top N payers by total charge (chart legibility). */
export async function payerMixTrend(
  connection: DuckDBConnection,
  clientId: number | null,
  endPeriodMonth: string,
  monthsBack = 6
): Promise<PayerMixTrendPoint[]> {
  const months = trailing12Months(endPeriodMonth).slice(-monthsBack)
  const byMonth = new Map<string, Array<{ payerName: string; charges: number }>>()

  for (const month of months) {
    const period = monthPeriod(month)
    const start = `${period.start}T00:00:00.000Z`
    const end = `${period.end}T23:59:59.999Z`
    const reader = await connection.runAndReadAll(kpiSql.payerMixScoped, [
      clientId,
      clientId,
      start,
      end
    ])
    byMonth.set(
      month,
      reader
        .getRowObjectsJS()
        .map((row) => ({ payerName: String(row.payer_name), charges: num(row.charges) }))
    )
  }

  const totalsByPayer = new Map<string, number>()
  for (const rows of byMonth.values()) {
    for (const row of rows) {
      totalsByPayer.set(row.payerName, (totalsByPayer.get(row.payerName) ?? 0) + row.charges)
    }
  }
  const topPayers = Array.from(totalsByPayer.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, PAYER_MIX_TREND_TOP_N)
    .map(([name]) => name)

  const points: PayerMixTrendPoint[] = []
  for (const month of months) {
    const rows = byMonth.get(month) ?? []
    const byPayer = new Map(rows.map((r) => [r.payerName, r.charges]))
    for (const payerName of topPayers) {
      points.push({ month, payerName, charges: round2(byPayer.get(payerName) ?? 0) })
    }
  }
  return points
}
