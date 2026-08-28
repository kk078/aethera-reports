import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse835 } from '../src/main/importers/x12/parse835'
import { X12TokenizeError } from '../src/main/importers/x12/tokenizer'

const FIXTURES_DIR = join(__dirname, '..', 'sample-data')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8')
}

describe('parse835', () => {
  it('parses payment header, payer/payee, claims, service lines, and adjustments', () => {
    const remit = parse835(readFixture('synthetic-835.835'))

    expect(remit.paymentAmount).toBe(600)
    expect(remit.paymentMethod).toBe('ACH')
    expect(remit.paymentDate).toBe('2026-01-15')
    expect(remit.traceNumber).toBe('84512300001')
    expect(remit.payerName).toBe('ACME HEALTH PLAN')
    expect(remit.payeeName).toBe('DEMO CLINIC')
    expect(remit.payeeNpi).toBe('1234567890')
    expect(remit.warnings).toEqual([])

    expect(remit.claims).toHaveLength(2)

    const [matched, unmatched] = remit.claims
    expect(matched.claimNumber).toBe('CLAIM1001')
    expect(matched.statusCode).toBe('1')
    expect(matched.totalChargeAmount).toBe(500)
    expect(matched.totalPaidAmount).toBe(400)
    expect(matched.patientResponsibility).toBe(50)
    expect(matched.payerClaimControlNumber).toBe('PAYERICN0001')
    expect(matched.allowedAmount).toBe(400)
    expect(matched.patientName).toBe('DOE, JANE')
    expect(matched.serviceDate).toBe('2026-01-05')

    expect(matched.serviceLines).toHaveLength(1)
    const [line] = matched.serviceLines
    expect(line.procedureCode).toBe('99213')
    expect(line.chargeAmount).toBe(500)
    expect(line.paidAmount).toBe(400)
    expect(line.units).toBe(1)
    expect(line.serviceDate).toBe('2026-01-05')
    expect(line.adjustments).toEqual([
      { groupCode: 'CO', carcCode: '45', amount: 100, quantity: undefined }
    ])

    expect(matched.claimAdjustments).toEqual([])

    expect(unmatched.claimNumber).toBe('CLAIM_UNMATCHED')
    expect(unmatched.totalPaidAmount).toBe(200)
    expect(unmatched.serviceLines[0].adjustments).toEqual([
      { groupCode: 'PR', carcCode: '1', amount: 30, quantity: undefined },
      { groupCode: 'CO', carcCode: '45', amount: 20, quantity: undefined }
    ])
  })

  it('degrades non-numeric amounts to 0 instead of throwing (Risk 3 applied to X12)', () => {
    const remit = parse835(readFixture('malformed-835-bad-amounts.835'))
    expect(remit.paymentAmount).toBe(0)
    expect(remit.claims).toHaveLength(1)
    expect(remit.claims[0].totalChargeAmount).toBe(0)
    expect(remit.claims[0].totalPaidAmount).toBe(0)
    expect(remit.claims[0].serviceLines[0].chargeAmount).toBe(0)
    expect(remit.claims[0].serviceLines[0].adjustments[0].amount).toBe(0)
  })

  it('throws X12TokenizeError (not a generic crash) on a truncated ISA', () => {
    expect(() => parse835(readFixture('malformed-835-truncated-isa.835'))).toThrow(X12TokenizeError)
  })

  it('warns instead of throwing on an orphan SVC/CAS with no preceding CLP', () => {
    const content =
      'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *260115*0900*^*00501*000000009*0*P*:~' +
      'GS*HP*A*B*20260115*0900*9*X*005010X221A1~' +
      'ST*835*0001~' +
      'BPR*I*0*C*ACH*CCP*01*1*DA*1*1**01*1*DA*1*20260115~' +
      'SVC*HC:99213*100*100**1~' +
      'CAS*CO*45*10~' +
      'SE*4*0001~'
    const remit = parse835(content)
    expect(remit.claims).toHaveLength(0)
    expect(remit.warnings.some((w) => w.includes('SVC'))).toBe(true)
    expect(remit.warnings.some((w) => w.includes('No CLP'))).toBe(true)
  })
})
