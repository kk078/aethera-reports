import { describe, expect, it } from 'vitest'
import {
  applyDateFmt,
  applyMoney,
  buildCanonicalRow
} from '../src/main/importers/csv-xlsx/transform'
import { tebraClaimExportTemplate } from '../src/main/importers/csv-xlsx/presets/tebra'
import type { MappingTemplate } from '../src/shared/domain'

const template: MappingTemplate = {
  templateId: 'test-template',
  version: 1,
  builtIn: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...tebraClaimExportTemplate
}

describe('applyMoney', () => {
  it('strips currency symbols and commas', () => {
    expect(applyMoney('$1,234.56')).toBeCloseTo(1234.56)
  })
  it('parses parenthesized negatives', () => {
    expect(applyMoney('($12.50)')).toBeCloseTo(-12.5)
  })
  it('returns null for garbage input', () => {
    expect(applyMoney('not-a-number')).toBeNull()
  })
})

describe('applyDateFmt', () => {
  it('passes through ISO dates', () => {
    expect(applyDateFmt('2026-01-15')).toBe('2026-01-15')
  })
  it('normalizes MM/DD/YYYY', () => {
    expect(applyDateFmt('1/5/2026')).toBe('2026-01-05')
  })
  it('returns null for unrecognized formats', () => {
    expect(applyDateFmt('not-a-date')).toBeNull()
  })
})

describe('buildCanonicalRow (Tebra preset)', () => {
  const goodRawRow: Record<string, string> = {
    'Patient Account Number': 'DEMO1-PT-1',
    'Claim Number': 'DEMO1-CLM-1',
    'Date of Service': '01/15/2026',
    'Payer Name': 'Aetna PPO',
    'Rendering Provider NPI': '1234567890',
    'Claim Status': 'Paid',
    'Procedure Code': '99213',
    Units: '1',
    'Charge Amount': '$150.00',
    'Allowed Amount': '$120.00',
    'Paid Amount': '$110.00',
    'Patient Responsibility': '$10.00',
    'Patient Paid': '$10.00',
    'Adjustment Amount': '$5.00',
    'Denial Code': '',
    'Denial Reason': ''
  }

  it('maps a valid row into the canonical shape', () => {
    const { row, errors } = buildCanonicalRow(goodRawRow, template)
    expect(errors).toEqual([])
    expect(row).not.toBeNull()
    expect(row?.claimNumber).toBe('DEMO1-CLM-1')
    expect(row?.dos).toBe('2026-01-15')
    expect(row?.chargeAmount).toBeCloseTo(150)
    expect(row?.carcCode).toBeUndefined()
  })

  it('quarantines a row with an unparseable date', () => {
    const { row, errors } = buildCanonicalRow(
      { ...goodRawRow, 'Date of Service': 'garbage' },
      template
    )
    expect(row).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
  })

  it('quarantines a row missing both claim number and external ref', () => {
    const { row, errors } = buildCanonicalRow({ ...goodRawRow, 'Claim Number': '' }, template)
    expect(row).toBeNull()
    expect(errors.some((e) => e.includes('claimNumber'))).toBe(true)
  })

  it('carries a denial through when a CARC code is present', () => {
    const { row } = buildCanonicalRow(
      { ...goodRawRow, 'Denial Code': 'CO-45', 'Denial Reason': 'Exceeds fee schedule' },
      template
    )
    expect(row?.carcCode).toBe('CO-45')
    expect(row?.denialDescription).toBe('Exceeds fee schedule')
  })
})
