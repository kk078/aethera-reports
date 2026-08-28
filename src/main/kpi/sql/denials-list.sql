-- Flat denial list with joined claim/payer/client context (plan §5
-- Denials screen drill-down + plan §6 XLSX "denials list with CARC
-- codes"). CARC pareto / denials-by-payer / root-cause breakdown are all
-- derived from this SAME row set client-side (grouped by carc_code,
-- payer_name, root_cause_stage respectively) rather than three separate
-- aggregate queries.
--
-- Nullable client_id: NULL means "all active clients" (the Denials
-- screen's default); the per-client XLSX export always passes a real
-- client_id.
SELECT
  d.denial_id,
  cl.code AS client_code,
  c.claim_number,
  c.external_ref,
  c.dos,
  COALESCE(p.name, 'Unknown') AS payer_name,
  d.carc_code,
  d.rarc_code,
  COALESCE(d.category, 'unclassified') AS category,
  d.root_cause_stage,
  d.description,
  d.recovered_amount,
  d.created_at,
  d.resolved_at
FROM denials d
JOIN claims c ON c.claim_id = d.claim_id
JOIN clients cl ON cl.client_id = c.client_id
LEFT JOIN payers p ON p.payer_id = c.payer_id
WHERE (CAST(? AS BIGINT) IS NULL OR c.client_id = CAST(? AS BIGINT))
  AND d.created_at >= ? AND d.created_at <= ?
ORDER BY d.created_at DESC
