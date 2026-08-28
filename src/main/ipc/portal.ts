/**
 * IPC handlers for `portal:*` (plan's Phase 3 addendum, chunk F):
 * portal connection settings and the manual "Publish to portal" action
 * on ClientDetail. Like `ipc/automation.ts`, this is where the admin
 * token is encrypted/decrypted — `LocalDataService` only ever sees the
 * opaque encrypted blob.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import { encryptCredential } from '../credentials'
import { getPortalStatus } from '../automation/portal-client'
import { publishClientToPortal } from '../automation/portal-publish'
import { resolveSmtpTransport, resolvePortalConfig } from '../automation/run-scheduler'
import type { IDataService } from '../services/data-service'

export function registerPortalHandlers(dataService: IDataService): void {
  ipcMain.handle('portal:getSettings', async (_event, rawPayload: unknown) => {
    parseIpcRequest('portal:getSettings', rawPayload)
    const settings = await dataService.getPortalSettings()
    return parseIpcResponse('portal:getSettings', settings)
  })

  ipcMain.handle('portal:saveSettings', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('portal:saveSettings', rawPayload)
    const settings = await dataService.savePortalSettings({
      baseUrl: request.baseUrl,
      encryptedAdminToken: request.adminToken ? encryptCredential(request.adminToken) : undefined
    })
    return parseIpcResponse('portal:saveSettings', settings)
  })

  ipcMain.handle('portal:testConnection', async (_event, rawPayload: unknown) => {
    parseIpcRequest('portal:testConnection', rawPayload)
    const portalConfig = await resolvePortalConfig(dataService)
    if (!portalConfig) {
      return parseIpcResponse('portal:testConnection', {
        ok: false,
        message: 'The portal is not configured yet — set the base URL and admin token first.'
      })
    }
    try {
      const status = await getPortalStatus(portalConfig)
      return parseIpcResponse('portal:testConnection', {
        ok: status.ok,
        message: `Connected — ${status.snapshotCount} snapshot(s), ${status.activeTokenCount} active link(s).`
      })
    } catch (error) {
      return parseIpcResponse('portal:testConnection', {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })

  ipcMain.handle('portal:publishReport', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('portal:publishReport', rawPayload)
    const portalConfig = await resolvePortalConfig(dataService)
    if (!portalConfig) {
      return parseIpcResponse('portal:publishReport', {
        clientCode: `#${request.clientId}`,
        ok: false,
        error: 'The portal is not configured yet — set it up in Settings first.',
        linksSent: []
      })
    }
    const clients = await dataService.listClients()
    const client = clients.find((c) => c.clientId === request.clientId)
    if (!client) {
      return parseIpcResponse('portal:publishReport', {
        clientCode: `#${request.clientId}`,
        ok: false,
        error: 'Client not found.',
        linksSent: []
      })
    }
    const smtp = request.sendLinks ? await resolveSmtpTransport(dataService) : null
    const result = await publishClientToPortal(
      dataService,
      portalConfig,
      smtp,
      client,
      request.periodMonth,
      request.sendLinks
    )
    return parseIpcResponse('portal:publishReport', result)
  })
}
