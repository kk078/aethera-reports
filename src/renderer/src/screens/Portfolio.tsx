import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ClientReport, ExportFormat, ImportJob } from '../../../shared/domain'
import { fmtMoney, fmtPct } from '../../../shared/format'
import Sparkline from '../components/charts/Sparkline'
import AttentionPanel, { type AttentionItem } from '../components/ui/AttentionPanel'
import AsyncState from '../components/ui/AsyncState'
import ScreenHeader from '../components/ui/ScreenHeader'
import ScreenShell from '../components/ui/ScreenShell'
import { useAppScope } from '../lib/app-scope'
import {
  generateClientReportBatch,
  getPortfolioReports,
  getPortfolioSparklines,
  listClients,
  listImportJobs
} from '../lib/api'

const ALL_FORMATS: ExportFormat[] = ['pdf', 'pptx', 'xlsx']

interface Row {
  clientId: number
  report: ClientReport
  sparkline: number[]
}

function reportNeedsData(report: ClientReport): boolean {
  return (
    report.volume.claimsSubmitted === 0 &&
    report.financials.grossCharges === 0 &&
    report.financials.totalCollections === 0
  )
}

function buildAttentionItems(
  rows: Row[],
  importJobs: ImportJob[],
  period: string
): AttentionItem[] {
  const items: AttentionItem[] = []

  const missing = rows.filter(({ report }) => reportNeedsData(report))
  if (missing.length > 0) {
    items.push({
      id: 'missing-data',
      severity: 'warning',
      title: `${missing.length} client${missing.length === 1 ? '' : 's'} with no data`,
      detail: `No claim activity for ${period} — check imports or manual entry.`,
      href: '/imports'
    })
  }

  const failed = importJobs.filter((j) => j.status === 'failed').slice(0, 5)
  for (const job of failed) {
    items.push({
      id: `import-failed-${job.jobId}`,
      severity: 'critical',
      title: `Import failed — ${job.fileName ?? job.sourceType}`,
      detail: job.error ? String(job.error) : 'See Imports for details.',
      href: '/imports'
    })
  }

  const warned = importJobs.filter((j) => j.status === 'succeeded_with_warnings').slice(0, 3)
  if (warned.length > 0) {
    items.push({
      id: 'import-warnings',
      severity: 'warning',
      title: `${warned.length} import${warned.length === 1 ? '' : 's'} with warnings`,
      detail: 'Some rows were quarantined — review before reporting.',
      href: '/imports'
    })
  }

  return items
}

/** All-clients KPI table with trailing-charges sparklines and attention callouts. */
function Portfolio(): React.JSX.Element {
  const { period } = useAppScope()
  const [rows, setRows] = useState<Row[]>([])
  const [importJobs, setImportJobs] = useState<ImportJob[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchLog, setBatchLog] = useState<string[]>([])
  const [formats, setFormats] = useState<Set<ExportFormat>>(new Set(['pdf']))

  useEffect(() => {
    setLoading(true)
    setError(null)
    Promise.all([getPortfolioReports(period), listClients(), listImportJobs()])
      .then(async ([reports, clients, jobs]) => {
        setImportJobs(jobs)
        const idByCode = new Map(clients.map((c) => [c.code, c.clientId]))
        const resolvedIds = reports
          .map((r) => idByCode.get(r.client.code) ?? 0)
          .filter((id) => id > 0)

        const sparklines = await getPortfolioSparklines(resolvedIds, period, 6)
        const sparklineById = new Map(sparklines.map((s) => [s.clientId, s.grossCharges]))

        const withSparklines: Row[] = reports.map((report) => {
          const clientId = idByCode.get(report.client.code) ?? 0
          return {
            clientId,
            report,
            sparkline: clientId ? (sparklineById.get(clientId) ?? []) : []
          }
        })
        setRows(withSparklines)
        setSelected(new Set())
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [period])

  const attentionItems = useMemo(
    () => buildAttentionItems(rows, importJobs, period),
    [rows, importJobs, period]
  )

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

  const exportActions = (
    <div className="toolbar-actions">
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
  )

  return (
    <ScreenShell>
      <ScreenHeader
        title="Portfolio"
        description="Headline KPIs for every client in the selected period."
        actions={exportActions}
      />

      <AttentionPanel items={attentionItems} />

      {batchLog.length > 0 && (
        <ul className="batch-log">
          {batchLog.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <AsyncState
        loading={loading}
        error={error}
        empty={rows.length === 0}
        emptyTitle="No active clients yet"
        emptyDescription="Add a client to start tracking KPIs and generating report packs."
        emptyAction={
          <Link to="/clients" className="text-link">
            Go to Clients
          </Link>
        }
      >
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col" aria-label="Select for export" />
              <th scope="col">Client</th>
              <th scope="col">Gross charges</th>
              <th scope="col">Net collection rate</th>
              <th scope="col">Days in A/R</th>
              <th scope="col">Denial rate</th>
              <th scope="col">Trend</th>
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
                    aria-label={`Select ${report.client.name}`}
                    onChange={() => toggleSelected(clientId)}
                  />
                </td>
                <td>
                  <Link to={`/clients/${clientId || report.client.code}`}>{report.client.name}</Link>
                  {reportNeedsData(report) && (
                    <span className="row-badge row-badge--warning">No data</span>
                  )}
                </td>
                <td className="tabular-nums">{fmtMoney(report.financials.grossCharges)}</td>
                <td className="tabular-nums">{fmtPct(report.financials.netCollectionRatePct)}</td>
                <td className="tabular-nums">{report.kpis.daysInAr ?? '—'}</td>
                <td className="tabular-nums">{fmtPct(report.kpis.denialRatePct)}</td>
                <td style={{ width: 90 }}>
                  {sparkline.length > 1 ? (
                    <Sparkline values={sparkline} />
                  ) : (
                    <span className="text-muted-xs">n/a</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </AsyncState>
    </ScreenShell>
  )
}

export default Portfolio
