-- ALL claims ever for this client, grouped by status — NOT period-scoped
-- (production.py lines 210, 214-218: `_status_counts(claims_q.all())`
-- operates on the client's entire claim history, unlike every other
-- field in the report).
SELECT status, COUNT(*) AS n
FROM claims
WHERE client_id = ?
GROUP BY status
