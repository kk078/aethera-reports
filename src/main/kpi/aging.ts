/**
 * Shared A/R aging math — the day-bucket thresholds and balance
 * expression from `client-report.ts`'s `computeAging` (verbatim from
 * production.py lines 165-172, cited in full there), extracted so the
 * new cross-client Denials/AR/Payers screens (plan §5, Phase 2 chunk B)
 * use the EXACT same math instead of a second hand-copied version that
 * could drift (Risk 2's KPI-parity concern, extended to these screens).
 */
import type { ArAgingBuckets } from '../../shared/domain'

export const EMPTY_AGING: ArAgingBuckets = {
  '0-30': 0,
  '31-60': 0,
  '61-90': 0,
  '91-120': 0,
  '120+': 0
}

export const AGING_BUCKET_ORDER: Array<keyof ArAgingBuckets> = [
  '0-30',
  '31-60',
  '61-90',
  '91-120',
  '120+'
]

/** production.py lines 169-172's day-bucket thresholds, verbatim. */
export function bucketForDays(days: number): keyof ArAgingBuckets {
  if (days <= 30) return '0-30'
  if (days <= 60) return '31-60'
  if (days <= 90) return '61-90'
  if (days <= 120) return '91-120'
  return '120+'
}

/** production.py line 166: `balance + max(patient_responsibility - patient_paid, 0)`. */
export function openClaimAmount(
  balance: number,
  patientResponsibility: number,
  patientPaid: number
): number {
  return balance + Math.max(patientResponsibility - patientPaid, 0)
}
