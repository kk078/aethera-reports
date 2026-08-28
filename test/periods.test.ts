import { describe, expect, it } from 'vitest'
import {
  daysBetween,
  daysBetweenInclusive,
  monthPeriod,
  parseYearMonth,
  trailing12Months,
  yoyMonth
} from '../src/shared/periods'

describe('parseYearMonth', () => {
  it('parses a valid YYYY-MM', () => {
    expect(parseYearMonth('2026-01')).toEqual({ year: 2026, month: 1 })
  })
  it('throws on malformed input', () => {
    expect(() => parseYearMonth('2026-1')).toThrow()
    expect(() => parseYearMonth('not-a-month')).toThrow()
  })
})

describe('monthPeriod', () => {
  it('returns the full calendar month, UTC', () => {
    expect(monthPeriod('2026-01')).toEqual({ start: '2026-01-01', end: '2026-01-31' })
  })
  it('handles February in a leap year', () => {
    expect(monthPeriod('2020-02')).toEqual({ start: '2020-02-01', end: '2020-02-29' })
  })
  it('handles February in a non-leap year', () => {
    expect(monthPeriod('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })
})

describe('trailing12Months', () => {
  it('returns 12 months ending at the given month, oldest first', () => {
    const months = trailing12Months('2026-03')
    expect(months).toHaveLength(12)
    expect(months[0]).toBe('2025-04')
    expect(months[11]).toBe('2026-03')
  })

  it('crosses a year boundary correctly', () => {
    const months = trailing12Months('2026-01')
    expect(months[0]).toBe('2025-02')
    expect(months[11]).toBe('2026-01')
  })
})

describe('yoyMonth', () => {
  it('subtracts exactly one year', () => {
    expect(yoyMonth('2026-06')).toBe('2025-06')
  })
})

describe('daysBetweenInclusive', () => {
  it('counts both endpoints', () => {
    expect(daysBetweenInclusive('2020-02-01', '2020-02-29')).toBe(29)
    expect(daysBetweenInclusive('2026-01-01', '2026-01-01')).toBe(1)
  })
})

describe('daysBetween', () => {
  it('computes a plain difference, not inclusive', () => {
    expect(daysBetween('2020-02-01', '2020-02-06')).toBe(5)
  })
})
