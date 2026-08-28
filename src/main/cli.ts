/**
 * Headless CLI mode (plan §11): the packaged executable accepts flags
 * and runs without a window, so Windows Task Scheduler (or a shell
 * script) can drive it. `parseCliArgs` is pure (unit-tested in
 * `test/cli.test.ts`); `runCli` reuses the exact same `IDataService`/
 * exporter code paths the UI uses — no separate "headless" logic.
 *
 *   --generate --period YYYY-MM --clients all|CODE1,CODE2 --formats pdf --out <dir>
 *   --import <file-or-dir> [--template <name>]
 *   --smoke   (handled separately in index.ts — the walking-skeleton flag)
 *
 * `--import <dir>` reuses the exact same watch-folder catch-up-scan
 * (`scanInboxOnce`, plan §11) the app itself runs at launch and the
 * Automation screen's "Scan now" button triggers — X12 vs CSV/XLSX is
 * auto-detected per file, each `<dir>/<CLIENT_CODE>/` folder's pinned
 * mapping template (Settings → Watch folder) is used when present, and
 * `--template` (now optional) is only the fallback default for folders
 * with no pin. Files move to `processed/`/`failed/` exactly as the live
 * watcher does. `--import <file>` (a single file, not a directory) keeps
 * its original Phase 1 behavior unchanged: CSV/XLSX only, `--template`
 * is required, and the client code is inferred from the file's parent
 * directory name — no move, no X12 auto-detect.
 */
import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { exportClientReportBatch } from './exporters/batch'
import { scanInboxOnce } from './automation/watch-folder'
import { exportFormatSchema } from '../shared/domain'
import type { ExportFormat } from '../shared/domain'
import type { IDataService } from './services/data-service'
import type { GenerateArgs, ImportArgs, ParsedCliArgs } from './cli-args'

export type CliLogger = (line: string) => void

function partitionFormats(requested: string[]): { valid: ExportFormat[]; invalid: string[] } {
  const valid: ExportFormat[] = []
  const invalid: string[] = []
  for (const raw of requested) {
    const parsed = exportFormatSchema.safeParse(raw)
    if (parsed.success) valid.push(parsed.data)
    else invalid.push(raw)
  }
  return { valid, invalid }
}

async function runGenerate(
  dataService: IDataService,
  args: GenerateArgs,
  log: CliLogger
): Promise<number> {
  const { valid: formats, invalid } = partitionFormats(args.formats)
  if (invalid.length > 0) {
    log(`Ignoring unknown format(s): ${invalid.join(', ')} (supported: pdf, pptx, xlsx)`)
  }
  if (formats.length === 0) {
    log('No supported export format requested — use --formats pdf,pptx,xlsx (any combination).')
    return 1
  }

  const clients = await dataService.listClients()
  let targets = clients.filter((c) => c.active)
  if (args.clients !== 'all') {
    const wanted = new Set(args.clients.split(',').map((c) => c.trim().toUpperCase()))
    targets = targets.filter((c) => wanted.has(c.code.toUpperCase()))
  }
  if (targets.length === 0) {
    log('No matching active clients — nothing to generate.')
    return 1
  }

  log(
    `Generating ${targets.length} report(s) x ${formats.length} format(s) for period ${args.period}...`
  )
  const results = await exportClientReportBatch(
    dataService,
    targets.map((c) => c.clientId),
    args.period,
    formats,
    (completed, total, clientResults) => {
      for (const result of clientResults) {
        log(
          `[${completed}/${total}] ${result.clientCode} (${result.format}): ${result.error ? `FAILED — ${result.error}` : result.filePath}`
        )
      }
    }
  )

  const failures = results.filter((r) => r.error !== null)
  if (failures.length > 0) {
    log(`${failures.length} of ${results.length} export(s) failed.`)
    return 1
  }
  log(`Generated ${results.length} report(s) successfully.`)
  return 0
}

/** Resolves `--template` (a name or id, matching the Phase 1 lookup) to a concrete template id, or `null` if unknown. */
async function resolveTemplateId(
  dataService: IDataService,
  templateNameOrId: string
): Promise<string | null> {
  const templates = await dataService.listMappingTemplates()
  const template = templates.find(
    (t) => t.templateId === templateNameOrId || t.name === templateNameOrId
  )
  return template ? template.templateId : null
}

async function runImportFile(
  dataService: IDataService,
  filePath: string,
  templateArg: string | undefined,
  log: CliLogger
): Promise<number> {
  if (!templateArg) {
    log('--import <file> requires --template <name-or-id>.')
    return 1
  }
  const templateId = await resolveTemplateId(dataService, templateArg)
  if (!templateId) {
    log(`Unknown mapping template: "${templateArg}"`)
    return 1
  }

  const clientCode = basename(dirname(filePath))
  try {
    const result = await dataService.runCsvImport({ filePath, templateId, clientCode })
    log(
      `${filePath} -> ${clientCode}: ${result.status} (${result.rowsLoaded} loaded, ${result.rowsSkipped} quarantined)`
    )
    return result.status === 'failed' ? 1 : 0
  } catch (error) {
    log(
      `${filePath} -> ${clientCode}: ERROR ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  }
}

async function runImportDirectory(
  dataService: IDataService,
  importPath: string,
  templateArg: string | undefined,
  log: CliLogger
): Promise<number> {
  let defaultTemplateId: string | null = null
  if (templateArg) {
    defaultTemplateId = await resolveTemplateId(dataService, templateArg)
    if (!defaultTemplateId) {
      log(`Unknown mapping template: "${templateArg}"`)
      return 1
    }
  }

  const result = await scanInboxOnce(importPath, {
    dataService,
    getPinnedTemplateId: (clientCode) => dataService.getPinnedTemplateId(clientCode),
    defaultTemplateId,
    log
  })

  if (result.processed === 0 && result.failed === 0) {
    log(`No importable files found under ${importPath}`)
    return 1
  }
  log(`Processed ${result.processed} file(s), ${result.failed} failure(s).`)
  return result.failed > 0 ? 1 : 0
}

async function runImport(
  dataService: IDataService,
  args: ImportArgs,
  log: CliLogger
): Promise<number> {
  const stat = statSync(args.importPath)
  if (stat.isFile()) {
    return runImportFile(dataService, args.importPath, args.template, log)
  }
  return runImportDirectory(dataService, args.importPath, args.template, log)
}

export async function runCli(
  dataService: IDataService,
  args: ParsedCliArgs,
  log: CliLogger
): Promise<number> {
  if (args.mode === 'generate') return runGenerate(dataService, args, log)
  if (args.mode === 'import') return runImport(dataService, args, log)
  return 0
}
