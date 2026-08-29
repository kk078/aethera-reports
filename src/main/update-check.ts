/**
 * Opt-in update check against the public GitHub Releases API. Two paths:
 * a manual "Check now" from Settings (always allowed — user-initiated),
 * and an automatic check at launch that runs ONLY when the user has
 * enabled it in Settings (`autoCheckUpdates` in app-config.json, default
 * off — the app's no-phone-home stance stays the default; see
 * SECURITY.md). This checks and NOTIFIES only: nothing is downloaded or
 * installed. Auto-install stays out until releases are code-signed.
 */
import { net } from 'electron'
import packageJson from '../../package.json'
import { isNewerVersion } from '../shared/version'
import type { UpdateCheckResult } from '../shared/domain'

const RELEASES_API = 'https://api.github.com/repos/kk078/aethera-reports/releases/latest'
const RELEASES_PAGE = 'https://github.com/kk078/aethera-reports/releases/latest'
const TIMEOUT_MS = 6000

// app.getVersion() reports Electron's own version under `electron-vite
// dev`, so the package version is the reliable source in both modes.
export const CURRENT_VERSION: string = packageJson.version

/**
 * Never throws — a network failure, rate limit, or unexpected payload
 * reports `checked: false` so callers can show "couldn't check" (manual)
 * or stay silent (auto).
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const base: UpdateCheckResult = {
    checked: false,
    updateAvailable: false,
    currentVersion: CURRENT_VERSION,
    latestVersion: null,
    releaseUrl: RELEASES_PAGE,
    checkedAt: new Date().toISOString()
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await net.fetch(RELEASES_API, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json' }
    })
    clearTimeout(timer)
    // 404 = the repo has no PUBLISHED releases yet (drafts don't count) —
    // that's a successful check with nothing newer, not a network failure.
    if (res.status === 404) return { ...base, checked: true }
    if (!res.ok) return base
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
    if (typeof body.tag_name !== 'string') return base
    return {
      ...base,
      checked: true,
      latestVersion: body.tag_name.replace(/^v/, ''),
      updateAvailable: isNewerVersion(body.tag_name, CURRENT_VERSION),
      releaseUrl: typeof body.html_url === 'string' ? body.html_url : RELEASES_PAGE
    }
  } catch {
    return base
  }
}

/** The launch-time auto-check's cached result (null until it completes). */
let startupResult: UpdateCheckResult | null = null

export function setStartupResult(result: UpdateCheckResult): void {
  startupResult = result
}

export function getStartupResult(): UpdateCheckResult | null {
  return startupResult
}
