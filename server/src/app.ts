/**
 * Builds (but does not `listen()`) the Fastify app — a factory so tests
 * can exercise the exact same route wiring via `.inject()` (no network,
 * "supertest-style" per the chunk E test requirement) that `index.ts`
 * actually serves.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import type Database from 'better-sqlite3'
import { authPlugin } from './auth/auth-plugin'
import { registerRpcRoutes } from './rpc-route'
import { registerUploadRoutes } from './upload-route'
import type { IDataService } from '../../src/main/services/data-service'

export interface BuildServerOptions {
  dataService: IDataService
  usersDb: Database.Database
  jwtSecret: string
  jwtExpiresIn: string
  uploadsDir: string
  /** Default `true`; tests pass `false` to keep vitest output quiet. */
  logger?: boolean
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024 // 200 MB — comfortably above any realistic single claim-export CSV/835/837.

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true })

  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } })
  await app.register(authPlugin, {
    usersDb: opts.usersDb,
    jwtSecret: opts.jwtSecret,
    jwtExpiresIn: opts.jwtExpiresIn
  })

  // Unauthenticated: a load balancer / docker healthcheck / Uptime Kuma
  // probe shouldn't need credentials to know the process is alive.
  app.get('/health', async () => ({ ok: true }))

  // Everything else requires a valid JWT (plan: "all endpoints authed").
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', protectedScope.authenticate)
    registerRpcRoutes(protectedScope, opts.dataService)
    registerUploadRoutes(protectedScope, opts.dataService, opts.uploadsDir)
  })

  return app
}
