/**
 * Hono app tests (plan: "admin auth rejection"; "page rendering smoke
 * (HTML contains expected numbers, no external URLs)"; expired/revoked
 * -> 403). Runs entirely under plain Node/vitest via `app.request()` —
 * no Workers runtime, Miniflare, or real network involved.
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type Env } from '../src/app'
import { createSqliteD1Double, applyPortalSchema } from '../src/db-sqlite-double'
import type { ClientReport } from '../../src/shared/domain'

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8')
const ADMIN_TOKEN = 'test-admin-token-not-for-production'
const SESSION_SECRET = 'test-session-secret-not-for-production'

function makeReport(overrides: Partial<ClientReport> = {}): ClientReport {
  return {
    client: { code: 'ACME', name: 'Acme Health', contract: '5% of collections' },
    period: { start: '2026-01-01', end: '2026-01-31' },
    source: 'claims',
    volume: { encountersReceived: 10, claimsSubmitted: 10, denialsReceived: 2 },
    financials: {
      grossCharges: 40911.89,
      insuranceCollections: 6000,
      patientCollections: 1000,
      totalCollections: 7000,
      rcmFee: 350,
      netCollectionRatePct: 70
    },
    kpis: {
      daysInAr: 32.5,
      openAr: 3000,
      arOver90Pct: 5.2,
      chargeLagDaysAvg: 2.1,
      slaDaysToSubmit: 5,
      slaMetPct: 90,
      firstPassAcceptancePct: 88,
      denialRatePct: 20
    },
    arAging: { '0-30': 2000, '31-60': 500, '61-90': 300, '91-120': 100, '120+': 100 },
    kpiTrends: { series: [], latest: null, deltas: {} },
    denialsByRootCause: { CODING: 2 },
    claimsByStatus: { Paid: 8, Denied: 2 },
    payerMix: [{ payerName: 'Aetna', charges: 5000 }],
    benchmark: null,
    ...overrides
  }
}

function extractCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? ''
  const [firstPair] = setCookie.split(';')
  return firstPair
}

describe('portal Hono app', () => {
  let sqlite: Database.Database
  let env: Env
  let app: ReturnType<typeof buildApp>

  beforeEach(() => {
    sqlite = new Database(':memory:')
    applyPortalSchema(sqlite, SCHEMA_SQL)
    env = { DB: createSqliteD1Double(sqlite), ADMIN_TOKEN, SESSION_SECRET }
    app = buildApp()
  })

  afterEach(() => {
    sqlite.close()
  })

  describe('admin auth', () => {
    it('rejects a request with no Authorization header', async () => {
      const res = await app.request('/admin/status', {}, env)
      expect(res.status).toBe(401)
    })

    it('rejects a request with the wrong token', async () => {
      const res = await app.request(
        '/admin/status',
        { headers: { Authorization: 'Bearer wrong-token' } },
        env
      )
      expect(res.status).toBe(401)
    })

    it('accepts the correct token', async () => {
      const res = await app.request(
        '/admin/status',
        { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
        env
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; snapshotCount: number }
      expect(body).toMatchObject({ ok: true, snapshotCount: 0 })
    })
  })

  describe('POST /admin/snapshots', () => {
    it('publishes a snapshot', async () => {
      const res = await app.request(
        '/admin/snapshots',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientCode: 'ACME', period: '2026-01', report: makeReport() })
        },
        env
      )
      expect(res.status).toBe(200)

      const status = await app.request(
        '/admin/status',
        { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
        env
      )
      expect((await status.json()) as { snapshotCount: number }).toMatchObject({ snapshotCount: 1 })
    })

    it('400s a malformed report body', async () => {
      const res = await app.request(
        '/admin/snapshots',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientCode: 'ACME', period: '2026-01', report: { bad: true } })
        },
        env
      )
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /admin/snapshots/:clientCode/:period', () => {
    it('revokes a published snapshot', async () => {
      await app.request(
        '/admin/snapshots',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientCode: 'ACME', period: '2026-01', report: makeReport() })
        },
        env
      )
      const del = await app.request(
        '/admin/snapshots/ACME/2026-01',
        { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
        env
      )
      expect(del.status).toBe(200)

      const status = await app.request(
        '/admin/status',
        { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
        env
      )
      expect((await status.json()) as { snapshotCount: number }).toMatchObject({ snapshotCount: 0 })
    })
  })

  describe('POST /admin/links + /r/:token', () => {
    async function mintLink(): Promise<{ token: string; url: string }> {
      const res = await app.request(
        '/admin/links',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientCode: 'ACME', email: 'billing@acme.example' })
        },
        env
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { url: string; expiresAt: string }
      const token = new URL(body.url).pathname.split('/').pop()!
      return { token, url: body.url }
    }

    it('mints a link whose URL is same-origin (no external URLs)', async () => {
      const { url } = await mintLink()
      expect(url.startsWith('http://localhost')).toBe(true)
    })

    it('a valid token sets a session cookie and redirects to the report list', async () => {
      const { token } = await mintLink()
      const res = await app.request(`/r/${token}`, { redirect: 'manual' }, env)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/portal/ACME')
      const cookieHeader = res.headers.get('set-cookie') ?? ''
      expect(cookieHeader).toContain('HttpOnly')
      // The raw token must never be reflected into the response (redirect
      // location, cookie, or body) — the security review's specific ask.
      expect(res.headers.get('location') ?? '').not.toContain(token)
      expect(cookieHeader).not.toContain(token)
    })

    it('an unknown token is rejected with 403 and a friendly page, never reflecting the token', async () => {
      const res = await app.request('/r/not-a-real-token-at-all', {}, env)
      expect(res.status).toBe(403)
      const html = await res.text()
      expect(html).toContain('expired')
      expect(html).not.toContain('not-a-real-token-at-all')
    })

    it('a revoked token is rejected with 403', async () => {
      const { token } = await mintLink()
      await app.request(
        '/admin/links/revoke',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientCode: 'ACME', email: 'billing@acme.example' })
        },
        env
      )
      const res = await app.request(`/r/${token}`, {}, env)
      expect(res.status).toBe(403)
    })

    it('full flow: mint link -> follow to session -> list periods -> view report with real numbers', async () => {
      await app.request(
        '/admin/snapshots',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientCode: 'ACME', period: '2026-01', report: makeReport() })
        },
        env
      )
      const { token } = await mintLink()

      const redirectRes = await app.request(`/r/${token}`, { redirect: 'manual' }, env)
      const cookie = extractCookie(redirectRes)

      const listRes = await app.request('/portal/ACME', { headers: { Cookie: cookie } }, env)
      expect(listRes.status).toBe(200)
      const listHtml = await listRes.text()
      expect(listHtml).toContain('2026-01')
      expect(listHtml).toContain('noindex')
      expect(listHtml.replace(/http:\/\/www.w3.org\/2000\/svg/g, '')).not.toMatch(
        /https?:\/\/(?!localhost)/
      ) // no external URLs (the SVG xmlns namespace URI isn't a fetched resource)

      const reportRes = await app.request(
        '/portal/ACME/2026-01',
        { headers: { Cookie: cookie } },
        env
      )
      expect(reportRes.status).toBe(200)
      const reportHtml = await reportRes.text()
      expect(reportHtml).toContain('Acme Health')
      expect(reportHtml).toContain('$40,912') // grossCharges, currency-formatted, rounded
      expect(reportHtml).toContain('CODING')
      expect(reportHtml.replace(/http:\/\/www.w3.org\/2000\/svg/g, '')).not.toMatch(
        /https?:\/\/(?!localhost)/
      )
      expect(reportHtml).toContain('<svg')
      expect(reportHtml).not.toContain('<script')
    })

    it('a report page request without a valid session cookie is rejected with 403', async () => {
      await app.request(
        '/admin/snapshots',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientCode: 'ACME', period: '2026-01', report: makeReport() })
        },
        env
      )
      const res = await app.request('/portal/ACME/2026-01', {}, env)
      expect(res.status).toBe(403)
    })

    it("a session cookie for one client cannot view another client's report", async () => {
      await app.request(
        '/admin/snapshots',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientCode: 'OTHERCO',
            period: '2026-01',
            report: makeReport({
              client: { code: 'OTHERCO', name: 'Other Co', contract: 'flat fee' }
            })
          })
        },
        env
      )
      const { token } = await mintLink() // minted for ACME
      const redirectRes = await app.request(`/r/${token}`, { redirect: 'manual' }, env)
      const cookie = extractCookie(redirectRes)

      const res = await app.request('/portal/OTHERCO/2026-01', { headers: { Cookie: cookie } }, env)
      expect(res.status).toBe(403)
    })
  })

  describe('security headers', () => {
    it('sets noindex/CSP/no-script headers on every response', async () => {
      const res = await app.request('/r/whatever', {}, env)
      expect(res.headers.get('x-robots-tag')).toContain('noindex')
      expect(res.headers.get('content-security-policy')).toContain("script-src 'none'")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    })
  })
})
