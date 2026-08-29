/**
 * The one piece of app config that has to exist BEFORE any `IDataService`
 * does (Phase 3 chunk E: "Data mode: Local / Server") — which data
 * service to construct at all, and (for Server mode) the connection to
 * reach it over. This can't live in `LocalDataService`'s `meta.db`: in
 * Server mode `LocalDataService` is never even opened, so the setting
 * that says "don't open it" would be trapped inside the very thing it's
 * saying not to open.
 *
 * Lives as a small standalone JSON file directly under Electron's
 * `userData` dir (`app-config.json`) — read once at launch by `index.ts`
 * before deciding which service to build, and written by the Settings
 * screen's "Data mode" section via `ipc/data-mode.ts`. The server
 * password is encrypted the same way the RCM connector's is
 * (`credentials.ts`, `safeStorage`) — this file is outside the
 * `no-restricted-imports` guard (`services/`/`importers/`/`kpi/`), so
 * touching Electron/`credentials.ts` here is fine.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EncryptedSecret } from './credentials'

export interface AppConfig {
  dataMode: 'local' | 'server'
  server: {
    baseUrl: string
    username: string
    encryptedPassword: EncryptedSecret | null
  } | null
  /** Opt-in launch-time update check (SECURITY.md: off by default). */
  autoCheckUpdates: boolean
}

const DEFAULT_CONFIG: AppConfig = { dataMode: 'local', server: null, autoCheckUpdates: false }

function configPath(userDataDir: string): string {
  return join(userDataDir, 'app-config.json')
}

/** Never throws — a missing, unreadable, or malformed config file just means "Local mode" (the safe default), not a launch failure. */
export function loadAppConfig(userDataDir: string): AppConfig {
  const path = configPath(userDataDir)
  if (!existsSync(path)) return DEFAULT_CONFIG
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppConfig>
    const autoCheckUpdates = raw.autoCheckUpdates === true
    if (raw.dataMode === 'server' && raw.server) {
      return { dataMode: 'server', server: raw.server, autoCheckUpdates }
    }
    return { ...DEFAULT_CONFIG, autoCheckUpdates }
  } catch {
    return DEFAULT_CONFIG
  }
}

export function saveAppConfig(userDataDir: string, config: AppConfig): void {
  writeFileSync(configPath(userDataDir), JSON.stringify(config, null, 2), 'utf-8')
}
