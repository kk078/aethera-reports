/**
 * Generic RCM Platform REST connector tests (plan §3 bullet 3, Phase 2
 * chunk C) — against a real `node:http` mock server standing in for the
 * reference implementation (rcm-prototype), exercising: the auth flow
 * (success/401/MFA-required/timeout), the sync's upserts into
 * `monthly_summaries`/`kpi_snapshots` with `source: 'synced'`, sync
 * cursor/status tracking, idempotent re-sync, and per-client failure
 * isolation.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  loginRcmPlatform,
  fetchRcmPortfolio,
  fetchRcmClientReport,
  RcmConnectorError
} from '../src/main/importers/rcm-connector'
import { LocalDataService } from '../src/main/services/local-data-service'

const VALID_USERNAME = 'manager'
const VALID_PASSWORD = 'test-password-not-real'
const PERIOD_MONTH = '2026-04'

interface MockServerState {
  mfaUser: boolean
  clientReports: Record<string, unknown>
  failClientCodes: Set<string>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => resolve(body))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A tiny stand-in for rcm-prototype's `/api/auth/token` + `/api/reports/*` (plan §3 bullet 3's reference implementation). */
function createMockRcmServer(state: MockServerState): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (req.method === 'POST' && url.pathname === '/api/auth/token') {
        const body = await readBody(req)
        const params = new URLSearchParams(body)
        const username = params.get('username')
        const password = params.get('password')
        if (username === 'mfa-user') {
          sendJson(res, 200, {
            mfa_required: true,
            access_token: 'mfa-scoped-token',
            token_type: 'bearer'
          })
          return
        }
        if (username !== VALID_USERNAME || password !== VALID_PASSWORD) {
          sendJson(res, 401, { detail: 'Incorrect username or password' })
          return
        }
        sendJson(res, 200, { access_token: 'test-access-token', token_type: 'bearer' })
        return
      }

      const auth = req.headers.authorization
      if (auth !== 'Bearer test-access-token') {
        sendJson(res, 401, { detail: 'Not authenticated' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/reports/clients') {
        sendJson(res, 200, {
          period: { start: url.searchParams.get('start'), end: url.searchParams.get('end') },
          clients: [
            { client: 'CONNA', name: 'Connector Client A', encounters: 5, charges: 5000 },
            { client: 'CONNB', name: 'Connector Client B', encounters: 3, charges: 3000 }
          ]
        })
        return
      }

      const clientMatch = url.pathname.match(/^\/api\/reports\/client\/(.+)$/)
      if (req.method === 'GET' && clientMatch) {
        const code = decodeURIComponent(clientMatch[1])
        if (state.failClientCodes.has(code)) {
          sendJson(res, 500, { detail: 'Internal error (simulated)' })
          return
        }
        const report = state.clientReports[code]
        if (!report) {
          sendJson(res, 404, { detail: 'Client not found' })
          return
        }
        sendJson(res, 200, report)
        return
      }

      sendJson(res, 404, { detail: 'Not found' })
    })()
  })
}

function makeClientReport(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    client: { code: 'CONNA', name: 'Connector Client A', contract: 'no contract on file' },
    period: { start: '2026-04-01', end: '2026-04-30' },
    volume: { encounters_received: 5, claims_submitted: 4, denials_received: 1 },
    financials: {
      gross_charges: 5000,
      insurance_collections: 3000,
      patient_collections: 200,
      total_collections: 3200,
      rcm_fee: 160,
      net_collection_rate_pct: 64.0
    },
    kpis: {
      days_in_ar: 22.5,
      open_ar: 1800,
      ar_over_90_pct: 10,
      charge_lag_days_avg: 2,
      sla_days_to_submit: 3,
      sla_met_pct: 90,
      first_pass_acceptance_pct: 80,
      denial_rate_pct: 25
    },
    ar_aging: { '0-30': 1000, '31-60': 500, '61-90': 300, '91-120': 0, '120+': 0 },
    denials_by_root_cause: { CODING: 1 },
    claims_by_status: { Paid: 3, Denied: 1 },
    ...overrides
  }
}

