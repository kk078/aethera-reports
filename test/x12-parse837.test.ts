import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse837 } from '../src/main/importers/x12/parse837'
import { detectX12Kind } from '../src/main/importers/x12'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8')
}

describe('parse837', () => {
  it('parses billing/rendering/subscriber NM1, CLM, SV1, DTP, and HI across two claims', () => {
    const parsed = parse837(readFixture('synthetic-837.837'))
    expect(parsed.warnings).toEqual([])
    expect(parsed.claims).toHaveLength(2)

    const [first, second] = parsed.claims

    expect(first.claimNumber).toBe('CLAIM1001')
    expect(first.totalChargeAmount).toBe(500)
    expect(first.billingProviderName).toBe('DEMO CLINIC')
    expect(first.billingProviderNpi).toBe('1234567890')
    expect(first.payerName).toBe('ACME HEALTH PLAN')
    expect(first.subscriberLastName).toBe('DOE')
    expect(first.subscriberFirstName).toBe('JANE')
    expect(first.subscriberMemberId).toBe('MEMBER0001')
    expect(first.patientLastName).toBe('DOE') // non-dependent: patient == subscriber
    expect(first.serviceDate).toBe('2026-01-05')
    expect(first.diagnoses).toEqual(['E119'])
    expect(first.serviceLines).toHaveLength(1)
    expect(first.serviceLines[0]).toMatchObject({
      lineNumber: 1,
      procedureCode: '99213',
      chargeAmount: 500,
      units: 1,
      serviceDate: '2026-01-05'
    })

    expect(second.claimNumber).toBe('CLAIM2002')
    expect(second.subscriberLastName).toBe('ROE')
    expect(second.subscriberMemberId).toBe('MEMBER0003')
    expect(second.totalChargeAmount).toBe(300)
    expect(second.serviceDate).toBe('2026-01-12')
  })

  it('is recognized as an 837 by detectX12Kind', () => {
    expect(detectX12Kind(readFixture('synthetic-837.837'))).toBe('837')
  })

  it('returns no claims and a warning for a file whose delimiters do not match its body (wrong delimiters)', () => {
    const content = readFixture('malformed-837-wrong-delimiters.837')
    // The comma-separated body never produces a recognizable ST segment,
    // so this file isn't even detectable as X12 837 up front...
    expect(detectX12Kind(content)).toBeNull()
    // ...and parsing it directly degrades to "no claims found" rather
    // than throwing, since the tokenizer itself never fails (ISA is
    // well-formed) — only the semantic parse comes up empty.
    const parsed = parse837(content)
    expect(parsed.claims).toEqual([])
    expect(parsed.warnings).toContain('No CLM segments found — no claims parsed from this file.')
  })
})
