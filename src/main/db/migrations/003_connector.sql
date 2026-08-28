-- Phase 2 chunk C: generic RCM Platform connector + Reference & Benchmark
-- connector support.
--
-- monthly_summaries.source distinguishes a human-entered month (Phase 1
-- Manual Entry screen — 'manual', the existing default/behavior,
-- unchanged) from one the RCM Platform connector synced in ('synced') —
-- buildClientReport (kpi/client-report.ts) reads this to set
-- ClientReport.source, matching the plan's provenance model
-- ("claims" | "manual" | "synced").
--
-- No `NOT NULL` here: DuckDB's `ALTER TABLE ... ADD COLUMN` does not yet
-- support adding a column with a constraint ("Parser Error: Adding
-- columns with constraints not yet supported", verified against the
-- pinned @duckdb/node-api version) — `DEFAULT 'manual'` alone is
-- supported and is all application code relies on; every write path
-- (upsertMonthlySummary, the connector's sync.ts) always sets this
-- column explicitly, so it is never actually null in practice.
ALTER TABLE monthly_summaries ADD COLUMN source VARCHAR DEFAULT 'manual';

-- clients.state: per-client US state, used by the Reference & Benchmark
-- connector to scope its `/price/commercial/{code}?state=...` percentile
-- lookup (the beacon paragraph in "Existing assets"). Nullable — the
-- benchmark block simply doesn't render when a client has no state set.
ALTER TABLE clients ADD COLUMN state VARCHAR;
