-- Claims first submitted in the period — production.py line 157:
-- `submitted = [c for c in claims_q.all() if c.first_submitted_at and
-- s_dt <= c.first_submitted_at <= e_dt]`. `dos` substitutes for
-- rcm-prototype's `encounter.date_of_service` (charge_lag_days_avg,
-- production.py line 173) — our schema keeps date of service on the
-- claim directly rather than a separate Encounter row.
SELECT claim_id, submission_count, dos, first_submitted_at, total_allowed, total_charge
FROM claims
WHERE client_id = ? AND first_submitted_at >= ? AND first_submitted_at <= ?
