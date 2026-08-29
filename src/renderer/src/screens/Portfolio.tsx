import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ClientReport, ExportFormat } from '../../../shared/domain'
import {
  generateClientReportBatch,
  getClientFinancialTrend,
  getPortfolioReports,
  listClients
} from '../lib/api'
import Sparkline from '../components/charts/Sparkline'

const ALL_FORMATS: ExportFormat[] = ['pdf', 'pptx', 'xlsx']

function currentMonthValue(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function fmtPct(value: number | null): string {
  return value === null ? '—' : `${value}%`
}
function fmtMoney(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

interface Row {
  clientId: number
  report: ClientReport
  sparkline: number[]
}

/** All-clients KPI table with trailing-charges sparklines (plan §5). */
function Portfolio(): React.JSX.Element {
  const [period, setPeriod] = useState(currentMonthValue())
  const [rows, setRows] = useState<Row[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchLog, setBatchLog] = useState<string[]>([])
  const [formats, setFormats] = useState<Set<ExportFormat>>(new Set(['pdf']))

  useEffect(() => {
    setLoading(true)
    setError(null)
    Promise.all([getPortfolioReports(period), listClients()])
      .then(async ([reports, clients]) => {
        const idByCode = new Map(clients.map((c) => [c.code, c.clientId]))
        const withSparklines = await Promise.all(
          reports.map(async (report): Promise<Row> => {
            const clientId = idByCode.get(report.client.code) ?? 0
            const sparkline = clientId
              ? (await getClientFinancialTrend(clientId, period, 6)).map((p) => p.grossCharges)
              : []
            return { clientId, report, sparkline }
          })
        )
        setRows(withSparklines)
        setSelected(new Set())
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [period])

  async function handleBatchExport(): Promise<void> {
    if (selected.size === 0 || formats.size === 0) return
    setBatchRunning(true)
    setBatchLog([])
    try {
      const results = await generateClientReportBatch(
        Array.from(selected),
        period,
        Array.from(formats)
      )
      setBatchLog(
        results.map((r) =>
          r.error
            ? `${r.clientCode} (${r.format}): FAILED — ${r.error}`
            : `${r.clientCode} (${r.format}): ${r.filePath}`
        )
      )
    } catch (err) {
      setBatchLog([String(err)])
    } finally {
      setBatchRunning(false)
    }
  }

  function toggleFormat(format: ExportFormat): void {
    setFormats((prev) => {
      const next = new Set(prev)
      if (next.has(format)) next.delete(format)
      else next.add(format)
      return next
    })
  }

  function toggleSelected(clientId: number): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(clientId)) next.delete(clientId)
      else next.add(clientId)
      return next
    })
  }

  return (
    <section className="screen-placeholder">
      <h1>Portfolio</h1>
      <p>Headline KPIs for every client in the selected period.</p>

      <div className="manual-entry-controls">
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
          disabled={selected.size === 0 || formats.size === 0 || batchRunning}
          onClick={() => void handleBatchExport()}
        >
          {batchRunning ? 'Exporting…' : `Export ${selected.size || ''} selected`}
        </button>
      </div>

      {batchLog.length > 0 && (
        <ul>
          {batchLog.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {error && <p className="form-error">{error}</p>}
      {loading ? (
        <table className="data-table" aria-busy="true" aria-label="Loading portfolio">
          <thead>
            <tr>
              <th />
              <th>Client</th>
              <th>Gross charges</th>
              <th>Net collection rate</th>
              <th>Days in A/R</th>
              <th>Denial rate</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i}>
                <td>
                  <span
                    className="skeleton"
                    style={{ display: 'inline-block', width: 14, height: 14 }}
                  />
                </td>
                <td>
                  <span
                    className="skeleton"
                    style={{ display: 'block', width: '70%', height: 14 }}
                  />
                </td>
                <td>
                  <span className="skeleton" style={{ display: 'block', width: 64, height: 14 }} />
                </td>
                <td>
                  <span className="skeleton" style={{ display: 'block', width: 48, height: 14 }} />
                </td>
                <td>
                  <span className="skeleton" style={{ display: 'block', width: 32, height: 14 }} />
                </td>
                <td>
                  <span className="skeleton" style={{ display: 'block', width: 48, height: 14 }} />
                </td>
                <td>
                  <span className="skeleton" style={{ display: 'block', width: 90, height: 20 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : rows.length === 0 ? (
        <p>No active clients yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th />
              <th>Client</th>
              <th>Gross charges</th>
              <th>Net collection rate</th>
              <th>Days in A/R</th>
              <th>Denial rate</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ clientId, report, sparkline }) => (
              <tr key={report.client.code}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(clientId)}
                    disabled={!clientId}
                    onChange={() => toggleSelected(clientId)}
                  />
                </td>
                <td>
                  <Link to={`/clients/${clientId || report.client.code}`}>
                    {report.client.name}
                  </Link>
                </td>
                <td className="tabular-nums">{fmtMoney(report.financials.grossCharges)}</td>
                <td className="tabular-nums">{fmtPct(report.financials.netCollectionRatePct)}</td>
                <td className="tabular-nums">{report.kpis.daysInAr ?? '—'}</td>
                <td className="tabular-nums">{fmtPct(report.kpis.denialRatePct)}</td>
                <td style={{ width: 90 }}>
                  {sparkline.length > 1 ? (
                    <Sparkline values={sparkline} />
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>n/a</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default Portfolio
