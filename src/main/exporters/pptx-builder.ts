/**
 * Pure PPTX deck assembly (plan §6) — no Electron, no I/O. Kept in its
 * own module, separate from `pptx.ts`'s offscreen-window orchestration,
 * specifically so this file (and only this file) can be imported by a
 * plain vitest test: `pptx.ts` imports `electron`'s `BrowserWindow` at
 * module scope, which fails to even load outside a real Electron
 * process, so anything that needs to be unit-testable can't live there.
 *
 * Builds a deck from the SAME `ClientReport` JSON the PDF path renders —
 * title slide (branding), KPI scorecard, one slide per chart (each PNG
 * already captured by the caller via the offscreen print route — see
 * `pptx.ts`/`print-ready.ts`/`ReportDocument.tsx`), and native pptx
 * tables for A/R aging, denials by root cause, and payer mix (editable
 * by account managers, unlike a PDF or a chart image).
 */
import PptxGenJS from 'pptxgenjs'
import type { Branding, ClientReport } from '../../shared/domain'
import type { ChartImageMap } from './print-ready'

const SLIDE_WIDTH_IN = 10
const SLIDE_HEIGHT_IN = 5.63 // 16:9

function hex(color: string): string {
  return color.replace('#', '')
}

function fmtMoney(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}
function fmtPct(value: number | null): string {
  return value === null ? 'no data' : `${value}%`
}
function fmtDays(value: number | null): string {
  return value === null ? 'no data' : `${value} days`
}

function addFooter(slide: PptxGenJS.Slide, disclaimer: string | null): void {
  if (!disclaimer) return
  slide.addText(disclaimer, {
    x: 0.4,
    y: SLIDE_HEIGHT_IN - 0.35,
    w: SLIDE_WIDTH_IN - 0.8,
    h: 0.3,
    fontSize: 8,
    color: '888888'
  })
}

