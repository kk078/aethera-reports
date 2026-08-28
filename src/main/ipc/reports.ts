/**
 * IPC handlers for `reports:*` (plan §4, Phase 1 step 7/8).
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'

export function registerReportsHandlers(dataService: IDataService): void {
  ipcMain.handle('reports:client', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('reports:client', rawPayload)
    const report = await dataService.buildClientReport(request.clientId, request.periodMonth)
    return parseIpcResponse('reports:client', report)
  })

  ipcMain.handle('reports:portfolio', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('reports:portfolio', rawPayload)
    const reports = await dataService.listClientReportsForPeriod(request.periodMonth)
    return parseIpcResponse('reports:portfolio', { reports })
  })

  ipcMain.handle('reports:trend', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('reports:trend', rawPayload)
    const points = await dataService.getClientFinancialTrend(
      request.clientId,
      request.endPeriodMonth,
      request.monthsBack
    )
    return parseIpcResponse('reports:trend', { points })
  })
}
