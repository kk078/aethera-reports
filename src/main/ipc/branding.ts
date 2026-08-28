/**
 * IPC handlers for `branding:*` (plan §6). The logo file-copy (Electron
 * `dialog` + `app.getPath('userData')`) lives here, not in
 * `LocalDataService`, which stays Electron-free.
 */
import { app, dialog, ipcMain } from 'electron'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { parseIpcRequest, parseIpcResponse } from '../../shared/ipc-contract'
import type { IDataService } from '../services/data-service'
import type { Branding } from '../../shared/domain'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
}

/**
 * The renderer's CSP only allows `img-src 'self' data:` (plan §7 — no
 * `file:` in img-src, to avoid loosening the hardened shell for a
 * feature this narrow). So logos are sent to the renderer as a base64
 * data URI, not a filesystem path — `Branding.logoPath` on the wire is
 * that data URI when a logo exists, even though the field is a real
 * path in meta.db.
 */
function withLogoDataUri(branding: Branding): Branding {
  if (!branding.logoPath) return branding
  try {
    const mime = MIME_BY_EXT[extname(branding.logoPath).toLowerCase()] ?? 'application/octet-stream'
    const base64 = readFileSync(branding.logoPath).toString('base64')
    return { ...branding, logoPath: `data:${mime};base64,${base64}` }
  } catch {
    return { ...branding, logoPath: null }
  }
}

export function registerBrandingHandlers(dataService: IDataService): void {
  ipcMain.handle('branding:get', async (_event, rawPayload: unknown) => {
    parseIpcRequest('branding:get', rawPayload)
    const branding = await dataService.getBranding()
    return parseIpcResponse('branding:get', withLogoDataUri(branding))
  })

  ipcMain.handle('branding:update', async (_event, rawPayload: unknown) => {
    const request = parseIpcRequest('branding:update', rawPayload)
    const branding = await dataService.updateBranding(request)
    return parseIpcResponse('branding:update', withLogoDataUri(branding))
  })

  ipcMain.handle('branding:pickAndSetLogo', async (_event, rawPayload: unknown) => {
    parseIpcRequest('branding:pickAndSetLogo', rawPayload)

    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose a logo image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg'] }]
    })
    if (canceled || filePaths.length === 0) {
      const branding = await dataService.getBranding()
      return parseIpcResponse('branding:pickAndSetLogo', withLogoDataUri(branding))
    }

    const brandingDir = join(app.getPath('userData'), 'branding')
    mkdirSync(brandingDir, { recursive: true })
    const destPath = join(brandingDir, `logo${extname(filePaths[0])}`)
    copyFileSync(filePaths[0], destPath)

    const branding = await dataService.setBrandingLogoPath(destPath)
    return parseIpcResponse('branding:pickAndSetLogo', withLogoDataUri(branding))
  })
}
