-- Nullable-client sibling of created-claims.sql, used by the days-in-AR
-- trend reconstruction across all clients (plan §5 AR screen). Kept
-- separate so created-claims.sql itself (used by the golden-tested
-- single-client report) never changes shape.
SELECT claim_id, total_charge
FROM claims
WHERE (CAST(? AS BIGINT) IS NULL OR client_id = CAST(? AS BIGINT))
  AND created_at >= ? AND created_at <= ?
