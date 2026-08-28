/**
 * HTTP client for the hosted client portal's Admin API (plan's Phase 3
 * addendum, chunk F: `portal/`, a Cloudflare Worker). Mirrors the RCM
 * connector client's shape (`importers/rcm-connector/client.ts`): pure
 * `fetch`, no Electron import, a timeout on every call, and a typed
 * error instead of a raw thrown `fetch` exception.
 *
 * The admin token arrives here already decrypted by the caller
 * (`ipc/portal.ts`, via `credentials.ts`) — this module never touches
 * `safeStorage` itself, same pattern as the RCM connector's password and
 * SMTP's.
 */
import type { ClientReport } from '../../shared/domain'

const DEFAULT_TIMEOUT_MS = 10_000

export type PortalClientErrorKind = 'unreachable' | 'timeout' | 'unauthorized' | 'http' | 'shape'

export class PortalClientError extends Error {
  constructor(
    public readonly kind: PortalClientErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'PortalClientError'
  }
}

export interface PortalConfig {
  baseUrl: string
  adminToken: string
}

export interface MintLinkResult {
  url: string
  expiresAt: string
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

async function adminRequest<T>(
  config: PortalConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const url = `${normalizeBaseUrl(config.baseUrl)}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.adminToken}`
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PortalClientError('timeout', `Request to ${url} timed out after ${timeoutMs}ms.`)
    }
    throw new PortalClientError(
      'unreachable',
      `Could not reach the portal at ${url}: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401 || response.status === 403) {
    throw new PortalClientError('unauthorized', 'The portal rejected the admin token.')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new PortalClientError(
      'http',
      `Portal request to ${path} failed (HTTP ${response.status})${text ? `: ${text}` : ''}`
    )
  }
  try {
    return (await response.json()) as T
  } catch {
    throw new PortalClientError('shape', `Portal response from ${path} was not valid JSON.`)
  }
}

/** `POST /admin/snapshots` — publish or replace a client+period's report (plan: "publish/replace a client+period report JSON"). */
export async function publishSnapshot(
  config: PortalConfig,
  clientCode: string,
  periodMonth: string,
  report: ClientReport
): Promise<void> {
  await adminRequest(config, 'POST', '/admin/snapshots', {
    clientCode,
    period: periodMonth,
    report
  })
}

/** `DELETE /admin/snapshots/:clientCode/:period` — revoke a published snapshot. */
export async function revokeSnapshot(
  config: PortalConfig,
  clientCode: string,
  periodMonth: string
): Promise<void> {
  await adminRequest(
    config,
    'DELETE',
    `/admin/snapshots/${encodeURIComponent(clientCode)}/${encodeURIComponent(periodMonth)}`
  )
}

/** `POST /admin/links` — mint a magic-link token for one recipient (plan: "TTL default 30 days -> returns URL"). */
export async function mintLink(
  config: PortalConfig,
  clientCode: string,
  email: string,
  ttlDays?: number
): Promise<MintLinkResult> {
  return adminRequest<MintLinkResult>(config, 'POST', '/admin/links', {
    clientCode,
    email,
    ttlDays
  })
}

/** `POST /admin/links/revoke` — revoke every active link for one recipient (e.g. they left the account). */
export async function revokeLinksForRecipient(
  config: PortalConfig,
  clientCode: string,
  email: string
): Promise<void> {
  await adminRequest(config, 'POST', '/admin/links/revoke', { clientCode, email })
}

/** `GET /admin/status` — connectivity/auth probe for Settings' "Test connection" button. */
export async function getPortalStatus(
  config: PortalConfig
): Promise<{ ok: boolean; snapshotCount: number; activeTokenCount: number }> {
  return adminRequest(config, 'GET', '/admin/status')
}
