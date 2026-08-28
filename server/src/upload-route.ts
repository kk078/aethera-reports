/**
 * `POST /api/import/upload` (Phase 3 chunk E: "File-upload import
 * endpoint (multipart) that runs the existing importers server-side (CSV/
 * XLSX needs template id; X12 auto-detects), recording import_jobs as
 * usual"). Multipart fields: `file` (required), `clientCode` (required),
 * `templateId` (required for CSV/XLSX, ignored for X12 — auto-detected).
 *
 * Uploaded files are kept under `<dataDir>/uploads/<CLIENT_CODE>/` rather
 * than deleted after import — same rationale as the watch-folder's
 * `processed/` convention (plan §11): a human should be able to see what
 * was actually imported, even though `stg_rows` already means the file
 * itself is never re-read.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { MultipartFields } from '@fastify/multipart'
import { importJobSchema } from '../../src/shared/domain'
import type { IDataService } from '../../src/main/services/data-service'

function firstFieldValue(fields: MultipartFields, name: string): string | undefined {
  const field = fields[name]
  const entry = Array.isArray(field) ? field[0] : field
  if (entry && entry.type === 'field') return String(entry.value)
  return undefined
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_')
}

export function registerUploadRoutes(
  app: FastifyInstance,
  dataService: IDataService,
  uploadsDir: string
): void {
  app.post('/api/import/upload', async (request, reply) => {
    const data = await request.file()
    if (!data) {
      reply.code(400)
      return { error: 'No file uploaded — expected a multipart "file" field.' }
    }

    const clientCode = firstFieldValue(data.fields, 'clientCode')
    const templateId = firstFieldValue(data.fields, 'templateId')
    if (!clientCode) {
      reply.code(400)
      return { error: 'Missing required multipart field "clientCode".' }
    }

    const buffer = await data.toBuffer()
    const clientDir = join(uploadsDir, sanitizePathSegment(clientCode))
    await mkdir(clientDir, { recursive: true })
    const destPath = join(clientDir, `${Date.now()}-${sanitizePathSegment(data.filename)}`)
    await writeFile(destPath, buffer)

    try {
      const kind = await dataService.detectImportFileKind(destPath)

      if (kind === 'x12-835' || kind === 'x12-837') {
        const job = await dataService.runX12Import({ filePath: destPath, clientCode })
        return { job: importJobSchema.parse(job) }
      }

      if (kind === 'csv' || kind === 'xlsx') {
        if (!templateId) {
          reply.code(400)
          return { error: 'CSV/XLSX uploads require a "templateId" multipart field.' }
        }
        const job = await dataService.runCsvImport({ filePath: destPath, templateId, clientCode })
        return { job: importJobSchema.parse(job) }
      }

      reply.code(400)
      return { error: 'Unrecognized file type — not a CSV/XLSX or X12 835/837.' }
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
}
