/**
 * HTML page rendering (plan: "renders the report list for that client";
 * "report page renders the ClientReport JSON mobile-friendly and
 * read-only: server-rendered inline SVG charts ... branding fields from
 * the snapshot, provenance/benchmark blocks when present"). No external
 * CSS/JS/fonts/CDNs anywhere — everything is inlined, and there is no
 * `<script>` tag in any of these pages at all (plan: "no JS needed or
 * minimal inline").
 */
import { escapeHtml, svgDonutChart, svgHorizontalBarChart } from './charts'
import type { ClientReport } from '../../src/shared/domain'
import type { SnapshotSummary } from './snapshots'

/*
 * Aethera Client Portal — M3 mobile styling (aethera_client_portal's
 * DESIGN.md): same palette family as the desktop app (Healthcare Blue
 * primary #005bbf; billing-green/high-emphasis-red/exception-orange
 * semantics), 8dp "Round Eight" radius everywhere, larger touch targets
 * (48dp minimum hit area) and generous mobile type sizes. Fonts stay a
 * system stack — no external font requests from a portal that must
 * remain zero-JS/strict-CSP; "Roboto Flex" in the spec is satisfied by
 * the system Roboto fallback wherever the OS ships it.
 */
const BASE_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 16px; background: #f9f9ff; color: #191c23; max-width: 720px; margin-left: auto; margin-right: auto; font-size: 14px; line-height: 1.5; }
  h1, h2 { color: #191c23; }
  h1 { font-size: 1.5rem; font-weight: 600; }
  h2 { font-size: 1.125rem; font-weight: 500; margin-top: 2rem; }
  .card { background: #ffffff; border: 1px solid #c4c7c5; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  td, th { text-align: left; padding: 10px 4px; border-bottom: 1px solid #e0e2ec; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
  .kpi { background: #f2f3fd; border-radius: 8px; padding: 12px; }
  .kpi .label { font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace; font-size: 0.6875rem; font-weight: 500; letter-spacing: 0.5px; text-transform: uppercase; color: #414754; }
  .kpi .value { font-size: 1.25rem; font-weight: 700; margin-top: 4px; color: #191c23; }
  .footer { font-size: 0.75rem; color: #727785; margin-top: 2rem; text-align: center; }
  a { color: #005bbf; }
  .period-list a { display: flex; align-items: center; min-height: 48px; padding: 10px 0; border-bottom: 1px solid #e0e2ec; font-size: 1rem; }
  .status-pill { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 500; }
  .status-pill--good { background: #e6f4ea; color: #1e8e3e; }
  .status-pill--warning { background: #fef7e0; color: #b06f00; }
  .status-pill--critical { background: #ffdad6; color: #93000a; }
`

function pageShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`
}

/** Shown for an unknown/expired/revoked token AND an unauthenticated/mismatched session — deliberately generic (never reveals which specific check failed). */
export function renderLinkExpiredPage(): string {
  return pageShell(
    'Link expired',
    `<div class="card">
      <h1>This link has expired</h1>
      <p>The report link you used is no longer valid — it may have expired, been revoked, or already been used from a different session.</p>
      <p>Please contact your account manager for a new link.</p>
    </div>`
  )
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  })
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`
}

export function renderReportListPage(clientCode: string, snapshots: SnapshotSummary[]): string {
  const rows =
    snapshots.length === 0
      ? '<p>No reports have been published for this account yet.</p>'
      : `<div class="period-list">${snapshots
          .map(
            (s) =>
              `<a href="/portal/${encodeURIComponent(clientCode)}/${encodeURIComponent(s.period)}">${escapeHtml(s.period)} — published ${new Date(s.publishedAt).toLocaleDateString()}</a>`
          )
          .join('')}</div>`

  return pageShell(
    `Reports — ${clientCode}`,
    `<div class="card">
      <h1>Your reports</h1>
      ${rows}
    </div>`
  )
}

export function renderReportPage(report: ClientReport, publishedAt: string): string {
  const arAgingChart = svgHorizontalBarChart(
    Object.entries(report.arAging).map(([label, value]) => ({ label, value })),
    { valueFormatter: formatCurrency }
  )
  const claimsByStatusChart = svgDonutChart(
    Object.entries(report.claimsByStatus).map(([label, value]) => ({ label, value }))
  )
  const denialsChart = svgHorizontalBarChart(
    Object.entries(report.denialsByRootCause).map(([label, value]) => ({ label, value }))
  )

  const benchmarkSection = report.benchmark
    ? `<div class="card">
        <h2>Benchmark — ${escapeHtml(report.benchmark.state)} (as of ${escapeHtml(report.benchmark.asOf)})</h2>
        <table>
          <tr><th>CPT</th><th>Avg allowed</th><th>State median</th></tr>
          ${report.benchmark.cpts
            .map(
              (cpt) =>
                `<tr><td>${escapeHtml(cpt.cptCode)}${cpt.description ? ` — ${escapeHtml(cpt.description)}` : ''}</td><td>${formatCurrency(cpt.avgAllowed)}</td><td>${cpt.stateMedian === null ? 'n/a' : formatCurrency(cpt.stateMedian)}</td></tr>`
            )
            .join('')}
        </table>
      </div>`
    : ''

  return pageShell(
    `${report.client.name} — ${report.period.start} to ${report.period.end}`,
    `<div class="card">
      <h1>${escapeHtml(report.client.name)}</h1>
      <p>${escapeHtml(report.client.code)} · ${escapeHtml(report.period.start)} to ${escapeHtml(report.period.end)} · source: ${escapeHtml(report.source)}</p>
      <p style="font-size:0.8rem;color:#888;">Published ${escapeHtml(new Date(publishedAt).toLocaleString())}</p>
    </div>

    <div class="card">
      <h2>Financials</h2>
      <div class="kpi-grid">
        <div class="kpi"><div class="label">Gross charges</div><div class="value">${formatCurrency(report.financials.grossCharges)}</div></div>
        <div class="kpi"><div class="label">Insurance collections</div><div class="value">${formatCurrency(report.financials.insuranceCollections)}</div></div>
        <div class="kpi"><div class="label">Patient collections</div><div class="value">${formatCurrency(report.financials.patientCollections)}</div></div>
        <div class="kpi"><div class="label">Net collection rate</div><div class="value">${formatPercent(report.financials.netCollectionRatePct)}</div></div>
      </div>
    </div>

    <div class="card">
      <h2>Key performance indicators</h2>
      <div class="kpi-grid">
        <div class="kpi"><div class="label">Days in A/R</div><div class="value">${report.kpis.daysInAr === null ? 'n/a' : report.kpis.daysInAr.toFixed(1)}</div></div>
        <div class="kpi"><div class="label">Open A/R</div><div class="value">${formatCurrency(report.kpis.openAr)}</div></div>
        <div class="kpi"><div class="label">A/R &gt; 90 days</div><div class="value">${formatPercent(report.kpis.arOver90Pct)}</div></div>
        <div class="kpi"><div class="label">First-pass acceptance</div><div class="value">${formatPercent(report.kpis.firstPassAcceptancePct)}</div></div>
        <div class="kpi"><div class="label">Denial rate</div><div class="value">${formatPercent(report.kpis.denialRatePct)}</div></div>
      </div>
    </div>

    <div class="card">
      <h2>A/R aging</h2>
      ${arAgingChart}
    </div>

    <div class="card">
      <h2>Claims by status</h2>
      ${claimsByStatusChart}
    </div>

    <div class="card">
      <h2>Denials by root cause</h2>
      ${denialsChart}
    </div>

    ${benchmarkSection}

    <div class="footer">This is a private, read-only summary — please don't forward this link.</div>`
  )
}
