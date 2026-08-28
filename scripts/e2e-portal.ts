/**
 * Hosted client portal end-to-end check (plan's Phase 3 addendum, chunk
 * F): spins the portal's Hono app up behind a REAL `node:http` server
 * (not `.inject()`/`app.request()` — this exercises the exact `fetch`-
 * based HTTP round trip the desktop's `portal-client.ts` actually uses)
 * on an ephemeral port, backed by a `better-sqlite3` D1 test double.
 * Publishes a real client's report from the app side (a real
 * `LocalDataService` + `publishSnapshot`/`mintLink` from
 * `automation/portal-client.ts`, not the Worker's own internals
 * directly), fetches `/r/<token>`, and asserts the rendered HTML shows
 * real KPI numbers plus the expired/revoked paths both 403.
 *
 * Run with: npm run e2e:portal
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { buildApp, type Env } from '../portal/src/app'
import { createSqliteD1Double, applyPortalSchema } from '../portal/src/db-sqlite-double'
import { LocalDataService } from '../src/main/services/local-data-service'
import {
  publishSnapshot,
  mintLink,
  revokeLinksForRecipient,
  getPortalStatus
} from '../src/main/automation/portal-client'
import type { PortalConfig } from '../src/main/automation/portal-client'

const ADMIN_TOKEN = 'e2e-portal-admin-token'
const SESSION_SECRET = 'e2e-portal-session-secret'
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'portal', 'schema.sql'), 'utf-8')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[e2e-portal] ASSERTION FAILED: ${message}`)
}

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function nodeHeadersToWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
    else if (value !== undefined) headers.set(key, value)
  }
  return headers
}

/** Bridges a real `node:http` request/response pair to Hono's fetch-style `app.fetch()` — no `@hono/node-server` dependency needed for one e2e script. */
function createHonoNodeServer(app: ReturnType<typeof buildApp>, env: Env): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // Node populates `Host` from the real HTTP request (including the
      // port) — using a hardcoded origin here previously dropped the
      // ephemeral port, so every `new URL(c.req.url).origin` the Worker
      // computed (e.g. minted magic-link URLs) came back as :80.
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`
      const url = new URL(req.url ?? '/', origin)
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const body = hasBody ? await readNodeBody(req) : undefined
      const webRequest = new Request(url, {
        method: req.method,
        headers: nodeHeadersToWebHeaders(req),
        body
      })
      const webResponse = await app.fetch(webRequest, env)
      res.statusCode = webResponse.status
      webResponse.headers.forEach((value, key) => res.setHeader(key, value))
      const buffer = Buffer.from(await webResponse.arrayBuffer())
      res.end(buffer)
    })()
  })
}

async function main(): Promise<void> {
  const sqlite = new Database(':memory:')
  applyPortalSchema(sqlite, SCHEMA_SQL)
  const env: Env = { DB: createSqliteD1Double(sqlite), ADMIN_TOKEN, SESSION_SECRET }
  const app = buildApp()
  const server = createHonoNodeServer(app, env)

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not report a port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  console.log(`[e2e-portal] portal Worker listening at ${baseUrl}`)

  const dbDir = mkdtempSync(join(tmpdir(), 'aethera-e2e-portal-'))
  const dataService = await LocalDataService.create({
    duckdbPath: join(dbDir, 'analytics.duckdb'),
    metaDbPath: join(dbDir, 'meta.db'),
    backupsDir: join(dbDir, 'backups')
  })

  try {
    console.log('[e2e-portal] verifying admin auth is enforced...')
    const unauthedStatus = await fetch(`${baseUrl}/admin/status`)
    assert(
      unauthedStatus.status === 401,
      `expected 401 with no admin token, got ${unauthedStatus.status}`
    )

    const portalConfig: PortalConfig = { baseUrl, adminToken: ADMIN_TOKEN }
    const status = await getPortalStatus(portalConfig)
    assert(status.ok, 'admin status should report ok with the correct token')
    console.log(
      `  status: ${status.snapshotCount} snapshot(s), ${status.activeTokenCount} active link(s)`
    )

    console.log('[e2e-portal] seeding a client with real claim data (LocalDataService)...')
    const client = await dataService.createClient({
      code: 'PORTALCO',
      name: 'Portal E2E Co',
      reportRecipients: ['billing@portalco.example']
    })
    const conn = (
      dataService as unknown as {
        duckdb: { connection: import('@duckdb/node-api').DuckDBConnection }
      }
    ).duckdb.connection
    await conn.run(
      `INSERT INTO claims (client_id, patient_key, claim_number, dos, created_at, first_submitted_at,
         status, total_charge, total_allowed, total_paid, patient_responsibility, patient_paid, balance, source, natural_key)
       VALUES (?, 'ph-e2e-portal', 'PORTAL-CLM-1', '2026-03-01', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z',
         'Paid', 5000, 4000, 3500, 500, 400, 100, 'manual', 'e2e-portal-nk-1')`,
      [client.clientId]
    )
    const periodMonth = '2026-03'
    const report = await dataService.buildClientReport(client.clientId, periodMonth)
    assert(
      report.financials.grossCharges === 5000,
      `expected grossCharges 5000, got ${report.financials.grossCharges}`
    )

    console.log(
      '[e2e-portal] publishing the report via the app-side publisher (publishSnapshot)...'
    )
    await publishSnapshot(portalConfig, client.code, periodMonth, report)

    console.log('[e2e-portal] minting a magic link (mintLink)...')
    const minted = await mintLink(portalConfig, client.code, 'billing@portalco.example')
    console.log(`  minted: ${minted.url} (expires ${minted.expiresAt})`)

    console.log('[e2e-portal] fetching /r/<token> and following the redirect...')
    const redirectRes = await fetch(minted.url, { redirect: 'manual' })
    assert(redirectRes.status === 302, `expected 302 redirect, got ${redirectRes.status}`)
    const cookieHeader = redirectRes.headers.get('set-cookie') ?? ''
    const sessionCookie = cookieHeader.split(';')[0]
    assert(sessionCookie.length > 0, 'expected a session cookie to be set')

    const location = redirectRes.headers.get('location') ?? ''
    const reportPageRes = await fetch(`${baseUrl}${location}/${periodMonth}`, {
      headers: { Cookie: sessionCookie }
    })
    assert(
      reportPageRes.status === 200,
      `expected 200 for the report page, got ${reportPageRes.status}`
    )
    const html = await reportPageRes.text()
    assert(html.includes('Portal E2E Co'), 'report page should show the real client name')
    assert(
      html.includes('$5,000'),
      `report page should show the real gross charges, got:\n${html.slice(0, 2000)}`
    )
    assert(html.includes('<svg'), 'report page should include inline SVG charts')
    assert(!html.includes('<script'), 'report page should include no <script> tags')
    console.log('  report page renders real KPI numbers — OK')

    console.log('[e2e-portal] verifying an already-expired link 403s...')
    // ttlDays is fractional days (`* 24 * 60 * 60 * 1000` internally) —
    // 20ms expressed in days, so a short, reliable wait actually crosses it.
    const twentyMsInDays = 20 / (24 * 60 * 60 * 1000)
    const almostExpired = await mintLink(
      portalConfig,
      client.code,
      'expiring@portalco.example',
      twentyMsInDays
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    const expiredRes = await fetch(almostExpired.url, { redirect: 'manual' })
    assert(expiredRes.status === 403, `expected 403 for an expired link, got ${expiredRes.status}`)

    console.log('[e2e-portal] verifying a revoked link 403s...')
    const toRevoke = await mintLink(portalConfig, client.code, 'revokeme@portalco.example')
    await revokeLinksForRecipient(portalConfig, client.code, 'revokeme@portalco.example')
    const revokedRes = await fetch(toRevoke.url, { redirect: 'manual' })
    assert(revokedRes.status === 403, `expected 403 for a revoked link, got ${revokedRes.status}`)

    console.log('\n[e2e-portal] all checks passed')
  } finally {
    dataService.close()
    sqlite.close()
    rmSync(dbDir, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

main().catch((error: unknown) => {
  console.error('[e2e-portal] FAILED:', error)
  process.exitCode = 1
})
