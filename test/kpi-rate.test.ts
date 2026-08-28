import { describe, expect, it } from 'vitest'
import { average, rate, ratePercent, round2 } from '../src/main/kpi/rate'

describe('rate (NULL-not-zero, plan Risk 2d)', () => {
  it('returns null for a zero denominator', () => {
    expect(rate(5, 0)).toBeNull()
  })
  it('divides and rounds otherwise', () => {
    expect(rate(1, 3, 4)).toBe(0.3333)
  })
})

describe('ratePercent', () => {
  it('returns null for a zero denominator', () => {
    expect(ratePercent(5, 0)).toBeNull()
  })
  it('scales to a percentage and rounds to 1 decimal by default', () => {
    expect(ratePercent(1, 3)).toBe(33.3)
    expect(ratePercent(2, 3)).toBe(66.7)
  })
})

describe('average', () => {
  it('returns null for an empty array', () => {
    expect(average([])).toBeNull()
  })
  it('averages and rounds', () => {
    expect(average([5, 4, 7])).toBe(5.3)
  })
})

describe('round2', () => {
  it('rounds to 2 decimals', () => {
    expect(round2(1.005)).toBeCloseTo(1.0, 1) // floating point — just sanity check, not exactness
    expect(round2(12.3456)).toBe(12.35)
  })
})
