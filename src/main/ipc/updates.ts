/**
 * `updates:*` — the opt-in update check (see `../update-check.ts`).
 * Settings drives all three: status (incl. the launch auto-check's
 * cached result, which AppLayout polls once for its banner), the
 * auto-check toggle (persisted in `app-config.json`), and "Check now".
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import { loadAppConfig, saveAppConfig } from '../app-config'
import { checkForUpdate, CURRENT_VERSION, getStartupResult } from '../update-check'
import type { UpdateSettingsStatus } from '../../shared/domain'

function status(userDataDir: string): UpdateSettingsStatus {
  return {
    autoCheckUpdates: loadAppConfig(userDataDir).autoCheckUpdates,
    currentVersion: CURRENT_VERSION,
    startupResult: getStartupResult()
  }
}

export function registerUpdateHandlers(userDataDir: string): void {
  ipcMain.handle('updates:getStatus', async (_event, rawPayload: unknown) => {
    parseIpcRequest('updates:getStatus', rawPayload)
    return parseIpcResponse('updates:getStatus', status(userDataDir))
  })

  ipcMain.handle('updates:setAutoCheck', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('updates:setAutoCheck', rawPayload)
    const config = loadAppConfig(userDataDir)
    saveAppConfig(userDataDir, { ...config, autoCheckUpdates: request.enabled })
    return parseIpcResponse('updates:setAutoCheck', status(userDataDir))
  })

  ipcMain.handle('updates:checkNow', async (_event, rawPayload: unknown) => {
    parseIpcRequest('updates:checkNow', rawPayload)
    return parseIpcResponse('updates:checkNow', await checkForUpdate())
  })
}
