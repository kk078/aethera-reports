/**
 * DuckDB upsert logic for the RCM Platform connector sync (plan §3
 * bullet 3). Pure — takes an already-open `DuckDBConnection` and already
 * -fetched report JSON (see `client.ts`); no Electron, no meta.db (the
 * sync cursor/status tracking in SQLite is the orchestrator's job —
 * `LocalDataService.runConnectorSync`, which owns both DB handles).
 *
 * The connector syncs **computed report JSON, not raw claims** (plan §3
 * — rcm-prototype's public API doesn't expose a claim dump), so every
 * write here lands in `monthly_summaries`/`kpi_snapshots` with
 * `source: 'synced'` — never in `claims`/`claim_lines`.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import type { RcmClientReportRaw, RcmPortfolioRow } from './types'

export interface FindOrCreateClientResult {
  clientId: number
  created: boolean
}

/**
 * Matches an existing client by `code`; creates a new one (active, no
 * contract configured yet — an operator fills that in later) when no
 * match exists. `created: true` is how the caller knows to flag this
 * client as "created by the connector" in the Settings sync-status list
 * (plan §3: "create missing clients (flagged active with a
 * synced-from-connector note in the UI)").
 */
export async function findOrCreateClientForSync(
  connection: DuckDBConnection,
  code: string,
  name: string
): Promise<FindOrCreateClientResult> {
  const existing = await connection.runAndReadAll('SELECT client_id FROM clients WHERE code = ?', [
    code
  ])
  const existingRows = existing.getRowObjectsJS()
  if (existingRows.length > 0) {
    return { clientId: Number(existingRows[0].client_id), created: false }
  }

  const inserted = await connection.runAndReadAll(
    `INSERT INTO clients (code, name, active) VALUES (?, ?, true) RETURNING client_id`,
    [code, name]
  )
  return { clientId: Number(inserted.getRowObjectsJS()[0].client_id), created: true }
}

function agingBucket(agAging: Record<string, number>, key: string): number | null {
  return key in agAging ? agAging[key] : null
}

/**
 * DuckDB returns BIGINT columns as JS `bigint` and DATE/TIMESTAMP as
 * `Date` (known codebase fact) — neither serializes with `JSON.stringify`
 * out of the box. This converts a raw row into something that does,
 * purely for the `prior_values` audit-trail JSON blob below.
 */
function toJsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') out[key] = Number(value)
    else if (value instanceof Date) out[key] = value.toISOString()
    else out[key] = value
  }
  return out
}

/**
 * Upserts one client-period into `monthly_summaries` with
 * `source = 'synced'`, following the exact same find-existing-then-
 * UPDATE/INSERT shape as `LocalDataService.upsertMonthlySummary` (prior
 * row captured into `prior_values` for the audit trail) rather than
 * `INSERT ... ON CONFLICT DO UPDATE` directly — consistent with this
 * codebase's established DuckDB upsert idiom.
 */
