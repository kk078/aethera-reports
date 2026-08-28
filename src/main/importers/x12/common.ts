/**
 * Small value-parsing helpers shared by `parse835.ts` and `parse837.ts`.
 * Deliberately tolerant: X12 amount/date elements that fail to parse
 * become `0`/`undefined` rather than throwing — a single malformed
 * amount inside an otherwise-good file shouldn't crash the whole parse
 * (the plan's Risk 3 quarantine philosophy, applied here at the segment
 * level instead of the CSV row level).
 */

/** Parses an X12 numeric element (plain decimal, optional leading `-`, no currency symbols). */
export function parseX12Amount(raw: string): number {
  if (raw === '') return 0
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

/** Converts an X12 `D8` date element (`YYYYMMDD`) to ISO `YYYY-MM-DD`; `undefined` if unparseable. */
export function d8ToIso(raw: string): string | undefined {
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!match) return undefined
  const [, year, month, day] = match
  return `${year}-${month}-${day}`
}

/** CAS group codes -> a human/denials-table-friendly category (plan §3 bullet 4). */
export const CAS_GROUP_CATEGORY: Record<string, string> = {
  CO: 'contractual_obligation',
  PR: 'patient_responsibility',
  OA: 'other_adjustment',
  PI: 'payer_initiated',
  CR: 'correction_reversal'
}
