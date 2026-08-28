-- Aethera Reports hosted client portal (Phase 3 chunk F) — D1 schema.
--
-- This file is the at-a-glance reference copy; the actual migration
-- wrangler applies is migrations/0001_init.sql (kept byte-identical to
-- this file's statements). Never store patient-level data here — a
-- `snapshots.report_json` value is always a `ClientReport` (aggregate
-- KPIs/financials/aging only), enforced by validating/stripping against
-- `src/shared/domain.ts`'s `clientReportSchema` on every publish.

CREATE TABLE IF NOT EXISTS snapshots (
  client_code TEXT NOT NULL,
  period TEXT NOT NULL,
  published_at TEXT NOT NULL,
  report_json TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_code, period)
);

-- Magic-link tokens (plan: "TTL default 30 days"). Only a SHA-256 hash
-- of the token is ever stored — the raw token exists only in the minted
-- URL handed back once to the admin caller and in the recipient's email.
-- Validation looks a presented token up BY its hash (an indexed exact
-- lookup), never by comparing raw strings in application code.
CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  client_code TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_tokens_client_email ON access_tokens (client_code, email);

-- Small free-form KV for whatever the Worker needs to remember about
-- itself (schema version marker, etc.) — not used by application logic
-- yet, included per the plan's stated schema.
CREATE TABLE IF NOT EXISTS admin_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
