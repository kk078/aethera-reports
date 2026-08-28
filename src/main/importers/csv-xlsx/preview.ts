/**
 * Wizard preview step (plan §3: "preview 50 rows with zod row validation
 * errors"). Read-only — no staging rows, no import job, nothing written
 * to the database. Lets the user see mapping problems before committing
 * to "save template → run".
 */
import { readRows } from './readers'
import { buildCanonicalRow } from './transform'
import type { MappingTemplate } from '../../../shared/domain'

export interface PreviewRow {
  rowNumber: number
  valid: boolean
  errors: string[]
  preview: Record<string, unknown>
}

export const DEFAULT_PREVIEW_LIMIT = 50

export async function previewMapping(
  filePath: string,
  template: MappingTemplate,
  limit: number = DEFAULT_PREVIEW_LIMIT
): Promise<PreviewRow[]> {
  const previews: PreviewRow[] = []

  await readRows(
    filePath,
    (rawRow, rowNumber) => {
      const { row, errors } = buildCanonicalRow(rawRow, template)
      previews.push({
        rowNumber,
        valid: row !== null,
        errors,
        preview: row ?? rawRow
      })
    },
    { limit }
  )

  return previews
}
