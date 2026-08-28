/**
 * Handler for the `ping` IPC channel (plan §7 hardened shell / Phase 1
 * step 3). Every channel is registered the same way: validate the
 * incoming payload against the shared zod schema, do the (here trivial)
 * work, validate the outgoing payload before returning it.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'

export function registerPingHandler(): void {
  ipcMain.handle('ping', (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('ping', rawPayload)
    const response = {
      message: request.message,
      echoedAt: new Date().toISOString(),
      pid: process.pid
    }
    return parseIpcResponse('ping', response)
  })
}
