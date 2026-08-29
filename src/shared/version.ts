/** Pure semver-ish helpers for the opt-in update check (main/update-check.ts). */

/** "v0.3.1" / "0.3.1" → [0, 3, 1]; anything unparseable → null. */
export function parseVersion(tag: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True only when `candidate` is a strictly newer parseable version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}
