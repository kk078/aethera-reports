-- Claims created in the period, for `volume.encounters_received` (our
-- schema has no separate Encounter entity, so a created claim is the
-- closest proxy) and `financials.gross_charges` (plan §4; production.py
-- lines 156, 162: `created = claims_q.filter(Claim.created_at.between(...))`,
-- `charges = sum(c.total_charge for c in created)`).
SELECT claim_id, total_charge
FROM claims
WHERE client_id = ? AND created_at >= ? AND created_at <= ?
