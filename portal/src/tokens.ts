/**
 * Magic-link token lifecycle (plan: mint/validate/expiry/revoke). Only a
 * SHA-256 hash of the raw token is ever persisted — `validateToken` looks
 * a presented token up BY its hash (an indexed exact-match query), never
 * by comparing raw token strings in application code, which is the
 * actual "hash compare" mitigation for magic-link tokens the security
 * review called for (as opposed to session cookies' HMAC signature,
 * which DOES need an explicit constant-time compare — see session.ts).
 */
import { generateRandomTokenHex, sha256Hex } from './crypto-utils'
import type { D1Like } from './db'

export const DEFAULT_LINK_TTL_DAYS = 30

export interface MintedToken {
  token: string
  expiresAt: string
}

interface AccessTokenRow {
  token_hash: string
  client_code: string
  email: string
  expires_at: string
  revoked: number
  created_at: string
  last_used_at: string | null
}

export async function mintToken(
  db: D1Like,
  clientCode: string,
  email: string,
  ttlDays: number,
  now: Date
): Promise<MintedToken> {
  const token = generateRandomTokenHex(32)
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
  await db
    .prepare(
      `INSERT INTO access_tokens (token_hash, client_code, email, expires_at, revoked, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    )
    .bind(tokenHash, clientCode, email, expiresAt, now.toISOString())
    .run()
  return { token, expiresAt }
}

export type TokenValidationResult =
  | { ok: true; clientCode: string; email: string }
  | { ok: false; reason: 'not-found' | 'revoked' | 'expired' }

/** Validates a presented (raw) token: exists, not revoked, not expired. Touches `last_used_at` on success — never reveals *which* check failed to the caller-facing UI (that distinction is only for internal logging), so an attacker probing tokens learns nothing extra from the failure mode. */
export async function validateToken(
  db: D1Like,
  token: string,
  now: Date
): Promise<TokenValidationResult> {
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare('SELECT * FROM access_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first<AccessTokenRow>()
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.revoked) return { ok: false, reason: 'revoked' }
  if (new Date(row.expires_at).getTime() < now.getTime()) return { ok: false, reason: 'expired' }

  await db
    .prepare('UPDATE access_tokens SET last_used_at = ? WHERE token_hash = ?')
    .bind(now.toISOString(), tokenHash)
    .run()
  return { ok: true, clientCode: row.client_code, email: row.email }
}

/** Revokes every currently-active link for one recipient (e.g. they left the account) — returns how many were revoked. */
export async function revokeTokensForRecipient(
  db: D1Like,
  clientCode: string,
  email: string
): Promise<number> {
  const result = await db
    .prepare(
      'UPDATE access_tokens SET revoked = 1 WHERE client_code = ? AND email = ? AND revoked = 0'
    )
    .bind(clientCode, email)
    .run()
  return result.meta.changes
}

export async function countActiveTokens(db: D1Like, now: Date): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM access_tokens WHERE revoked = 0 AND expires_at > ?')
    .bind(now.toISOString())
    .first<{ n: number }>()
  return row?.n ?? 0
}
