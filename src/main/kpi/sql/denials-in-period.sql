-- Denials received in the period — production.py line 163:
-- `denials = db.query(Denial).join(Claim).filter(Claim.client_id ==
-- client.id, Denial.created_at.between(s_dt, e_dt)).all()`.
SELECT d.denial_id, d.claim_id, d.root_cause_stage
FROM denials d
JOIN claims c ON c.claim_id = d.claim_id
WHERE c.client_id = ? AND d.created_at >= ? AND d.created_at <= ?
