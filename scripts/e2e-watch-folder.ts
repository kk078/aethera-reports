/**
 * Watch-folder auto-import end-to-end check (plan §11, Phase 2 chunk D):
 * drops the same synthetic fixtures `e2e-import-check.ts` uses into a
 * temp inbox directory laid out as `<inbox>/<CLIENT_CODE>/`, runs the
 * real catch-up scan (`scanInboxOnce` — the same function the app calls
 * on launch and the CLI's `--import <dir>` calls), and asserts both the
 * resulting `import_jobs` rows and the processed/failed file moves.
 *
 * No Electron process needed here (unlike `e2e-generate-check.ts`) —
 * `scanInboxOnce`/`LocalDataService` are both Electron-free, so this
 * drives the real code directly under `vite-node` (needed only because
 * `db/migrations` loads `.sql` files via Vite's `?raw` import suffix).
 *
 * Run with: npm run e2e:watch-folder
 */
import { join } from 'node:path'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { LocalDataService } from '../src/main/services/local-data-service'
import { scanInboxOnce } from '../src/main/automation/watch-folder'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[e2e-watch-folder] ASSERTION FAILED: ${message}`)
}

async function main(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), 'aethera-e2e-watch-db-'))
  const inboxRoot = mkdtempSync(join(tmpdir(), 'aethera-e2e-watch-inbox-'))
  console.log(`[e2e-watch-folder] db dir: ${dbDir}`)
  console.log(`[e2e-watch-folder] inbox root: ${inboxRoot}`)

  const service = await LocalDataService.create({
    duckdbPath: join(dbDir, 'analytics.duckdb'),
    metaDbPath: join(dbDir, 'meta.db'),
    backupsDir: join(dbDir, 'backups')
  })

  try {
    console.log('[e2e-watch-folder] seeding clients ...')
    await service.createClient({ code: 'WF1', name: 'Watch-Folder Client One' })
    await service.createClient({ code: 'WF2', name: 'Watch-Folder Client Two' })
    // Deliberately no client row for "WFBAD" — proves an import failure
    // still moves the file to failed/ with a .error.txt reason instead
    // of getting stuck or crashing the scan.

    console.log('[e2e-watch-folder] dropping fixture files into the inbox ...')
    mkdirSync(join(inboxRoot, 'WF1'), { recursive: true })
    mkdirSync(join(inboxRoot, 'WF2'), { recursive: true })
    mkdirSync(join(inboxRoot, 'WFBAD'), { recursive: true })
    copyFileSync(
      join(FIXTURES_DIR, 'tebra-claim-export.csv'),
      join(inboxRoot, 'WF1', 'tebra-claim-export.csv')
    )
    copyFileSync(
      join(FIXTURES_DIR, 'synthetic-837.837'),
      join(inboxRoot, 'WF2', 'synthetic-837.837')
    )
    // Byte-distinct from WF1's copy — the importer dedups by file content
    // hash, and an exact copy would short-circuit to a "reused existing
    // job" success instead of exercising the unknown-client failure path.
    writeFileSync(
      join(inboxRoot, 'WFBAD', 'tebra-claim-export.csv'),
      `${readFileSync(join(FIXTURES_DIR, 'tebra-claim-export.csv'), 'utf-8')}\n`
    )

    console.log('[e2e-watch-folder] running the catch-up scan (scanInboxOnce) ...')
    const result = await scanInboxOnce(inboxRoot, {
      dataService: service,
      getPinnedTemplateId: async () => null,
      defaultTemplateId: 'tebra-claim-export',
      log: (line) => console.log(`  ${line}`)
    })
    console.log('  result:', { processed: result.processed, failed: result.failed })

    assert(result.processed === 2, `expected 2 processed, got ${result.processed}`)
    assert(result.failed === 1, `expected 1 failed, got ${result.failed}`)

    const wf1Processed = join(inboxRoot, 'WF1', 'processed', 'tebra-claim-export.csv')
    const wf2Processed = join(inboxRoot, 'WF2', 'processed', 'synthetic-837.837')
    const wfBadFailed = join(inboxRoot, 'WFBAD', 'failed', 'tebra-claim-export.csv')

    assert(existsSync(wf1Processed), `WF1's CSV should have moved to processed/: ${wf1Processed}`)
    assert(
      !existsSync(join(inboxRoot, 'WF1', 'tebra-claim-export.csv')),
      "WF1's original file should be gone after the move"
    )
    assert(
      existsSync(wf2Processed),
      `WF2's X12 837 should have moved to processed/: ${wf2Processed}`
    )
    assert(existsSync(wfBadFailed), `WFBAD's CSV should have moved to failed/: ${wfBadFailed}`)
    assert(
      existsSync(`${wfBadFailed}.error.txt`),
      'WFBAD failure should have a .error.txt reason alongside it'
    )
    const errorText = readFileSync(`${wfBadFailed}.error.txt`, 'utf-8')
    assert(
      /Unknown client code/.test(errorText),
      `expected "Unknown client code" in .error.txt, got: ${errorText}`
    )
    console.log(`  [wfbad] .error.txt: ${errorText}`)

    console.log('[e2e-watch-folder] checking import_jobs ...')
    const jobs = await service.listImportJobs()
    console.log(`  ${jobs.length} import job(s) recorded`)
    assert(jobs.length >= 2, `expected at least 2 import_jobs rows, got ${jobs.length}`)

    console.log('\n[e2e-watch-folder] all checks passed')
  } finally {
    service.close()
    rmSync(dbDir, { recursive: true, force: true })
    rmSync(inboxRoot, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error('[e2e-watch-folder] FAILED:', error)
  process.exitCode = 1
})
