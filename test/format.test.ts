import { describe, expect, it } from 'vitest'
import { currentMonthValue, fmtLag, fmtMoney, fmtPct } from '../src/shared/format'

describe('format', () => {
  it('fmtPct renders null as em dash by default', () => {
    expect(fmtPct(null)).toBe('—')
    expect(fmtPct(42.5)).toBe('42.5%')
  })

  it('fmtMoney formats whole dollars', () => {
    expect(fmtMoney(1234567)).toBe('$1,234,567')
  })

  it('currentMonthValue returns YYYY-MM', () => {
    expect(currentMonthValue()).toMatch(/^\d{4}-\d{2}$/)
  })

  it('fmtLag handles insufficient samples', () => {
    expect(fmtLag(null, 0)).toBe('insufficient data')
    expect(fmtLag(12, 5)).toBe('12 days (n=5)')
  })
})
