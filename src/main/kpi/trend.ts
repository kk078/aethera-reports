/**
 * Lightweight trailing-month trend for the Portfolio screen's
 * sparklines and the report document's charges/collections chart (plan
 * §5/§6). Deliberately NOT a full `buildClientReport` per month (too
 * expensive for 75+ clients) — just the two aggregates these charts
 * need, reusing the same queries `buildClientReport` uses for the same
 * fields.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { kpiSql } from './sql'
import { monthPeriod, trailing12Months } from '../../shared/periods'
import { round2 } from './rate'

export interface MonthlyFinancialPoint {
  month: string
  grossCharges: number
  totalCollections: number
}

function sumColumn(rows: Record<string, unknown>[], column: string): number {
  return rows.reduce((sum, row) => {
    const value = row[column]
    return sum + (typeof value === 'number' ? value : Number(value ?? 0))
  }, 0)
}

export async function buildFinancialTrend(
  connection: DuckDBConnection,
  clientId: number,
  endMonth: string,
  monthsBack = 6
): Promise<MonthlyFinancialPoint[]> {
  const months = trailing12Months(endMonth).slice(-monthsBack)
  const points: MonthlyFinancialPoint[] = []

  for (const month of months) {
    const period = monthPeriod(month)
    const start = `${period.start}T00:00:00.000Z`
    const end = `${period.end}T23:59:59.999Z`

    const [createdReader, insReader, ptReader] = await Promise.all([
      connection.runAndReadAll(kpiSql.createdClaims, [clientId, start, end]),
      connection.runAndReadAll(kpiSql.insuranceCollections, [clientId, start, end]),
      connection.runAndReadAll(kpiSql.patientCollections, [clientId, start, end])
    ])

    const charges = sumColumn(createdReader.getRowObjectsJS(), 'total_charge')
    const ins = Number(insReader.getRowObjectsJS()[0]?.total ?? 0)
    const pt = Number(ptReader.getRowObjectsJS()[0]?.total ?? 0)

    points.push({ month, grossCharges: round2(charges), totalCollections: round2(ins + pt) })
  }

  return points
}

/** Portfolio sparklines — one service call, parallel per-client trend queries. */
export async function buildPortfolioSparklines(
  connection: DuckDBConnection,
  clientIds: number[],
  endMonth: string,
  monthsBack = 6
): Promise<Array<{ clientId: number; grossCharges: number[] }>> {
  const uniqueIds = [...new Set(clientIds)].filter((id) => id > 0)
  return Promise.all(
    uniqueIds.map(async (clientId) => {
      const points = await buildFinancialTrend(connection, clientId, endMonth, monthsBack)
      return { clientId, grossCharges: points.map((p) => p.grossCharges) }
    })
  )
}
