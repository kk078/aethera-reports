-- Charges by payer for a scope (a single client, or all active clients
-- when NULL) and period — the nullable-client sibling of payer-mix.sql,
-- called once per trailing month to build the Payers screen's "mix over
-- time" trend (plan §5). payer-mix.sql itself stays single-client-only
-- and unchanged (used by buildClientReport).
SELECT COALESCE(p.name, 'Unknown') AS payer_name, SUM(c.total_charge) AS charges
FROM claims c
LEFT JOIN payers p ON p.payer_id = c.payer_id
WHERE (CAST(? AS BIGINT) IS NULL OR c.client_id = CAST(? AS BIGINT))
  AND c.created_at >= ? AND c.created_at <= ?
GROUP BY COALESCE(p.name, 'Unknown')
ORDER BY charges DESC
