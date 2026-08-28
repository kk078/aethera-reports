/**
 * IPC handlers for `referenceApi:*` (the beacon paragraph, Phase 2 chunk
 * C) — the generic Reference & Benchmark API connector. No credentials
 * (the reference API has none), so unlike `rcm-connector.ts` this is a
 * plain pass-through to `LocalDataService`.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'

export function registerReferenceApiHandlers(dataService: IDataService): void {
  ipcMain.handle('referenceApi:getSettings', async (_event, rawPayload: unknown) => {
    parseIpcRequest('referenceApi:getSettings', rawPayload)
    const settings = await dataService.getReferenceApiSettings()
    return parseIpcResponse('referenceApi:getSettings', settings)
  })

  ipcMain.handle('referenceApi:saveSettings', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('referenceApi:saveSettings', rawPayload)
    const settings = await dataService.saveReferenceApiSettings(request)
    return parseIpcResponse('referenceApi:saveSettings', settings)
  })

  ipcMain.handle('referenceApi:testConnection', async (_event, rawPayload: unknown) => {
    parseIpcRequest('referenceApi:testConnection', rawPayload)
    const result = await dataService.testReferenceApiConnection()
    return parseIpcResponse('referenceApi:testConnection', result)
  })

  ipcMain.handle('referenceApi:refreshCache', async (_event, rawPayload: unknown) => {
    parseIpcRequest('referenceApi:refreshCache', rawPayload)
    const result = await dataService.refreshReferenceApiCache()
    return parseIpcResponse('referenceApi:refreshCache', result)
  })

  ipcMain.handle('referenceApi:getCarcDescriptions', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('referenceApi:getCarcDescriptions', rawPayload)
    const descriptions = await dataService.getCarcDescriptions(request.codes)
    return parseIpcResponse('referenceApi:getCarcDescriptions', { descriptions })
  })
}
