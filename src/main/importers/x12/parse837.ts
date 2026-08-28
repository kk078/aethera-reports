/**
 * X12 837 (Health Care Claim, professional/institutional) semantic
 * parser (plan §3 bullet 2). Walks the tokenizer's flat segment stream
 * through the HL provider/subscriber/patient hierarchy and assembles
 * typed `Claim837` records — CLM, SV1/SV2, NM1 (billing/rendering/
 * subscriber), DTP (DOS), HI (diagnoses — captured, analytics may
 * ignore per the plan).
 *
 * Pure function, no DB/Electron access. Supports a batch file with
 * multiple ST/SE claim transactions and multiple CLM loops per ST.
 */
import { tokenize, el, splitComponents, type X12Segment } from './tokenizer'
import { parseX12Amount, d8ToIso } from './common'

export interface Claim837ServiceLine {
  lineNumber: number
  procedureCode?: string
  modifiers: string[]
  chargeAmount: number
  units?: number
  serviceDate?: string
}

export interface Claim837 {
  /** CLM01 — the claim_number our own systems know it by. */
  claimNumber: string
  /** CLM02 */
  totalChargeAmount: number
  billingProviderName?: string
  billingProviderNpi?: string
  renderingProviderNpi?: string
  payerName?: string
  subscriberLastName?: string
  subscriberFirstName?: string
  /** NM1*IL, identification qualifier MI — the subscriber's member id, our best patient-key source. */
  subscriberMemberId?: string
  /** Only set when the claim is for a dependent (HL level code 23) rather than the subscriber. */
  patientLastName?: string
  patientFirstName?: string
  /** Best-effort date of service: claim-level DTP*434 start date, else the first line's DTP*472. */
  serviceDate?: string
  /** HI-segment diagnosis codes, in file order — captured, not required by the KPI engine (plan §3 bullet 3). */
  diagnoses: string[]
  serviceLines: Claim837ServiceLine[]
}

export interface Claim837File {
  claims: Claim837[]
  warnings: string[]
}

function readComposite(
  segment: X12Segment,
  index1Based: number,
  delimiters: Parameters<typeof splitComponents>[1]
): string[] {
  return splitComponents(el(segment, index1Based), delimiters)
}

export function parse837(content: string): Claim837File {
  const { segments, delimiters } = tokenize(content)

  const warnings: string[] = []
  const claims: Claim837[] = []

  let billingProviderName: string | undefined
  let billingProviderNpi: string | undefined
  let renderingProviderNpi: string | undefined
  let payerName: string | undefined
  let subscriberLastName: string | undefined
  let subscriberFirstName: string | undefined
  let subscriberMemberId: string | undefined
  let patientLastName: string | undefined
  let patientFirstName: string | undefined
  let isDependentContext = false

  let currentClaim: Claim837 | null = null
  let currentLine: Claim837ServiceLine | null = null

  const finishClaim = (): void => {
    if (currentClaim) claims.push(currentClaim)
    currentClaim = null
    currentLine = null
  }

  for (const segment of segments) {
    switch (segment.tag) {
      case 'HL': {
        // HL03 — hierarchical level code: 20 billing provider, 22 subscriber, 23 patient/dependent.
        const levelCode = el(segment, 3)
        if (levelCode === '22') {
          isDependentContext = false
          patientLastName = undefined
          patientFirstName = undefined
        } else if (levelCode === '23') {
          isDependentContext = true
        }
        break
      }

      case 'NM1': {
        const qualifier = el(segment, 1)
        const last = el(segment, 3)
        const first = el(segment, 4)
        const idQualifier = el(segment, 8)
        const idValue = el(segment, 9) || undefined
        if (qualifier === '85') {
          billingProviderName = [last, first].filter(Boolean).join(' ') || last || undefined
          if (idQualifier === 'XX') billingProviderNpi = idValue
        } else if (qualifier === '82') {
          if (idQualifier === 'XX') renderingProviderNpi = idValue
        } else if (qualifier === 'PR') {
          payerName = last || undefined
        } else if (qualifier === 'IL') {
          subscriberLastName = last || undefined
          subscriberFirstName = first || undefined
          if (idQualifier === 'MI') subscriberMemberId = idValue
        } else if (qualifier === 'QC') {
          patientLastName = last || undefined
          patientFirstName = first || undefined
        }
        break
      }

      case 'CLM': {
        finishClaim()
        currentClaim = {
          claimNumber: el(segment, 1),
          totalChargeAmount: parseX12Amount(el(segment, 2)),
          billingProviderName,
          billingProviderNpi,
          renderingProviderNpi,
          payerName,
          subscriberLastName,
          subscriberFirstName,
          subscriberMemberId,
          patientLastName: isDependentContext ? patientLastName : subscriberLastName,
          patientFirstName: isDependentContext ? patientFirstName : subscriberFirstName,
          diagnoses: [],
          serviceLines: []
        }
        if (!currentClaim.claimNumber) {
          warnings.push(
            `CLM segment at position ${segment.position} has no claim number (CLM01) — kept, but it cannot be deduped/matched later.`
          )
        }
        break
      }

      case 'DTP': {
        const qualifier = el(segment, 1)
        const formatQualifier = el(segment, 2)
        const value = el(segment, 3)
        if (qualifier === '434') {
          // RD8 composite date range "YYYYMMDD-YYYYMMDD" — take the start date.
          const start = value.split('-')[0]
          const iso = d8ToIso(start)
          if (currentClaim && iso) currentClaim.serviceDate = iso
        } else if (qualifier === '472' && formatQualifier === 'D8') {
          const iso = d8ToIso(value)
          if (currentLine) currentLine.serviceDate = iso
          if (currentClaim && !currentClaim.serviceDate && iso) currentClaim.serviceDate = iso
        }
        break
      }

      case 'HI': {
        if (!currentClaim) break
        for (const rawElement of segment.elements) {
          const parts = rawElement.split(delimiters.component)
          const code = parts[1]
          if (code) currentClaim.diagnoses.push(code)
        }
        break
      }

      case 'LX': {
        // A new 2400 line loop begins; SV1/SV2 creates the actual line record.
        currentLine = null
        break
      }

      case 'SV1':
      case 'SV2': {
        if (!currentClaim) {
          warnings.push(
            `${segment.tag} segment at position ${segment.position} appeared before any CLM segment — skipped.`
          )
          break
        }
        const isProfessional = segment.tag === 'SV1'
        const composite = readComposite(segment, isProfessional ? 1 : 2, delimiters)
        const chargeIndex = isProfessional ? 2 : 3
        const unitsIndex = isProfessional ? 4 : 5
        currentLine = {
          lineNumber: currentClaim.serviceLines.length + 1,
          procedureCode: composite[1] || undefined,
          modifiers: composite.slice(2).filter(Boolean),
          chargeAmount: parseX12Amount(el(segment, chargeIndex)),
          units: el(segment, unitsIndex) ? parseX12Amount(el(segment, unitsIndex)) : undefined
        }
        currentClaim.serviceLines.push(currentLine)
        break
      }

      case 'SE': {
        finishClaim()
        break
      }

      default:
        break
    }
  }
  finishClaim()

  if (claims.length === 0) {
    warnings.push('No CLM segments found — no claims parsed from this file.')
  }

  return { claims, warnings }
}
