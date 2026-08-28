/**
 * Port of `kpi_trends()` (`app/services/kpi.py` lines 116-136): the
 * trailing snapshot series plus latest-vs-baseline deltas. Phase 1 ships
 * no background sweeper populating `kpi_snapshots` yet (that's a
 * separate future task — the automation suite in plan §11 covers
 * scheduled work, not this), so in practice this returns the same
 * empty shape kpi.py itself returns before any snapshot exists.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { kpiSql } from './sql'
import { daysBetween } from '../../shared/periods'
import type { KpiSnapshotRow, KpiTrends } from '../../shared/domain'

const DELTA_LABELS: Array<{ label: 'vs_7d' | 'vs_30d'; minAgeDays: number }> = [
  { label: 'vs_7d', minAgeDays: 7 },
  { label: 'vs_30d', minAgeDays: 30 }
]

const DELTA_FIELDS = [
  'denialRate',
  'firstPassRate',
  'cleanClaimRate',
  'daysToCash',
  'openAr',
  'arOver90Pct'
] as const

function toRow(raw: Record<string, unknown>): KpiSnapshotRow {
  const date =
    raw.snapshot_date instanceof Date
      ? raw.snapshot_date.toISOString().slice(0, 10)
      : String(raw.snapshot_date)
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
  return {
    date,
    denialRate: num(raw.denial_rate),
    firstPassRate: num(raw.first_pass_rate),
    cleanClaimRate: num(raw.clean_claim_rate),
    daysToCash: num(raw.days_to_cash),
    openAr: num(raw.open_ar),
    arOver90Pct: num(raw.ar_over_90_pct),
    netCollectionRate: num(raw.net_collection_rate)
  }
}

export async function buildKpiTrends(
  connection: DuckDBConnection,
  clientId: number,
  asOfDate: string,
  windowDays = 180
): Promise<KpiTrends> {
  const sinceMs = Date.parse(`${asOfDate}T00:00:00.000Z`) - windowDays * 86_400_000
  const since = new Date(sinceMs).toISOString().slice(0, 10)

  const reader = await connection.runAndReadAll(kpiSql.kpiSnapshotSeries, [
    clientId,
    since,
    asOfDate
  ])
  const series = reader.getRowObjectsJS().map(toRow)

  const result: KpiTrends = {
    series,
    latest: series.length > 0 ? series[series.length - 1] : null,
    deltas: {}
  }

  if (series.length >= 2) {
    const latest = series[series.length - 1]
    for (const { label, minAgeDays } of DELTA_LABELS) {
      const base = series.find((row) => daysBetween(row.date, latest.date) >= minAgeDays)
      if (!base) continue
      const delta: Record<string, number | null | string> = { baselineDate: base.date }
      for (const field of DELTA_FIELDS) {
        const latestValue = latest[field]
        const baseValue = base[field]
        delta[field] =
          latestValue !== null && baseValue !== null
            ? Math.round((latestValue - baseValue) * 10000) / 10000
            : null
      }
      result.deltas[label] = delta as KpiTrends['deltas'][string]
    }
  }

  return result
}
