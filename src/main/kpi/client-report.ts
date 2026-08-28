/**
 * Port of `client_report()` (`app/services/production.py` lines
 * 152-211) — see `docs/kpi-parity.md` for the field-by-field contract
 * table with exact source-line citations. This function returns the
 * subset of that shape our schema supports (volume, financials, kpis,
 * ar_aging, kpi_trends, denials_by_root_cause, claims_by_status) per
 * plan §4 — `specialty`/`ai_coding` have no analog in our schema and are
 * intentionally omitted, not stubbed.
 *
 * Fallback ladder (plan §4): claim-level data for this client -> the
 * `monthly_summaries` row for this client-month -> an empty claims-shaped
 * report. `source` on the result says which one produced the numbers.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { kpiSql } from './sql'
import { ratePercent, round2 } from './rate'
import { buildKpiTrends } from './kpi-trends'
import { daysBetween, daysBetweenInclusive, monthPeriod, todayUtcIso } from '../../shared/periods'
import type { ArAgingBuckets, ClientReport } from '../../shared/domain'

const EMPTY_AGING: ArAgingBuckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 }

interface ClientRow {
  clientId: number
  code: string
  name: string
  contractType: string | null
  contractRate: number | null
  slaDaysToSubmit: number | null
}

async function fetchClient(
  connection: DuckDBConnection,
  clientId: number
): Promise<ClientRow | null> {
  const reader = await connection.runAndReadAll(
    'SELECT client_id, code, name, contract_type, contract_rate, sla_days_to_submit FROM clients WHERE client_id = ?',
    [clientId]
  )
  const rows = reader.getRowObjectsJS()
  if (rows.length === 0) return null
  const row = rows[0]
  return {
    clientId: Number(row.client_id),
    code: String(row.code),
    name: String(row.name),
    contractType: (row.contract_type as string | null) ?? null,
    contractRate: row.contract_rate === null ? null : Number(row.contract_rate),
    slaDaysToSubmit: row.sla_days_to_submit === null ? null : Number(row.sla_days_to_submit)
  }
}

/** production.py line 192: `f"{rate*100:g}% of collections"` / `f"${rate:,.2f} per claim"`. */
function formatContract(contractType: string | null, contractRate: number | null): string {
  if (contractRate === null) return 'no contract on file'
  if (contractType === 'PERCENT_OF_COLLECTIONS') {
    const pct = contractRate * 100
    return `${Number(pct.toFixed(4))}% of collections`
  }
  return `$${contractRate.toFixed(2)} per claim`
}

/** production.py line 197: `c.total_allowed or c.total_charge` — 0 is falsy in Python too. */
function allowedOrCharge(totalAllowed: number, totalCharge: number): number {
  return totalAllowed || totalCharge
}

