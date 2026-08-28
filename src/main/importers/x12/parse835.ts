/**
 * X12 835 (Health Care Claim Payment/Advice) semantic parser (plan §3
 * bullet 2). Walks the tokenizer's flat segment stream and assembles a
 * typed `Remittance835` — BPR (payment amount/date), TRN (check/EFT
 * trace), N1 (payer/payee), CLP (claim payment), SVC (service lines),
 * CAS (adjustments incl. CARC codes), DTM (dates).
 *
 * Pure function, no DB/Electron access — `run-x12-import.ts` is the only
 * caller that touches the database. Assumes a single ST*835 (and its one
 * BPR/TRN payment header) per file, which covers the overwhelmingly
 * common case of one ERA per file; a batch file containing multiple
 * BPR-distinct 835 transactions would need a v2 that returns
 * `Remittance835[]` — out of scope here (noted, not silently wrong: we
 * still parse every CLP we find, just under one payment header).
 */
import { tokenize, el, splitComponents, type X12Segment } from './tokenizer'
import { parseX12Amount, d8ToIso } from './common'

export interface Remit835Adjustment {
  /** CAS01 — CO/PR/OA/PI/CR. */
  groupCode: string
  /** CAS02/05/08/... — the CARC code. */
  carcCode: string
  /** CAS03/06/09/... */
  amount: number
  /** CAS04/07/10/... (units affected), when present. */
  quantity?: number
}

export interface Remit835ServiceLine {
  lineNumber: number
  procedureCode?: string
  modifiers: string[]
  chargeAmount: number
  paidAmount: number
  units?: number
  serviceDate?: string
  adjustments: Remit835Adjustment[]
}

export interface Remit835Claim {
  /** CLP01 — patient control number, i.e. the claim_number/external_ref we submitted. */
  claimNumber: string
  /** CLP02 — claim status code. */
  statusCode: string
  /** CLP03 */
  totalChargeAmount: number
  /** CLP04 */
  totalPaidAmount: number
  /** CLP05 */
  patientResponsibility: number
  /** CLP07 — payer's internal claim control number (ICN). */
  payerClaimControlNumber?: string
  /** AMT*B6, when the payer includes an explicit allowed-amount segment. */
  allowedAmount?: number
  patientName?: string
  serviceDate?: string
  claimAdjustments: Remit835Adjustment[]
  serviceLines: Remit835ServiceLine[]
}

export interface Remittance835 {
  payerName?: string
  payeeName?: string
  payeeNpi?: string
  /** BPR02 — total payment amount for this remittance. */
  paymentAmount: number
  /** BPR16 */
  paymentDate?: string
  /** BPR04 — payment method code (CHK, ACH, ...). */
  paymentMethod?: string
  /** TRN02 — the check/EFT trace number. */
  traceNumber?: string
  claims: Remit835Claim[]
  /** Structural oddities that didn't stop the parse (e.g. an orphan SVC/CAS) — surfaced like quarantine reasons by the caller. */
  warnings: string[]
}

function parseCasAdjustments(segment: X12Segment): Remit835Adjustment[] {
  const groupCode = el(segment, 1)
  const adjustments: Remit835Adjustment[] = []
  // CAS carries up to 6 (reason, amount, quantity) triples: elements
  // 2-4, 5-7, 8-10, 11-13, 14-16, 17-19.
  for (let i = 0; i < 6; i++) {
    const carcCode = el(segment, 2 + i * 3)
    if (!carcCode) break
    const amount = parseX12Amount(el(segment, 3 + i * 3))
    const quantityRaw = el(segment, 4 + i * 3)
    adjustments.push({
      groupCode,
      carcCode,
      amount,
      quantity: quantityRaw ? parseX12Amount(quantityRaw) : undefined
    })
  }
  return adjustments
}

