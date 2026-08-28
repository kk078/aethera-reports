/**
 * IPC handlers for `manualEntry:*` (plan §3, Phase 1 step 6).
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'

export function registerManualEntryHandlers(dataService: IDataService): void {
  ipcMain.handle('manualEntry:upsert', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('manualEntry:upsert', rawPayload)
    const summary = await dataService.upsertMonthlySummary(request)
    return parseIpcResponse('manualEntry:upsert', summary)
  })

  ipcMain.handle('manualEntry:get', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('manualEntry:get', rawPayload)
    const summary = await dataService.getMonthlySummary(request.clientId, request.periodMonth)
    return parseIpcResponse('manualEntry:get', { summary })
  })
}
