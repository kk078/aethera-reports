/**
 * IPC handlers for `importJobs:*` (plan §3, Phase 1 step 5): the wizard's
 * file picker, header peek + fuzzy-match steps, running an import, and
 * reading back job/quarantine state. Progress is observed by the
 * renderer polling `importJobs:get` while a job runs (see
 * `run-csv-import.ts`'s header comment for why — the hardened shell's
 * single-`invoke` model has no push channel).
 */
import { dialog, ipcMain } from 'electron'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'
import {
  peekHeaders,
  previewMapping,
  suggestColumnMappings,
  CLAIM_LINE_TARGET_FIELDS
} from '../importers/csv-xlsx'

export function registerImportsHandlers(dataService: IDataService): void {
  ipcMain.handle('importJobs:list', async (_event, rawPayload: unknown) => {
    parseIpcRequest('importJobs:list', rawPayload)
    const jobs = await dataService.listImportJobs()
    return parseIpcResponse('importJobs:list', { jobs })
  })

  ipcMain.handle('importJobs:get', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('importJobs:get', rawPayload)
    const job = await dataService.getImportJob(request.jobId)
    return parseIpcResponse('importJobs:get', { job })
  })

  ipcMain.handle('importJobs:runCsv', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('importJobs:runCsv', rawPayload)
    const job = await dataService.runCsvImport(request)
    return parseIpcResponse('importJobs:runCsv', job)
  })

  ipcMain.handle('importJobs:listQuarantine', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('importJobs:listQuarantine', rawPayload)
    const rows = await dataService.listQuarantineRows(request.jobId)
    return parseIpcResponse('importJobs:listQuarantine', { rows })
  })

  ipcMain.handle('importJobs:pickFile', async (_event, rawPayload: unknown) => {
    parseIpcRequest('importJobs:pickFile', rawPayload)
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Select a claim export or X12 835/837 file',
      properties: ['openFile'],
      filters: [
        {
          name: 'All supported imports',
          extensions: ['csv', 'xlsx', 'xls', '835', '837', 'edi', 'txt']
        },
        { name: 'Claim exports', extensions: ['csv', 'xlsx', 'xls'] },
        { name: 'X12 835/837', extensions: ['835', '837', 'edi', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const filePath = !canceled && filePaths.length > 0 ? filePaths[0] : null
    return parseIpcResponse('importJobs:pickFile', { filePath })
  })

  ipcMain.handle('importJobs:peekHeaders', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('importJobs:peekHeaders', rawPayload)
    const headers = await peekHeaders(request.filePath)
    return parseIpcResponse('importJobs:peekHeaders', { headers })
  })

  ipcMain.handle('importJobs:suggestMapping', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('importJobs:suggestMapping', rawPayload)
    const suggestions = suggestColumnMappings(request.headers, CLAIM_LINE_TARGET_FIELDS)
    return parseIpcResponse('importJobs:suggestMapping', { suggestions })
  })

  // --- X12 835/837 (plan §3 bullet 2) ---

  ipcMain.handle('importJobs:detectFileKind', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('importJobs:detectFileKind', rawPayload)
    const kind = await dataService.detectImportFileKind(request.filePath)
    return parseIpcResponse('importJobs:detectFileKind', { kind })
  })

  ipcMain.handle('importJobs:previewX12', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('importJobs:previewX12', rawPayload)
    const summary = await dataService.previewX12Import(request.filePath)
    return parseIpcResponse('importJobs:previewX12', { summary })
  })

  ipcMain.handle('importJobs:runX12', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('importJobs:runX12', rawPayload)
    const job = await dataService.runX12Import(request)
    return parseIpcResponse('importJobs:runX12', job)
  })

  ipcMain.handle('importJobs:previewMapping', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('importJobs:previewMapping', rawPayload)
    // A draft template, not persisted — preview happens before "save
    // template → run" in the wizard (plan §3).
    const draftTemplate = {
      templateId: request.mapping.templateId ?? 'draft',
      version: 1,
      builtIn: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...request.mapping
    }
    const rows = await previewMapping(request.filePath, draftTemplate)
    return parseIpcResponse('importJobs:previewMapping', { rows })
  })
}
