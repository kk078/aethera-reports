import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { Branding, ClientReport, ExportFormat } from '../../../shared/domain'
import AsyncState from '../components/ui/AsyncState'
import ScreenHeader from '../components/ui/ScreenHeader'
import ScreenShell from '../components/ui/ScreenShell'
import { useAppScope } from '../lib/app-scope'
import {
  generateClientReport,
  getBranding,
  getClientFinancialTrend,
  getClientReport,
  publishToPortal,
  sendReportPackNow
} from '../lib/api'
import ReportDocument, { type FinancialTrendPoint } from '../report-doc/ReportDocument'

const ALL_FORMATS: ExportFormat[] = ['pdf', 'pptx', 'xlsx']

/** Interactive client report pack — client picker + shared period scope over ReportDocument. */
function ClientDetail(): React.JSX.Element {
  const { clientId: clientIdParam } = useParams<{ clientId: string }>()
  const { period, setPeriod, clients, setClientId: setScopeClientId } = useAppScope()
  const [selectedClientId, setSelectedClientId] = useState<number | ''>('')
  const [report, setReport] = useState<ClientReport | null>(null)
  const [branding, setBranding] = useState<Branding | null>(null)
  const [trend, setTrend] = useState<FinancialTrendPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [formats, setFormats] = useState<Set<ExportFormat>>(new Set(['pdf']))
  const [sending, setSending] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishSendLinks, setPublishSendLinks] = useState(true)

  useEffect(() => {
    const fromRoute =
      clientIdParam && clientIdParam !== 'demo' ? Number(clientIdParam) : undefined
    if (fromRoute && clients.some((c) => c.clientId === fromRoute)) {
      setSelectedClientId(fromRoute)
      setScopeClientId(fromRoute)
    } else if (clients.length > 0 && !selectedClientId) {
      setSelectedClientId(clients[0].clientId)
    }
    getBranding().then(setBranding)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- route drives initial client only once clients load
  }, [clients, clientIdParam])

  useEffect(() => {
    if (!selectedClientId) return
    setLoading(true)
    setError(null)
    Promise.all([
      getClientReport(selectedClientId, period),
      getClientFinancialTrend(selectedClientId, period)
    ])
      .then(([r, t]) => {
        setReport(r)
        setTrend(t)
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [selectedClientId, period])

  function handleClientChange(id: number): void {
    setSelectedClientId(id)
    setScopeClientId(id)
  }

  function toggleFormat(format: ExportFormat): void {
    setFormats((prev) => {
      const next = new Set(prev)
      if (next.has(format)) next.delete(format)
      else next.add(format)
      return next
    })
  }

  async function handleExport(): Promise<void> {
    if (!selectedClientId || formats.size === 0) return
    setExporting(true)
    setExportMessage(null)
    try {
      const results = await generateClientReport(selectedClientId, period, Array.from(formats))
      setExportMessage(
        results
          .map((r) => (r.error ? `${r.format}: FAILED — ${r.error}` : `${r.format}: ${r.filePath}`))
          .join(' | ')
      )
    } catch (err) {
      setExportMessage(String(err))
    } finally {
      setExporting(false)
    }
  }

  async function handleSendPack(): Promise<void> {
    if (!selectedClientId || formats.size === 0) return
    setSending(true)
    setExportMessage(null)
    try {
      const result = await sendReportPackNow(selectedClientId, period, Array.from(formats))
      if (result.ok) setExportMessage(`Sent to ${result.clientCode}'s report_recipients.`)
      else if (result.queued) setExportMessage(`Queued for delivery: ${result.error}`)
      else setExportMessage(`Send failed: ${result.error}`)
    } catch (err) {
      setExportMessage(String(err))
    } finally {
      setSending(false)
    }
  }

  async function handlePublishToPortal(): Promise<void> {
    if (!selectedClientId) return
    setPublishing(true)
    setExportMessage(null)
    try {
      const result = await publishToPortal({
        clientId: selectedClientId,
        periodMonth: period,
        sendLinks: publishSendLinks
      })
      if (!result.ok) {
        setExportMessage(`Publish failed: ${result.error}`)
      } else if (result.linksSent.length === 0) {
        setExportMessage(`Published ${result.clientCode}'s report to the portal.`)
      } else {
        const failed = result.linksSent.filter((l) => !l.ok)
        setExportMessage(
          failed.length === 0
            ? `Published and emailed links to ${result.linksSent.length} recipient(s).`
            : `Published. ${result.linksSent.length - failed.length} link(s) sent, ${failed.length} failed: ${failed.map((l) => `${l.email} (${l.error})`).join('; ')}`
        )
      }
    } catch (err) {
      setExportMessage(String(err))
    } finally {
      setPublishing(false)
    }
  }

  const toolbar = (
    <div className="toolbar-actions manual-entry-controls">
      <label>
        Client
        <select
          value={selectedClientId}
          onChange={(e) => handleClientChange(Number(e.target.value))}
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
      <span className="format-checkboxes">
        {ALL_FORMATS.map((format) => (
          <label key={format}>
            <input
              type="checkbox"
              checked={formats.has(format)}
              onChange={() => toggleFormat(format)}
            />
            {format.toUpperCase()}
          </label>
        ))}
      </span>
      <button
        type="button"
        disabled={!selectedClientId || exporting || formats.size === 0}
        onClick={() => void handleExport()}
      >
        {exporting ? 'Exporting…' : 'Export'}
      </button>
      <button
        type="button"
        disabled={!selectedClientId || sending || formats.size === 0}
        onClick={() => void handleSendPack()}
      >
        {sending ? 'Sending…' : 'Send pack'}
      </button>
      <label>
        <input
          type="checkbox"
          checked={publishSendLinks}
          onChange={(e) => setPublishSendLinks(e.target.checked)}
        />
        Email links
      </label>
      <button
        type="button"
        disabled={!selectedClientId || publishing}
        onClick={() => void handlePublishToPortal()}
      >
        {publishing ? 'Publishing…' : 'Publish to portal'}
      </button>
    </div>
  )

  return (
    <ScreenShell>
      <ScreenHeader title="Client Detail" actions={toolbar} />
      {exportMessage && <p className="form-success">{exportMessage}</p>}

      <AsyncState loading={loading || !branding} error={error} empty={!selectedClientId}>
        {report && branding ? (
          <div className="report-doc-preview-frame">
            <ReportDocument report={report} branding={branding} trend={trend} mode="interactive" />
          </div>
        ) : null}
      </AsyncState>
    </ScreenShell>
  )
}

export default ClientDetail
