import { useEffect, useState } from 'react'
import type { DenialListRow, MonthlyRateTrendPoint } from '../../../shared/domain'
import DenialsParetoChart from '../components/charts/DenialsParetoChart'
import TrendBarChart from '../components/charts/TrendBarChart'
import AsyncState from '../components/ui/AsyncState'
import ScreenHeader from '../components/ui/ScreenHeader'
import ScreenShell from '../components/ui/ScreenShell'
import { useAppScope } from '../lib/app-scope'
import { getCarcDescriptions, getDenialRateTrend, listDenials } from '../lib/api'

function countBy(
  rows: DenialListRow[],
  key: (row: DenialListRow) => string
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const k = key(row)
    counts[k] = (counts[k] ?? 0) + 1
  }
  return counts
}

/** Denials screen: CARC pareto, by-payer table, denial-rate trend, root-cause breakdown, drill-down list. */
function Denials(): React.JSX.Element {
  const { period, clientId } = useAppScope()
  const [rows, setRows] = useState<DenialListRow[]>([])
  const [trend, setTrend] = useState<MonthlyRateTrendPoint[]>([])
  const [carcDescriptions, setCarcDescriptions] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    Promise.all([listDenials(clientId, period), getDenialRateTrend(clientId, period)])
      .then(([denialRows, ratePoints]) => {
        setRows(denialRows)
        setTrend(ratePoints)
        const codes = Array.from(
          new Set(denialRows.map((r) => r.carcCode).filter((c): c is string => !!c))
        )
        if (codes.length > 0) void getCarcDescriptions(codes).then(setCarcDescriptions)
        else setCarcDescriptions({})
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [clientId, period])

  const byCarc = countBy(rows, (r) => r.carcCode ?? 'Unspecified')
  const byPayer = countBy(rows, (r) => r.payerName)
  const byRootCause = countBy(rows, (r) => r.rootCauseStage ?? 'unclassified')

  return (
    <ScreenShell>
      <ScreenHeader
        title="Denials"
        description="CARC pareto, by payer, by root cause, and a filterable drill-down list."
      />

      <AsyncState loading={loading} error={error}>
        <>
          <section className="report-doc-section">
            <h2>CARC pareto</h2>
            <DenialsParetoChart denialsByRootCause={byCarc} />
          </section>

          <section className="report-doc-section">
            <h2>Denial rate trend</h2>
            {trend.length > 0 ? (
              <TrendBarChart
                categories={trend.map((t) => t.month)}
                series={[{ name: 'Denial rate %', values: trend.map((t) => t.ratePct ?? NaN) }]}
                valueFormatter={(v) => `${v}%`}
              />
            ) : (
              <p>Not enough history yet.</p>
            )}
          </section>

          <section className="report-doc-section">
            <h2>Denials by payer</h2>
            {Object.keys(byPayer).length === 0 ? (
              <p>No denials in this scope/period.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Payer</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(byPayer)
                    .sort((a, b) => b[1] - a[1])
                    .map(([payer, count]) => (
                      <tr key={payer}>
                        <td>{payer}</td>
                        <td>{count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="report-doc-section">
            <h2>Root-cause breakdown</h2>
            {Object.keys(byRootCause).length === 0 ? (
              <p>No denials in this scope/period.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Root cause</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(byRootCause)
                    .sort((a, b) => b[1] - a[1])
                    .map(([cause, count]) => (
                      <tr key={cause}>
                        <td>{cause}</td>
                        <td>{count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="report-doc-section">
            <h2>Drill-down ({rows.length})</h2>
            {rows.length === 0 ? (
              <p>No denials in this scope/period.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Claim</th>
                    <th>DOS</th>
                    <th>Payer</th>
                    <th>CARC</th>
                    <th>CARC description</th>
                    <th>Category</th>
                    <th>Root cause</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.denialId}>
                      <td>{row.clientCode}</td>
                      <td>{row.claimNumber ?? row.externalRef ?? '—'}</td>
                      <td>{row.dos ?? '—'}</td>
                      <td>{row.payerName}</td>
                      <td>{row.carcCode ?? '—'}</td>
                      <td>{(row.carcCode && carcDescriptions[row.carcCode]) || '—'}</td>
                      <td>{row.category}</td>
                      <td>{row.rootCauseStage ?? '—'}</td>
                      <td>{new Date(row.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      </AsyncState>
    </ScreenShell>
  )
}

export default Denials
