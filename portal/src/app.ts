/**
 * The portal Worker's Hono app (plan's Phase 3 addendum, chunk F).
 * `buildApp()` takes no bindings itself — every route reads `c.env` at
 * request time — so tests build one `Hono` instance and call
 * `app.request(path, init, env)` directly (Hono is runtime-agnostic;
 * this needs no Workers runtime, Miniflare, or `@cloudflare/vitest-pool-workers`
 * at all — see test/portal-app.test.ts).
 */
import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { requireAdminAuth } from './admin-auth'
import {
  publishSnapshot,
  getSnapshot,
  listSnapshotsForClient,
  revokeSnapshot,
  countSnapshots
} from './snapshots'
import {
  mintToken,
  revokeTokensForRecipient,
  validateToken,
  countActiveTokens,
  DEFAULT_LINK_TTL_DAYS
} from './tokens'
import { createSessionCookieValue, verifySessionCookieValue } from './session'
import { renderLinkExpiredPage, renderReportListPage, renderReportPage } from './render'
import type { D1Like } from './db'

export interface Env {
  DB: D1Like
  ADMIN_TOKEN: string
  SESSION_SECRET: string
}

const SESSION_COOKIE_NAME = 'portal_session'
const SESSION_TTL_MS = 60 * 60 * 1000 // 1 hour — refreshed on every valid /r/:token visit and page view.

type AppEnv = { Bindings: Env }

function securityHeaders(): Record<string, string> {
  return {
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY'
  }
}

export function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    await next()
    for (const [key, value] of Object.entries(securityHeaders())) c.header(key, value)
  })

  // -------------------------------------------------------------------
  // Admin API
  // -------------------------------------------------------------------
  const admin = new Hono<AppEnv>()
  admin.use('*', requireAdminAuth<AppEnv>())

  admin.post('/snapshots', async (c) => {
    let body: { clientCode?: unknown; period?: unknown; report?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400)
    }
    if (typeof body.clientCode !== 'string' || typeof body.period !== 'string' || !body.report) {
      return c.json({ error: 'clientCode, period, and report are required.' }, 400)
    }
    try {
      await publishSnapshot(c.env.DB, body.clientCode, body.period, body.report, new Date())
    } catch (error) {
      return c.json(
        {
          error: `report did not match the expected ClientReport shape: ${error instanceof Error ? error.message : String(error)}`
        },
        400
      )
    }
    return c.json({ ok: true })
  })

  admin.delete('/snapshots/:clientCode/:period', async (c) => {
    await revokeSnapshot(c.env.DB, c.req.param('clientCode'), c.req.param('period'))
    return c.json({ ok: true })
  })

  admin.post('/links', async (c) => {
    let body: { clientCode?: unknown; email?: unknown; ttlDays?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400)
    }
    if (typeof body.clientCode !== 'string' || typeof body.email !== 'string') {
      return c.json({ error: 'clientCode and email are required.' }, 400)
    }
    const ttlDays =
      typeof body.ttlDays === 'number' && body.ttlDays > 0 ? body.ttlDays : DEFAULT_LINK_TTL_DAYS
    const minted = await mintToken(c.env.DB, body.clientCode, body.email, ttlDays, new Date())
    const origin = new URL(c.req.url).origin
    return c.json({ url: `${origin}/r/${minted.token}`, expiresAt: minted.expiresAt })
  })

  admin.post('/links/revoke', async (c) => {
    let body: { clientCode?: unknown; email?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400)
    }
    if (typeof body.clientCode !== 'string' || typeof body.email !== 'string') {
      return c.json({ error: 'clientCode and email are required.' }, 400)
    }
    const revokedCount = await revokeTokensForRecipient(c.env.DB, body.clientCode, body.email)
    return c.json({ ok: true, revokedCount })
  })

  admin.get('/status', async (c) => {
    const now = new Date()
    const [snapshotCount, activeTokenCount] = await Promise.all([
      countSnapshots(c.env.DB),
      countActiveTokens(c.env.DB, now)
    ])
    return c.json({ ok: true, snapshotCount, activeTokenCount })
  })

  app.route('/admin', admin)

  // -------------------------------------------------------------------
  // Client-facing pages
  // -------------------------------------------------------------------

  /** Validates the magic link, sets a session cookie, and redirects — the raw token is a URL path segment consumed here and NEVER reflected back into any response body/cookie/header (the security review's specific ask). */
  app.get('/r/:token', async (c) => {
    const token = c.req.param('token')
    const result = await validateToken(c.env.DB, token, new Date())
    if (!result.ok) {
      return c.html(renderLinkExpiredPage(), 403)
    }

    const sessionValue = await createSessionCookieValue(
      c.env.SESSION_SECRET,
      result.clientCode,
      SESSION_TTL_MS,
      new Date()
    )
    setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000
    })
    return c.redirect(`/portal/${encodeURIComponent(result.clientCode)}`, 302)
  })

  async function requireSessionForClient(c: Context<AppEnv>, clientCode: string): Promise<boolean> {
    const cookieValue = getCookie(c, SESSION_COOKIE_NAME)
    if (!cookieValue) return false
    const sessionClientCode = await verifySessionCookieValue(
      c.env.SESSION_SECRET,
      cookieValue,
      new Date()
    )
    return sessionClientCode === clientCode
  }

  app.get('/portal/:clientCode', async (c) => {
    const clientCode = c.req.param('clientCode')
    if (!(await requireSessionForClient(c, clientCode))) {
      return c.html(renderLinkExpiredPage(), 403)
    }
    const snapshots = await listSnapshotsForClient(c.env.DB, clientCode)
    return c.html(renderReportListPage(clientCode, snapshots))
  })

  app.get('/portal/:clientCode/:period', async (c) => {
    const clientCode = c.req.param('clientCode')
    const period = c.req.param('period')
    if (!(await requireSessionForClient(c, clientCode))) {
      return c.html(renderLinkExpiredPage(), 403)
    }
    const snapshot = await getSnapshot(c.env.DB, clientCode, period)
    if (!snapshot) return c.html(renderLinkExpiredPage(), 403)
    return c.html(renderReportPage(snapshot.report, snapshot.publishedAt))
  })

  return app
}
