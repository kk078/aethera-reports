/**
 * Period math for the KPI engine and dashboards (plan §4). Pure
 * functions, UTC date-only arithmetic throughout — never `new Date()`
 * without an explicit UTC path, so results don't depend on the host
 * machine's timezone (a report generated in any timezone must show the
 * same period boundaries).
 *
 * A "period" is always a closed `[start, end]` range of ISO date strings
 * (`YYYY-MM-DD`), inclusive on both ends — matching rcm-prototype's
 * `client_report(db, client, start, end)` signature
 * (`app/services/production.py` line 152).
 */

export interface Period {
  start: string // YYYY-MM-DD
  end: string // YYYY-MM-DD
}

/** `YYYY-MM` -> `{ year, month }` (month is 1-12). Throws on malformed input. */
export function parseYearMonth(yyyyMm: string): { year: number; month: number } {
  const match = yyyyMm.match(/^(\d{4})-(\d{2})$/)
  if (!match) throw new Error(`Expected a "YYYY-MM" period, got: "${yyyyMm}"`)
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) throw new Error(`Invalid month in "${yyyyMm}"`)
  return { year, month }
}

function toIsoDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.toISOString().slice(0, 10)
}

/** Last calendar day of `year`-`month` (month is 1-12), UTC. */
function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of "next month" is the last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The full calendar month for `"YYYY-MM"` as a `[YYYY-MM-01, YYYY-MM-last]` period. */
export function monthPeriod(yyyyMm: string): Period {
  const { year, month } = parseYearMonth(yyyyMm)
  return {
    start: toIsoDate(year, month, 1),
    end: toIsoDate(year, month, lastDayOfMonth(year, month))
  }
}

/** `periodMonth` column value for `"YYYY-MM"` — always the 1st, per `monthly_summaries` (plan §2). */
export function periodMonthColumn(yyyyMm: string): string {
  return monthPeriod(yyyyMm).start
}

function addMonths(yyyyMm: string, delta: number): string {
  const { year, month } = parseYearMonth(yyyyMm)
  const zeroBased = month - 1 + delta
  const newYear = year + Math.floor(zeroBased / 12)
  const newMonth = ((zeroBased % 12) + 12) % 12 // handle negative deltas
  return `${newYear}-${String(newMonth + 1).padStart(2, '0')}`
}

/** The 12 months ending at (and including) `yyyyMm`, oldest first. */
export function trailing12Months(yyyyMm: string): string[] {
  const months: string[] = []
  for (let i = 11; i >= 0; i--) {
    months.push(addMonths(yyyyMm, -i))
  }
  return months
}

/** Same calendar month, one year earlier — for year-over-year comparisons. */
export function yoyMonth(yyyyMm: string): string {
  return addMonths(yyyyMm, -12)
}

/** Inclusive day count between two ISO dates (`end` >= `start`). */
export function daysBetweenInclusive(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00.000Z`)
  const endMs = Date.parse(`${end}T00:00:00.000Z`)
  return Math.round((endMs - startMs) / 86_400_000) + 1
}

/** Days between two ISO date (or ISO datetime) strings — `end - start`, can be negative. */
export function daysBetween(start: string, end: string): number {
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  return Math.round((endMs - startMs) / 86_400_000)
}

/** Today's date (UTC) as an ISO date string — the single clock read for "as of now" KPI math. */
export function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10)
}
