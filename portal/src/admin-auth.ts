/**
 * Bearer-token auth for `/admin/*` (plan: "Admin API (Bearer token via
 * Worker secret)"). Uses `constantTimeStringEqual` rather than `===` —
 * a naive comparison of the presented token against `env.ADMIN_TOKEN`
 * is exactly the kind of timing side-channel the security review asked
 * to guard against here too, not just the magic-link tokens.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { constantTimeStringEqual } from './crypto-utils'

export interface AdminAuthEnv {
  ADMIN_TOKEN: string
}

export function requireAdminAuth<E extends { Bindings: AdminAuthEnv }>(): MiddlewareHandler<E> {
  return async (c: Context<E>, next) => {
    const configuredToken = c.env.ADMIN_TOKEN
    const header = c.req.header('Authorization') ?? ''
    const presentedToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null

    if (
      !configuredToken ||
      !presentedToken ||
      !(await constantTimeStringEqual(presentedToken, configuredToken))
    ) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  }
}
