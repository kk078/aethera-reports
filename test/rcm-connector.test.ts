/**
 * Generic RCM Platform REST connector tests (plan §3 bullet 3, Phase 2
 * chunk C; claim-level sync per docs/connectors.md) — against a real
 * `node:http` mock server standing in for the reference implementation
 * (rcm-prototype), exercising: the auth flow (success/401/MFA-required/
 * timeout), the summary sync's upserts into
 * `monthly_summaries`/`kpi_snapshots` with `source: 'synced'`, sync
 * cursor/status tracking, idempotent re-sync, per-client failure
 * isolation, and the claim-level sync (batch import into
 * `claims`/`claim_lines` with `source: 'api'`, re-sync no-op via
 * `run837Import`'s existing dedup, payment/denial enrichment, and the
 * KPI ladder preferring claim-level data once it exists).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { DuckDBConnection } from '@duckdb/node-api'
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

const SYNTHETIC_837 = readFileSync(
  join(__dirname, '..', 'sample-data', 'synthetic-837.837'),
  'utf-8'
)

interface MockPlatformClient {
  id: number
  code: string
  name: string
}

interface MockBatch {
  id: number
  batch_number: string
  client_id: number
  status: string
  claims: number
  total_charge: number
  clearinghouse_ref: string
  created_at: string
}

interface MockServerState {
  mfaUser: boolean
  clientReports: Record<string, unknown>
  failClientCodes: Set<string>
  /** `GET /api/clients` — id<->code map the claim-level sync needs (`/api/batches`/`/api/claims` only carry the numeric id). */
  platformClients: MockPlatformClient[]
  /** `GET /api/batches` */
  batches: MockBatch[]
  /** `GET /api/batches/{id}/837.edi` — batch id -> raw X12 text. */
  batchEdi: Record<number, string>
  /** `GET /api/claims?client_id=` — platform client id -> claim rows. */
  claimsByClientId: Record<number, unknown[]>
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

      // --- Claim-level sync (docs/connectors.md "Claim-level sync") ---
      if (req.method === 'GET' && url.pathname === '/api/clients') {
        sendJson(res, 200, state.platformClients)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/batches') {
        sendJson(res, 200, state.batches)
        return
      }

      const batchEdiMatch = url.pathname.match(/^\/api\/batches\/(\d+)\/837\.edi$/)
      if (req.method === 'GET' && batchEdiMatch) {
        const batchId = Number(batchEdiMatch[1])
        // `in` (not a truthy check) — a registered-but-empty-string entry
        // is a deliberate, real response (see fetchRcmBatchEdi837's doc
        // comment), distinct from "no such batch" below.
        if (!(batchId in state.batchEdi)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not found')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(state.batchEdi[batchId])
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/claims') {
        const clientId = Number(url.searchParams.get('client_id') ?? 'NaN')
        const limit = Number(url.searchParams.get('limit') ?? '200')
        const offset = Number(url.searchParams.get('offset') ?? '0')
        const all = state.claimsByClientId[clientId] ?? []
        sendJson(res, 200, all.slice(offset, offset + limit))
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
    failClientCodes: new Set(),
    // Platform ids for CONNA/CONNB, the same two codes the summary sync
    // above creates every test — /api/batches and /api/claims only carry
    // these numeric ids, never the code.
    platformClients: [
      { id: 1, code: 'CONNA', name: 'Connector Client A' },
      { id: 2, code: 'CONNB', name: 'Connector Client B' }
    ],
    batches: [],
    batchEdi: {},
    claimsByClientId: {}
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
      state.batches = []
      state.batchEdi = {}
      state.claimsByClientId = {}
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

  describe('claim-level sync (docs/connectors.md "Claim-level sync")', () => {
    let dir: string
    let service: LocalDataService

    function connection(): DuckDBConnection {
      return (service as unknown as { duckdb: { connection: DuckDBConnection } }).duckdb.connection
    }

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'aethera-rcm-connector-claim-test-'))
      service = await LocalDataService.create({
        duckdbPath: join(dir, 'analytics.duckdb'),
        metaDbPath: join(dir, 'meta.db'),
        backupsDir: join(dir, 'backups')
      })
      state.failClientCodes.clear()
      state.batches = []
      state.batchEdi = {}
      state.claimsByClientId = {}
    })

    afterEach(() => {
      service.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('imports a submission batch into claims/claim_lines with source=api and enriches it with paid/denial detail in the same pass', async () => {
      // Batch 101 belongs to platform client_id 1 = CONNA (state.platformClients above).
      state.batches = [
        {
          id: 101,
          batch_number: 'B-101',
          client_id: 1,
          status: 'SUBMITTED',
          claims: 2,
          total_charge: 800,
          clearinghouse_ref: 'CH-101',
          created_at: '2026-04-01T00:00:00Z'
        }
      ]
      state.batchEdi[101] = SYNTHETIC_837 // CLAIM1001 ($500), CLAIM2002 ($300) — see sample-data/synthetic-837.837
      // Enrichment data for CLAIM1001 only — CLAIM2002 stays unenriched, a control showing enrichment is scoped per-claim.
      state.claimsByClientId[1] = [
        {
          id: 9001,
          claim_number: 'CLAIM1001',
          client_id: 1,
          status: 'PAID',
          external_ref: null,
          total_charge: 500,
          total_allowed: 400,
          total_paid: 380,
          patient_responsibility: 20,
          patient_paid: 20,
          adjustments: 100,
          balance: 0,
          lines: [{ line_number: 1, cpt_code: '99213', adjustment_codes: ['CO-45', 'PR-1'] }]
        }
      ]

      const result = await service.runConnectorSync(
        baseUrl,
        VALID_USERNAME,
        VALID_PASSWORD,
        PERIOD_MONTH
      )

      expect(result.claimLevel.enabled).toBe(true)
      expect(result.claimLevel.batches).toHaveLength(1)
      expect(result.claimLevel.batches[0]).toMatchObject({
        clientCode: 'CONNA',
        batchId: 101,
        ok: true,
        claimsLoaded: 2
      })
      expect(result.claimLevel.enrichment.claimsUpdated).toBe(1)
      expect(result.claimLevel.enrichment.denialsWritten).toBe(2)
      expect(result.claimLevel.enrichment.errors).toEqual([])

      const clientA = (await service.listClients()).find((c) => c.code === 'CONNA')!
      const claimsReader = await connection().runAndReadAll(
        `SELECT claim_number, source, total_paid, total_allowed, patient_responsibility, status, balance
         FROM claims WHERE client_id = ? ORDER BY claim_number`,
        [clientA.clientId]
      )
      const claims = claimsReader.getRowObjectsJS()
      expect(claims).toHaveLength(2)
      expect(claims.every((c) => c.source === 'api')).toBe(true)

      const claim1001 = claims.find((c) => c.claim_number === 'CLAIM1001')!
      expect(Number(claim1001.total_paid)).toBe(380)
      expect(Number(claim1001.total_allowed)).toBe(400)
      expect(Number(claim1001.patient_responsibility)).toBe(20)
      expect(claim1001.status).toBe('PAID')
      expect(Number(claim1001.balance)).toBe(100) // 500 charge - 380 paid - 20 patient_paid

      const claim2002 = claims.find((c) => c.claim_number === 'CLAIM2002')!
      expect(Number(claim2002.total_paid)).toBe(0) // never enriched — control

      const denialsReader = await connection().runAndReadAll(
        `SELECT d.carc_code, d.category FROM denials d
         JOIN claims c ON c.claim_id = d.claim_id
         WHERE c.claim_number = 'CLAIM1001' ORDER BY d.carc_code`,
        []
      )
      const denials = denialsReader.getRowObjectsJS()
      expect(denials).toEqual([
        { carc_code: '1', category: 'patient_responsibility' },
        { carc_code: '45', category: 'contractual_obligation' }
      ])

      const status = await service.listConnectorSyncStatus()
      expect(status.find((r) => r.clientCode === 'CONNA')?.lastBatchCursor).toBe(101)
    })

    it('re-syncing is a no-op: an already-imported batch is not re-fetched and claims are not duplicated', async () => {
      state.batches = [
        {
          id: 202,
          batch_number: 'B-202',
          client_id: 1,
          status: 'SUBMITTED',
          claims: 2,
          total_charge: 800,
          clearinghouse_ref: 'CH-202',
          created_at: '2026-04-01T00:00:00Z'
        }
      ]
      state.batchEdi[202] = SYNTHETIC_837

      const first = await service.runConnectorSync(
        baseUrl,
        VALID_USERNAME,
        VALID_PASSWORD,
        PERIOD_MONTH
      )
      expect(first.claimLevel.batches).toHaveLength(1)
      expect(first.claimLevel.batches[0].ok).toBe(true)

      const second = await service.runConnectorSync(
        baseUrl,
        VALID_USERNAME,
        VALID_PASSWORD,
        PERIOD_MONTH
      )
      // Batch 202 is now behind CONNA's cursor — nothing new to fetch.
      expect(second.claimLevel.batches).toHaveLength(0)

      const clientA = (await service.listClients()).find((c) => c.code === 'CONNA')!
      const countReader = await connection().runAndReadAll(
        'SELECT COUNT(*) AS n FROM claims WHERE client_id = ?',
        [clientA.clientId]
      )
      expect(Number(countReader.getRowObjectsJS()[0].n)).toBe(2) // not 4 — no duplicates

      const status = await service.listConnectorSyncStatus()
      expect(status.find((r) => r.clientCode === 'CONNA')?.lastBatchCursor).toBe(202)
    })

    it('an empty-body batch (a real response the live reference instance sends — see fetchRcmBatchEdi837) is a clean no-op success, and does not block a later batch for the same client', async () => {
      state.batches = [
        {
          id: 401,
          batch_number: 'B-401-EMPTY',
          client_id: 1,
          status: 'SUBMITTED',
          claims: 0,
          total_charge: 0,
          clearinghouse_ref: '',
          created_at: '2026-04-01T00:00:00Z'
        },
        {
          id: 402,
          batch_number: 'B-402',
          client_id: 1,
          status: 'SUBMITTED',
          claims: 2,
          total_charge: 800,
          clearinghouse_ref: '',
          created_at: '2026-04-02T00:00:00Z'
        }
      ]
      state.batchEdi[401] = '' // registered, deliberately empty — distinct from "no such batch"
      state.batchEdi[402] = SYNTHETIC_837

      const result = await service.runConnectorSync(
        baseUrl,
        VALID_USERNAME,
        VALID_PASSWORD,
        PERIOD_MONTH
      )

      expect(result.claimLevel.batches).toHaveLength(2)
      const b401 = result.claimLevel.batches.find((b) => b.batchId === 401)!
      const b402 = result.claimLevel.batches.find((b) => b.batchId === 402)!
      expect(b401).toMatchObject({ ok: true, claimsLoaded: 0 })
      expect(b402).toMatchObject({ ok: true, claimsLoaded: 2 }) // not blocked by batch 401

      const clientA = (await service.listClients()).find((c) => c.code === 'CONNA')!
      const countReader = await connection().runAndReadAll(
        'SELECT COUNT(*) AS n FROM claims WHERE client_id = ?',
        [clientA.clientId]
      )
      expect(Number(countReader.getRowObjectsJS()[0].n)).toBe(2) // batch 402's two claims only

      const status = await service.listConnectorSyncStatus()
      expect(status.find((r) => r.clientCode === 'CONNA')?.lastBatchCursor).toBe(402)
    })

    it('a genuine batch failure (not the empty-body case) does not block a later batch for the same client, and the cursor jumps the gap', async () => {
      state.batches = [
        {
          id: 501,
          batch_number: 'B-501-BROKEN',
          client_id: 1,
          status: 'SUBMITTED',
          claims: 1,
          total_charge: 100,
          clearinghouse_ref: '',
          created_at: '2026-04-01T00:00:00Z'
        },
        {
          id: 502,
          batch_number: 'B-502',
          client_id: 1,
          status: 'SUBMITTED',
          claims: 2,
          total_charge: 800,
          clearinghouse_ref: '',
          created_at: '2026-04-02T00:00:00Z'
        }
      ]
      // 501 has no batchEdi entry at all -> the mock server 404s it (a genuine fetch failure, not the empty-body case above).
      state.batchEdi[502] = SYNTHETIC_837

      const result = await service.runConnectorSync(
        baseUrl,
        VALID_USERNAME,
        VALID_PASSWORD,
        PERIOD_MONTH
      )

      const b501 = result.claimLevel.batches.find((b) => b.batchId === 501)!
      const b502 = result.claimLevel.batches.find((b) => b.batchId === 502)!
      expect(b501.ok).toBe(false)
      expect(b501.error).toBeTruthy()
      expect(b502).toMatchObject({ ok: true, claimsLoaded: 2 }) // not blocked by 501's failure

      // Cursor jumps past the still-broken 501 once 502 (the later batch) succeeds.
      const status = await service.listConnectorSyncStatus()
      expect(status.find((r) => r.clientCode === 'CONNA')?.lastBatchCursor).toBe(502)
    })

    it('the KPI fallback ladder prefers claim-level data over the synced monthly_summaries once claims exist for the client', async () => {
      state.batches = [
        {
          id: 303,
          batch_number: 'B-303',
          client_id: 1,
          status: 'SUBMITTED',
          claims: 2,
          total_charge: 800,
          clearinghouse_ref: 'CH-303',
          created_at: '2026-04-01T00:00:00Z'
        }
      ]
      state.batchEdi[303] = SYNTHETIC_837

      await service.runConnectorSync(baseUrl, VALID_USERNAME, VALID_PASSWORD, PERIOD_MONTH)

      const clientA = (await service.listClients()).find((c) => c.code === 'CONNA')!

      // The summary sync (same call, same cycle) did write a 'synced' monthly_summaries row for this exact client-month —
      // the ladder has both a claims-shaped source and a manual/synced-shaped one to choose between.
      const summary = await service.getMonthlySummary(clientA.clientId, '2026-04-01')
      expect(summary?.source).toBe('synced')
      expect(summary?.charges).toBe(5000) // the summary sync's number (makeClientReport's gross_charges)

      const report = await service.buildClientReport(clientA.clientId, PERIOD_MONTH)
      expect(report.source).toBe('claims')
      // Real claim-level computation, not a copy of the monthly_summaries row above.
      expect(report.financials.grossCharges).not.toBe(5000)
    })
  })
})
