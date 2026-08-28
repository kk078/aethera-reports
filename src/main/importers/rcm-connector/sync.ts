/**
 * DuckDB upsert logic for the RCM Platform connector sync (plan §3
 * bullet 3). Pure — takes an already-open `DuckDBConnection` and already
 * -fetched report JSON (see `client.ts`); no Electron, no meta.db (the
 * sync cursor/status tracking in SQLite is the orchestrator's job —
 * `LocalDataService.runConnectorSync`, which owns both DB handles).
 *
 * The summary sync pulls **computed report JSON, not raw claims**, so
 * every write in that half of this file lands in
 * `monthly_summaries`/`kpi_snapshots` with `source: 'synced'` — never in
 * `claims`/`claim_lines`. The opt-in **claim-level sync** (see
 * docs/connectors.md "Claim-level sync") is the exception: its batch
 * import goes through `run837Import` (importers/x12) directly, giving
 * `claims`/`claim_lines` rows `source: 'api'`; the claim-enrichment
 * helpers below (the second half of this file) upsert onto those same
 * `'api'`-sourced rows.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { CAS_GROUP_CATEGORY } from '../x12/common'
import type { RcmClaimRow, RcmClientReportRaw, RcmPortfolioRow } from './types'

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

// ---------------------------------------------------------------------
// Claim-level sync (docs/connectors.md "Claim-level sync") — batch
// import goes through `run837Import` directly (importers/x12), so
// everything below is the enrichment half: matching a platform claim
// back to the local row `run837Import` created, then upserting its
// paid/allowed/patient-responsibility/status and CARC denials.
// ---------------------------------------------------------------------

/** Nullable variant of `run-x12-import.ts`'s `getClientId` — a platform client with no local match is skipped, not an error (its summary sync already logged whatever went wrong finding/creating it). */
export async function findLocalClientIdByCode(
  connection: DuckDBConnection,
  code: string
): Promise<number | null> {
  const reader = await connection.runAndReadAll('SELECT client_id FROM clients WHERE code = ?', [
    code
  ])
  const rows = reader.getRowObjectsJS()
  return rows.length > 0 ? Number(rows[0].client_id) : null
}

/** Whether it's worth paging through this client's platform claims at all — skipped entirely (no HTTP calls) once this is 0. */
export async function countApiSourcedClaims(
  connection: DuckDBConnection,
  clientId: number
): Promise<number> {
  const reader = await connection.runAndReadAll(
    "SELECT COUNT(*) AS n FROM claims WHERE client_id = ? AND source = 'api'",
    [clientId]
  )
  return Number(reader.getRowObjectsJS()[0].n)
}

/**
 * Matches a platform claim back to the local row `run837Import` created
 * for it — by `claim_number` or `external_ref`, same fields the 835 path
 * matches on (`run-x12-import.ts`'s `findMatchingClaimId`). Scoped to
 * `source = 'api'` deliberately: this enrichment step only ever touches
 * claims *this* connector synced in, never a CSV/manually-X12-imported
 * claim that happens to share a claim number.
 */
export async function findApiClaimIdByIdentifier(
  connection: DuckDBConnection,
  clientId: number,
  claimNumber: string | null,
  externalRef: string | null
): Promise<number | null> {
  if (!claimNumber && !externalRef) return null
  const reader = await connection.runAndReadAll(
    `SELECT claim_id FROM claims
     WHERE client_id = ? AND source = 'api' AND (claim_number = ? OR external_ref = ?)
     LIMIT 1`,
    [clientId, claimNumber, externalRef]
  )
  const rows = reader.getRowObjectsJS()
  return rows.length > 0 ? Number(rows[0].claim_id) : null
}

/** Splits the reference implementation's `"CO-16"` encoding into CAS group + CARC reason codes; a code with no group prefix (no `-`) is stored bare with an `'unclassified'` category, same fallback as an unrecognized group in `run-x12-import.ts`. */
function splitAdjustmentCode(raw: string): { group: string | null; carc: string } {
  const dash = raw.indexOf('-')
  if (dash <= 0) return { group: null, carc: raw }
  return { group: raw.slice(0, dash), carc: raw.slice(dash + 1) }
}

/**
 * Upserts one enriched claim: absolute paid/allowed/patient-responsibility
 * /status/adjustments (a full snapshot from the platform, so this
 * `UPDATE ... SET` overwrites rather than the 835 path's incremental
 * `total_paid = total_paid + remit_amount` — there's no prior-remittance
 * amount to add to here, only "this is the claim's current state") plus
 * a full replace of its `denials` rows (delete-then-reinsert from the
 * latest CARC codes — makes re-enrichment idempotent the same way
 * re-running `run837Import` against an unchanged file is, without a
 * dedicated `file_sha256`-style guard for a JSON API response). Note:
 * this *does* mean a denial posted by a manually-imported 835 file
 * against an `'api'`-sourced claim would be overwritten by the next
 * enrichment pass — an unlikely channel mix this v1 doesn't guard
 * against (see docs/connectors.md).
 */
export async function enrichClaimFromPlatform(
  connection: DuckDBConnection,
  claimId: number,
  claim: RcmClaimRow
): Promise<{ denialsWritten: number }> {
  const balance = claim.total_charge - claim.total_paid - claim.patient_paid
  await connection.run(
    `UPDATE claims SET
       total_allowed = ?, total_paid = ?, patient_responsibility = ?, patient_paid = ?,
       adjustments = ?, balance = ?, status = ?
     WHERE claim_id = ?`,
    [
      claim.total_allowed,
      claim.total_paid,
      claim.patient_responsibility,
      claim.patient_paid,
      claim.adjustments,
      balance,
      claim.status ?? null,
      claimId
    ]
  )

  await connection.run('DELETE FROM denials WHERE claim_id = ?', [claimId])

  let denialsWritten = 0
  for (const line of claim.lines ?? []) {
    for (const code of line.adjustment_codes ?? []) {
      const { group, carc } = splitAdjustmentCode(code)
      await connection.run('INSERT INTO denials (claim_id, carc_code, category) VALUES (?, ?, ?)', [
        claimId,
        carc,
        group ? (CAS_GROUP_CATEGORY[group] ?? 'unclassified') : 'unclassified'
      ])
      denialsWritten += 1
    }
  }

  return { denialsWritten }
}
