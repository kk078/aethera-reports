-- "First pass acceptance" claim set — production.py line 174:
-- `first_pass = [c for c in submitted if c.submission_count == 1 and not
-- c.denials]`. `not c.denials` means the claim has never had ANY denial
-- (not scoped to the report period) — replicated here via NOT EXISTS
-- over the whole `denials` table, not just denials-in-period.
SELECT c.claim_id
FROM claims c
WHERE c.client_id = ?
  AND c.first_submitted_at >= ? AND c.first_submitted_at <= ?
  AND c.submission_count = 1
  AND NOT EXISTS (SELECT 1 FROM denials d WHERE d.claim_id = c.claim_id)
