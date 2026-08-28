/**
 * Shared server mode end-to-end check (Phase 3 chunk E): starts the real
 * Fastify server on an ephemeral port against a temp data dir, seeds a
 * user, then drives `RemoteDataService` (the same class the desktop app
 * uses in "Data mode: Server") through client CRUD + a CSV import + a
 * `buildClientReport` call — over real HTTP, real auth, no mocks — and
 * asserts the result matches a plain `LocalDataService` doing the exact
 * same sequence against the exact same fixture. That parity is the whole
 * point of the `IDataService` seam: the UI/exporters/automation can't
 * tell which one they're talking to.
 *
 * Run with: npm run e2e:server-mode
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deepStrictEqual as assertDeepStrictEqual } from 'node:assert'
import type { AddressInfo } from 'node:net'
import { LocalDataService } from '../src/main/services/local-data-service'
import { RemoteDataService } from '../src/main/services/remote-data-service'
import { buildServer } from '../server/src/app'
import { openUsersDb, createUser } from '../server/src/auth/users-db'
import { hashPassword } from '../server/src/auth/auth-plugin'
import type { ClientReport } from '../src/shared/domain'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')
const USERNAME = 'e2e-server-mode'
const PASSWORD = 'e2e-server-mode-password'
const CLIENT_CODE = 'SRVMODE'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[e2e-server-mode] ASSERTION FAILED: ${message}`)
}

function currentPeriodMonth(): string {
  // `claims.first_submitted_at` is set to import wall-clock time (not the
  // fixture's date-of-service column), so both services are asked for
  // whatever month it is right now.
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The subset of `ClientReport` worth diffing for parity — everything that doesn't depend on incidental IDs/timestamps that legitimately differ between two independent databases. */
function comparableReportFields(report: ClientReport): unknown {
  return {
    client: { code: report.client.code, name: report.client.name },
    source: report.source,
    volume: report.volume,
    financials: report.financials,
    kpis: report.kpis,
    arAging: report.arAging,
    denialsByRootCause: report.denialsByRootCause,
    claimsByStatus: report.claimsByStatus
  }
}

async function main(): Promise<void> {
  const serverDataDir = mkdtempSync(join(tmpdir(), 'aethera-e2e-server-mode-srv-'))
  const localDataDir = mkdtempSync(join(tmpdir(), 'aethera-e2e-server-mode-local-'))
  console.log(`[e2e-server-mode] server data dir: ${serverDataDir}`)
  console.log(`[e2e-server-mode] local data dir (parity baseline): ${localDataDir}`)

  const serverDataService = await LocalDataService.create({
    duckdbPath: join(serverDataDir, 'analytics.duckdb'),
    metaDbPath: join(serverDataDir, 'meta.db'),
    backupsDir: join(serverDataDir, 'backups')
  })
  const usersDb = openUsersDb(serverDataDir)
  createUser(usersDb, USERNAME, await hashPassword(PASSWORD))

  const app = await buildServer({
    dataService: serverDataService,
    usersDb,
    jwtSecret: 'e2e-server-mode-secret',
    jwtExpiresIn: '10m',
    uploadsDir: join(serverDataDir, 'uploads'),
    logger: false
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`[e2e-server-mode] server listening at ${baseUrl}`)

  const localBaselineService = await LocalDataService.create({
    duckdbPath: join(localDataDir, 'analytics.duckdb'),
    metaDbPath: join(localDataDir, 'meta.db'),
    backupsDir: join(localDataDir, 'backups')
  })

  try {
    const remote = new RemoteDataService({ baseUrl, username: USERNAME, password: PASSWORD })

    console.log('[e2e-server-mode] creating the same client on both services...')
    const remoteClient = await remote.createClient({ code: CLIENT_CODE, name: 'Server Mode Co' })
    const localClient = await localBaselineService.createClient({
      code: CLIENT_CODE,
      name: 'Server Mode Co'
    })
    assert(remoteClient.code === localClient.code, 'client codes should match')

    console.log('[e2e-server-mode] importing the same CSV fixture on both services...')
    const csvPath = join(FIXTURES_DIR, 'tebra-claim-export.csv')
    const remoteJob = await remote.runCsvImport({
      filePath: csvPath,
      templateId: 'tebra-claim-export',
      clientCode: CLIENT_CODE
    })
    const localJob = await localBaselineService.runCsvImport({
      filePath: csvPath,
      templateId: 'tebra-claim-export',
      clientCode: CLIENT_CODE
    })
    console.log(`  remote: ${remoteJob.status}, ${remoteJob.rowsLoaded} rows loaded`)
    console.log(`  local:  ${localJob.status}, ${localJob.rowsLoaded} rows loaded`)
    assert(remoteJob.status === 'succeeded', 'remote import should succeed')
    assert(localJob.status === 'succeeded', 'local import should succeed')
    assert(
      remoteJob.rowsLoaded === localJob.rowsLoaded,
      `rowsLoaded should match (remote=${remoteJob.rowsLoaded}, local=${localJob.rowsLoaded})`
    )

    console.log('[e2e-server-mode] building the same client report on both services...')
    const period = currentPeriodMonth()
    const remoteReport = await remote.buildClientReport(remoteClient.clientId, period)
    const localReport = await localBaselineService.buildClientReport(localClient.clientId, period)

    const remoteComparable = comparableReportFields(remoteReport)
    const localComparable = comparableReportFields(localReport)
    try {
      // Deep-equal, not a JSON-string diff: `claimsByStatus`'s GROUP BY
      // has no ORDER BY, so its key order isn't guaranteed to match
      // between two independently-populated databases even when its
      // contents are identical — a naive string compare would be a false
      // positive for parity failures on every unordered field.
      assertDeepStrictEqual(remoteComparable, localComparable)
    } catch (error) {
      console.error('  REMOTE:', JSON.stringify(remoteComparable, null, 2))
      console.error('  LOCAL: ', JSON.stringify(localComparable, null, 2))
      throw new Error(
        `[e2e-server-mode] ASSERTION FAILED: report fields diverged between Remote and Local: ${error instanceof Error ? error.message : error}`
      )
    }
    console.log(
      `  parity OK — ${remoteReport.volume.claimsSubmitted} claim(s), source=${remoteReport.source}`
    )
    assert(remoteReport.volume.claimsSubmitted > 0, 'the report should reflect the imported claims')

    console.log(
      '[e2e-server-mode] verifying an unauthenticated/unreachable RemoteDataService fails cleanly...'
    )
    const badRemote = new RemoteDataService({
      baseUrl: `http://127.0.0.1:${port}`,
      username: USERNAME,
      password: 'wrong-password'
    })
    let threw = false
    try {
      await badRemote.listClients()
    } catch (error) {
      threw = true
      console.log(
        `  got the expected clean error: ${error instanceof Error ? error.message : error}`
      )
    }
    assert(threw, 'a wrong password should throw, not silently return data')

    console.log('\n[e2e-server-mode] all checks passed')
  } finally {
    await app.close()
    serverDataService.close()
    localBaselineService.close()
    usersDb.close()
    rmSync(serverDataDir, { recursive: true, force: true })
    rmSync(localDataDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error('[e2e-server-mode] FAILED:', error)
  process.exitCode = 1
})