export function buildClientReportPptx(
  report: ClientReport,
  branding: Branding,
  chartImages: ChartImageMap
): PptxGenJS {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'AETHERA_REPORTS', width: SLIDE_WIDTH_IN, height: SLIDE_HEIGHT_IN })
  pptx.layout = 'AETHERA_REPORTS'

  // --- Title slide ---
  const title = pptx.addSlide()
  title.background = { color: hex(branding.primaryColor) }
  if (branding.logoPath) {
    // Called directly (not over IPC), so `logoPath` is the real
    // filesystem path meta.db stores — no data-URI conversion needed
    // (that only happens in `ipc/branding.ts`, for the renderer's CSP).
    title.addImage({ path: branding.logoPath, x: 0.4, y: 0.3, w: 1.0, h: 1.0 })
  }
  title.addText(branding.firmName, {
    x: 0.4,
    y: 1.5,
    w: SLIDE_WIDTH_IN - 0.8,
    h: 0.4,
    fontSize: 16,
    color: 'FFFFFF',
    bold: true
  })
  title.addText(`${report.client.name} (${report.client.code})`, {
    x: 0.4,
    y: 2.0,
    w: SLIDE_WIDTH_IN - 0.8,
    h: 0.6,
    fontSize: 26,
    color: 'FFFFFF',
    bold: true
  })
  title.addText(`Period: ${report.period.start} - ${report.period.end}`, {
    x: 0.4,
    y: 2.7,
    w: SLIDE_WIDTH_IN - 0.8,
    h: 0.35,
    fontSize: 13,
    color: 'FFFFFF'
  })
  title.addText(`Contract: ${report.client.contract}`, {
    x: 0.4,
    y: 3.05,
    w: SLIDE_WIDTH_IN - 0.8,
    h: 0.35,
    fontSize: 13,
    color: 'FFFFFF'
  })
  addFooter(title, branding.footerDisclaimer)

  // --- KPI scorecard slide ---
  const kpiSlide = pptx.addSlide()
  kpiSlide.addText('KPI Scorecard', {
    x: 0.4,
    y: 0.3,
    w: SLIDE_WIDTH_IN - 0.8,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: hex(branding.primaryColor)
  })
  const kpiPairs: Array<[string, string]> = [
    ['Gross charges', fmtMoney(report.financials.grossCharges)],
    ['Total collections', fmtMoney(report.financials.totalCollections)],
    ['Net collection rate', fmtPct(report.financials.netCollectionRatePct)],
    ['Days in A/R', fmtDays(report.kpis.daysInAr)],
    ['Open A/R', `${fmtMoney(report.kpis.openAr)} (${report.kpis.arOver90Pct}% over 90 days)`],
    ['Denial rate', fmtPct(report.kpis.denialRatePct)],
    ['First-pass acceptance', fmtPct(report.kpis.firstPassAcceptancePct)]
  ]
  kpiSlide.addTable(
    kpiPairs.map(([label, value]) => [
      { text: label, options: { bold: true, color: '333333' } },
      { text: value }
    ]),
    {
      x: 0.4,
      y: 1.0,
      w: SLIDE_WIDTH_IN - 0.8,
      colW: [(SLIDE_WIDTH_IN - 0.8) * 0.45, (SLIDE_WIDTH_IN - 0.8) * 0.55],
      fontSize: 14,
      border: { type: 'solid', color: 'CCCCCC', pt: 0.5 },
      autoPage: false
    }
  )
  addFooter(kpiSlide, branding.footerDisclaimer)

  // --- Chart slides (one per captured PNG; a missing chart image gets a "no data" note instead of a blank slide) ---
  const chartSpecs: Array<{ key: string; title: string }> = [
    { key: 'trend', title: 'Charges vs. Collections (trailing months)' },
    { key: 'arAging', title: 'A/R Aging' },
    { key: 'denialsByRootCause', title: 'Denials by Root Cause' },
    { key: 'payerMix', title: 'Payer Mix' }
  ]
  for (const spec of chartSpecs) {
    const slide = pptx.addSlide()
    slide.addText(spec.title, {
      x: 0.4,
      y: 0.3,
      w: SLIDE_WIDTH_IN - 0.8,
      h: 0.5,
      fontSize: 22,
      bold: true,
      color: hex(branding.primaryColor)
    })
    const image = chartImages[spec.key]
    if (image) {
      slide.addImage({
        data: image,
        x: 0.5,
        y: 1.0,
        w: SLIDE_WIDTH_IN - 1.0,
        h: SLIDE_HEIGHT_IN - 1.5
      })
    } else {
      slide.addText('No data for this period.', {
        x: 0.4,
        y: 2.4,
        w: SLIDE_WIDTH_IN - 0.8,
        h: 0.5,
        fontSize: 16,
        color: '888888',
        align: 'center'
      })
    }
    addFooter(slide, branding.footerDisclaimer)
  }

  // --- Native tables (editable by account managers) ---
  const agingSlide = pptx.addSlide()
  agingSlide.addText('A/R Aging Detail', {
    x: 0.4,
    y: 0.3,
    w: SLIDE_WIDTH_IN - 0.8,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: hex(branding.primaryColor)
  })
  agingSlide.addTable(
    [
      [
        { text: 'Bucket', options: { bold: true } },
        { text: 'Amount', options: { bold: true } }
      ],
      ...Object.entries(report.arAging).map(([bucket, amount]) => [
        { text: bucket },
        { text: fmtMoney(amount) }
      ])
    ],
    { x: 0.4, y: 1.0, w: 5, fontSize: 13, border: { type: 'solid', color: 'CCCCCC', pt: 0.5 } }
  )
  addFooter(agingSlide, branding.footerDisclaimer)

  const denialsSlide = pptx.addSlide()
  denialsSlide.addText('Denials by Root Cause', {
    x: 0.4,
    y: 0.3,
    w: SLIDE_WIDTH_IN - 0.8,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: hex(branding.primaryColor)
  })
  const denialEntries = Object.entries(report.denialsByRootCause)
  denialsSlide.addTable(
    [
      [
        { text: 'Root cause', options: { bold: true } },
        { text: 'Count', options: { bold: true } }
      ],
      ...(denialEntries.length > 0
        ? denialEntries.map(([cause, count]) => [{ text: cause }, { text: String(count) }])
        : [[{ text: 'No denials in this period.' }, { text: '' }]])
    ],
    { x: 0.4, y: 1.0, w: 6, fontSize: 13, border: { type: 'solid', color: 'CCCCCC', pt: 0.5 } }
  )
  addFooter(denialsSlide, branding.footerDisclaimer)

  const payerSlide = pptx.addSlide()
  payerSlide.addText('Payer Mix', {
    x: 0.4,
    y: 0.3,
    w: SLIDE_WIDTH_IN - 0.8,
    h: 0.5,
    fontSize: 22,
    bold: true,
    color: hex(branding.primaryColor)
  })
  payerSlide.addTable(
    [
      [
        { text: 'Payer', options: { bold: true } },
        { text: 'Charges', options: { bold: true } }
      ],
      ...(report.payerMix.length > 0
        ? report.payerMix.map((p) => [{ text: p.payerName }, { text: fmtMoney(p.charges) }])
        : [[{ text: 'No claims in this period.' }, { text: '' }]])
    ],
    { x: 0.4, y: 1.0, w: 6, fontSize: 13, border: { type: 'solid', color: 'CCCCCC', pt: 0.5 } }
  )
  addFooter(payerSlide, branding.footerDisclaimer)

  return pptx
}
