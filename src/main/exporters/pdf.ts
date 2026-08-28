/**
 * PDF export (plan §6): an offscreen `BrowserWindow` loads the print
 * route (`#/print/:clientId/:period`), waits for the renderer's
 * `reports:printReady` signal (charts finished rendering), then
 * `webContents.printToPDF`. Same hardening flags as the main window
 * (plan §7) — a print window is still a renderer process.
 */
import { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadRenderer } from '../window-target'
import { waitForPrintReady } from './print-ready'
import { reportPdfPath } from './paths'
import type { IDataService } from '../services/data-service'
import type { ExportResult } from '../../shared/domain'

export async function renderClientReportPdfBuffer(
  clientId: number,
  periodMonth: string
): Promise<Buffer> {
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
    await readyPromise // chart-image map is PPTX-only (pptx.ts) — printToPDF screenshots the whole page instead
    const pdfBuffer = await win.webContents.printToPDF({
      pageSize: 'Letter',
      printBackground: true,
      preferCSSPageSize: false
    })
    return pdfBuffer
  } finally {
    if (!win.isDestroyed()) win.close()
  }
}

export async function exportClientReportPdf(
  dataService: IDataService,
  clientId: number,
  periodMonth: string
): Promise<ExportResult> {
  const client = await (async () => {
    // Reuse the client list rather than adding a getById method just for this.
    const all = await dataService.listClients()
    return all.find((c) => c.clientId === clientId) ?? null
  })()

  if (!client) {
    return {
      clientCode: `#${clientId}`,
      periodMonth,
      format: 'pdf',
      filePath: null,
      error: 'Client not found'
    }
  }

  try {
    const buffer = await renderClientReportPdfBuffer(clientId, periodMonth)
    const filePath = reportPdfPath(periodMonth, client.code)
    await writeFile(filePath, buffer)
    dataService.recordExport({
      action: 'export_pdf',
      clientCode: client.code,
      periodMonth,
      filePath
    })
    return { clientCode: client.code, periodMonth, format: 'pdf', filePath, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { clientCode: client.code, periodMonth, format: 'pdf', filePath: null, error: message }
  }
}
