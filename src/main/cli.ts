/**
 * Headless CLI mode (plan §11): the packaged executable accepts flags
 * and runs without a window, so Windows Task Scheduler (or a shell
 * script) can drive it. `parseCliArgs` is pure (unit-tested in
 * `test/cli.test.ts`); `runCli` reuses the exact same `IDataService`/
 * exporter code paths the UI uses — no separate "headless" logic.
 *
 *   --generate --period YYYY-MM --clients all|CODE1,CODE2 --formats pdf --out <dir>
 *   --import <file-or-dir> --template <name>
 *   --smoke   (handled separately in index.ts — the walking-skeleton flag)
 *
 * `--import <dir>` follows the same `<inbox>/<CLIENT_CODE>/` convention
 * the Phase 2 watch-folder feature will use (plan §11): each immediate
 * subdirectory of `<dir>` is one client's folder. `--import <file>`
 * (a single file, not a directory) infers the client code from that
 * file's parent directory name.
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { exportClientReportBatch } from './exporters/batch'
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

interface ImportJob {
  filePath: string
  clientCode: string
}

function discoverImportJobs(importPath: string): ImportJob[] {
  const stat = statSync(importPath)
  if (stat.isFile()) {
    return [{ filePath: importPath, clientCode: basename(dirname(importPath)) }]
  }

  const jobs: ImportJob[] = []
  for (const entry of readdirSync(importPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const clientCode = entry.name
    const subdir = join(importPath, entry.name)
    for (const file of readdirSync(subdir)) {
      if (/\.(csv|xlsx|xls)$/i.test(file)) {
        jobs.push({ filePath: join(subdir, file), clientCode })
      }
    }
  }
  return jobs
}

async function runImport(
  dataService: IDataService,
  args: ImportArgs,
  log: CliLogger
): Promise<number> {
  const templates = await dataService.listMappingTemplates()
  const template = templates.find((t) => t.templateId === args.template || t.name === args.template)
  if (!template) {
    log(`Unknown mapping template: "${args.template}"`)
    return 1
  }

  const jobs = discoverImportJobs(args.importPath)
  if (jobs.length === 0) {
    log(`No importable files found under ${args.importPath}`)
    return 1
  }

  let failures = 0
  for (const job of jobs) {
    try {
      const result = await dataService.runCsvImport({
        filePath: job.filePath,
        templateId: template.templateId,
        clientCode: job.clientCode
      })
      log(
        `${job.filePath} -> ${job.clientCode}: ${result.status} (${result.rowsLoaded} loaded, ${result.rowsSkipped} quarantined)`
      )
      if (result.status === 'failed') failures += 1
    } catch (error) {
      log(
        `${job.filePath} -> ${job.clientCode}: ERROR ${error instanceof Error ? error.message : String(error)}`
      )
      failures += 1
    }
  }

  return failures > 0 ? 1 : 0
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
