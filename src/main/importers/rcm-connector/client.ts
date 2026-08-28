/**
 * HTTP client for the generic RCM Platform REST connector (plan §3
 * bullet 3). Pure `fetch`-based — no Electron import, so this stays
 * usable from `LocalDataService` (the `no-restricted-imports` ESLint
 * rule only blocks `services/`/`importers/`/`kpi/` from importing
 * `electron` itself; `fetch` is a plain Node/Electron-runtime global).
 *
 * Auth: `POST {base}/api/auth/token` (OAuth2 password form) — proven
 * against the live rcm-prototype reference implementation in
 * `scripts/crosscheck-rcm.ts`. Every call has a timeout and never throws
 * an unhandled shape — callers get a clear `RcmConnectorError` with a
 * `kind` they can branch on (unreachable/timeout/401/unexpected shape).
 */
import type {
  RcmAuthTokenResponse,
  RcmClientReportRaw,
  RcmConnectorConfig,
  RcmPortfolioResponse
} from './types'

const DEFAULT_TIMEOUT_MS = 10_000

export type RcmConnectorErrorKind = 'unreachable' | 'timeout' | 'unauthorized' | 'http' | 'shape'

export class RcmConnectorError extends Error {
  constructor(
    public readonly kind: RcmConnectorErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'RcmConnectorError'
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RcmConnectorError('timeout', `Request to ${url} timed out after ${timeoutMs}ms.`)
    }
    throw new RcmConnectorError(
      'unreachable',
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    clearTimeout(timer)
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** `POST {base}/api/auth/token` — OAuth2 password form, matching rcm-prototype's `/api/auth/token` (auth.py). */
export async function loginRcmPlatform(config: RcmConnectorConfig): Promise<string> {
  const base = normalizeBaseUrl(config.baseUrl)
  const body = new URLSearchParams({ username: config.username, password: config.password })
  const res = await fetchWithTimeout(
    `${base}/api/auth/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )

  if (res.status === 401 || res.status === 403) {
    throw new RcmConnectorError('unauthorized', 'Login rejected — check the username/password.')
  }
  if (!res.ok) {
    throw new RcmConnectorError('http', `Login failed: HTTP ${res.status} ${await safeText(res)}`)
  }

  let json: RcmAuthTokenResponse
  try {
    json = (await res.json()) as RcmAuthTokenResponse
  } catch {
    throw new RcmConnectorError('shape', 'Login response was not valid JSON.')
  }

  // A pending-MFA response carries `mfa_required: true` at the TOP level
  // (auth.py's `_login()` short-circuits before issuing a full session
  // token in that branch) — the connector has no interactive MFA step,
  // so this is a clear configuration error, not a retryable one.
  if (json.mfa_required || json.user?.mfa_required) {
    throw new RcmConnectorError(
      'unauthorized',
      'This account requires multi-factor authentication — the connector needs a service account with MFA disabled.'
    )
  }
  if (!json.access_token) {
    throw new RcmConnectorError('shape', 'Login response did not include an access_token.')
  }
  return json.access_token
}

async function authorizedGet<T>(
  baseUrl: string,
  token: string,
  path: string,
  params: Record<string, string>,
  timeoutMs: number
): Promise<T> {
  const base = normalizeBaseUrl(baseUrl)
  const url = new URL(`${base}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  const res = await fetchWithTimeout(
    url.toString(),
    { headers: { Authorization: `Bearer ${token}` } },
    timeoutMs
  )
  if (res.status === 401) {
    throw new RcmConnectorError(
      'unauthorized',
      `${path} returned 401 — the token may have expired.`
    )
  }
  if (!res.ok) {
    throw new RcmConnectorError(
      'http',
      `GET ${path} failed: HTTP ${res.status} ${await safeText(res)}`
    )
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new RcmConnectorError('shape', `${path} did not return valid JSON.`)
  }
}

/** `GET {base}/api/reports/clients?start&end` — the portfolio list (plan §3 bullet 3). */
export async function fetchRcmPortfolio(
  config: RcmConnectorConfig,
  token: string,
  start: string,
  end: string
): Promise<RcmPortfolioResponse> {
  return authorizedGet<RcmPortfolioResponse>(
    config.baseUrl,
    token,
    '/api/reports/clients',
    { start, end },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )
}

/** `GET {base}/api/reports/client/{code}?start&end` — one client's computed report JSON for the period. */
export async function fetchRcmClientReport(
  config: RcmConnectorConfig,
  token: string,
  clientCode: string,
  start: string,
  end: string
): Promise<RcmClientReportRaw> {
  return authorizedGet<RcmClientReportRaw>(
    config.baseUrl,
    token,
    `/api/reports/client/${encodeURIComponent(clientCode)}`,
    { start, end },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
