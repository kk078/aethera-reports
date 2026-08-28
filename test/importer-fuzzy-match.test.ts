import { describe, expect, it } from 'vitest'
import { suggestColumnMappings } from '../src/main/importers/csv-xlsx/fuzzy-match'
import { CLAIM_LINE_TARGET_FIELDS } from '../src/main/importers/csv-xlsx'

describe('suggestColumnMappings', () => {
  it('matches an exact target field name', () => {
    const [suggestion] = suggestColumnMappings(['Charge Amount'], CLAIM_LINE_TARGET_FIELDS)
    expect(suggestion.suggestedField).toBe('chargeAmount')
    expect(suggestion.confidence).toBe(1)
  })

  it('matches via a declared synonym with a small spelling variation', () => {
    const [suggestion] = suggestColumnMappings(['Claim #'], CLAIM_LINE_TARGET_FIELDS)
    expect(suggestion.suggestedField).toBe('claimNumber')
  })

  it('leaves an unrelated header unmapped', () => {
    const [suggestion] = suggestColumnMappings(['Office Fax Number'], CLAIM_LINE_TARGET_FIELDS)
    expect(suggestion.suggestedField).toBeNull()
  })
})
