-- Insurance collections in the period — production.py line 160:
-- `ins_paid = db.query(func.coalesce(func.sum(Remittance.total_paid), 0))
-- .join(Claim).filter(Claim.client_id == client.id,
-- Remittance.received_at.between(s_dt, e_dt)).scalar()`.
SELECT COALESCE(SUM(r.total_paid), 0) AS total
FROM remittances r
JOIN claims c ON c.claim_id = r.claim_id
WHERE c.client_id = ? AND r.received_at >= ? AND r.received_at <= ?
