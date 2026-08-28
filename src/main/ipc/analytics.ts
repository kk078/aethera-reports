/**
 * IPC handlers for `analytics:*` (plan §5, Phase 2 chunk B) — the
 * Denials/AR/Payers screens' cross-client aggregates.
 */
import { ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'

export function registerAnalyticsHandlers(dataService: IDataService): void {
  ipcMain.handle('analytics:listDenials', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('analytics:listDenials', rawPayload)
    const rows = await dataService.listDenials(request.clientId, request.periodMonth)
    return parseIpcResponse('analytics:listDenials', { rows })
  })

  ipcMain.handle('analytics:denialRateTrend', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('analytics:denialRateTrend', rawPayload)
    const points = await dataService.getDenialRateTrend(
      request.clientId,
      request.endPeriodMonth,
      request.monthsBack
    )
    return parseIpcResponse('analytics:denialRateTrend', { points })
  })

  ipcMain.handle('analytics:arAgingByClient', async (_event, rawPayload: unknown) => {
    parseIpcRequest('analytics:arAgingByClient', rawPayload)
    const rows = await dataService.getArAgingByClient()
    return parseIpcResponse('analytics:arAgingByClient', { rows })
  })

  ipcMain.handle('analytics:arPayerVsPatientSplit', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('analytics:arPayerVsPatientSplit', rawPayload)
    const split = await dataService.getArPayerVsPatientSplit(request.clientId)
    return parseIpcResponse('analytics:arPayerVsPatientSplit', split)
  })

  ipcMain.handle('analytics:topAgedClaims', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('analytics:topAgedClaims', rawPayload)
    const rows = await dataService.getTopAgedClaims(request.clientId, request.limit)
    return parseIpcResponse('analytics:topAgedClaims', { rows })
  })

  ipcMain.handle('analytics:daysInArTrend', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('analytics:daysInArTrend', rawPayload)
    const points = await dataService.getDaysInArTrend(
      request.clientId,
      request.endPeriodMonth,
      request.monthsBack
    )
    return parseIpcResponse('analytics:daysInArTrend', { points })
  })

  ipcMain.handle('analytics:payerAnalysis', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('analytics:payerAnalysis', rawPayload)
    const rows = await dataService.getPayerAnalysis(request.clientId, request.periodMonth)
    return parseIpcResponse('analytics:payerAnalysis', { rows })
  })

  ipcMain.handle('analytics:payerMixTrend', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('analytics:payerMixTrend', rawPayload)
    const points = await dataService.getPayerMixTrend(
      request.clientId,
      request.endPeriodMonth,
      request.monthsBack
    )
    return parseIpcResponse('analytics:payerMixTrend', { points })
  })
}
