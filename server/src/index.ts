/**
 * Server entry point (Phase 3 chunk E). Run with:
 *   npm run server            (dev, foreground)
 *   npx vite-node server/src/index.ts   (equivalent, what the Dockerfile runs)
 *
 * Opens its OWN `analytics.duckdb` + `meta.db` under `AETHERA_SERVER_DATA_DIR`
 * (default `./server-data`) via the exact same `LocalDataService` the
 * desktop app uses — see `docs/server-mode.md` for every env var.
 */
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { LocalDataService } from '../../src/main/services/local-data-service'
import { loadServerConfig } from './config'
import { openUsersDb, countUsers } from './auth/users-db'
import { buildServer } from './app'

async function main(): Promise<void> {
  const config = loadServerConfig()
  const uploadsDir = join(config.dataDir, 'uploads')
  mkdirSync(uploadsDir, { recursive: true })

  console.log(`[server] data dir: ${config.dataDir}`)

  const dataService = await LocalDataService.create({
    duckdbPath: join(config.dataDir, 'analytics.duckdb'),
    metaDbPath: join(config.dataDir, 'meta.db'),
    backupsDir: join(config.dataDir, 'backups')
  })
  const usersDb = openUsersDb(config.dataDir)

  if (countUsers(usersDb) === 0) {
    console.warn(
      '[server] no users exist yet — seed one with: ' +
        'npm run server:user -- add <username> <password>'
    )
  }

  const app = await buildServer({
    dataService,
    usersDb,
    jwtSecret: config.jwtSecret,
    jwtExpiresIn: config.jwtExpiresIn,
    uploadsDir
  })

  await app.listen({ host: config.host, port: config.port })
  console.log(`[server] listening on http://${config.host}:${config.port}`)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[server] received ${signal}, shutting down...`)
    try {
      await app.close()
    } finally {
      dataService.close()
      usersDb.close()
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  console.error('[server] fatal startup error:', error)
  process.exitCode = 1
})
