/**
 * Staff auth (Phase 3 chunk E): bcrypt password hashing, a
 * `POST /api/auth/login` route issuing a short-lived JWT, and an
 * `authenticate` decorator every `/api/rpc/*` and `/api/import/*` route
 * requires (wired in `app.ts`). Login is rate-limited (plan: "Rate-limit
 * login") tighter than the server's general request rate.
 */
import bcrypt from 'bcryptjs'
import fastifyJwt from '@fastify/jwt'
import fp from 'fastify-plugin'
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type Database from 'better-sqlite3'
import { findUserByUsername } from './users-db'

/** bcrypt's own recommended-minimum-ish cost for a server that isn't hashing at huge scale — a login is an infrequent, human-paced action, so this can afford to be deliberately slow. */
const BCRYPT_ROUNDS = 12

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash)
}

const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
})

export interface AuthPluginOptions {
  usersDb: Database.Database
  jwtSecret: string
  jwtExpiresIn: string
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { username: string; userId: number }
    user: { username: string; userId: number }
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** `onRequest` hook: 401s unless a valid, unexpired JWT is present. Register on any route/scope that needs auth — see `app.ts`. */
    authenticate: (request: import('fastify').FastifyRequest) => Promise<void>
  }
}

const authPluginImpl: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  await app.register(fastifyJwt, {
    secret: opts.jwtSecret,
    sign: { expiresIn: opts.jwtExpiresIn }
  })

  app.decorate('authenticate', async (request) => {
    // Throws (and the default error handler turns that into a 401) when
    // the token is missing, malformed, or expired — the desktop's
    // `RemoteDataService` treats any 401 as "log in again."
    await request.jwtVerify()
  })

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = loginRequestSchema.parse(request.body)
      const user = findUserByUsername(opts.usersDb, body.username)
      const passwordOk = user ? await verifyPassword(body.password, user.passwordHash) : false
      // Constant-shaped response regardless of whether the username or
      // the password was wrong — never reveal which one failed.
      if (!user || !passwordOk) {
        reply.code(401)
        return { error: 'Invalid username or password.' }
      }
      const token = await reply.jwtSign({ username: user.username, userId: user.userId })
      return { token, username: user.username, expiresIn: opts.jwtExpiresIn }
    }
  )
}

export const authPlugin = fp(authPluginImpl, { name: 'aethera-auth' })
