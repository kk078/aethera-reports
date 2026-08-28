import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { Branding, ClientReport } from '../../../shared/domain'
import {
  generateClientReportPdf,
  getBranding,
  getClientFinancialTrend,
  getClientReport,
  listClients
} from '../lib/api'
import ReportDocument, { type FinancialTrendPoint } from '../report-doc/ReportDocument'

function currentMonthValue(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Interactive client report pack (plan §5/§6) — client + period pickers over the shared ReportDocument. */
function ClientDetail(): React.JSX.Element {
  const { clientId: clientIdParam } = useParams<{ clientId: string }>()
  const [clients, setClients] = useState<Array<{ clientId: number; code: string; name: string }>>(
    []
  )
  const [clientId, setClientId] = useState<number | ''>('')
  const [period, setPeriod] = useState(currentMonthValue())
  const [report, setReport] = useState<ClientReport | null>(null)
  const [branding, setBranding] = useState<Branding | null>(null)
  const [trend, setTrend] = useState<FinancialTrendPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)

  useEffect(() => {
    listClients().then((all) => {
      setClients(all.map((c) => ({ clientId: c.clientId, code: c.code, name: c.name })))
      const fromRoute =
        clientIdParam && clientIdParam !== 'demo' ? Number(clientIdParam) : undefined
      if (fromRoute && all.some((c) => c.clientId === fromRoute)) {
        setClientId(fromRoute)
      } else if (all.length > 0) {
        setClientId(all[0].clientId)
      }
    })
    getBranding().then(setBranding)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-derive the initial client from the route once
  }, [])

  useEffect(() => {
    if (!clientId) return
    setLoading(true)
    setError(null)
    Promise.all([getClientReport(clientId, period), getClientFinancialTrend(clientId, period)])
      .then(([r, t]) => {
        setReport(r)
        setTrend(t)
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [clientId, period])

  async function handleExport(): Promise<void> {
    if (!clientId) return
    setExporting(true)
    setExportMessage(null)
    try {
      const result = await generateClientReportPdf(clientId, period)
      setExportMessage(
        result.error ? `Export failed: ${result.error}` : `Saved to ${result.filePath}`
      )
    } catch (err) {
      setExportMessage(String(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="screen-placeholder">
      <h1>Client Detail</h1>

      <div className="manual-entry-controls">
        <label>
          Client
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : '')}
          >
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
        <button type="button" disabled={!clientId || exporting} onClick={() => void handleExport()}>
          {exporting ? 'Exporting…' : 'Export PDF'}
        </button>
      </div>
      {exportMessage && <p>{exportMessage}</p>}

      {error && <p className="form-error">{error}</p>}
      {loading && <p>Loading…</p>}

      {report && branding && !loading && (
        <div style={{ background: '#fff', padding: 24, borderRadius: 8 }}>
          <ReportDocument report={report} branding={branding} trend={trend} mode="interactive" />
        </div>
      )}
    </section>
  )
}

export default ClientDetail
