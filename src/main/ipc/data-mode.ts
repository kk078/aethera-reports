/**
 * `dataMode:*` + `app:restart` (Phase 3 chunk E, plan's Phase 3 addendum:
 * "Settings gains 'Data mode: Local / Server (URL + credentials via
 * safeStorage)'; switching prompts an app restart"). The server password
 * is encrypted here (never in `app-config.ts` or the renderer) — same
 * pattern as `ipc/rcm-connector.ts`'s connector password.
 */
import { app, ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import { loadAppConfig, saveAppConfig, type AppConfig } from '../app-config'
import { encryptCredential } from '../credentials'
import { testRemoteConnection } from '../services/remote-data-service'
import type { DataModeStatus } from '../../shared/domain'

function statusFromConfig(config: AppConfig): DataModeStatus {
  return {
    mode: config.dataMode,
    server: config.server
      ? { baseUrl: config.server.baseUrl, username: config.server.username }
      : null
  }
}

export function registerDataModeHandlers(userDataDir: string): void {
  ipcMain.handle('dataMode:get', async (_event, rawPayload: unknown) => {
    parseIpcRequest('dataMode:get', rawPayload)
    return parseIpcResponse('dataMode:get', statusFromConfig(loadAppConfig(userDataDir)))
  })

  ipcMain.handle('dataMode:setLocal', async (_event, rawPayload: unknown) => {
    parseIpcRequest('dataMode:setLocal', rawPayload)
    const config: AppConfig = { dataMode: 'local', server: null }
    saveAppConfig(userDataDir, config)
    return parseIpcResponse('dataMode:setLocal', statusFromConfig(config))
  })

  ipcMain.handle('dataMode:setServer', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('dataMode:setServer', rawPayload)
    const config: AppConfig = {
      dataMode: 'server',
      server: {
        baseUrl: request.baseUrl,
        username: request.username,
        encryptedPassword: encryptCredential(request.password)
      }
    }
    saveAppConfig(userDataDir, config)
    return parseIpcResponse('dataMode:setServer', statusFromConfig(config))
  })

  ipcMain.handle('dataMode:testServerConnection', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('dataMode:testServerConnection', rawPayload)
    const result = await testRemoteConnection(request)
    return parseIpcResponse('dataMode:testServerConnection', result)
  })

  ipcMain.handle('app:restart', async (_event, rawPayload: unknown) => {
    parseIpcRequest('app:restart', rawPayload)
    // A short delay so the renderer actually receives this response
    // before the process tears itself down.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 100)
    return parseIpcResponse('app:restart', { ok: true })
  })
}
