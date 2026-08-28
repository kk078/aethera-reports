/**
 * IPC handlers for `mappingTemplates:*` (plan §3, Phase 1 step 5). The
 * file-picker dialogs live here (not in `LocalDataService`, which stays
 * Electron-free) — `exportToFile`/`importFromFile` wrap the plain
 * JSON-string `IDataService` methods with a native save/open dialog.
 */
import { dialog, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'

export function registerMappingTemplateHandlers(dataService: IDataService): void {
  ipcMain.handle('mappingTemplates:list', async (_event, rawPayload: unknown) => {
    parseIpcRequest('mappingTemplates:list', rawPayload)
    const templates = await dataService.listMappingTemplates()
    return parseIpcResponse('mappingTemplates:list', { templates })
  })

  ipcMain.handle('mappingTemplates:get', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('mappingTemplates:get', rawPayload)
    const template = await dataService.getMappingTemplate(request.templateId)
    return parseIpcResponse('mappingTemplates:get', { template })
  })

  ipcMain.handle('mappingTemplates:save', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('mappingTemplates:save', rawPayload)
    const template = await dataService.saveMappingTemplate(request)
    return parseIpcResponse('mappingTemplates:save', template)
  })

  ipcMain.handle('mappingTemplates:exportToFile', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('mappingTemplates:exportToFile', rawPayload)
    const template = await dataService.getMappingTemplate(request.templateId)
    if (!template) return parseIpcResponse('mappingTemplates:exportToFile', { filePath: null })

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export mapping template',
      defaultPath: `${template.templateId}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath)
      return parseIpcResponse('mappingTemplates:exportToFile', { filePath: null })

    const json = await dataService.exportMappingTemplate(request.templateId)
    await writeFile(filePath, json, 'utf-8')
    return parseIpcResponse('mappingTemplates:exportToFile', { filePath })
  })

  ipcMain.handle('mappingTemplates:importFromFile', async (_event, rawPayload: unknown) => {
    parseIpcRequest('mappingTemplates:importFromFile', rawPayload)

    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import mapping template',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || filePaths.length === 0) {
      return parseIpcResponse('mappingTemplates:importFromFile', { template: null })
    }

    const json = await readFile(filePaths[0], 'utf-8')
    const template = await dataService.importMappingTemplate(json)
    return parseIpcResponse('mappingTemplates:importFromFile', { template })
  })
}
