import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { Branding, ClientReport } from '../../../../shared/domain'
import { getBranding, getClientFinancialTrend, getClientReport } from '../../lib/api'
import ReportDocument, { type FinancialTrendPoint } from '../../report-doc/ReportDocument'

/**
 * The print route (`#/print/:clientId/:period`, plan §6) — loaded by an
 * offscreen `BrowserWindow` for PDF export. Renders the same
 * `ReportDocument` as ClientDetail, in `mode="print"`, which signals
 * `reports:printReady` once its charts have painted.
 */
function PrintClientReport(): React.JSX.Element {
  const { clientId, period } = useParams<{ clientId: string; period: string }>()
  const [report, setReport] = useState<ClientReport | null>(null)
  const [branding, setBranding] = useState<Branding | null>(null)
  const [trend, setTrend] = useState<FinancialTrendPoint[]>([])
  const [error, setError] = useState<string | null>(null)

  // The print route's own CSS (report-document.css) is always
  // white/ink, regardless of the interactive window's light/dark
  // choice — this offscreen window shares the same origin/localStorage,
  // so it would otherwise inherit whatever theme the user last picked
  // and render its charts' grid/text/legend colors for THAT mode on a
  // page that's always white. Force light here, unconditionally: this
  // route never renders anything else.
  useEffect(() => {
    document.documentElement.dataset.theme = 'light'
  }, [])

  useEffect(() => {
    if (!clientId || !period) return
    const id = Number(clientId)
    Promise.all([getClientReport(id, period), getBranding(), getClientFinancialTrend(id, period)])
      .then(([r, b, t]) => {
        setReport(r)
        setBranding(b)
        setTrend(t)
      })
      .catch((err: unknown) => setError(String(err)))
  }, [clientId, period])

  if (error) return <p style={{ padding: 24 }}>{error}</p>
  if (!report || !branding) return <p style={{ padding: 24 }}>Loading…</p>

  return <ReportDocument report={report} branding={branding} trend={trend} mode="print" />
}

export default PrintClientReport