export async function upsertMonthlySummaryFromReport(
  connection: DuckDBConnection,
  clientId: number,
  periodMonth: string,
  report: RcmClientReportRaw
): Promise<void> {
  const existingReader = await connection.runAndReadAll(
    'SELECT * FROM monthly_summaries WHERE client_id = ? AND period_month = ?',
    [clientId, periodMonth]
  )
  const existingRows = existingReader.getRowObjectsJS()
  const priorValues = existingRows.length > 0 ? existingRows[0] : null

  const values = {
    charges: report.financials.gross_charges,
    insCollections: report.financials.insurance_collections,
    ptCollections: report.financials.patient_collections,
    openAr: report.kpis.open_ar,
    arAging0To30: agingBucket(report.ar_aging, '0-30'),
    arAging31To60: agingBucket(report.ar_aging, '31-60'),
    arAging61To90: agingBucket(report.ar_aging, '61-90'),
    arAging91To120: agingBucket(report.ar_aging, '91-120'),
    arAging120Plus: agingBucket(report.ar_aging, '120+'),
    claimsSubmitted: report.volume.claims_submitted,
    denialsCount: report.volume.denials_received
  }

  if (existingRows.length > 0) {
    await connection.run(
      `UPDATE monthly_summaries SET
         charges = ?, ins_collections = ?, pt_collections = ?, open_ar = ?,
         ar_aging_0_30 = ?, ar_aging_31_60 = ?, ar_aging_61_90 = ?, ar_aging_91_120 = ?, ar_aging_120_plus = ?,
         claims_submitted = ?, denials_count = ?, notes = ?, source = 'synced',
         updated_at = now(), prior_values = ?
       WHERE client_id = ? AND period_month = ?`,
      [
        values.charges,
        values.insCollections,
        values.ptCollections,
        values.openAr,
        values.arAging0To30,
        values.arAging31To60,
        values.arAging61To90,
        values.arAging91To120,
        values.arAging120Plus,
        values.claimsSubmitted,
        values.denialsCount,
        'Synced from RCM Platform connector.',
        JSON.stringify(priorValues ? toJsonSafe(priorValues) : null),
        clientId,
        periodMonth
      ]
    )
  } else {
    await connection.run(
      `INSERT INTO monthly_summaries (
         client_id, period_month, charges, ins_collections, pt_collections, open_ar,
         ar_aging_0_30, ar_aging_31_60, ar_aging_61_90, ar_aging_91_120, ar_aging_120_plus,
         claims_submitted, denials_count, notes, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
      [
        clientId,
        periodMonth,
        values.charges,
        values.insCollections,
        values.ptCollections,
        values.openAr,
        values.arAging0To30,
        values.arAging31To60,
        values.arAging61To90,
        values.arAging91To120,
        values.arAging120Plus,
        values.claimsSubmitted,
        values.denialsCount,
        'Synced from RCM Platform connector.'
      ]
    )
  }
}

/**
 * Upserts one `kpi_snapshots` row from the synced report. `kpi_snapshots`
 * has no unique constraint on `(client_id, snapshot_date)` (Phase 1
 * never needed one — nothing wrote to it yet, see `kpi-trends.ts`'s
 * header comment), so this uses the same find-then-branch idiom as
 * everywhere else rather than `ON CONFLICT`. Fields rcm-prototype's
 * `/api/reports/client/{code}` doesn't expose (`clean_claim_rate`,
 * `days_to_cash` — those live behind `/api/reports/kpi-trends`, not
 * synced in v1, see docs/connectors.md) are left `NULL`, never
 * fabricated.
 */
export async function upsertKpiSnapshotFromReport(
  connection: DuckDBConnection,
  clientId: number,
  snapshotDate: string,
  report: RcmClientReportRaw
): Promise<void> {
  const existing = await connection.runAndReadAll(
    'SELECT 1 FROM kpi_snapshots WHERE client_id = ? AND snapshot_date = ?',
    [clientId, snapshotDate]
  )
  const values = [
    report.kpis.denial_rate_pct,
    report.kpis.first_pass_acceptance_pct,
    report.kpis.days_in_ar,
    report.kpis.open_ar,
    report.kpis.ar_over_90_pct,
    report.financials.net_collection_rate_pct
  ]

  if (existing.getRowObjectsJS().length > 0) {
    await connection.run(
      `UPDATE kpi_snapshots SET
         denial_rate = ?, first_pass_rate = ?, days_in_ar = ?, open_ar = ?, ar_over_90_pct = ?, net_collection_rate = ?
       WHERE client_id = ? AND snapshot_date = ?`,
      [...values, clientId, snapshotDate]
    )
  } else {
    await connection.run(
      `INSERT INTO kpi_snapshots (
         client_id, snapshot_date, denial_rate, first_pass_rate, days_in_ar, open_ar, ar_over_90_pct, net_collection_rate
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [clientId, snapshotDate, ...values]
    )
  }
}

/** Maps a portfolio row's client code/name — used to find-or-create clients before per-client sync (plan §3). */
export function portfolioRowIdentity(row: RcmPortfolioRow): { code: string; name: string } {
  return { code: row.client, name: row.name }
}
