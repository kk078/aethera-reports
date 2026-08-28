/**
 * IPC handlers for the `clients:*` channels (plan Phase 1 step 4). Every
 * handler validates its payload via `parseIpcRequest`/`parseIpcResponse`
 * before touching `IDataService` — see `ping.ts` for the pattern this
 * follows.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'

export function registerClientsHandlers(dataService: IDataService): void {
  ipcMain.handle('clients:list', async (_event, rawPayload: unknown) => {
    parseIpcRequest('clients:list', rawPayload)
    const clients = await dataService.listClients()
    return parseIpcResponse('clients:list', { clients })
  })

  ipcMain.handle('clients:create', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('clients:create', rawPayload)
    const client = await dataService.createClient(request)
    return parseIpcResponse('clients:create', client)
  })

  ipcMain.handle('clients:update', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('clients:update', rawPayload)
    const client = await dataService.updateClient(request.clientId, request.patch)
    return parseIpcResponse('clients:update', client)
  })

  ipcMain.handle('clients:deactivate', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('clients:deactivate', rawPayload)
    const client = await dataService.deactivateClient(request.clientId)
    return parseIpcResponse('clients:deactivate', client)
  })
}
