-- Denials in the period grouped by root cause — production.py lines
-- 176-178:
--   for d in denials: denial_by_cause[d.root_cause_stage] = ... + 1
SELECT COALESCE(d.root_cause_stage, 'unclassified') AS root_cause, COUNT(*) AS n
FROM denials d
JOIN claims c ON c.claim_id = d.claim_id
WHERE c.client_id = ? AND d.created_at >= ? AND d.created_at <= ?
GROUP BY COALESCE(d.root_cause_stage, 'unclassified')
