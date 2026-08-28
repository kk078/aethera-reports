/**
 * Where a `BrowserWindow` should load its renderer from — dev server URL
 * vs. the built `index.html` — shared between the visible main window
 * and the offscreen print window (plan §6) so the two never drift.
 */
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'

export async function loadRenderer(window: BrowserWindow, hash?: string): Promise<void> {
  const suffix = hash ? `#${hash}` : ''
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${suffix}`)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}
