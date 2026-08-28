/**
 * "Apply brand accent to app" (optional layer, off by default) — maps
 * the client's configured branding primary color onto the `--accent`
 * token ONLY, so a firm can make the chrome feel like theirs without
 * losing the committed neutral palette as the project's actual default
 * (the report document/exports already use branding fully, unconditionally
 * — this is purely a cosmetic app-chrome layer on top).
 *
 * Uses `color-mix()` to derive `--accent-strong`/`--accent-tint` from
 * whatever color the firm picked, rather than a hand-tuned pair per
 * brand color — good enough for an optional, reversible preference,
 * and it automatically re-mixes against the current mode's `--surface`
 * if the user switches light/dark while the tint is active.
 */
const STORAGE_KEY = 'aethera-brand-accent-tint'

export function isBrandAccentTintEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'on'
}

export function setBrandAccentTintEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off')
}

/** Pass a hex color to apply the tint, or `null` to clear it back to tokens.css's committed neutral accent. */
export function applyBrandAccentTint(primaryColor: string | null): void {
  const root = document.documentElement.style
  if (!primaryColor) {
    root.removeProperty('--brand-tint-color')
    root.removeProperty('--accent')
    root.removeProperty('--accent-strong')
    root.removeProperty('--accent-tint')
    root.removeProperty('--focus-ring')
    return
  }
  root.setProperty('--brand-tint-color', primaryColor)
  root.setProperty('--accent', 'var(--brand-tint-color)')
  root.setProperty('--accent-strong', 'color-mix(in oklab, var(--brand-tint-color) 78%, black)')
  root.setProperty(
    '--accent-tint',
    'color-mix(in oklab, var(--brand-tint-color) 16%, var(--surface))'
  )
  root.setProperty('--focus-ring', 'var(--brand-tint-color)')
}
