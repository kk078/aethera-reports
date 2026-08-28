-- Point-in-time (not period-scoped) open claims for `open_ar` and A/R
-- aging — production.py lines 164-172:
--   open_claims = claims_q.filter(Claim.status.notin_([ClaimStatus.CLOSED])).all()
--   open_ar = sum(c.balance + max(c.patient_responsibility - c.patient_paid, 0) for c in open_claims)
--   anchor = c.first_submitted_at or c.created_at
--   bucket = "0-30" if d <= 30 else "31-60" if d <= 60 else "61-90" if d <= 90 else "91-120" if d <= 120 else "120+"
-- rcm-prototype tests an enum status; our schema tracks a free-text
-- status plus a `closed_at` timestamp, so `closed_at IS NULL` is the
-- equivalent "still open" test. Bucketing and the balance expression
-- itself are computed in TS from these raw rows (see client-report.ts)
-- to keep the exact `max(x - y, 0)` / day-bucket logic in one place,
-- shared with `financials`/`kpis` composition.
SELECT
  claim_id,
  balance,
  patient_responsibility,
  patient_paid,
  COALESCE(first_submitted_at, created_at) AS anchor
FROM claims
WHERE client_id = ? AND closed_at IS NULL
