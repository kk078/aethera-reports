/**
 * PPTX exporter tests (plan §6, Phase 2 chunk B). `buildClientReportPptx`
 * (`pptx-builder.ts`) is the pure deck-assembly half of the PPTX
 * exporter — no Electron, no I/O — kept in its own module specifically
 * so it's unit-testable without a live offscreen `BrowserWindow` (the
 * other half, chart-image capture in `pptx.ts`, needs a real renderer
 * and is exercised instead by `scripts/e2e-generate-check.ts`).
 * `pptxgenjs` writes straight to a Node buffer, which is a real OOXML
 * zip — unzipped here with `jszip` to assert slide count and content,
 * exactly like opening the file in PowerPoint would show.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildClientReportPptx } from '../src/main/exporters/pptx-builder'
import type { Branding, ClientReport } from '../src/shared/domain'

const BRANDING: Branding = {
  firmName: 'Test Firm',
  logoPath: null,
  primaryColor: '#336699',
  secondaryColor: '#222222',
  footerDisclaimer: 'Confidential — for internal use only.',
  updatedAt: new Date().toISOString()
}

const REPORT: ClientReport = {
  client: { code: 'PPTXCO', name: 'PPTX Export Co', contract: '5.0% of collections' },
  period: { start: '2026-02-01', end: '2026-02-28' },
  source: 'claims',
  volume: { encountersReceived: 10, claimsSubmitted: 9, denialsReceived: 1 },
  financials: {
    grossCharges: 10000,
    insuranceCollections: 7000,
    patientCollections: 500,
    totalCollections: 7500,
    rcmFee: 375,
    netCollectionRatePct: 75
  },
  kpis: {
    daysInAr: 32.4,
    openAr: 4200,
    arOver90Pct: 12.5,
    chargeLagDaysAvg: 2.1,
    slaDaysToSubmit: 3,
    slaMetPct: 88.9,
    firstPassAcceptancePct: 91.2,
    denialRatePct: 11.1
  },
  arAging: { '0-30': 1000, '31-60': 900, '61-90': 800, '91-120': 700, '120+': 800 },
  kpiTrends: { series: [], latest: null, deltas: {} },
  denialsByRootCause: { CODING: 1 },
  claimsByStatus: { Open: 5, Paid: 4 },
  payerMix: [
    { payerName: 'Payer X', charges: 6000 },
    { payerName: 'Payer Y', charges: 4000 }
  ]
}

async function slideXmlFiles(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer)
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort()
}

async function readSlideText(buffer: Buffer, fileName: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const file = zip.file(fileName)
  if (!file) throw new Error(`${fileName} not found in pptx zip`)
  return file.async('string')
}

describe('buildClientReportPptx', () => {
  it('produces a valid OOXML deck with one slide per section (title, KPI, 4 charts, 3 tables)', async () => {
    const pptx = buildClientReportPptx(REPORT, BRANDING, {
      trend: 'data:image/png;base64,AAAA',
      arAging: 'data:image/png;base64,AAAA'
      // denialsByRootCause / payerMix deliberately omitted -> "no data" slides
    })
    const output = await pptx.write({ outputType: 'nodebuffer' })
    const buffer = Buffer.from(output as Uint8Array)

    const slides = await slideXmlFiles(buffer)
    // title, kpi scorecard, 4 chart slides, ar-aging table, denials table, payer-mix table = 9
    expect(slides).toHaveLength(9)
  })

  it('places the branding firm name and client/period on the title slide', async () => {
    const pptx = buildClientReportPptx(REPORT, BRANDING, {})
    const buffer = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Uint8Array)
    const slides = await slideXmlFiles(buffer)
    const titleXml = await readSlideText(buffer, slides[0])
    expect(titleXml).toContain('Test Firm')
    expect(titleXml).toContain('PPTX Export Co')
    expect(titleXml).toContain('PPTXCO')
  })

  it('renders the KPI scorecard as a native (editable) table, not an image', async () => {
    const pptx = buildClientReportPptx(REPORT, BRANDING, {})
    const buffer = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Uint8Array)
    const slides = await slideXmlFiles(buffer)
    const kpiXml = await readSlideText(buffer, slides[1])
    expect(kpiXml).toContain('<a:tbl>') // a real OOXML table element, not a picture
    expect(kpiXml).toContain('Gross charges')
    expect(kpiXml).toContain('Days in A/R')
  })

  it('places a chart image when captured, and a "no data" note when not', async () => {
    const pptx = buildClientReportPptx(REPORT, BRANDING, { trend: 'data:image/png;base64,AAAA' })
    const buffer = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Uint8Array)
    const slides = await slideXmlFiles(buffer)
    // slide index 2 = first chart slide ("trend") — has an image.
    const trendXml = await readSlideText(buffer, slides[2])
    expect(trendXml).toContain('<p:pic>')
    // slide index 3 = second chart slide ("arAging") — no image captured -> text note instead.
    const arAgingXml = await readSlideText(buffer, slides[3])
    expect(arAgingXml).not.toContain('<p:pic>')
    expect(arAgingXml).toContain('No data for this period.')
  })

  it('builds native pptx tables for A/R aging, denials by root cause, and payer mix', async () => {
    const pptx = buildClientReportPptx(REPORT, BRANDING, {})
    const buffer = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Uint8Array)
    const slides = await slideXmlFiles(buffer)
    // slides 0=title,1=kpi,2-5=charts,6=ar-aging,7=denials,8=payer-mix
    const agingXml = await readSlideText(buffer, slides[6])
    expect(agingXml).toContain('<a:tbl>')
    expect(agingXml).toContain('0-30')

    const denialsXml = await readSlideText(buffer, slides[7])
    expect(denialsXml).toContain('<a:tbl>')
    expect(denialsXml).toContain('CODING')

    const payerXml = await readSlideText(buffer, slides[8])
    expect(payerXml).toContain('<a:tbl>')
    expect(payerXml).toContain('Payer X')
  })

  it('never crashes on an empty report (no denials, no payer mix)', async () => {
    const emptyReport: ClientReport = {
      ...REPORT,
      denialsByRootCause: {},
      payerMix: [],
      claimsByStatus: {}
    }
    const pptx = buildClientReportPptx(emptyReport, BRANDING, {})
    const buffer = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Uint8Array)
    const slides = await slideXmlFiles(buffer)
    expect(slides.length).toBeGreaterThan(0)
    const denialsXml = await readSlideText(buffer, slides[7])
    expect(denialsXml).toContain('No denials in this period.')
  })
})
