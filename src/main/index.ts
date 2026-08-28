import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { helloQueryDuckDb } from './db/duckdb'
import { helloQuerySqlite } from './db/meta'
import { LocalDataService } from './services/local-data-service'
import type { IDataService } from './services/data-service'
import { loadRenderer } from './window-target'
import { runCli } from './cli'
import { parseCliArgs } from './cli-args'
import { createCliLogger } from './cli-logger'
import { createInboxWatcher, scanInboxOnce, type WatchFolderDeps } from './automation/watch-folder'
import { runSchedulerTick } from './automation/run-scheduler'
import type { FSWatcher } from 'chokidar'

let dataService: IDataService | null = null
let inboxWatcher: FSWatcher | null = null
let schedulerIntervalHandle: ReturnType<typeof setInterval> | null = null

/** Scheduler rules are day-of-month granularity, so a tick doesn't need to be more frequent than this while the app stays open (plan §11). */
const SCHEDULER_TICK_INTERVAL_MS = 30 * 60 * 1000

/**
 * Real startup DB paths, all under Electron's per-OS `userData` dir
 * (plan §2 / Risk 5) — never inside the app bundle itself.
 */
function resolveDataServicePaths(): {
  duckdbPath: string
  metaDbPath: string
  backupsDir: string
} {
  const userDataDir = app.getPath('userData')
  return {
    duckdbPath: join(userDataDir, 'analytics.duckdb'),
    metaDbPath: join(userDataDir, 'meta.db'),
    backupsDir: join(userDataDir, 'backups')
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Hardening (plan §7 — PHI-handling app, no exceptions):
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Deny creating new BrowserWindows from renderer-triggered navigation;
  // hand plain links to the OS browser instead of loading remote content
  // inside the app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  void loadRenderer(mainWindow)
}

/**
 * `--smoke` (plan Phase 1 step 2 / §11): open a throwaway DuckDB +
 * SQLite pair in a temp directory, run a trivial query through each
 * real code path, and exit — no window, no persistent state. This is
 * what CI runs against the packaged executable to prove the native
 * modules survived packaging before building installers.
 */
async function runSmokeCheck(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aethera-reports-smoke-'))
  const duckdbPath = join(dir, 'analytics.duckdb')
  const metaDbPath = join(dir, 'meta.db')

  console.log(`[smoke] using temp dir: ${dir}`)

  const duckdbResult = await helloQueryDuckDb(duckdbPath)
  if (duckdbResult !== 1) {
    throw new Error(`[smoke] DuckDB hello query returned ${duckdbResult}, expected 1`)
  }
  console.log('[smoke] DuckDB hello query OK')

  const sqliteResult = helloQuerySqlite(metaDbPath)
  if (sqliteResult !== 1) {
    throw new Error(`[smoke] SQLite hello query returned ${sqliteResult}, expected 1`)
  }
  console.log('[smoke] SQLite hello query OK')

  console.log('[smoke] all checks passed')
}

/**
 * Interactive-mode automation (plan §11): a launch-time watch-folder
 * catch-up scan + live chokidar watcher (only when an inbox root is
 * configured), and a scheduler tick run immediately (missed-run
 * catch-up while the app was closed) then repeated on an interval.
 * Every failure here is logged and swallowed — automation never blocks
 * or crashes the app; it's purely best-effort background work.
 */
async function startAutomation(service: IDataService, userDataDir: string): Promise<void> {
  const logger = createCliLogger(userDataDir)

  try {
    const settings = await service.getAutomationInboxSettings()
    if (settings.inboxRoot) {
      const deps: WatchFolderDeps = {
        dataService: service,
        getPinnedTemplateId: (clientCode) => service.getPinnedTemplateId(clientCode),
        log: logger
      }
      const scanResult = await scanInboxOnce(settings.inboxRoot, deps)
      if (scanResult.processed > 0 || scanResult.failed > 0) {
        logger(
          `[watch-folder] launch catch-up scan: ${scanResult.processed} processed, ${scanResult.failed} failed.`
        )
      }
      inboxWatcher = createInboxWatcher(settings.inboxRoot, deps)
      logger(`[watch-folder] watching ${settings.inboxRoot}`)
    }
  } catch (error) {
    logger(
      `[watch-folder] failed to start: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const tick = (): void => {
    void runSchedulerTick(service, new Date(), logger).catch((error: unknown) => {
      logger(`[scheduler] tick failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  tick() // missed-run catch-up for whatever became due while the app was closed
  schedulerIntervalHandle = setInterval(tick, SCHEDULER_TICK_INTERVAL_MS)
}

const isSmoke = process.argv.includes('--smoke')
const cliArgs = parseCliArgs(process.argv)
const isCli = cliArgs.mode !== 'none'

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.aethera.reports')

  if (isSmoke) {
    try {
      await runSmokeCheck()
      app.exit(0)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
    return
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    dataService = await LocalDataService.create(resolveDataServicePaths())
  } catch (error) {
    console.error('[db] failed to initialize LocalDataService:', error)
    app.exit(1)
    return
  }

  registerIpcHandlers(dataService)

  // Headless CLI mode (plan §11): --generate / --import run without a
  // window and reuse the same IDataService/exporter paths as the UI.
  // The offscreen PDF export window still needs the IPC handlers
  // registered above (it's a real renderer process, just never shown).
  if (isCli) {
    const logger = createCliLogger(app.getPath('userData'))
    try {
      const exitCode = await runCli(dataService, cliArgs, logger)
      dataService.close()
      app.exit(exitCode)
    } catch (error) {
      logger(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
      dataService.close()
      app.exit(1)
    }
    return
  }

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  void startAutomation(dataService, app.getPath('userData'))
})

app.on('window-all-closed', () => {
  // CLI mode (and --smoke) manage their own exit explicitly via
  // app.exit() once done — batch PDF export opens and closes several
  // offscreen windows in sequence, and this handler firing after the
  // first one would quit the app mid-batch otherwise.
  if (process.platform !== 'darwin' && !isSmoke && !isCli) {
    app.quit()
  }
})

app.on('before-quit', () => {
  dataService?.close()
  dataService = null
  if (inboxWatcher) {
    void inboxWatcher.close()
    inboxWatcher = null
  }
  if (schedulerIntervalHandle) {
    clearInterval(schedulerIntervalHandle)
    schedulerIntervalHandle = null
  }
})
