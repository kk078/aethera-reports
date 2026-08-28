/**
 * Small Web Crypto helpers shared by tokens.ts, session.ts, and
 * admin-auth.ts. Pure Web Crypto (`crypto.subtle`, `crypto.getRandomValues`)
 * — available natively in the Workers runtime AND in Node 19+ (so this
 * runs unmodified under vitest, no polyfill/mock needed).
 *
 * Security note (flagged in review): comparing secrets/token hashes with
 * plain `===`/`!==` on strings is not constant-time in JS engines, which
 * can leak timing information to an attacker probing character-by-
 * character. `timingSafeEqualHex` does a fixed-cost XOR-accumulate
 * comparison instead; `constantTimeStringEqual` additionally hashes both
 * inputs first, so even the comparison's *shape* doesn't depend on the
 * caller-supplied string's real length or content beyond its hash.
 */

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(digest))
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function generateRandomTokenHex(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

/** Fixed-cost comparison of two equal-length hex strings — returns `false` immediately (not a timing concern, since length itself isn't secret here) if the lengths differ. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** Constant-time-ish equality for two secrets of arbitrary (possibly attacker-controlled) length — hashes both first so the XOR-compare always runs over fixed-length digests. */
export async function constantTimeStringEqual(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([sha256Hex(a), sha256Hex(b)])
  return timingSafeEqualHex(hashA, hashB)
}
