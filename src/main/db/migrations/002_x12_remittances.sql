-- Aethera Reports — X12 835 support (plan §3 bullet 2, plan §2 schema
-- note): an 835 remit that doesn't match any known claim is still
-- recorded rather than dropped, with `claim_id = NULL` and a
-- `quarantine_rows` entry surfacing the mismatch (Risk 3's "never fail
-- the job" philosophy, applied to remits instead of CSV rows). The
-- initial schema declared `claim_id NOT NULL` before this case was
-- designed for — relax it here rather than editing 001_init.sql, which
-- has already shipped.
ALTER TABLE remittances ALTER COLUMN claim_id DROP NOT NULL;
