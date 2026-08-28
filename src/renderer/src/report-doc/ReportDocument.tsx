import { useEffect } from 'react'
import type { Branding, ClientReport } from '../../../shared/domain'
import KpiScorecard from './KpiScorecard'
import TrendBarChart from '../components/charts/TrendBarChart'
import ArAgingChart from '../components/charts/ArAgingChart'
import DenialsParetoChart from '../components/charts/DenialsParetoChart'
import PayerMixChart from '../components/charts/PayerMixChart'
import { signalPrintReady } from '../lib/api'
import './report-document.css'

export interface FinancialTrendPoint {
  month: string
  grossCharges: number
  totalCollections: number
}

export interface ReportDocumentProps {
  report: ClientReport
  branding: Branding
  trend?: FinancialTrendPoint[]
  /** print mode: static charts (animation off) + signals `reports:printReady` once rendered (plan §6). */
  mode?: 'interactive' | 'print'
}

const SOURCE_LABEL: Record<ClientReport['source'], string> = {
  claims: 'imported claims',
  manual: 'manual monthly entry',
  synced: 'synced from connected platform'
}

/**
 * The ONE report document (plan §6) — renders both the interactive
 * ClientDetail screen and the print route. Print mode signals
 * `reports:printReady` after a short delay so the offscreen window's
 * ECharts SVGs have finished painting before `printToPDF` runs.
 */
function ReportDocument({
  report,
  branding,
  trend = [],
  mode = 'interactive'
}: ReportDocumentProps): React.JSX.Element {
  useEffect(() => {
    if (mode !== 'print') return undefined
    const timer = setTimeout(() => {
      void signalPrintReady()
    }, 400)
    return () => clearTimeout(timer)
  }, [mode])

  const style = {
    '--brand-primary': branding.primaryColor,
    '--brand-secondary': branding.secondaryColor
  } as React.CSSProperties
  const animation = mode === 'interactive'

  return (
    <div className={`report-doc${mode === 'print' ? ' report-doc-print' : ''}`} style={style}>
      <header className="report-doc-header">
        {branding.logoPath && (
          // `logoPath` arrives over IPC as a data: URI (see branding.ts) — CSP allows `data:`, not `file:`.
          <img src={branding.logoPath} alt="" className="report-doc-logo" />
        )}
        <div>
          <div className="report-doc-firm">{branding.firmName}</div>
          <h1>
            {report.client.name} ({report.client.code})
          </h1>
          <p>
            Period: {report.period.start} – {report.period.end} · Contract: {report.client.contract}
          </p>
          <p className="report-doc-provenance">Data source: {SOURCE_LABEL[report.source]}</p>
        </div>
      </header>

      <section className="report-doc-section">
        <h2>KPI scorecard</h2>
        <KpiScorecard
          grossCharges={report.financials.grossCharges}
          totalCollections={report.financials.totalCollections}
          netCollectionRatePct={report.financials.netCollectionRatePct}
          daysInAr={report.kpis.daysInAr}
          openAr={report.kpis.openAr}
          arOver90Pct={report.kpis.arOver90Pct}
          denialRatePct={report.kpis.denialRatePct}
          firstPassAcceptancePct={report.kpis.firstPassAcceptancePct}
        />
      </section>

      <section className="report-doc-section report-doc-page-break">
        <h2>Charges vs. collections (trailing months)</h2>
        {trend.length > 0 ? (
          <TrendBarChart
            categories={trend.map((t) => t.month)}
            series={[
              { name: 'Gross charges', values: trend.map((t) => t.grossCharges) },
              { name: 'Total collections', values: trend.map((t) => t.totalCollections) }
            ]}
            animation={animation}
            valueFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
          />
        ) : (
          <p>Not enough history yet.</p>
        )}
      </section>

      <section className="report-doc-section">
        <h2>A/R aging</h2>
        <ArAgingChart aging={report.arAging} animation={animation} />
      </section>

      <section className="report-doc-section report-doc-page-break">
        <h2>Denials by root cause</h2>
        <DenialsParetoChart denialsByRootCause={report.denialsByRootCause} animation={animation} />
      </section>

      <section className="report-doc-section">
        <h2>Payer mix</h2>
        <PayerMixChart payerMix={report.payerMix} animation={animation} />
      </section>

      <footer className="report-doc-footer">
        {branding.footerDisclaimer && <p>{branding.footerDisclaimer}</p>}
        <p>
          Generated {new Date().toLocaleString()} — provenance: {report.source}.
        </p>
      </footer>
    </div>
  )
}

export default ReportDocument
