/**
 * IPC handlers for `exports:*` (plan §6): single-client multi-format
 * export and the batch queue.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'
import { exportClientReport } from '../exporters/report'
import { exportClientReportBatch } from '../exporters/batch'

export function registerExportsHandlers(dataService: IDataService): void {
  ipcMain.handle('exports:generateReport', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('exports:generateReport', rawPayload)
    const results = await exportClientReport(
      dataService,
      request.clientId,
      request.periodMonth,
      request.formats
    )
    return parseIpcResponse('exports:generateReport', { results })
  })

  ipcMain.handle('exports:generateBatch', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('exports:generateBatch', rawPayload)
    const results = await exportClientReportBatch(
      dataService,
      request.clientIds,
      request.periodMonth,
      request.formats
    )
    return parseIpcResponse('exports:generateBatch', { results })
  })
}
