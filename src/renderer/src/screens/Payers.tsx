import { useEffect, useState } from 'react'
import type { PayerAnalysisRow, PayerMixTrendPoint } from '../../../shared/domain'
import { fmtLag, fmtMoney, fmtPct } from '../../../shared/format'
import TrendBarChart from '../components/charts/TrendBarChart'
import PayerComparisonChart from '../components/charts/PayerComparisonChart'
import AsyncState from '../components/ui/AsyncState'
import ScreenHeader from '../components/ui/ScreenHeader'
import ScreenShell from '../components/ui/ScreenShell'
import { useAppScope } from '../lib/app-scope'
import { getPayerAnalysis, getPayerMixTrend } from '../lib/api'

/** Payer Analysis: mix over time, avg allowed vs. charge, payment lag, denial rate by payer. */
function Payers(): React.JSX.Element {
  const { period, clientId } = useAppScope()
  const [rows, setRows] = useState<PayerAnalysisRow[]>([])
  const [mixTrend, setMixTrend] = useState<PayerMixTrendPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    Promise.all([getPayerAnalysis(clientId, period), getPayerMixTrend(clientId, period)])
      .then(([analysisRows, trendPoints]) => {
        setRows(analysisRows)
        setMixTrend(trendPoints)
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [clientId, period])

  const months = Array.from(new Set(mixTrend.map((p) => p.month)))
  const payerNames = Array.from(new Set(mixTrend.map((p) => p.payerName)))
  const mixSeries = payerNames.map((payerName) => ({
    name: payerName,
    values: months.map(
      (month) => mixTrend.find((p) => p.month === month && p.payerName === payerName)?.charges ?? 0
    )
  }))

  const hasAnyLagData = rows.some((r) => r.lagSampleCount > 0)

  return (
    <ScreenShell>
      <ScreenHeader
        title="Payer Analysis"
        description="Payer mix over time, avg allowed vs. charge, payment lag, and denial rate by payer."
      />

      <AsyncState loading={loading} error={error}>
        <>
          <section className="report-doc-section">
            <h2>Payer mix over time (top 5 by charges)</h2>
            {months.length > 0 && mixSeries.length > 0 ? (
              <TrendBarChart
                categories={months}
                series={mixSeries}
                valueFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
              />
            ) : (
              <p>Not enough history yet.</p>
            )}
          </section>

          <section className="report-doc-section">
            <h2>Avg allowed vs. charge by payer</h2>
            <PayerComparisonChart
              rows={rows.map((r) => ({ payerName: r.payerName, a: r.avgCharge, b: r.avgAllowed }))}
              seriesNames={['Avg charge', 'Avg allowed']}
              emptyLabel="No claims in this period."
            />
          </section>

          <section className="report-doc-section">
            <h2>Payer detail — denial rate &amp; payment lag</h2>
            {!hasAnyLagData && (
              <p className="form-error">
                Payment lag is insufficient data for this scope/period — no remittances recorded
                yet.
              </p>
            )}
            {rows.length === 0 ? (
              <p>No claims in this period.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Payer</th>
                    <th>Claims</th>
                    <th>Total charge</th>
                    <th>Total allowed</th>
                    <th>Denial rate</th>
                    <th>Avg payment lag</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.payerName}>
                      <td>{row.payerName}</td>
                      <td>{row.claimsCount}</td>
                      <td>{fmtMoney(row.totalCharge)}</td>
                      <td>{fmtMoney(row.totalAllowed)}</td>
                      <td>{fmtPct(row.denialRatePct, 'no data')}</td>
                      <td>{fmtLag(row.avgLagDays, row.lagSampleCount)}</td>
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

export default Payers
