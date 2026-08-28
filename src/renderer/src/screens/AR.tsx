import { useEffect, useState } from 'react'
import type {
  ArAgingByClientRow,
  Client,
  DaysInArTrendPoint,
  TopAgedClaimRow
} from '../../../shared/domain'
import {
  getArAgingByClient,
  getArPayerVsPatientSplit,
  getDaysInArTrend,
  getTopAgedClaims,
  listClients
} from '../lib/api'
import StackedByClientChart from '../components/charts/StackedByClientChart'
import PayerMixChart from '../components/charts/PayerMixChart'
import TrendBarChart from '../components/charts/TrendBarChart'

function currentMonthValue(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function fmtMoney(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

/** A/R screen (plan §5): aging distribution by client, payer-vs-patient split, top aged claims, days-in-AR trend. */
function AR(): React.JSX.Element {
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | ''>('') // '' = all clients (the default)
  const [endPeriod, setEndPeriod] = useState(currentMonthValue())
  const [byClient, setByClient] = useState<ArAgingByClientRow[]>([])
  const [split, setSplit] = useState<{ insurancePortion: number; patientPortion: number } | null>(
    null
  )
  const [topAged, setTopAged] = useState<TopAgedClaimRow[]>([])
  const [daysInArTrendPoints, setDaysInArTrendPoints] = useState<DaysInArTrendPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void listClients().then(setClients)
    void getArAgingByClient().then(setByClient)
  }, [])

  useEffect(() => {
    setLoading(true)
    setError(null)
    const scopedClientId = clientId === '' ? null : clientId
    Promise.all([
      getArPayerVsPatientSplit(scopedClientId),
      getTopAgedClaims(scopedClientId, 25),
      getDaysInArTrend(scopedClientId, endPeriod)
    ])
      .then(([splitResult, top, trendPoints]) => {
        setSplit(splitResult)
        setTopAged(top)
        setDaysInArTrendPoints(trendPoints)
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [clientId, endPeriod])

  const splitForChart = split
    ? [
        { payerName: 'Insurance-owed', charges: split.insurancePortion },
        { payerName: 'Patient-owed', charges: split.patientPortion }
      ]
    : []

  return (
    <section className="screen-placeholder">
      <h1>A/R</h1>
      <p>
        Aging distribution by client, payer-vs-patient split, top aged claims, days-in-A/R trend.
      </p>

      <div className="manual-entry-controls">
        <label>
          Client (for split/trend/top-aged)
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
          Trend end month
          <input type="month" value={endPeriod} onChange={(e) => setEndPeriod(e.target.value)} />
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}

      <section className="report-doc-section">
        <h2>Aging distribution by client</h2>
        <StackedByClientChart rows={byClient} />
      </section>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          <section className="report-doc-section">
            <h2>Payer vs. patient split</h2>
            {split && split.insurancePortion + split.patientPortion > 0 ? (
              <PayerMixChart payerMix={splitForChart} />
            ) : (
              <p>No open A/R in this scope.</p>
            )}
          </section>

          <section className="report-doc-section">
            <h2>Days in A/R trend</h2>
            {daysInArTrendPoints.length > 0 ? (
              <TrendBarChart
                categories={daysInArTrendPoints.map((p) => p.month)}
                series={[
                  { name: 'Days in A/R', values: daysInArTrendPoints.map((p) => p.daysInAr ?? NaN) }
                ]}
                valueFormatter={(v) => `${v}d`}
              />
            ) : (
              <p>Not enough history yet.</p>
            )}
          </section>

          <section className="report-doc-section">
            <h2>Top aged claims ({topAged.length})</h2>
            {topAged.length === 0 ? (
              <p>No open claims in this scope.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Claim</th>
                    <th>Payer</th>
                    <th>DOS</th>
                    <th>Amount</th>
                    <th>Days open</th>
                  </tr>
                </thead>
                <tbody>
                  {topAged.map((row, index) => (
                    <tr key={`${row.clientCode}-${row.claimNumber ?? row.externalRef ?? index}`}>
                      <td>{row.clientCode}</td>
                      <td>{row.claimNumber ?? row.externalRef ?? '—'}</td>
                      <td>{row.payerName}</td>
                      <td>{row.dos ?? '—'}</td>
                      <td>{fmtMoney(row.amount)}</td>
                      <td>{row.daysOpen}</td>
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

export default AR
