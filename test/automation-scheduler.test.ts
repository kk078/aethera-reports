/**
 * Report scheduler due-logic tests (plan §11, Phase 2 chunk D) — pure
 * functions, injected clock throughout (never `Date.now()`/`new Date()`
 * inside `scheduler.ts` itself), covering the once-per-period guard and
 * the missed-run catch-up behavior the plan calls for.
 */
import { describe, expect, it } from 'vitest'
import {
  isRuleDue,
  priorMonthPeriod,
  resolveRuleClientCodes,
  selectDueRules
} from '../src/main/automation/scheduler'
import type { AutomationRule } from '../src/shared/domain'

function makeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    ruleId: 'rule-1',
    name: 'Monthly pack',
    dayOfMonth: 3,
    clients: 'all',
    formats: ['pdf'],
    outputDir: null,
    deliver: 'none',
    enabled: true,
    lastRunPeriod: null,
    lastRunAt: null,
    lastRunStatus: null,
    ...overrides
  }
}

describe('priorMonthPeriod', () => {
  it('returns the prior month within the same year', () => {
    expect(priorMonthPeriod(new Date(Date.UTC(2026, 2, 15)))).toBe('2026-02') // March -> February
  })

  it('rolls over the year boundary', () => {
    expect(priorMonthPeriod(new Date(Date.UTC(2026, 0, 15)))).toBe('2025-12') // January -> prior December
  })
})

describe('isRuleDue', () => {
  it('is false when the rule is disabled, regardless of date', () => {
    const rule = makeRule({ enabled: false, dayOfMonth: 1 })
    expect(isRuleDue(rule, new Date(Date.UTC(2026, 5, 20)))).toBe(false)
  })

  it('is false before the scheduled day-of-month arrives', () => {
    const rule = makeRule({ dayOfMonth: 10 })
    expect(isRuleDue(rule, new Date(Date.UTC(2026, 5, 5)))).toBe(false)
  })

  it('is true on the scheduled day when it has not run for the resulting period yet', () => {
    const rule = makeRule({ dayOfMonth: 10, lastRunPeriod: null })
    expect(isRuleDue(rule, new Date(Date.UTC(2026, 5, 10)))).toBe(true)
  })

  it('stays true past the scheduled day if the app was closed — missed-run catch-up', () => {
    const rule = makeRule({ dayOfMonth: 3, lastRunPeriod: null })
    // The app wasn't open on the 3rd; the first tick happens on the 20th.
    expect(isRuleDue(rule, new Date(Date.UTC(2026, 5, 20)))).toBe(true)
  })

  it('is false once it has already run for the period it would generate — the once-per-period guard', () => {
    const now = new Date(Date.UTC(2026, 5, 20)) // June 20 -> would generate for May
    const rule = makeRule({ dayOfMonth: 3, lastRunPeriod: priorMonthPeriod(now) })
    expect(isRuleDue(rule, now)).toBe(false)
  })

  it('becomes due again once a new month/period rolls around after a prior run', () => {
    const rule = makeRule({ dayOfMonth: 3, lastRunPeriod: '2026-04' }) // ran for April
    // Now in June, due period is May — different from the last-run period.
    expect(isRuleDue(rule, new Date(Date.UTC(2026, 5, 10)))).toBe(true)
  })
})

describe('selectDueRules', () => {
  it('returns only due rules, each paired with the period it should generate for', () => {
    const now = new Date(Date.UTC(2026, 5, 20))
    const due = makeRule({ ruleId: 'due-1', dayOfMonth: 3, lastRunPeriod: null })
    const notYet = makeRule({ ruleId: 'not-yet', dayOfMonth: 25, lastRunPeriod: null })
    const alreadyRan = makeRule({
      ruleId: 'already-ran',
      dayOfMonth: 3,
      lastRunPeriod: priorMonthPeriod(now)
    })
    const disabled = makeRule({ ruleId: 'disabled', dayOfMonth: 1, enabled: false })

    const result = selectDueRules([due, notYet, alreadyRan, disabled], now)

    expect(result).toEqual([{ rule: due, periodMonth: priorMonthPeriod(now) }])
  })

  it('returns an empty array when nothing is due', () => {
    const now = new Date(Date.UTC(2026, 5, 1))
    const rule = makeRule({ dayOfMonth: 15 })
    expect(selectDueRules([rule], now)).toEqual([])
  })
})

describe('resolveRuleClientCodes', () => {
  it('returns every active client code for "all"', () => {
    const rule = makeRule({ clients: 'all' })
    expect(resolveRuleClientCodes(rule, ['ACME', 'BETA'])).toEqual(['ACME', 'BETA'])
  })

  it('filters to the requested codes, case-insensitively', () => {
    const rule = makeRule({ clients: ['acme'] })
    expect(resolveRuleClientCodes(rule, ['ACME', 'BETA'])).toEqual(['ACME'])
  })

  it('drops requested codes that are no longer active', () => {
    const rule = makeRule({ clients: ['ACME', 'GONE'] })
    expect(resolveRuleClientCodes(rule, ['ACME', 'BETA'])).toEqual(['ACME'])
  })
})
