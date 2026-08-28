/**
 * "report-ready" signaling for the offscreen PDF/PPTX print window (plan
 * §6). The print route (`#/print/:clientId/:period`) invokes
 * `reports:printReady` once its charts have finished rendering, carrying
 * each chart's captured PNG (data URI) keyed by chart name;
 * `waitForPrintReady` resolves with that map once the promise
 * `exportClientReportPdf`/`renderClientReportPptxBuffer` is awaiting
 * fires. The PDF path ignores the map (printToPDF screenshots the whole
 * page); the PPTX exporter places the images on slides.
 *
 * Correlated by `event.sender.id` (the print WebContents), not a single
 * global flag — batch export (plan §6) runs up to 2 exports
 * concurrently, so two offscreen windows can be waiting at once.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'

export type ChartImageMap = Record<string, string>

const pendingBySenderId = new Map<number, (chartImages: ChartImageMap) => void>()

export function registerPrintReadyHandler(): void {
  ipcMain.handle('reports:printReady', (event, rawPayload: unknown) => {
    const request = parseIpcRequest('reports:printReady', rawPayload)
    const resolve = pendingBySenderId.get(event.sender.id)
    if (resolve) {
      pendingBySenderId.delete(event.sender.id)
      resolve(request.chartImages)
    }
    return parseIpcResponse('reports:printReady', { ok: true })
  })
}

/** Resolves with the chart-image map when the given WebContents id signals `reports:printReady`, or `{}` after `timeoutMs`. */
export function waitForPrintReady(
  webContentsId: number,
  timeoutMs = 15_000
): Promise<ChartImageMap> {
  return new Promise((resolve) => {
    let settled = false
    const done = (chartImages: ChartImageMap = {}): void => {
      if (settled) return
      settled = true
      pendingBySenderId.delete(webContentsId)
      resolve(chartImages)
    }
    pendingBySenderId.set(webContentsId, done)
    setTimeout(() => done(), timeoutMs)
  })
}
