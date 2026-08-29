/**
 * Display formatting shared between renderer screens and exporters.
 * Pure functions — safe to import from main, renderer, and server.
 */

/** Current calendar month as `"YYYY-MM"` (UTC). */
export function currentMonthValue(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Percentage for KPI tables; null → em dash. */
export function fmtPct(value: number | null, emptyLabel = '—'): string {
  return value === null ? emptyLabel : `${value}%`
}

/** Whole-dollar currency for dashboard tables. */
export function fmtMoney(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

/** Payment lag with sample count — Payers screen wording. */
export function fmtLag(value: number | null, sampleCount: number): string {
  return value === null || sampleCount === 0
    ? 'insufficient data'
    : `${value} days (n=${sampleCount})`
}
