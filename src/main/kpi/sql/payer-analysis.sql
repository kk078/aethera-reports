-- Consolidated per-payer analytics for the Payers screen (plan §5):
-- claim volume/charges/allowed (for "payer mix" + "avg allowed vs
-- charge"), denial count (for "denial rate by payer"), and average
-- submission-to-remittance lag in days (for "payment lag when
-- computable" — a payer with zero remittances in scope gets a NULL
-- avg_lag_days and a 0 lag_sample_count; the caller renders "insufficient
-- data" rather than fabricating a number). Nullable client_id scopes to
-- "all active clients" when NULL.
--
-- `IS NOT DISTINCT FROM` (not `=`) joins the CTEs on payer_id because
-- claims.payer_id is nullable — a plain `=` would silently drop every
-- no-payer claim's denial/lag numbers (NULL = NULL is NULL, not true).
WITH claim_agg AS (
  SELECT c.payer_id,
         COUNT(*) AS claims_count,
         SUM(c.total_charge) AS total_charge,
         SUM(CASE WHEN c.total_allowed = 0 THEN c.total_charge ELSE c.total_allowed END) AS total_allowed
  FROM claims c
  WHERE (CAST(? AS BIGINT) IS NULL OR c.client_id = CAST(? AS BIGINT))
    AND c.created_at >= ? AND c.created_at <= ?
  GROUP BY c.payer_id
),
denial_agg AS (
  SELECT c.payer_id, COUNT(*) AS denial_count
  FROM denials d
  JOIN claims c ON c.claim_id = d.claim_id
  WHERE (CAST(? AS BIGINT) IS NULL OR c.client_id = CAST(? AS BIGINT))
    AND d.created_at >= ? AND d.created_at <= ?
  GROUP BY c.payer_id
),
lag_agg AS (
  SELECT c.payer_id,
         AVG(date_diff('day', c.first_submitted_at, r.received_at)) AS avg_lag_days,
         COUNT(*) AS lag_sample_count
  FROM remittances r
  JOIN claims c ON c.claim_id = r.claim_id
  WHERE c.first_submitted_at IS NOT NULL
    AND r.received_at IS NOT NULL
    AND (CAST(? AS BIGINT) IS NULL OR c.client_id = CAST(? AS BIGINT))
    AND r.received_at >= ? AND r.received_at <= ?
  GROUP BY c.payer_id
)
SELECT
  ca.payer_id,
  COALESCE(p.name, 'Unknown') AS payer_name,
  ca.claims_count,
  ca.total_charge,
  ca.total_allowed,
  COALESCE(da.denial_count, 0) AS denial_count,
  la.avg_lag_days,
  COALESCE(la.lag_sample_count, 0) AS lag_sample_count
FROM claim_agg ca
LEFT JOIN payers p ON p.payer_id = ca.payer_id
LEFT JOIN denial_agg da ON da.payer_id IS NOT DISTINCT FROM ca.payer_id
LEFT JOIN lag_agg la ON la.payer_id IS NOT DISTINCT FROM ca.payer_id
ORDER BY ca.total_charge DESC
