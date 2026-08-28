import { useEffect, useState } from 'react'
import type { Client, PayerAnalysisRow, PayerMixTrendPoint } from '../../../shared/domain'
import { getPayerAnalysis, getPayerMixTrend, listClients } from '../lib/api'
import TrendBarChart from '../components/charts/TrendBarChart'
import PayerComparisonChart from '../components/charts/PayerComparisonChart'

function currentMonthValue(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function fmtMoney(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}
function fmtPct(value: number | null): string {
  return value === null ? 'no data' : `${value}%`
}
function fmtLag(value: number | null, sampleCount: number): string {
  return value === null || sampleCount === 0
    ? 'insufficient data'
    : `${value} days (n=${sampleCount})`
}

/** Payer Analysis screen (plan §5): mix over time, avg allowed vs. charge, payment lag, denial rate by payer. */
function Payers(): React.JSX.Element {
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>('') // '' = all clients (the default)
  const [period, setPeriod] = useState(currentMonthValue())
  const [rows, setRows] = useState<PayerAnalysisRow[]>([])
  const [mixTrend, setMixTrend] = useState<PayerMixTrendPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void listClients().then(setClients)
  }, [])

  useEffect(() => {
    setLoading(true)
    setError(null)
    const scopedClientId = clientId === '' ? null : clientId
    Promise.all([
      getPayerAnalysis(scopedClientId, period),
      getPayerMixTrend(scopedClientId, period)
    ])
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
    <section className="screen-placeholder">
      <h1>Payer Analysis</h1>
      <p>Payer mix over time, avg allowed vs. charge, payment lag, and denial rate by payer.</p>

      <div className="manual-entry-controls">
        <label>
          Client
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.clientId} value={c.clientId}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Period
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : (
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
                      <td>{fmtPct(row.denialRatePct)}</td>
                      <td>{fmtLag(row.avgLagDays, row.lagSampleCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </section>
  )
}

export default Payers
