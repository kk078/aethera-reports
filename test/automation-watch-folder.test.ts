/**
 * Watch-folder auto-import tests (plan §11, Phase 2 chunk D) — real
 * chokidar + real temp directories + a real `LocalDataService`
 * (DuckDB + SQLite), exercising both the catch-up scan (`scanInboxOnce`,
 * used at app launch and by the CLI's `--import <dir>`) and the live
 * watcher (`createInboxWatcher`) end to end: X12-vs-CSV/XLSX auto-detect,
 * per-folder template pins vs the fallback default, and processed/
 * failed/ file moves with a `.error.txt` reason on failure.
 */
import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDataService } from '../src/main/services/local-data-service'
import {
  createInboxWatcher,
  scanInboxOnce,
  type WatchFolderDeps
} from '../src/main/automation/watch-folder'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  if (!predicate()) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`)
}

describe('watch-folder auto-import', () => {
  let dbDir: string
  let inboxRoot: string
  let service: LocalDataService

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'aethera-watch-db-'))
    inboxRoot = mkdtempSync(join(tmpdir(), 'aethera-watch-inbox-'))
    service = await LocalDataService.create({
      duckdbPath: join(dbDir, 'analytics.duckdb'),
      metaDbPath: join(dbDir, 'meta.db'),
      backupsDir: join(dbDir, 'backups')
    })
  })

  afterEach(() => {
    service.close()
    rmSync(dbDir, { recursive: true, force: true })
    rmSync(inboxRoot, { recursive: true, force: true })
  })

  describe('scanInboxOnce (catch-up scan)', () => {
    it('auto-detects CSV vs X12, imports via the pinned/default template, and moves each file to processed/ or failed/', async () => {
      await service.createClient({ code: 'DEMO1', name: 'Demo Client One' })
      await service.createClient({ code: 'DEMO2', name: 'Demo Client Two' })
      // Deliberately no client row for "DEMOBAD" — its import will fail.

      mkdirSync(join(inboxRoot, 'DEMO1'), { recursive: true })
      mkdirSync(join(inboxRoot, 'DEMO2'), { recursive: true })
      mkdirSync(join(inboxRoot, 'DEMOBAD'), { recursive: true })
      copyFileSync(
        join(FIXTURES_DIR, 'tebra-claim-export.csv'),
        join(inboxRoot, 'DEMO1', 'tebra-claim-export.csv')
      )
      copyFileSync(
        join(FIXTURES_DIR, 'synthetic-837.837'),
        join(inboxRoot, 'DEMO2', 'synthetic-837.837')
      )
      // A byte-distinct copy (not `copyFileSync`) — the importer dedups
      // purely by file content hash (`file_sha256`), so an exact copy of
      // DEMO1's already-imported file would short-circuit to a "reused
      // existing job" success here instead of exercising the "unknown
      // client code" failure this case is meant to test.
      writeFileSync(
        join(inboxRoot, 'DEMOBAD', 'tebra-claim-export.csv'),
        `${readFileSync(join(FIXTURES_DIR, 'tebra-claim-export.csv'), 'utf-8')}\n`
      )
      // Reserved move-destination directories must never be treated as client folders.
      mkdirSync(join(inboxRoot, 'processed'), { recursive: true })

      const deps: WatchFolderDeps = {
        dataService: service,
        getPinnedTemplateId: async () => null,
        defaultTemplateId: 'tebra-claim-export'
      }
      const result = await scanInboxOnce(inboxRoot, deps)

      expect(result.processed).toBe(2)
      expect(result.failed).toBe(1)
      expect(result.results).toHaveLength(3)

      // Successful CSV import: moved to processed/, original gone.
      expect(existsSync(join(inboxRoot, 'DEMO1', 'tebra-claim-export.csv'))).toBe(false)
      expect(existsSync(join(inboxRoot, 'DEMO1', 'processed', 'tebra-claim-export.csv'))).toBe(true)

      // Successful X12 837 import: auto-detected without any template, moved to processed/.
      expect(existsSync(join(inboxRoot, 'DEMO2', 'processed', 'synthetic-837.837'))).toBe(true)

      // Unknown client code: import throws, file moves to failed/ with a .error.txt reason.
      const failedPath = join(inboxRoot, 'DEMOBAD', 'failed', 'tebra-claim-export.csv')
      expect(existsSync(failedPath)).toBe(true)
      expect(existsSync(`${failedPath}.error.txt`)).toBe(true)
      expect(readFileSync(`${failedPath}.error.txt`, 'utf-8')).toMatch(/Unknown client code/)

      // Every attempt is reflected in import_jobs regardless of outcome.
      const jobs = await service.listImportJobs()
      expect(jobs.length).toBeGreaterThanOrEqual(2)
    })

    it('uses a per-client-folder pinned template over the fallback default', async () => {
      await service.createClient({ code: 'PINNED', name: 'Pinned Client' })
      mkdirSync(join(inboxRoot, 'PINNED'), { recursive: true })
      copyFileSync(
        join(FIXTURES_DIR, 'tebra-claim-export.csv'),
        join(inboxRoot, 'PINNED', 'tebra-claim-export.csv')
      )

      let askedFor: string | null = null
      const deps: WatchFolderDeps = {
        dataService: service,
        getPinnedTemplateId: async (clientCode) => {
          askedFor = clientCode
          return 'tebra-claim-export'
        },
        defaultTemplateId: null // no fallback — proves the pin alone resolved the template
      }
      const result = await scanInboxOnce(inboxRoot, deps)

      expect(askedFor).toBe('PINNED')
      expect(result.processed).toBe(1)
      expect(existsSync(join(inboxRoot, 'PINNED', 'processed', 'tebra-claim-export.csv'))).toBe(
        true
      )
    })

    it('fails a CSV/XLSX file gracefully when no pin and no default template are available', async () => {
      await service.createClient({ code: 'NOPIN', name: 'No Pin Client' })
      mkdirSync(join(inboxRoot, 'NOPIN'), { recursive: true })
      copyFileSync(
        join(FIXTURES_DIR, 'tebra-claim-export.csv'),
        join(inboxRoot, 'NOPIN', 'tebra-claim-export.csv')
      )

      const deps: WatchFolderDeps = {
        dataService: service,
        getPinnedTemplateId: async () => null,
        defaultTemplateId: null
      }
      const result = await scanInboxOnce(inboxRoot, deps)

      expect(result.processed).toBe(0)
      expect(result.failed).toBe(1)
      const failedPath = join(inboxRoot, 'NOPIN', 'failed', 'tebra-claim-export.csv')
      expect(existsSync(failedPath)).toBe(true)
      expect(readFileSync(`${failedPath}.error.txt`, 'utf-8')).toMatch(/No mapping template pinned/)
    })

    it('returns zero results when the inbox root does not exist yet (never throws)', async () => {
      const deps: WatchFolderDeps = {
        dataService: service,
        getPinnedTemplateId: async () => null,
        defaultTemplateId: null
      }
      const result = await scanInboxOnce(join(inboxRoot, 'does-not-exist'), deps)
      expect(result).toEqual({ processed: 0, failed: 0, results: [] })
    })
  })

  describe('createInboxWatcher (live watch)', () => {
    it('picks up a file dropped into a client folder while watching and moves it to processed/', async () => {
      await service.createClient({ code: 'LIVE1', name: 'Live Client' })
      mkdirSync(join(inboxRoot, 'LIVE1'), { recursive: true })

      const deps: WatchFolderDeps = {
        dataService: service,
        getPinnedTemplateId: async () => null,
        defaultTemplateId: 'tebra-claim-export'
      }
      const watcher = createInboxWatcher(inboxRoot, deps)
      try {
        await new Promise<void>((resolve) => watcher.on('ready', () => resolve()))
        copyFileSync(
          join(FIXTURES_DIR, 'tebra-claim-export.csv'),
          join(inboxRoot, 'LIVE1', 'tebra-claim-export.csv')
        )

        const destPath = join(inboxRoot, 'LIVE1', 'processed', 'tebra-claim-export.csv')
        await waitUntil(() => existsSync(destPath))
        expect(existsSync(destPath)).toBe(true)
      } finally {
        await watcher.close()
      }
    }, 15000)

    it('never treats the processed/ or failed/ subfolders as client folders', async () => {
      await service.createClient({ code: 'LIVE2', name: 'Live Client Two' })
      mkdirSync(join(inboxRoot, 'LIVE2', 'processed'), { recursive: true })

      const deps: WatchFolderDeps = {
        dataService: service,
        getPinnedTemplateId: async () => null,
        defaultTemplateId: 'tebra-claim-export'
      }
      const watcher = createInboxWatcher(inboxRoot, deps)
      try {
        await new Promise<void>((resolve) => watcher.on('ready', () => resolve()))
        // Drop a file directly into the reserved processed/ subfolder — it must never be re-imported/moved again.
        copyFileSync(
          join(FIXTURES_DIR, 'tebra-claim-export.csv'),
          join(inboxRoot, 'LIVE2', 'processed', 'already-done.csv')
        )
        // Give the watcher a beat to (not) react, then confirm it's untouched.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        expect(existsSync(join(inboxRoot, 'LIVE2', 'processed', 'already-done.csv'))).toBe(true)
        expect(existsSync(join(inboxRoot, 'LIVE2', 'processed', 'processed'))).toBe(false)
      } finally {
        await watcher.close()
      }
    }, 15000)
  })
})
