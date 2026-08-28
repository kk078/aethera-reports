/**
 * "report-ready" signaling for the offscreen PDF print window (plan §6).
 * The print route (`#/print/:clientId/:period`) invokes
 * `reports:printReady` once its charts have finished rendering;
 * `waitForPrintReady` resolves the promise `exportClientReportPdf` is
 * awaiting before calling `printToPDF`.
 *
 * Correlated by `event.sender.id` (the print WebContents), not a single
 * global flag — batch export (plan §6) runs up to 2 exports
 * concurrently, so two offscreen windows can be waiting at once.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'

const pendingBySenderId = new Map<number, () => void>()

export function registerPrintReadyHandler(): void {
  ipcMain.handle('reports:printReady', (event, rawPayload: unknown) => {
    parseIpcRequest('reports:printReady', rawPayload)
    const resolve = pendingBySenderId.get(event.sender.id)
    if (resolve) {
      pendingBySenderId.delete(event.sender.id)
      resolve()
    }
    return parseIpcResponse('reports:printReady', { ok: true })
  })
}

/** Resolves when the given WebContents id signals `reports:printReady`, or after `timeoutMs` regardless. */
export function waitForPrintReady(webContentsId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      pendingBySenderId.delete(webContentsId)
      resolve()
    }
    pendingBySenderId.set(webContentsId, done)
    setTimeout(done, timeoutMs)
  })
}
