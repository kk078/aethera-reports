/**
 * Watch-folder auto-import (plan §11, Phase 2 chunk D): a configurable
 * inbox root with per-client subfolders (`<inbox>/<CLIENT_CODE>/`,
 * mirroring rcm-prototype's convention). `scanInboxOnce` is the
 * catch-up-scan half — used on app launch and by the CLI's
 * `--import <dir>` (plan: "no watcher") — `createInboxWatcher` is the
 * live `chokidar` half used while the app is open. Both funnel through
 * `processInboxFile`, so the routing/settle/move logic can never drift
 * between the two entry points.
 *
 * Routing: X12 files via the importer registry's `detect()`
 * (`IDataService.detectImportFileKind`); CSV/XLSX need a mapping
 * template pinned per client folder (Settings), falling back to a
 * caller-supplied default (the CLI's `--template` flag) when no pin
 * exists. Processed files move to `processed/`, failures to `failed/`
 * with a `.error.txt` reason — every attempt is already recorded in
 * `import_jobs` by `runCsvImport`/`runX12Import` themselves.
 */
import { watch, type FSWatcher } from 'chokidar'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { IDataService } from '../services/data-service'

const IMPORTABLE_EXTENSIONS = /\.(csv|xlsx|xls|835|837|edi)$/i
const RESERVED_DIRS = new Set(['processed', 'failed'])

export interface WatchFolderDeps {
  dataService: IDataService
  /** Looks up the client folder's pinned mapping template (Settings → Watch folder). `null` when none is pinned. */
  getPinnedTemplateId: (clientCode: string) => Promise<string | null>
  /** Fallback when a CSV/XLSX folder has no pin — the CLI's `--import --template` flag uses this. */
  defaultTemplateId?: string | null
  log?: (line: string) => void
}

export interface ProcessFileResult {
  filePath: string
  clientCode: string
  ok: boolean
  action: 'moved-processed' | 'moved-failed'
  reason?: string
}

export interface ScanResult {
  processed: number
  failed: number
  results: ProcessFileResult[]
}

function extractErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return error ? String(error) : 'import failed'
}

/**
 * Size-stable settle check for the catch-up scan (no chokidar there to
 * do it natively) — a file is "done being written" once its size stops
 * changing across `checks` polls. Returns `false` (never throws) if the
 * file vanishes mid-check.
 */
async function waitForFileStable(filePath: string, checks = 3, intervalMs = 300): Promise<boolean> {
  let lastSize = -1
  for (let i = 0; i <= checks; i++) {
    if (!existsSync(filePath)) return false
    const size = statSync(filePath).size
    if (i > 0 && size === lastSize) return true
    lastSize = size
    if (i < checks) await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return true
}

function moveToSubdir(
  filePath: string,
  clientDir: string,
  subdir: 'processed' | 'failed',
  errorText?: string
): void {
  const destDir = join(clientDir, subdir)
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, basename(filePath))
  renameSync(filePath, dest)
  if (errorText) writeFileSync(`${dest}.error.txt`, errorText, 'utf-8')
}

