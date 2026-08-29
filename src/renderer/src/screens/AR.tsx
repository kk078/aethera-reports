import { useEffect, useState } from 'react'
import type {
  ArAgingByClientRow,
  DaysInArTrendPoint,
  TopAgedClaimRow
} from '../../../shared/domain'
import { fmtMoney } from '../../../shared/format'
import StackedByClientChart from '../components/charts/StackedByClientChart'
import PayerMixChart from '../components/charts/PayerMixChart'
import TrendBarChart from '../components/charts/TrendBarChart'
import AsyncState from '../components/ui/AsyncState'
import ScreenHeader from '../components/ui/ScreenHeader'
import ScreenShell from '../components/ui/ScreenShell'
import { useAppScope } from '../lib/app-scope'
import {
  getArAgingByClient,
  getArPayerVsPatientSplit,
  getDaysInArTrend,
  getTopAgedClaims
} from '../lib/api'

/** A/R screen: aging distribution by client, payer-vs-patient split, top aged claims, days-in-A/R trend. */
function AR(): React.JSX.Element {
  const { period, clientId } = useAppScope()
  const [byClient, setByClient] = useState<ArAgingByClientRow[]>([])
  const [split, setSplit] = useState<{ insurancePortion: number; patientPortion: number } | null>(
    null
  )
  const [topAged, setTopAged] = useState<TopAgedClaimRow[]>([])
  const [daysInArTrendPoints, setDaysInArTrendPoints] = useState<DaysInArTrendPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getArAgingByClient().then(setByClient)
  }, [])

  useEffect(() => {
    setLoading(true)
    setError(null)
    Promise.all([
      getArPayerVsPatientSplit(clientId),
      getTopAgedClaims(clientId, 25),
      getDaysInArTrend(clientId, period)
    ])
      .then(([splitResult, top, trendPoints]) => {
        setSplit(splitResult)
        setTopAged(top)
        setDaysInArTrendPoints(trendPoints)
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [clientId, period])

  const splitForChart = split
    ? [
        { payerName: 'Insurance-owed', charges: split.insurancePortion },
        { payerName: 'Patient-owed', charges: split.patientPortion }
      ]
    : []

  return (
    <ScreenShell>
      <ScreenHeader
        title="A/R"
        description="Aging distribution by client, payer-vs-patient split, top aged claims, days-in-A/R trend."
      />

      <section className="report-doc-section">
        <h2>Aging distribution by client</h2>
        <StackedByClientChart rows={byClient} />
      </section>

      <AsyncState loading={loading} error={error}>
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
      </AsyncState>
    </ScreenShell>
  )
}

export default AR
