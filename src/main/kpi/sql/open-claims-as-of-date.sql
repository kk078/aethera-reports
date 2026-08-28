-- Claims that were still open "as of" a given date — reconstructs a
-- past month-end's open A/R for the days-in-AR trend (plan §5 AR
-- screen), since there is no historical snapshot table populated yet
-- (see kpi-trends.ts). Uses each claim's CURRENT balance/patient
-- figures as a stand-in for their value as of that date — a documented
-- approximation (see `daysInArTrend` in kpi/analytics.ts), not a
-- fabricated one: exact for a claim still open today, slightly low for
-- one paid down further since the historical date in question.
SELECT balance, patient_responsibility, patient_paid
FROM claims
WHERE (CAST(? AS BIGINT) IS NULL OR client_id = CAST(? AS BIGINT))
  AND (closed_at IS NULL OR closed_at > ?)
  AND COALESCE(first_submitted_at, created_at) <= ?