/** Processes one file already known to live in `<clientDir>` (named `clientCode`) — detect, import, move. Never throws; failures move the file to `failed/` and are reflected in the returned result. */
export async function processInboxFile(
  filePath: string,
  clientCode: string,
  clientDir: string,
  deps: WatchFolderDeps
): Promise<ProcessFileResult> {
  const log = deps.log ?? ((): void => undefined)
  try {
    const stable = await waitForFileStable(filePath)
    if (!stable) throw new Error('File no longer exists — skipped.')

    const kind = await deps.dataService.detectImportFileKind(filePath)

    if (kind === 'x12-835' || kind === 'x12-837') {
      const job = await deps.dataService.runX12Import({ filePath, clientCode })
      if (job.status === 'failed') throw new Error(extractErrorMessage(job.error))
      moveToSubdir(filePath, clientDir, 'processed')
      log(`${filePath}: imported as ${kind} (${job.status}, job #${job.jobId})`)
      return { filePath, clientCode, ok: true, action: 'moved-processed' }
    }

    if (kind === 'csv' || kind === 'xlsx') {
      const templateId =
        (await deps.getPinnedTemplateId(clientCode)) ?? deps.defaultTemplateId ?? null
      if (!templateId) {
        throw new Error(
          `No mapping template pinned for client folder "${clientCode}" (Settings → Watch folder) and no default template given.`
        )
      }
      const job = await deps.dataService.runCsvImport({ filePath, templateId, clientCode })
      if (job.status === 'failed') throw new Error(extractErrorMessage(job.error))
      moveToSubdir(filePath, clientDir, 'processed')
      log(`${filePath}: imported (${job.status}, job #${job.jobId})`)
      return { filePath, clientCode, ok: true, action: 'moved-processed' }
    }

    throw new Error(`Unrecognized file type — not a CSV/XLSX or X12 835/837.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      moveToSubdir(filePath, clientDir, 'failed', message)
    } catch {
      // The file may already be gone (race with another scan); the
      // import failure is still reported below regardless.
    }
    log(`${filePath}: FAILED — ${message}`)
    return { filePath, clientCode, ok: false, action: 'moved-failed', reason: message }
  }
}

/**
 * One-shot catch-up scan of every `<inbox>/<CLIENT_CODE>/*` file (plan
 * §11) — run on app launch and by the CLI's `--import <dir>`. Client
 * subfolders named `processed`/`failed` are the move destinations, not
 * client codes, and are skipped as scan roots.
 */
export async function scanInboxOnce(inboxRoot: string, deps: WatchFolderDeps): Promise<ScanResult> {
  const results: ProcessFileResult[] = []
  if (!existsSync(inboxRoot)) return { processed: 0, failed: 0, results }

  for (const entry of readdirSync(inboxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue
    const clientCode = entry.name
    const clientDir = join(inboxRoot, clientCode)
    for (const file of readdirSync(clientDir, { withFileTypes: true })) {
      if (!file.isFile() || !IMPORTABLE_EXTENSIONS.test(file.name)) continue
      const filePath = join(clientDir, file.name)
      results.push(await processInboxFile(filePath, clientCode, clientDir, deps))
    }
  }

  return {
    processed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  }
}

/**
 * Live watcher (plan §11) — `awaitWriteFinish` is chokidar's own
 * size-stable settle check for files still being written, so the live
 * path doesn't need `waitForFileStable` to do real work (it still runs,
 * harmlessly, inside `processInboxFile`). `depth: 1` limits watching to
 * exactly `<inbox>/<CLIENT_CODE>/<file>` — not `processed/`/`failed/`
 * subfolders, which live one level deeper.
 */
export function createInboxWatcher(inboxRoot: string, deps: WatchFolderDeps): FSWatcher {
  const watcher = watch(inboxRoot, {
    depth: 1,
    ignoreInitial: true, // the launch-time catch-up scan already handles pre-existing files
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    ignored: (path: string, stats?: { isFile: () => boolean }) => {
      const dir = basename(dirname(path))
      if (RESERVED_DIRS.has(dir)) return true
      // Chokidar calls this once per path *without* `stats` (before it knows
      // whether the path is a file or directory) and again *with* `stats`
      // once it does. Extension-filtering on that first, stats-less call
      // would misfire on every directory (the inbox root itself included —
      // its name never matches `IMPORTABLE_EXTENSIONS`) and wrongly mark
      // the whole tree "ignored", so only files ever get extension-tested;
      // directories (and the stats-less pre-check) always pass through.
      if (!stats || !stats.isFile()) return false
      return !IMPORTABLE_EXTENSIONS.test(path)
    }
  })

  watcher.on('add', (filePath: string) => {
    void (async () => {
      const clientDir = dirname(filePath)
      const clientCode = basename(clientDir)
      if (clientDir === inboxRoot || RESERVED_DIRS.has(clientCode)) return
      await processInboxFile(filePath, clientCode, clientDir, deps)
    })()
  })

  return watcher
}
