/**
 * IPC handlers for `backups:*` (Risk 5).
 */
import { app, ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'

export function registerBackupsHandlers(dataService: IDataService): void {
  ipcMain.handle('backups:status', async (_event, rawPayload: unknown) => {
    parseIpcRequest('backups:status', rawPayload)
    const status = await dataService.getBackupStatus()
    return parseIpcResponse('backups:status', status)
  })

  ipcMain.handle('backups:runNow', async (_event, rawPayload: unknown) => {
    parseIpcRequest('backups:runNow', rawPayload)
    const status = await dataService.runBackupNow()
    return parseIpcResponse('backups:runNow', status)
  })

  ipcMain.handle('backups:restoreLatest', async (_event, rawPayload: unknown) => {
    parseIpcRequest('backups:restoreLatest', rawPayload)
    const result = await dataService.restoreLatestBackup()
    // The DB connections this dataService held are now closed (plan
    // step 9: "restore = close connections, copy backup over live
    // files, relaunch prompt"). Reply to the renderer first so it can
    // show "restoring, restarting…", then relaunch shortly after —
    // `app.exit()` (not `app.quit()`) skips `before-quit`, so we don't
    // try to close the already-closed connections a second time.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 500)
    return parseIpcResponse('backups:restoreLatest', result)
  })
}
