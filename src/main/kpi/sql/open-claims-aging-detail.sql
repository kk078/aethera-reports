-- Point-in-time open claims across a scope (a single client, or all
-- active clients when the client param is NULL), with enough joined
-- context (client code, claim number, payer, dos) to drive the AR
-- screen's aging-by-client chart, payer-vs-patient split, and top-aged-
-- claims table (plan §5). Bucketing/amount math happens in TS via
-- `kpi/aging.ts` — the same helper the single-client report
-- (open-claims-aging.sql) uses, so thresholds can't drift between the
-- two paths.
SELECT
  c.claim_id,
  cl.code AS client_code,
  c.claim_number,
  c.external_ref,
  c.dos,
  COALESCE(p.name, 'Unknown') AS payer_name,
  c.balance,
  c.patient_responsibility,
  c.patient_paid,
  COALESCE(c.first_submitted_at, c.created_at) AS anchor
FROM claims c
JOIN clients cl ON cl.client_id = c.client_id
LEFT JOIN payers p ON p.payer_id = c.payer_id
WHERE c.closed_at IS NULL
  AND (CAST(? AS BIGINT) IS NULL OR c.client_id = CAST(? AS BIGINT))
