/**
 * Report scheduler due-logic (plan §11) — deliberately pure and
 * Electron-free: every function here takes `now: Date` as an explicit
 * parameter rather than calling `Date.now()`/`new Date()` itself, so
 * "missed-run catch-up on launch" and "run at most once per period" are
 * fully unit-testable with an injected clock instead of real wall-clock
 * waits. The actual work a due rule triggers (export + email) lives in
 * `run-scheduler.ts`, which calls into this module rather than folding
 * the two concerns together.
 */
import type { AutomationRule } from '../../shared/domain'

export type { AutomationRule }

export interface DueRule {
  rule: AutomationRule
  /** The prior-month period (plan §11: `period: prior_month`) this run would generate for. */
  periodMonth: string
}

/** The `"YYYY-MM"` period immediately before `now`'s month, in UTC. */
export function priorMonthPeriod(now: Date): string {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * A rule is due when: enabled, today's day-of-month has reached
 * `dayOfMonth` (so a rule scheduled for the 3rd stays "due" every day
 * from the 3rd through month-end if it hasn't run yet — the missed-run
 * catch-up), and it hasn't already run for the period it would generate
 * (the once-per-period guard).
 */
export function isRuleDue(rule: AutomationRule, now: Date): boolean {
  if (!rule.enabled) return false
  if (now.getUTCDate() < rule.dayOfMonth) return false
  return rule.lastRunPeriod !== priorMonthPeriod(now)
}

/** Every currently-due rule, paired with the period it should generate for. */
export function selectDueRules(rules: AutomationRule[], now: Date): DueRule[] {
  const period = priorMonthPeriod(now)
  return rules.filter((rule) => isRuleDue(rule, now)).map((rule) => ({ rule, periodMonth: period }))
}

/** Resolves a rule's `clients: 'all' | string[]` against the live active-client-code list. */
export function resolveRuleClientCodes(
  rule: AutomationRule,
  activeClientCodes: string[]
): string[] {
  if (rule.clients === 'all') return activeClientCodes
  const wanted = new Set(rule.clients.map((c) => c.toUpperCase()))
  return activeClientCodes.filter((code) => wanted.has(code.toUpperCase()))
}
