/**
 * IPC handlers for `connector:*` (plan §3 bullet 3, Phase 2 chunk C) —
 * the generic RCM Platform REST connector. This is the ONE place
 * (besides `credentials.ts` itself) that touches password encryption:
 * the renderer sends the plaintext password once, at save time, over
 * the already-trusted preload/IPC boundary; it's encrypted here before
 * anything reaches `LocalDataService`/meta.db.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import { encryptCredential, decryptCredential } from '../credentials'
import type { IDataService } from '../services/data-service'

export function registerRcmConnectorHandlers(dataService: IDataService): void {
  ipcMain.handle('connector:getSettings', async (_event, rawPayload: unknown) => {
    parseIpcRequest('connector:getSettings', rawPayload)
    const settings = await dataService.getConnectorSettings()
    return parseIpcResponse('connector:getSettings', settings)
  })

  ipcMain.handle('connector:saveSettings', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('connector:saveSettings', rawPayload)
    const settings = await dataService.saveConnectorSettings({
      baseUrl: request.baseUrl,
      username: request.username,
      enabled: request.enabled,
      encryptedPassword: request.password ? encryptCredential(request.password) : undefined
    })
    return parseIpcResponse('connector:saveSettings', settings)
  })

  ipcMain.handle('connector:testConnection', async (_event, rawPayload: unknown) => {
    parseIpcRequest('connector:testConnection', rawPayload)
    const settings = await dataService.getConnectorSettings()
    if (!settings.baseUrl || !settings.username) {
      return parseIpcResponse('connector:testConnection', {
        ok: false,
        message: 'Connector is not configured yet — set the base URL, username, and password first.'
      })
    }
    const secret = await dataService.getEncryptedConnectorPassword()
    if (!secret) {
      return parseIpcResponse('connector:testConnection', {
        ok: false,
        message: 'No password saved for the connector yet.'
      })
    }
    try {
      const password = decryptCredential(secret)
      const result = await dataService.testConnectorConnection(
        settings.baseUrl,
        settings.username,
        password
      )
      return parseIpcResponse('connector:testConnection', result)
    } catch (error) {
      return parseIpcResponse('connector:testConnection', {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })

  ipcMain.handle('connector:syncNow', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('connector:syncNow', rawPayload)
    const settings = await dataService.getConnectorSettings()
    if (!settings.baseUrl || !settings.username) {
      throw new Error(
        'Connector is not configured yet — set the base URL, username, and password first.'
      )
    }
    const secret = await dataService.getEncryptedConnectorPassword()
    if (!secret) throw new Error('No password saved for the connector yet.')
    const password = decryptCredential(secret)
    const result = await dataService.runConnectorSync(
      settings.baseUrl,
      settings.username,
      password,
      request.periodMonth
    )
    return parseIpcResponse('connector:syncNow', result)
  })

  ipcMain.handle('connector:syncStatus', async (_event, rawPayload: unknown) => {
    parseIpcRequest('connector:syncStatus', rawPayload)
    const rows = await dataService.listConnectorSyncStatus()
    return parseIpcResponse('connector:syncStatus', { rows })
  })
}
