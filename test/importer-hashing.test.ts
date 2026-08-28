import { describe, expect, it } from 'vitest'
import { computeNaturalKey, hashPatientKey } from '../src/main/importers/csv-xlsx/hashing'

describe('hashPatientKey', () => {
  it('is deterministic for the same input', () => {
    expect(hashPatientKey('PT-100', 'DEMO1')).toBe(hashPatientKey('PT-100', 'DEMO1'))
  })

  it('never returns the raw identifier', () => {
    const hashed = hashPatientKey('PT-100', 'DEMO1')
    expect(hashed).not.toContain('PT-100')
    expect(hashed).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
  })

  it('namespaces by client so the same account number differs across clients', () => {
    expect(hashPatientKey('PT-100', 'DEMO1')).not.toBe(hashPatientKey('PT-100', 'DEMO2'))
  })
})

describe('computeNaturalKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeNaturalKey('csv', 'DEMO1', 'CLM-1', '2026-01-15')
    const b = computeNaturalKey('csv', 'DEMO1', 'CLM-1', '2026-01-15')
    expect(a).toBe(b)
  })

  it('differs when any component differs', () => {
    const base = computeNaturalKey('csv', 'DEMO1', 'CLM-1', '2026-01-15')
    expect(computeNaturalKey('csv', 'DEMO1', 'CLM-2', '2026-01-15')).not.toBe(base)
    expect(computeNaturalKey('csv', 'DEMO2', 'CLM-1', '2026-01-15')).not.toBe(base)
    expect(computeNaturalKey('x12', 'DEMO1', 'CLM-1', '2026-01-15')).not.toBe(base)
  })
})
