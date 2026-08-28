/**
 * PPTX export orchestration (plan §6): renders the offscreen print
 * route to capture each chart as a PNG (same window/route the PDF path
 * uses — see `print-ready.ts`), then hands the report + branding + chart
 * images to the pure deck builder in `pptx-builder.ts`. Kept separate
 * from that file specifically because this one imports `electron`
 * (`BrowserWindow`) at module scope, which only resolves inside a real
 * Electron process — `pptx-builder.ts` has no such dependency and is
 * unit-tested directly.
 */
import { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadRenderer } from '../window-target'
import { waitForPrintReady, type ChartImageMap } from './print-ready'
import { buildClientReportPptx } from './pptx-builder'
import { reportPptxPath } from './paths'
import type { IDataService } from '../services/data-service'
import type { ExportResult } from '../../shared/domain'

/**
 * Renders the same offscreen print route the PDF path uses, purely to
 * capture each chart's PNG — the PPTX doesn't otherwise use anything
 * this window renders (its layout/tables are built directly from the
 * `ClientReport` JSON, not scraped from the page).
 */
async function renderChartImages(clientId: number, periodMonth: string): Promise<ChartImageMap> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  try {
    const readyPromise = waitForPrintReady(win.webContents.id)
    await loadRenderer(win, `/print/${clientId}/${periodMonth}`)
    return await readyPromise
  } finally {
    if (!win.isDestroyed()) win.close()
  }
}

export async function renderClientReportPptxBuffer(
  dataService: IDataService,
  clientId: number,
  periodMonth: string
): Promise<Buffer> {
  const [report, branding, chartImages] = await Promise.all([
    dataService.buildClientReport(clientId, periodMonth),
    dataService.getBranding(),
    renderChartImages(clientId, periodMonth)
  ])

  const pptx = buildClientReportPptx(report, branding, chartImages)
  const output = await pptx.write({ outputType: 'nodebuffer' })
  return Buffer.from(output as Uint8Array)
}

export async function exportClientReportPptx(
  dataService: IDataService,
  clientId: number,
  periodMonth: string
): Promise<ExportResult> {
  const client = (await dataService.listClients()).find((c) => c.clientId === clientId) ?? null
  if (!client) {
    return {
      clientCode: `#${clientId}`,
      periodMonth,
      format: 'pptx',
      filePath: null,
      error: 'Client not found'
    }
  }

  try {
    const buffer = await renderClientReportPptxBuffer(dataService, clientId, periodMonth)
    const filePath = reportPptxPath(periodMonth, client.code)
    await writeFile(filePath, buffer)
    dataService.recordExport({
      action: 'export_pptx',
      clientCode: client.code,
      periodMonth,
      filePath
    })
    return { clientCode: client.code, periodMonth, format: 'pptx', filePath, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { clientCode: client.code, periodMonth, format: 'pptx', filePath: null, error: message }
  }
}
