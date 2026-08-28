/**
 * Short-lived, signed session cookie set by `GET /r/:token` once a magic
 * link validates, so browsing between a client's report periods doesn't
 * require the token in every URL (plan: "sets a short session cookie,
 * renders the report list for that client"). Signed (HMAC-SHA256) with
 * its own dedicated `SESSION_SECRET` Worker secret — deliberately NOT
 * the admin token, so a leaked session cookie (e.g. via a shared/public
 * device) can never be used to derive or brute-force anything
 * admin-scoped.
 *
 * The cookie's own value is `{clientCode}.{expiresAtMs}.{hmacHex}` —
 * never the magic-link token itself, so nothing here "reflects the
 * token into HTML/cookies" (the security review's other concern was
 * specifically about `/r/<token>`'s HTML response body, not this).
 */
import { timingSafeEqualHex } from './crypto-utils'

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function createSessionCookieValue(
  sessionSecret: string,
  clientCode: string,
  ttlMs: number,
  now: Date
): Promise<string> {
  const expiresAtMs = now.getTime() + ttlMs
  const payload = `${clientCode}.${expiresAtMs}`
  const signatureHex = await sign(sessionSecret, payload)
  return `${payload}.${signatureHex}`
}

/** Returns the session's `clientCode` if the cookie's signature is valid and it hasn't expired, `null` otherwise (malformed, forged, or expired — the caller doesn't need to distinguish which). */
export async function verifySessionCookieValue(
  sessionSecret: string,
  cookieValue: string,
  now: Date
): Promise<string | null> {
  const parts = cookieValue.split('.')
  if (parts.length !== 3) return null
  const [clientCode, expiresAtStr, signatureHex] = parts
  const payload = `${clientCode}.${expiresAtStr}`
  const expectedSignatureHex = await sign(sessionSecret, payload)
  if (!timingSafeEqualHex(signatureHex, expectedSignatureHex)) return null

  const expiresAtMs = Number(expiresAtStr)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < now.getTime()) return null
  return clientCode
}
