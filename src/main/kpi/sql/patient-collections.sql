-- Patient collections in the period. rcm-prototype derives this from a
-- ProductionEvent ledger it doesn't expose to us (production.py line
-- 161); our schema has a dedicated `payments_patient` table (plan §2),
-- which is the more direct source for the same concept: money the
-- patient actually paid, in the period.
SELECT COALESCE(SUM(amount), 0) AS total
FROM payments_patient
WHERE client_id = ? AND received_at >= ? AND received_at <= ?