interface AgingRow {
  claim_id: unknown
  balance: unknown
  patient_responsibility: unknown
  patient_paid: unknown
  anchor: unknown
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

function anchorIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/** production.py lines 165-172: open-claim balance expression and day-bucketing, verbatim. */
function computeAging(rows: AgingRow[], nowIso: string): { openAr: number; aging: ArAgingBuckets } {
  let openAr = 0
  const aging: ArAgingBuckets = { ...EMPTY_AGING }

  for (const row of rows) {
    const balance = num(row.balance)
    const patientResponsibility = num(row.patient_responsibility)
    const patientPaid = num(row.patient_paid)
    const amount = balance + Math.max(patientResponsibility - patientPaid, 0)
    openAr += amount

    const days = daysBetween(anchorIso(row.anchor), nowIso)
    const bucket: keyof ArAgingBuckets =
      days <= 30
        ? '0-30'
        : days <= 60
          ? '31-60'
          : days <= 90
            ? '61-90'
            : days <= 120
              ? '91-120'
              : '120+'
    aging[bucket] += amount
  }

  const roundedAging: ArAgingBuckets = {
    '0-30': round2(aging['0-30']),
    '31-60': round2(aging['31-60']),
    '61-90': round2(aging['61-90']),
    '91-120': round2(aging['91-120']),
    '120+': round2(aging['120+'])
  }
  return { openAr, aging: roundedAging }
}

async function buildEmptyReport(
  connection: DuckDBConnection,
  client: ClientRow,
  periodMonth: string
): Promise<ClientReport> {
  const period = monthPeriod(periodMonth)
  const kpiTrends = await buildKpiTrends(connection, client.clientId, period.end)
  return {
    client: {
      code: client.code,
      name: client.name,
      contract: formatContract(client.contractType, client.contractRate)
    },
    period,
    source: 'claims',
    volume: { encountersReceived: 0, claimsSubmitted: 0, denialsReceived: 0 },
    financials: {
      grossCharges: 0,
      insuranceCollections: 0,
      patientCollections: 0,
      totalCollections: 0,
      rcmFee: 0,
      netCollectionRatePct: null
    },
    kpis: {
      daysInAr: null,
      openAr: 0,
      arOver90Pct: 0,
      chargeLagDaysAvg: null,
      slaDaysToSubmit: client.slaDaysToSubmit,
      slaMetPct: null,
      firstPassAcceptancePct: null,
      denialRatePct: null
    },
    arAging: { ...EMPTY_AGING },
    kpiTrends,
    denialsByRootCause: {},
    claimsByStatus: {},
    payerMix: []
  }
}

/** Manual-entry fallback: build the report shape from a `monthly_summaries` row (plan §4). */
function buildManualReport(
  client: ClientRow,
  period: { start: string; end: string },
  summary: {
    charges: number | null
    insCollections: number | null
    ptCollections: number | null
    openAr: number | null
    arAging0To30: number | null
    arAging31To60: number | null
    arAging61To90: number | null
    arAging91To120: number | null
    arAging120Plus: number | null
    claimsSubmitted: number | null
    denialsCount: number | null
  },
  kpiTrends: ClientReport['kpiTrends']
): ClientReport {
  const totalCollections = (summary.insCollections ?? 0) + (summary.ptCollections ?? 0)
  const openAr = summary.openAr ?? 0
  const arOver90 = (summary.arAging91To120 ?? 0) + (summary.arAging120Plus ?? 0)
  return {
    client: {
      code: client.code,
      name: client.name,
      contract: formatContract(client.contractType, client.contractRate)
    },
    period,
    source: 'manual',
    volume: {
      encountersReceived: summary.claimsSubmitted ?? 0,
      claimsSubmitted: summary.claimsSubmitted ?? 0,
      denialsReceived: summary.denialsCount ?? 0
    },
    financials: {
      grossCharges: summary.charges ?? 0,
      insuranceCollections: summary.insCollections ?? 0,
      patientCollections: summary.ptCollections ?? 0,
      totalCollections,
      rcmFee:
        client.contractType === 'PERCENT_OF_COLLECTIONS'
          ? totalCollections * (client.contractRate ?? 0)
          : (summary.claimsSubmitted ?? 0) * (client.contractRate ?? 0),
      netCollectionRatePct: null // not derivable from an aggregate monthly summary
    },
    kpis: {
      daysInAr: null,
      openAr,
      arOver90Pct: openAr ? (ratePercent(arOver90, openAr) ?? 0) : 0,
      chargeLagDaysAvg: null,
      slaDaysToSubmit: client.slaDaysToSubmit,
      slaMetPct: null,
      firstPassAcceptancePct: null,
      denialRatePct: summary.claimsSubmitted
        ? ratePercent(summary.denialsCount ?? 0, summary.claimsSubmitted)
        : null
    },
    arAging: {
      '0-30': round2(summary.arAging0To30 ?? 0),
      '31-60': round2(summary.arAging31To60 ?? 0),
      '61-90': round2(summary.arAging61To90 ?? 0),
      '91-120': round2(summary.arAging91To120 ?? 0),
      '120+': round2(summary.arAging120Plus ?? 0)
    },
    kpiTrends,
    denialsByRootCause: {},
    claimsByStatus: {},
    payerMix: []
  }
}

export async function buildClientReport(
  connection: DuckDBConnection,
  clientId: number,
  periodMonth: string
): Promise<ClientReport> {
  const client = await fetchClient(connection, clientId)
  if (!client) throw new Error(`Unknown client_id: ${clientId}`)

  const period = monthPeriod(periodMonth)
  const periodStartDt = `${period.start}T00:00:00.000Z`
  const periodEndDt = `${period.end}T23:59:59.999Z`

  const totalClaimsReader = await connection.runAndReadAll(
    'SELECT COUNT(*) AS n FROM claims WHERE client_id = ?',
    [clientId]
  )
  const hasClaimData = Number(totalClaimsReader.getRowObjectsJS()[0].n) > 0

  if (!hasClaimData) {
    const summaryReader = await connection.runAndReadAll(
      'SELECT * FROM monthly_summaries WHERE client_id = ? AND period_month = ?',
      [clientId, period.start]
    )
    const summaryRows = summaryReader.getRowObjectsJS()
    const kpiTrends = await buildKpiTrends(connection, clientId, period.end)
    if (summaryRows.length > 0) {
      const s = summaryRows[0]
      const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
      return buildManualReport(
        client,
        period,
        {
          charges: n(s.charges),
          insCollections: n(s.ins_collections),
          ptCollections: n(s.pt_collections),
          openAr: n(s.open_ar),
          arAging0To30: n(s.ar_aging_0_30),
          arAging31To60: n(s.ar_aging_31_60),
          arAging61To90: n(s.ar_aging_61_90),
          arAging91To120: n(s.ar_aging_91_120),
          arAging120Plus: n(s.ar_aging_120_plus),
          claimsSubmitted: n(s.claims_submitted),
          denialsCount: n(s.denials_count)
        },
        kpiTrends
      )
    }
    return buildEmptyReport(connection, client, periodMonth)
  }

  const [
    createdReader,
    submittedReader,
    denialsReader,
    agingReader,
    insReader,
    ptReader,
    statusReader,
    causeReader,
    firstPassReader,
    payerMixReader
  ] = await Promise.all([
    connection.runAndReadAll(kpiSql.createdClaims, [clientId, periodStartDt, periodEndDt]),
    connection.runAndReadAll(kpiSql.submittedClaims, [clientId, periodStartDt, periodEndDt]),
    connection.runAndReadAll(kpiSql.denialsInPeriod, [clientId, periodStartDt, periodEndDt]),
    connection.runAndReadAll(kpiSql.openClaimsAging, [clientId]),
    connection.runAndReadAll(kpiSql.insuranceCollections, [clientId, periodStartDt, periodEndDt]),
    connection.runAndReadAll(kpiSql.patientCollections, [clientId, periodStartDt, periodEndDt]),
    connection.runAndReadAll(kpiSql.claimsByStatus, [clientId]),
    connection.runAndReadAll(kpiSql.denialsByRootCause, [clientId, periodStartDt, periodEndDt]),
    connection.runAndReadAll(kpiSql.firstPassClaims, [clientId, periodStartDt, periodEndDt]),
    connection.runAndReadAll(kpiSql.payerMix, [clientId, periodStartDt, periodEndDt])
  ])

  const created = createdReader.getRowObjectsJS()
  const submitted = submittedReader.getRowObjectsJS()
  const denials = denialsReader.getRowObjectsJS()
  const agingRows = agingReader.getRowObjectsJS() as unknown as AgingRow[]
  const firstPass = firstPassReader.getRowObjectsJS()

  const charges = created.reduce((sum, row) => sum + num(row.total_charge), 0)
  const insCollections = num(insReader.getRowObjectsJS()[0]?.total)
  const ptCollections = num(ptReader.getRowObjectsJS()[0]?.total)
  const totalCollections = insCollections + ptCollections

  const fee =
    client.contractType === 'PERCENT_OF_COLLECTIONS'
      ? totalCollections * (client.contractRate ?? 0)
      : submitted.length * (client.contractRate ?? 0)

  const allowedOrChargeSum = submitted.reduce(
    (sum, row) => sum + allowedOrCharge(num(row.total_allowed), num(row.total_charge)),
    0
  )
  // production.py line 197 divides by sum(allowed_or_charge); if that sum is
  // 0 despite submitted claims existing (a genuinely degenerate edge case —
  // e.g. every charge and allowed amount is 0), Python would raise
  // ZeroDivisionError. We return null instead of crashing: there's no
  // meaningful "parity" value to diff against a crash anyway.
  const netCollectionRatePct =
    submitted.length > 0 ? ratePercent(totalCollections, allowedOrChargeSum) : null

  const avgDailyCharge = charges / Math.max(1, daysBetweenInclusive(period.start, period.end))
  const now = todayUtcIso() + 'T00:00:00.000Z'
  const { openAr, aging } = computeAging(agingRows, now)
  const daysInAr = avgDailyCharge ? Math.round((openAr / avgDailyCharge) * 10) / 10 : null
  const arOver90 = aging['91-120'] + aging['120+']
  const arOver90Pct = openAr ? (ratePercent(arOver90, openAr) ?? 0) : 0

  const lag: number[] = []
  for (const row of submitted) {
    if (!row.dos || !row.first_submitted_at) continue
    const dosIso = row.dos instanceof Date ? row.dos.toISOString() : String(row.dos)
    const submittedIso =
      row.first_submitted_at instanceof Date
        ? row.first_submitted_at.toISOString()
        : String(row.first_submitted_at)
    lag.push(daysBetween(dosIso, submittedIso))
  }
  const chargeLagDaysAvg = lag.length
    ? Math.round((lag.reduce((a, b) => a + b, 0) / lag.length) * 10) / 10
    : null
  const slaMetPct =
    lag.length && client.slaDaysToSubmit !== null
      ? ratePercent(lag.filter((l) => l <= client.slaDaysToSubmit!).length, lag.length)
      : null

  const firstPassAcceptancePct = submitted.length
    ? ratePercent(firstPass.length, submitted.length)
    : null
  const denialRatePct = submitted.length ? ratePercent(denials.length, submitted.length) : null

  const denialsByRootCause: Record<string, number> = {}
  for (const row of causeReader.getRowObjectsJS()) {
    denialsByRootCause[String(row.root_cause)] = Number(row.n)
  }

  const claimsByStatus: Record<string, number> = {}
  for (const row of statusReader.getRowObjectsJS()) {
    claimsByStatus[String(row.status)] = Number(row.n)
  }

  const payerMix = payerMixReader
    .getRowObjectsJS()
    .map((row) => ({ payerName: String(row.payer_name), charges: num(row.charges) }))

  const kpiTrends = await buildKpiTrends(connection, clientId, period.end)

  return {
    client: {
      code: client.code,
      name: client.name,
      contract: formatContract(client.contractType, client.contractRate)
    },
    period,
    source: 'claims',
    volume: {
      encountersReceived: created.length,
      claimsSubmitted: submitted.length,
      denialsReceived: denials.length
    },
    financials: {
      grossCharges: round2(charges),
      insuranceCollections: round2(insCollections),
      patientCollections: round2(ptCollections),
      totalCollections: round2(totalCollections),
      rcmFee: round2(fee),
      netCollectionRatePct
    },
    kpis: {
      daysInAr,
      openAr: round2(openAr),
      arOver90Pct,
      chargeLagDaysAvg,
      slaDaysToSubmit: client.slaDaysToSubmit,
      slaMetPct,
      firstPassAcceptancePct,
      denialRatePct
    },
    arAging: aging,
    kpiTrends,
    denialsByRootCause,
    claimsByStatus,
    payerMix
  }
}
