-- One row: submitted-claim count + denial count for a scope (a single
-- client, or all active clients when the client param is NULL) and
-- period — feeds the Denials screen's denial-rate trend (plan §5).
-- Deliberately a standalone nullable-client query rather than adding a
-- NULL branch to submitted-claims.sql/denials-in-period.sql, which stay
-- exactly as they are for the already golden-tested single-client
-- report path (Risk 2).
SELECT
  (SELECT COUNT(*) FROM claims c
     WHERE (CAST(? AS BIGINT) IS NULL OR c.client_id = CAST(? AS BIGINT))
       AND c.first_submitted_at >= ? AND c.first_submitted_at <= ?) AS submitted_count,
  (SELECT COUNT(*) FROM denials d JOIN claims c2 ON c2.claim_id = d.claim_id
     WHERE (CAST(? AS BIGINT) IS NULL OR c2.client_id = CAST(? AS BIGINT))
       AND d.created_at >= ? AND d.created_at <= ?) AS denial_count
