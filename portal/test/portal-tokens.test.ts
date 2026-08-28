/**
 * Magic-link token lifecycle tests (plan: "token mint/validate/expiry/revoke").
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1Double, applyPortalSchema } from '../src/db-sqlite-double'
import {
  countActiveTokens,
  mintToken,
  revokeTokensForRecipient,
  validateToken
} from '../src/tokens'
import type { D1Like } from '../src/db'

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8')

describe('tokens', () => {
  let sqlite: Database.Database
  let db: D1Like

  beforeEach(() => {
    sqlite = new Database(':memory:')
    applyPortalSchema(sqlite, SCHEMA_SQL)
    db = createSqliteD1Double(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('mints a token and validates it successfully', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const minted = await mintToken(db, 'ACME', 'billing@acme.example', 30, now)
    expect(minted.token).toMatch(/^[0-9a-f]{64}$/)
    expect(minted.expiresAt).toBe('2026-01-31T00:00:00.000Z')

    const result = await validateToken(db, minted.token, now)
    expect(result).toEqual({ ok: true, clientCode: 'ACME', email: 'billing@acme.example' })
  })

  it('rejects an unknown token', async () => {
    const result = await validateToken(db, 'not-a-real-token', new Date())
    expect(result).toEqual({ ok: false, reason: 'not-found' })
  })

  it('rejects an expired token', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const minted = await mintToken(db, 'ACME', 'billing@acme.example', 1, now)
    const later = new Date('2026-01-03T00:00:00Z') // 2 days later, past the 1-day TTL
    const result = await validateToken(db, minted.token, later)
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a revoked token', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const minted = await mintToken(db, 'ACME', 'billing@acme.example', 30, now)
    const revokedCount = await revokeTokensForRecipient(db, 'ACME', 'billing@acme.example')
    expect(revokedCount).toBe(1)

    const result = await validateToken(db, minted.token, now)
    expect(result).toEqual({ ok: false, reason: 'revoked' })
  })

  it('revoking one recipient does not affect another recipient of the same client', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const a = await mintToken(db, 'ACME', 'a@acme.example', 30, now)
    const b = await mintToken(db, 'ACME', 'b@acme.example', 30, now)
    await revokeTokensForRecipient(db, 'ACME', 'a@acme.example')

    expect((await validateToken(db, a.token, now)).ok).toBe(false)
    expect((await validateToken(db, b.token, now)).ok).toBe(true)
  })

  it('records last_used_at on a successful validation', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const minted = await mintToken(db, 'ACME', 'billing@acme.example', 30, now)
    await validateToken(db, minted.token, now)
    const row = sqlite.prepare('SELECT last_used_at FROM access_tokens').get() as {
      last_used_at: string | null
    }
    expect(row.last_used_at).toBe(now.toISOString())
  })

  it('counts only active (non-revoked, non-expired) tokens', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    await mintToken(db, 'ACME', 'active@acme.example', 30, now)
    const expiring = await mintToken(db, 'ACME', 'expiring@acme.example', 1, now)
    await mintToken(db, 'ACME', 'revoked@acme.example', 30, now)
    await revokeTokensForRecipient(db, 'ACME', 'revoked@acme.example')

    const beforeExpiry = await countActiveTokens(db, now)
    expect(beforeExpiry).toBe(2) // active + expiring, not revoked

    const justAfterExpiry = new Date(new Date(expiring.expiresAt).getTime() + 1000)
    const afterExpiry = await countActiveTokens(db, justAfterExpiry)
    expect(afterExpiry).toBe(1) // only the still-active one
  })

  it('two mints for the same client+email produce different, independently-valid tokens', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const first = await mintToken(db, 'ACME', 'billing@acme.example', 30, now)
    const second = await mintToken(db, 'ACME', 'billing@acme.example', 30, now)
    expect(first.token).not.toBe(second.token)
    expect((await validateToken(db, first.token, now)).ok).toBe(true)
    expect((await validateToken(db, second.token, now)).ok).toBe(true)
  })
})
