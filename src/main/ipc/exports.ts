/**
 * IPC handlers for `exports:*` (plan §6): single and batch PDF export.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'
import { exportClientReportPdf } from '../exporters/pdf'
import { exportClientReportPdfBatch } from '../exporters/batch'

export function registerExportsHandlers(dataService: IDataService): void {
  ipcMain.handle('exports:generatePdf', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('exports:generatePdf', rawPayload)
    const result = await exportClientReportPdf(dataService, request.clientId, request.periodMonth)
    return parseIpcResponse('exports:generatePdf', result)
  })

  ipcMain.handle('exports:generateBatch', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('exports:generateBatch', rawPayload)
    const results = await exportClientReportPdfBatch(
      dataService,
      request.clientIds,
      request.periodMonth
    )
    return parseIpcResponse('exports:generateBatch', { results })
  })
}
