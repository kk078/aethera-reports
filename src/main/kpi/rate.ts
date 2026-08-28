/**
 * The one shared rate helper (plan §4, Risk 2d): every ratio in the KPI
 * engine goes through this, so NULL-vs-zero semantics can't diverge
 * per-KPI. Mirrors rcm-prototype's `_rate()`
 * (`app/services/kpi.py` lines 27-28):
 *
 *   def _rate(num: int, den: int) -> float | None:
 *       return round(num / den, 4) if den else None
 *
 * i.e. a zero (or falsy) denominator is `null`, never `0` — "no data",
 * not "a perfect/zero score". `client_report()`
 * (`app/services/production.py`) inlines the same
 * `X if condition else None` pattern for its own percentage KPIs rather
 * than calling `_rate` directly; `ratePercent` below is that same
 * pattern built on the one shared primitive instead of being
 * reimplemented per call site.
 */

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** `num / den`, rounded to `decimals` places, or `null` if `den` is falsy. */
export function rate(num: number, den: number, decimals = 4): number | null {
  return den ? roundTo(num / den, decimals) : null
}

/** `100 * num / den`, rounded to `decimals` places, or `null` if `den` is falsy. */
export function ratePercent(num: number, den: number, decimals = 1): number | null {
  const r = rate(num, den, decimals + 2)
  return r === null ? null : roundTo(r * 100, decimals)
}

/**
 * `average(values)`, or `null` for an empty array — the same NULL-not-0
 * convention applied to averages (`charge_lag_days_avg`, `days_to_cash`,
 * etc. in production.py/kpi.py, which all read `if xs else None`).
 */
export function average(values: number[], decimals = 1): number | null {
  if (values.length === 0) return null
  return roundTo(values.reduce((sum, v) => sum + v, 0) / values.length, decimals)
}

export function round2(value: number): number {
  return roundTo(value, 2)
}
