/**
 * `RemoteDataService` tests (Phase 3 chunk E) — against a real Fastify
 * server (`server/src/app.ts`) actually listening on an ephemeral local
 * port (unlike `test/server-api.test.ts`'s `.inject()`, `RemoteDataService`
 * uses the real global `fetch`, which needs a real socket to hit), backed
 * by a real temp DuckDB/SQLite pair.
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDataService } from '../src/main/services/local-data-service'
import { buildServer } from '../server/src/app'
import { openUsersDb, createUser } from '../server/src/auth/users-db'
import { hashPassword } from '../server/src/auth/auth-plugin'
import {
  RemoteDataService,
  RemoteDataServiceError,
  testRemoteConnection
} from '../src/main/services/remote-data-service'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')
const USERNAME = 'bob'
const PASSWORD = 'super-secret-password'

async function startServer(
  dbDir: string,
  service: LocalDataService,
  usersDb: Database.Database,
  jwtExpiresIn = '30m'
): Promise<{ app: FastifyInstance; baseUrl: string }> {
  const app = await buildServer({
    dataService: service,
    usersDb,
    jwtSecret: 'test-secret-not-for-production',
    jwtExpiresIn,
    uploadsDir: join(dbDir, 'uploads'),
    logger: false
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo
  return { app, baseUrl: `http://127.0.0.1:${port}` }
}

describe('RemoteDataService', () => {
  let dbDir: string
  let service: LocalDataService
  let usersDb: Database.Database
  let app: FastifyInstance
  let baseUrl: string

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'aethera-remote-ds-test-'))
    service = await LocalDataService.create({
      duckdbPath: join(dbDir, 'analytics.duckdb'),
      metaDbPath: join(dbDir, 'meta.db'),
      backupsDir: join(dbDir, 'backups')
    })
    usersDb = openUsersDb(dbDir)
    createUser(usersDb, USERNAME, await hashPassword(PASSWORD))
    ;({ app, baseUrl } = await startServer(dbDir, service, usersDb))
  })

  afterEach(async () => {
    await app.close()
    service.close()
    usersDb.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  describe('login / connectivity', () => {
    it('testRemoteConnection reports ok for correct credentials', async () => {
      const result = await testRemoteConnection({ baseUrl, username: USERNAME, password: PASSWORD })
      expect(result.ok).toBe(true)
    })

    it('testRemoteConnection reports a clean failure for a wrong password', async () => {
      const result = await testRemoteConnection({ baseUrl, username: USERNAME, password: 'nope' })
      expect(result.ok).toBe(false)
      expect(result.message).toBeTruthy()
    })

    it('surfaces a clear error (not a raw fetch TypeError) when the server is unreachable', async () => {
      const remote = new RemoteDataService({
        baseUrl: 'http://127.0.0.1:1', // nothing listens on port 1 — connection refused, fast
        username: USERNAME,
        password: PASSWORD
      })
      await expect(remote.listClients()).rejects.toThrow(RemoteDataServiceError)
      await expect(remote.listClients()).rejects.toThrow(/could not reach the server/i)
    })

    it('throws a RemoteDataServiceError for a wrong password on first use', async () => {
      const remote = new RemoteDataService({ baseUrl, username: USERNAME, password: 'wrong' })
      await expect(remote.listClients()).rejects.toThrow(RemoteDataServiceError)
    })
  })

  describe('IDataService surface over HTTP', () => {
    it('round-trips client CRUD', async () => {
      const remote = new RemoteDataService({ baseUrl, username: USERNAME, password: PASSWORD })

      const created = await remote.createClient({ code: 'REMOTECO', name: 'Remote Co' })
      expect(created.code).toBe('REMOTECO')

      const list = await remote.listClients()
      expect(list.map((c) => c.code)).toContain('REMOTECO')

      const found = await remote.getClientByCode('REMOTECO')
      expect(found?.clientId).toBe(created.clientId)

      const updated = await remote.updateClient(created.clientId, { contractRate: 0.07 })
      expect(updated.contractRate).toBeCloseTo(0.07)

      const deactivated = await remote.deactivateClient(created.clientId)
      expect(deactivated.active).toBe(false)
    })

    it('detects a local file kind without any network call (still works against an unreachable server)', async () => {
      const remote = new RemoteDataService({
        baseUrl: 'http://127.0.0.1:1',
        username: USERNAME,
        password: PASSWORD
      })
      const kind = await remote.detectImportFileKind(join(FIXTURES_DIR, 'tebra-claim-export.csv'))
      expect(kind).toBe('csv')
      const x12Kind = await remote.detectImportFileKind(join(FIXTURES_DIR, 'synthetic-837.837'))
      expect(x12Kind).toBe('x12-837')
    })

    it('previews an X12 file locally, with real parsed counts, without any network call', async () => {
      const remote = new RemoteDataService({
        baseUrl: 'http://127.0.0.1:1',
        username: USERNAME,
        password: PASSWORD
      })
      const summary = await remote.previewX12Import(join(FIXTURES_DIR, 'synthetic-837.837'))
      expect(summary.kind).toBe('837')
      expect(summary.claimsCount).toBeGreaterThan(0)
    })

    it('runCsvImport uploads the local file and returns the resulting job', async () => {
      const remote = new RemoteDataService({ baseUrl, username: USERNAME, password: PASSWORD })
      await remote.createClient({ code: 'REMOTEIMP', name: 'Remote Import Co' })

      const job = await remote.runCsvImport({
        filePath: join(FIXTURES_DIR, 'tebra-claim-export.csv'),
        templateId: 'tebra-claim-export',
        clientCode: 'REMOTEIMP'
      })
      expect(job.status).toBe('succeeded')
      expect(job.rowsLoaded).toBeGreaterThan(0)

      const jobs = await remote.listImportJobs()
      expect(jobs.some((j) => j.jobId === job.jobId)).toBe(true)
    })

    it('runX12Import uploads the local file and auto-detects it server-side', async () => {
      const remote = new RemoteDataService({ baseUrl, username: USERNAME, password: PASSWORD })
      await remote.createClient({ code: 'REMOTEX12', name: 'Remote X12 Co' })

      const job = await remote.runX12Import({
        filePath: join(FIXTURES_DIR, 'synthetic-837.837'),
        clientCode: 'REMOTEX12'
      })
      expect(job.status).toBe('succeeded')
      expect(job.sourceType).toBe('x12-837')
    })

    it('reads maintenance/analytics endpoints', async () => {
      const remote = new RemoteDataService({ baseUrl, username: USERNAME, password: PASSWORD })
      const backupStatus = await remote.getBackupStatus()
      expect(typeof backupStatus.backupCount).toBe('number')

      const arRows = await remote.getArAgingByClient()
      expect(arRows).toEqual([])

      const branding = await remote.getBranding()
      expect(branding.firmName).toBeTruthy()
    })

    it('close() clears the token but the service transparently re-logs-in on the next call', async () => {
      const remote = new RemoteDataService({ baseUrl, username: USERNAME, password: PASSWORD })
      await remote.listClients()
      remote.close()
      const clients = await remote.listClients()
      expect(Array.isArray(clients)).toBe(true)
    })

    it('setBrandingLogoPath throws a clear "Local mode only" error rather than silently no-op-ing', async () => {
      const remote = new RemoteDataService({ baseUrl, username: USERNAME, password: PASSWORD })
      await expect(remote.setBrandingLogoPath()).rejects.toThrow(/local data mode/i)
    })
  })

  describe('token refresh on 401', () => {
    it('re-logs-in transparently once the JWT has expired', async () => {
      await app.close() // replace with a short-lived-token server for this one test
      // Long enough that the retry's freshly-issued token is still valid
      // for the few milliseconds it takes to use it, short enough to
      // reliably expire within this test's own wall-clock wait below.
      ;({ app, baseUrl } = await startServer(dbDir, service, usersDb, '750ms'))

      const remote = new RemoteDataService({ baseUrl, username: USERNAME, password: PASSWORD })
      await remote.createClient({ code: 'EXPIRECO', name: 'Expiry Co' }) // issues the first token
      await new Promise((resolve) => setTimeout(resolve, 900)) // let that first token expire

      // Without token-refresh-on-401 this would throw; with it, it just
      // works — RemoteDataService re-logs-in on the 401 and retries once.
      const clients = await remote.listClients()
      expect(clients.map((c) => c.code)).toContain('EXPIRECO')
    })
  })
})