export function parse835(content: string): Remittance835 {
  const { segments, delimiters } = tokenize(content)

  const warnings: string[] = []
  let payerName: string | undefined
  let payeeName: string | undefined
  let payeeNpi: string | undefined
  let paymentAmount = 0
  let paymentDate: string | undefined
  let paymentMethod: string | undefined
  let traceNumber: string | undefined

  const claims: Remit835Claim[] = []
  let currentClaim: Remit835Claim | null = null
  let currentLine: Remit835ServiceLine | null = null

  const finishClaim = (): void => {
    if (currentClaim) claims.push(currentClaim)
    currentClaim = null
    currentLine = null
  }

  for (const segment of segments) {
    switch (segment.tag) {
      case 'BPR':
        paymentAmount = parseX12Amount(el(segment, 2))
        paymentMethod = el(segment, 4) || undefined
        paymentDate = d8ToIso(el(segment, 16))
        break

      case 'TRN':
        traceNumber = el(segment, 2) || undefined
        break

      case 'N1': {
        const qualifier = el(segment, 1)
        const name = el(segment, 2) || undefined
        const idQualifier = el(segment, 3)
        const idValue = el(segment, 4) || undefined
        if (qualifier === 'PR') payerName = name
        if (qualifier === 'PE') {
          payeeName = name
          if (idQualifier === 'XX') payeeNpi = idValue
        }
        break
      }

      case 'CLP': {
        finishClaim()
        currentClaim = {
          claimNumber: el(segment, 1),
          statusCode: el(segment, 2),
          totalChargeAmount: parseX12Amount(el(segment, 3)),
          totalPaidAmount: parseX12Amount(el(segment, 4)),
          patientResponsibility: parseX12Amount(el(segment, 5)),
          payerClaimControlNumber: el(segment, 7) || undefined,
          claimAdjustments: [],
          serviceLines: []
        }
        if (!currentClaim.claimNumber) {
          warnings.push(
            `CLP segment at position ${segment.position} has no claim number (CLP01) — kept, but it will fail to match any claim.`
          )
        }
        break
      }

      case 'NM1': {
        const qualifier = el(segment, 1)
        if (currentClaim && qualifier === 'QC') {
          const last = el(segment, 3)
          const first = el(segment, 4)
          currentClaim.patientName = [last, first].filter(Boolean).join(', ') || undefined
        }
        break
      }

      case 'DTM': {
        const qualifier = el(segment, 1)
        const iso = d8ToIso(el(segment, 2))
        if (currentLine && qualifier === '472') {
          currentLine.serviceDate = iso
        } else if (currentClaim && (qualifier === '232' || qualifier === '050') && iso) {
          currentClaim.serviceDate = currentClaim.serviceDate ?? iso
        }
        break
      }

      case 'AMT': {
        if (currentClaim && el(segment, 1) === 'B6') {
          currentClaim.allowedAmount = parseX12Amount(el(segment, 2))
        }
        break
      }

      case 'SVC': {
        if (!currentClaim) {
          warnings.push(
            `SVC segment at position ${segment.position} appeared before any CLP segment — skipped.`
          )
          break
        }
        const composite = splitComponents(el(segment, 1), delimiters)
        currentLine = {
          lineNumber: currentClaim.serviceLines.length + 1,
          procedureCode: composite[1] || undefined,
          modifiers: composite.slice(2).filter(Boolean),
          chargeAmount: parseX12Amount(el(segment, 2)),
          paidAmount: parseX12Amount(el(segment, 3)),
          units: el(segment, 5) ? parseX12Amount(el(segment, 5)) : undefined,
          adjustments: []
        }
        currentClaim.serviceLines.push(currentLine)
        break
      }

      case 'CAS': {
        const adjustments = parseCasAdjustments(segment)
        if (currentLine) {
          currentLine.adjustments.push(...adjustments)
        } else if (currentClaim) {
          currentClaim.claimAdjustments.push(...adjustments)
        } else {
          warnings.push(
            `CAS segment at position ${segment.position} appeared before any CLP segment — skipped.`
          )
        }
        break
      }

      default:
        break
    }
  }
  finishClaim()

  if (claims.length === 0) {
    warnings.push('No CLP segments found — no claim payments parsed from this file.')
  }

  return {
    payerName,
    payeeName,
    payeeNpi,
    paymentAmount,
    paymentDate,
    paymentMethod,
    traceNumber,
    claims,
    warnings
  }
}
