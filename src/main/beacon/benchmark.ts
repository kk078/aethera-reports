/**
 * Assembles the `ClientReport.benchmark` block (plan's beacon paragraph
 * + chunk-C instructions): avg allowed on the client's top CPT codes vs.
 * the state median/percentile from the Reference & Benchmark API's
 * `/price/commercial/{code}` percentile data. Renders (returns non-null)
 * only when: the connector is enabled, the client has a `state`
 * configured, the reference API is reachable, and at least one CPT
 * benchmark came back — every other case is a clean `null`, which
 * `ReportDocument.tsx` treats as "no callout section," never a
 * fabricated placeholder.
 *
 * Deliberately excluded from `buildClientReport`'s own signature/tests:
 * this is assembled by `LocalDataService` and passed in as an already-
 * computed value (see `client-report.ts`'s `options.benchmark`), so the
 * KPI engine itself stays network-free and the rcm-prototype parity
 * crosscheck (`scripts/crosscheck-rcm.ts`, which calls `buildClientReport`
 * directly with no options) never touches this — documented as excluded
 * in `docs/kpi-parity.md`, since rcm-prototype has no equivalent field.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { fetchCommercialBenchmark, fetchCptDescription } from './reference-api-client'
import { monthPeriod } from '../../shared/periods'
import type { BenchmarkBlock } from '../../shared/domain'

const TOP_CPT_LIMIT = 3

interface TopCptRow {
  cptCode: string
  avgAllowed: number
  claimsCount: number
}

async function topCptCodesForClient(
  connection: DuckDBConnection,
  clientId: number,
  periodMonth: string,
  limit: number
): Promise<TopCptRow[]> {
  const period = monthPeriod(periodMonth)
  const start = `${period.start}T00:00:00.000Z`
  const end = `${period.end}T23:59:59.999Z`
  const reader = await connection.runAndReadAll(
    `SELECT cl.cpt_code AS cpt_code,
            AVG(CASE WHEN cl.allowed_amount > 0 THEN cl.allowed_amount ELSE cl.charge_amount END) AS avg_allowed,
            COUNT(*) AS claims_count
     FROM claim_lines cl
     JOIN claims c ON c.claim_id = cl.claim_id
     WHERE c.client_id = ? AND cl.cpt_code IS NOT NULL
       AND c.created_at >= ? AND c.created_at <= ?
     GROUP BY cl.cpt_code
     ORDER BY SUM(cl.charge_amount) DESC
     LIMIT ?`,
    [clientId, start, end, limit]
  )
  return reader.getRowObjectsJS().map((row) => ({
    cptCode: String(row.cpt_code),
    avgAllowed: Number(row.avg_allowed ?? 0),
    claimsCount: Number(row.claims_count)
  }))
}

/**
 * Builds the benchmark block, or `null` when it can't (no state, no
 * reachable reference API, or no billable CPT volume this period).
 * `isReferenceApiHealthy` is injected by the caller (`LocalDataService`)
 * since health-check caching lives there, alongside the other
 * reference-api settings state.
 */
export async function buildBenchmarkBlock(
  connection: DuckDBConnection,
  baseUrl: string,
  clientState: string | null,
  clientId: number,
  periodMonth: string,
  isReferenceApiHealthy: boolean
): Promise<BenchmarkBlock | null> {
  if (!clientState || !isReferenceApiHealthy) return null

  const topCpts = await topCptCodesForClient(connection, clientId, periodMonth, TOP_CPT_LIMIT)
  if (topCpts.length === 0) return null

  const rows = await Promise.all(
    topCpts.map(async (row) => {
      const [benchmark, description] = await Promise.all([
        fetchCommercialBenchmark(baseUrl, row.cptCode, clientState),
        fetchCptDescription(baseUrl, row.cptCode)
      ])
      return {
        cptCode: row.cptCode,
        description: description?.description ?? null,
        avgAllowed: Math.round(row.avgAllowed * 100) / 100,
        claimsCount: row.claimsCount,
        stateMedian: benchmark?.medianRate ?? null,
        statePercentile25: benchmark?.p25 ?? null,
        statePercentile75: benchmark?.p75 ?? null
      }
    })
  )

  const withBenchmarkData = rows.filter((r) => r.stateMedian !== null)
  if (withBenchmarkData.length === 0) return null

  return {
    state: clientState,
    asOf: new Date().toISOString(),
    cpts: rows
  }
}
