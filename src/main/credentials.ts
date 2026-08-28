/**
 * Credential encryption for the RCM Platform connector (plan §7:
 * "Credentials via Electron `safeStorage` (DPAPI on Windows)"; plan §2's
 * meta.db note: "connector credentials (via Electron `safeStorage`)").
 *
 * This is the ONE place in the app that imports `electron.safeStorage` —
 * `services/`, `importers/`, and `kpi/` must stay Electron-free (the
 * `no-restricted-imports` ESLint rule), so `ipc/rcm-connector.ts` calls
 * these functions and hands `LocalDataService` only the already-resolved
 * plaintext (to use once, in memory, for one login) or the already-
 * encrypted opaque blob (to persist) — `LocalDataService` never touches
 * `safeStorage` itself.
 *
 * Fallback: on a platform/setup where OS-level encryption isn't
 * available (`safeStorage.isEncryptionAvailable()` false — e.g. no
 * keyring on some Linux distros), the password is stored in **plaintext**
 * in meta.db rather than refusing to save it at all. `encoding` on the
 * stored record says which happened, and the Settings screen surfaces a
 * clear warning when it's `'plaintext'` — this is a documented tradeoff,
 * not a silent downgrade.
 */
import { safeStorage } from 'electron'

export interface EncryptedSecret {
  /** base64 of `safeStorage.encryptString()`'s Buffer, or the raw plaintext password, depending on `encoding`. */
  data: string
  encoding: 'safeStorage' | 'plaintext'
}

/** True when the OS-level credential store is available on this machine (DPAPI/Keychain/libsecret). */
export function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Encrypts a plaintext secret for storage, falling back to plaintext (flagged) when safeStorage is unavailable. */
export function encryptCredential(plaintext: string): EncryptedSecret {
  if (isSafeStorageAvailable()) {
    const buffer = safeStorage.encryptString(plaintext)
    return { data: buffer.toString('base64'), encoding: 'safeStorage' }
  }
  return { data: plaintext, encoding: 'plaintext' }
}

/** Reverses `encryptCredential`. Throws a clear error if a `'safeStorage'`-encoded secret can't be decrypted on this machine (e.g. moved to another OS/user). */
export function decryptCredential(secret: EncryptedSecret): string {
  if (secret.encoding === 'plaintext') return secret.data
  if (!isSafeStorageAvailable()) {
    throw new Error(
      'Stored connector password was encrypted with OS-level storage, but it is unavailable on this machine — re-enter the password in Settings.'
    )
  }
  return safeStorage.decryptString(Buffer.from(secret.data, 'base64'))
}
