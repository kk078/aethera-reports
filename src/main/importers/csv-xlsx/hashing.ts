/**
 * PHI-minimization + dedup hashing (plan §2, §7). Pure functions, no
 * Electron/Node-API imports beyond `node:crypto` — safe under the
 * `services`/`importers`/`kpi` no-Electron-imports guard.
 */
import { createHash } from 'node:crypto'

/**
 * Hashes a raw patient identifier (account number, MRN — whatever the PM
 * export uses) into the value that actually lands in `claims.patient_key`.
 * Never store the raw identifier. Namespaced by client code so the same
 * account number at two different practices doesn't collide.
 */
export function hashPatientKey(rawIdentifier: string, clientCode: string): string {
  return createHash('sha256').update(`${clientCode}|${rawIdentifier}`).digest('hex')
}

/**
 * `natural_key = sha1(source || client_code || claim_number/external_ref || dos)`
 * — verbatim from plan §2's dedup spec. Two imports describing the same
 * claim collapse to the same key regardless of which file or channel
 * they came from.
 */
export function computeNaturalKey(
  source: string,
  clientCode: string,
  claimIdentifier: string,
  dos: string
): string {
  return createHash('sha1')
    .update(`${source}|${clientCode}|${claimIdentifier}|${dos}`)
    .digest('hex')
}
