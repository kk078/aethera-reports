/**
 * Output path convention for generated report packs (plan §6):
 * `<Documents>/Aethera Reports/<YYYY-MM>/<client_code>/`.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export function reportOutputDir(periodMonth: string, clientCode: string): string {
  const dir = join(app.getPath('documents'), 'Aethera Reports', periodMonth, clientCode)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function reportPdfPath(periodMonth: string, clientCode: string): string {
  return join(reportOutputDir(periodMonth, clientCode), `${clientCode}-${periodMonth}.pdf`)
}
