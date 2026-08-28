-- Payer mix (charges by payer) for claims created in the period. Not
-- part of rcm-prototype's client_report() shape — a new field added for
-- the dashboard's payer-mix chart (plan §5/§6), so it's excluded from
-- the KPI parity contract (docs/kpi-parity.md) rather than compared
-- against rcm-prototype.
SELECT COALESCE(p.name, 'Unknown') AS payer_name, SUM(c.total_charge) AS charges
FROM claims c
LEFT JOIN payers p ON p.payer_id = c.payer_id
WHERE c.client_id = ? AND c.created_at >= ? AND c.created_at <= ?
GROUP BY COALESCE(p.name, 'Unknown')
ORDER BY charges DESC