describe('rcm-connector against a mock HTTP server', () => {
  let server: Server
  let baseUrl: string
  const state: MockServerState = {
    mfaUser: false,
    clientReports: {
      CONNA: makeClientReport(),
      CONNB: makeClientReport({
        client: { code: 'CONNB', name: 'Connector Client B', contract: 'no contract on file' }
      })
    },
    failClientCodes: new Set()
  }

  beforeAll(async () => {
    server = createMockRcmServer(state)
    server.listen(0)
    await once(server, 'listening')
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(() => {
    server.close()
  })

  describe('client.ts (auth + fetch, unit level)', () => {
    it('logs in and returns a bearer token', async () => {
      const token = await loginRcmPlatform({
        baseUrl,
        username: VALID_USERNAME,
        password: VALID_PASSWORD
      })
      expect(token).toBe('test-access-token')
    })

    it('rejects bad credentials with a clean unauthorized error', async () => {
      await expect(
        loginRcmPlatform({ baseUrl, username: VALID_USERNAME, password: 'wrong' })
      ).rejects.toMatchObject({ kind: 'unauthorized' })
    })

    it('refuses to proceed when the account requires MFA', async () => {
      await expect(
        loginRcmPlatform({ baseUrl, username: 'mfa-user', password: 'anything' })
      ).rejects.toThrow(/multi-factor/)
    })

    it('times out cleanly against an unreachable host', async () => {
      await expect(
        loginRcmPlatform({
          baseUrl: 'http://127.0.0.1:1',
          username: VALID_USERNAME,
          password: VALID_PASSWORD,
          timeoutMs: 500
        })
      ).rejects.toMatchObject({ kind: expect.stringMatching(/unreachable|timeout/) })
    })

    it('fetches the portfolio and one client report with the token', async () => {
      const token = await loginRcmPlatform({
        baseUrl,
        username: VALID_USERNAME,
        password: VALID_PASSWORD
      })
      const portfolio = await fetchRcmPortfolio(
        { baseUrl, username: VALID_USERNAME, password: VALID_PASSWORD },
        token,
        '2026-04-01',
        '2026-04-30'
      )
      expect(portfolio.clients.map((c) => c.client)).toEqual(['CONNA', 'CONNB'])

      const report = await fetchRcmClientReport(
        { baseUrl, username: VALID_USERNAME, password: VALID_PASSWORD },
        token,
        'CONNA',
        '2026-04-01',
        '2026-04-30'
      )
      expect(report.financials.gross_charges).toBe(5000)
    })

    it('raises a typed RcmConnectorError (not a generic crash) on a 401 mid-session', async () => {
      await expect(
        fetchRcmPortfolio(
          { baseUrl, username: VALID_USERNAME, password: VALID_PASSWORD },
          'not-a-real-token',
          '2026-04-01',
          '2026-04-30'
        )
      ).rejects.toBeInstanceOf(RcmConnectorError)
    })
  })

  describe('LocalDataService.runConnectorSync (integration level)', () => {
    let dir: string
    let service: LocalDataService

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'aethera-rcm-connector-test-'))
      service = await LocalDataService.create({
        duckdbPath: join(dir, 'analytics.duckdb'),
        metaDbPath: join(dir, 'meta.db'),
        backupsDir: join(dir, 'backups')
      })
      state.failClientCodes.clear()
    })

    afterEach(() => {
      service.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('creates missing clients, upserts monthly_summaries + kpi_snapshots with source=synced, and records sync status', async () => {
      const result = await service.runConnectorSync(
        baseUrl,
        VALID_USERNAME,
        VALID_PASSWORD,
        PERIOD_MONTH
      )

      expect(result.periodMonth).toBe(PERIOD_MONTH)
      expect(result.results).toHaveLength(2)
      expect(result.results.every((r) => r.ok)).toBe(true)
      expect(result.results.every((r) => r.created)).toBe(true) // both clients are new

      const clients = await service.listClients()
      const clientA = clients.find((c) => c.code === 'CONNA')
      expect(clientA).toBeDefined()
      expect(clientA?.active).toBe(true)

      const summary = await service.getMonthlySummary(clientA!.clientId, '2026-04-01')
      expect(summary?.source).toBe('synced')
      expect(summary?.charges).toBe(5000)
      expect(summary?.openAr).toBe(1800)

      // Report provenance shows 'synced' (plan §3 / this chunk's E2E requirement).
      const report = await service.buildClientReport(clientA!.clientId, PERIOD_MONTH)
      expect(report.source).toBe('synced')
      expect(report.financials.grossCharges).toBe(5000)

      const status = await service.listConnectorSyncStatus()
      const rowA = status.find((r) => r.clientCode === 'CONNA')
      expect(rowA?.lastStatus).toBe('ok')
      expect(rowA?.createdByConnector).toBe(true)
      expect(rowA?.lastSyncedPeriod).toBe(PERIOD_MONTH)
    })

    it('is idempotent: re-syncing the same period does not duplicate clients or summary rows', async () => {
      const first = await service.runConnectorSync(
        baseUrl,
        VALID_USERNAME,
        VALID_PASSWORD,
        PERIOD_MONTH
      )
      const second = await service.runConnectorSync(
        baseUrl,
        VALID_USERNAME,
        VALID_PASSWORD,
        PERIOD_MONTH
      )

      expect(second.results.every((r) => r.ok)).toBe(true)
      expect(second.results.every((r) => !r.created)).toBe(true) // clients already existed the 2nd time

      const clients = await service.listClients()
      expect(clients.filter((c) => c.code === 'CONNA')).toHaveLength(1)

      const clientA = clients.find((c) => c.code === 'CONNA')!
      const summary = await service.getMonthlySummary(clientA.clientId, '2026-04-01')
      expect(summary?.source).toBe('synced')

      void first
    })

    it('isolates a per-client failure — one client erroring never aborts the whole sync', async () => {
      state.failClientCodes.add('CONNB')
      const result = await service.runConnectorSync(
        baseUrl,
        VALID_USERNAME,
        VALID_PASSWORD,
        PERIOD_MONTH
      )

      const a = result.results.find((r) => r.clientCode === 'CONNA')
      const b = result.results.find((r) => r.clientCode === 'CONNB')
      expect(a?.ok).toBe(true)
      expect(b?.ok).toBe(false)
      expect(b?.error).toBeTruthy()

      const status = await service.listConnectorSyncStatus()
      expect(status.find((r) => r.clientCode === 'CONNA')?.lastStatus).toBe('ok')
      expect(status.find((r) => r.clientCode === 'CONNB')?.lastStatus).toBe('error')

      // CONNA (which succeeded) still got its data written despite CONNB's failure.
      const clients = await service.listClients()
      const clientA = clients.find((c) => c.code === 'CONNA')!
      const summary = await service.getMonthlySummary(clientA.clientId, '2026-04-01')
      expect(summary).not.toBeNull()
    })

    it('401/unauthorized on login surfaces a clean rejection, not a crash', async () => {
      await expect(
        service.runConnectorSync(baseUrl, VALID_USERNAME, 'wrong-password', PERIOD_MONTH)
      ).rejects.toMatchObject({ kind: 'unauthorized' })
    })

    it('testConnectorConnection reports ok/not-ok without throwing either way', async () => {
      const ok = await service.testConnectorConnection(baseUrl, VALID_USERNAME, VALID_PASSWORD)
      expect(ok.ok).toBe(true)

      const bad = await service.testConnectorConnection(baseUrl, VALID_USERNAME, 'wrong')
      expect(bad.ok).toBe(false)
      expect(bad.message).toBeTruthy()
    })
  })
})
