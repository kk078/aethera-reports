/**
 * Server API tests (Phase 3 chunk E) — a real Fastify instance built by
 * `server/src/app.ts`, exercised entirely via `.inject()` (fastify's
 * built-in "supertest-style, no real network" testing mechanism) against
 * a real temp DuckDB/SQLite pair, exactly like `LocalDataService`'s own
 * tests. Covers: login success/401/rate-limit, RPC auth gating, a
 * representative set of RPC methods, unknown-method 404, and the
 * multipart upload-import roundtrip (CSV + X12 auto-detect).
 */
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDataService } from '../src/main/services/local-data-service'
import { buildServer } from '../server/src/app'
import { openUsersDb, createUser } from '../server/src/auth/users-db'
import { hashPassword } from '../server/src/auth/auth-plugin'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')
const TEST_USERNAME = 'alice'
const TEST_PASSWORD = 'correct-horse-battery-staple'

function buildMultipartBody(
  fields: Record<string, string>,
  file: { fieldName: string; filename: string; contentType: string; content: Buffer }
): { body: Buffer; contentType: string } {
  const boundary = `----aethera-test-boundary-${Math.random().toString(16).slice(2)}`
  const parts: Buffer[] = []
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
    )
  )
  parts.push(file.content)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

describe('server API', () => {
  let dbDir: string
  let service: LocalDataService
  let usersDb: Database.Database
  let app: FastifyInstance
  let token: string

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'aethera-server-test-'))
    service = await LocalDataService.create({
      duckdbPath: join(dbDir, 'analytics.duckdb'),
      metaDbPath: join(dbDir, 'meta.db'),
      backupsDir: join(dbDir, 'backups')
    })
    usersDb = openUsersDb(dbDir)
    createUser(usersDb, TEST_USERNAME, await hashPassword(TEST_PASSWORD))

    app = await buildServer({
      dataService: service,
      usersDb,
      jwtSecret: 'test-secret-not-for-production',
      jwtExpiresIn: '15m',
      uploadsDir: join(dbDir, 'uploads'),
      logger: false
    })
    await app.ready()

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD }
    })
    token = (loginRes.json() as { token: string }).token
  })

  afterEach(async () => {
    await app.close()
    service.close()
    usersDb.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  describe('GET /health', () => {
    it('responds without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
    })
  })

  describe('POST /api/auth/login', () => {
    it('issues a JWT for correct credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD }
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { token: string; username: string }
      expect(body.username).toBe(TEST_USERNAME)
      expect(typeof body.token).toBe('string')
      expect(body.token.split('.')).toHaveLength(3) // header.payload.signature
    })

    it('rejects a wrong password with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: TEST_USERNAME, password: 'nope' }
      })
      expect(res.statusCode).toBe(401)
    })

    it('rejects an unknown username with 401 (same shape as a wrong password)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'ghost', password: 'whatever' }
      })
      expect(res.statusCode).toBe(401)
    })

    it('rate-limits repeated login attempts', async () => {
      const attempt = (): Promise<{ statusCode: number }> =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: TEST_USERNAME, password: 'nope' }
        })
      const results: number[] = []
      for (let i = 0; i < 7; i++) {
        results.push((await attempt()).statusCode)
      }
      expect(results.filter((code) => code === 401).length).toBeGreaterThan(0)
      expect(results).toContain(429)
    })
  })

  describe('POST /api/rpc/:method — auth gating', () => {
    it('rejects a request with no Authorization header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rpc/listClients',
        payload: {}
      })
      expect(res.statusCode).toBe(401)
    })

    it('rejects a request with a garbage token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rpc/listClients',
        headers: { authorization: 'Bearer not-a-real-token' },
        payload: {}
      })
      expect(res.statusCode).toBe(401)
    })

    it('rejects an expired token', async () => {
      const shortLivedApp = await buildServer({
        dataService: service,
        usersDb,
        jwtSecret: 'test-secret-not-for-production',
        jwtExpiresIn: '1ms',
        uploadsDir: join(dbDir, 'uploads'),
        logger: false
      })
      await shortLivedApp.ready()
      const loginRes = await shortLivedApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD }
      })
      const expiredToken = (loginRes.json() as { token: string }).token
      await new Promise((resolve) => setTimeout(resolve, 20))
      const res = await shortLivedApp.inject({
        method: 'POST',
        url: '/api/rpc/listClients',
        headers: { authorization: `Bearer ${expiredToken}` },
        payload: {}
      })
      expect(res.statusCode).toBe(401)
      await shortLivedApp.close()
    })
  })

  describe('POST /api/rpc/:method — a representative set of methods', () => {
    it('404s an unknown method name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rpc/thisMethodDoesNotExist',
        headers: { authorization: `Bearer ${token}` },
        payload: {}
      })
      expect(res.statusCode).toBe(404)
    })

    it('400s a request body that fails zod validation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rpc/createClient',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Missing the required "code" field' }
      })
      expect(res.statusCode).toBe(400)
    })

    it('creates and lists clients against a real DuckDB', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/rpc/createClient',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: 'RPCCO', name: 'RPC Test Co' }
      })
      expect(createRes.statusCode).toBe(200)
      const created = createRes.json() as { clientId: number; code: string }
      expect(created.code).toBe('RPCCO')

      const listRes = await app.inject({
        method: 'POST',
        url: '/api/rpc/listClients',
        headers: { authorization: `Bearer ${token}` },
        payload: {}
      })
      expect(listRes.statusCode).toBe(200)
      const { clients } = listRes.json() as { clients: Array<{ code: string }> }
      expect(clients.map((c) => c.code)).toContain('RPCCO')

      const updateRes = await app.inject({
        method: 'POST',
        url: '/api/rpc/updateClient',
        headers: { authorization: `Bearer ${token}` },
        payload: { clientId: created.clientId, patch: { contractRate: 0.06 } }
      })
      expect(updateRes.statusCode).toBe(200)
      expect((updateRes.json() as { contractRate: number }).contractRate).toBeCloseTo(0.06)
    })

    it('runs a CSV import via RPC (a real local file path, as the desktop client would send after resolving one) and reflects it in buildClientReport', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/rpc/createClient',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: 'RPCIMP', name: 'RPC Import Co' }
      })

      const importRes = await app.inject({
        method: 'POST',
        url: '/api/rpc/runCsvImport',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          filePath: join(FIXTURES_DIR, 'tebra-claim-export.csv'),
          templateId: 'tebra-claim-export',
          clientCode: 'RPCIMP'
        }
      })
      expect(importRes.statusCode).toBe(200)
      const job = importRes.json() as { status: string; rowsLoaded: number }
      expect(job.status).toBe('succeeded')
      expect(job.rowsLoaded).toBeGreaterThan(0)

      const clients = (
        (
          await app.inject({
            method: 'POST',
            url: '/api/rpc/listClients',
            headers: { authorization: `Bearer ${token}` },
            payload: {}
          })
        ).json() as { clients: Array<{ clientId: number; code: string }> }
      ).clients
      const client = clients.find((c) => c.code === 'RPCIMP')!

      // `claims.first_submitted_at` is set to the import's own wall-clock
      // time (not the fixture's date-of-service column), so "the period a
      // freshly-imported claim counts toward" is whatever month it is
      // right now — not the fixture's 2026-01 service dates.
      const now = new Date()
      const currentPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

      const reportRes = await app.inject({
        method: 'POST',
        url: '/api/rpc/buildClientReport',
        headers: { authorization: `Bearer ${token}` },
        payload: { clientId: client.clientId, periodMonth: currentPeriod }
      })
      expect(reportRes.statusCode).toBe(200)
      const report = reportRes.json() as { source: string; volume: { claimsSubmitted: number } }
      expect(report.source).toBe('claims')
      expect(report.volume.claimsSubmitted).toBeGreaterThan(0)
    })

    it('exercises a few more read-only methods across other areas of the surface', async () => {
      const arRes = await app.inject({
        method: 'POST',
        url: '/api/rpc/getArAgingByClient',
        headers: { authorization: `Bearer ${token}` },
        payload: {}
      })
      expect(arRes.statusCode).toBe(200)
      expect(arRes.json()).toEqual({ rows: [] })

      const rulesRes = await app.inject({
        method: 'POST',
        url: '/api/rpc/listAutomationRules',
        headers: { authorization: `Bearer ${token}` },
        payload: {}
      })
      expect(rulesRes.statusCode).toBe(200)
      expect(rulesRes.json()).toEqual({ rules: [] })

      const backupRes = await app.inject({
        method: 'POST',
        url: '/api/rpc/getBackupStatus',
        headers: { authorization: `Bearer ${token}` },
        payload: {}
      })
      expect(backupRes.statusCode).toBe(200)
      expect(backupRes.json()).toMatchObject({ backupCount: expect.any(Number) })
    })
  })

  describe('POST /api/import/upload', () => {
    it('imports an uploaded CSV using the given templateId', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/rpc/createClient',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: 'UPLOADCO', name: 'Upload Test Co' }
      })

      const { body, contentType } = buildMultipartBody(
        { clientCode: 'UPLOADCO', templateId: 'tebra-claim-export' },
        {
          fieldName: 'file',
          filename: 'tebra-claim-export.csv',
          contentType: 'text/csv',
          content: readFileSync(join(FIXTURES_DIR, 'tebra-claim-export.csv'))
        }
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/import/upload',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        payload: body
      })
      expect(res.statusCode).toBe(200)
      const { job } = res.json() as { job: { status: string; rowsLoaded: number } }
      expect(job.status).toBe('succeeded')
      expect(job.rowsLoaded).toBeGreaterThan(0)
    })

    it('auto-detects an uploaded X12 837 file with no templateId', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/rpc/createClient',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: 'UPLOADX12', name: 'Upload X12 Co' }
      })

      const { body, contentType } = buildMultipartBody(
        { clientCode: 'UPLOADX12' },
        {
          fieldName: 'file',
          filename: 'synthetic-837.837',
          contentType: 'application/octet-stream',
          content: readFileSync(join(FIXTURES_DIR, 'synthetic-837.837'))
        }
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/import/upload',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        payload: body
      })
      expect(res.statusCode).toBe(200)
      const { job } = res.json() as { job: { status: string; sourceType: string } }
      expect(job.status).toBe('succeeded')
      expect(job.sourceType).toBe('x12-837')
    })

    it('rejects an unauthenticated upload', async () => {
      const { body, contentType } = buildMultipartBody(
        { clientCode: 'NOPE' },
        {
          fieldName: 'file',
          filename: 'x.csv',
          contentType: 'text/csv',
          content: Buffer.from('a,b\n1,2\n')
        }
      )
      const res = await app.inject({
        method: 'POST',
        url: '/api/import/upload',
        headers: { 'content-type': contentType },
        payload: body
      })
      expect(res.statusCode).toBe(401)
    })

    it('400s a CSV upload with no templateId', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/rpc/createClient',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: 'NOTMPL', name: 'No Template Co' }
      })
      const { body, contentType } = buildMultipartBody(
        { clientCode: 'NOTMPL' },
        {
          fieldName: 'file',
          filename: 'tebra-claim-export.csv',
          contentType: 'text/csv',
          content: readFileSync(join(FIXTURES_DIR, 'tebra-claim-export.csv'))
        }
      )
      const res = await app.inject({
        method: 'POST',
        url: '/api/import/upload',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        payload: body
      })
      expect(res.statusCode).toBe(400)
    })
  })
})
