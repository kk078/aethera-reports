-- Aethera Reports — analytics.duckdb initial schema (plan §2).
-- Column names deliberately mirror rcm-prototype's models
-- (/home/aethera/rcm-prototype/app/models.py) so the KPI engine (Phase 1
-- step 7) can port formulas verbatim.

-- ---------------------------------------------------------------------
-- Sequences (DuckDB has no AUTOINCREMENT; nextval() on a sequence is the
-- idiomatic surrogate-key pattern).
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS seq_stg_rows START 1;
CREATE SEQUENCE IF NOT EXISTS seq_quarantine_rows START 1;
CREATE SEQUENCE IF NOT EXISTS seq_clients START 1;
CREATE SEQUENCE IF NOT EXISTS seq_providers START 1;
CREATE SEQUENCE IF NOT EXISTS seq_payers START 1;
CREATE SEQUENCE IF NOT EXISTS seq_claims START 1;
CREATE SEQUENCE IF NOT EXISTS seq_claim_lines START 1;
CREATE SEQUENCE IF NOT EXISTS seq_remittances START 1;
CREATE SEQUENCE IF NOT EXISTS seq_payments_patient START 1;
CREATE SEQUENCE IF NOT EXISTS seq_denials START 1;
CREATE SEQUENCE IF NOT EXISTS seq_import_jobs START 1;

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
CREATE TYPE payer_class_t AS ENUM ('Medicare', 'Medicaid', 'Commercial', 'TRICARE', 'WorkersComp', 'SelfPay', 'Other');
CREATE TYPE claim_source_t AS ENUM ('csv', 'x12', 'api', 'manual');
CREATE TYPE remit_source_t AS ENUM ('EOB', 'ERA');
CREATE TYPE import_status_t AS ENUM ('running', 'succeeded', 'succeeded_with_warnings', 'failed');

-- ---------------------------------------------------------------------
-- Staging: every import lands here raw before mapping, so a mapping fix
-- can be re-run without re-reading the source file (plan §2/§3, Risk 3).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg_rows (
  stg_row_id BIGINT PRIMARY KEY DEFAULT nextval('seq_stg_rows'),
  import_job_id BIGINT NOT NULL,
  source_row_num INTEGER NOT NULL,
  payload JSON NOT NULL
);

-- ---------------------------------------------------------------------
-- import_jobs — one row per import attempt. file_sha256 lets the
-- importer make re-importing the same file a no-op (plan §2).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_jobs (
  job_id BIGINT PRIMARY KEY DEFAULT nextval('seq_import_jobs'),
  source_type VARCHAR NOT NULL,
  file_name VARCHAR,
  file_sha256 VARCHAR,
  mapping_template_id VARCHAR,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP,
  status import_status_t NOT NULL DEFAULT 'running',
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_loaded INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  error JSON
);

-- Row-level quarantine (Risk 3): a single bad row never fails the whole
-- job — it lands here with a reason and the job finishes with a warning
-- count instead.
CREATE TABLE IF NOT EXISTS quarantine_rows (
  quarantine_id BIGINT PRIMARY KEY DEFAULT nextval('seq_quarantine_rows'),
  import_job_id BIGINT NOT NULL,
  source_row_num INTEGER NOT NULL,
  target_entity VARCHAR NOT NULL,
  payload JSON NOT NULL,
  reasons JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- Canonical tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
  client_id BIGINT PRIMARY KEY DEFAULT nextval('seq_clients'),
  code VARCHAR NOT NULL UNIQUE,
  name VARCHAR NOT NULL,
  contract_type VARCHAR,
  contract_rate DOUBLE,
  sla_days_to_submit INTEGER,
  report_recipients JSON,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS providers (
  provider_id BIGINT PRIMARY KEY DEFAULT nextval('seq_providers'),
  client_id BIGINT NOT NULL REFERENCES clients (client_id),
  npi VARCHAR,
  name VARCHAR,
  specialty VARCHAR
);

CREATE TABLE IF NOT EXISTS payers (
  payer_id BIGINT PRIMARY KEY DEFAULT nextval('seq_payers'),
  name VARCHAR NOT NULL,
  payer_class payer_class_t,
  external_ids JSON,
  timely_filing_days INTEGER
);

-- patient_key is a one-way hash (plan §7 PHI minimization) — never a raw
-- name/DOB. balance/patient_responsibility math for A/R aging is defined
-- in the KPI engine (Phase 1 step 7), not here.
CREATE TABLE IF NOT EXISTS claims (
  claim_id BIGINT PRIMARY KEY DEFAULT nextval('seq_claims'),
  client_id BIGINT NOT NULL REFERENCES clients (client_id),
  provider_id BIGINT REFERENCES providers (provider_id),
  payer_id BIGINT REFERENCES payers (payer_id),
  patient_key VARCHAR NOT NULL,
  claim_number VARCHAR,
  external_ref VARCHAR,
  dos DATE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_submitted_at TIMESTAMP,
  submission_count INTEGER NOT NULL DEFAULT 1,
  status VARCHAR,
  total_charge DECIMAL(14, 2) NOT NULL DEFAULT 0,
  total_allowed DECIMAL(14, 2) NOT NULL DEFAULT 0,
  total_paid DECIMAL(14, 2) NOT NULL DEFAULT 0,
  patient_responsibility DECIMAL(14, 2) NOT NULL DEFAULT 0,
  patient_paid DECIMAL(14, 2) NOT NULL DEFAULT 0,
  adjustments DECIMAL(14, 2) NOT NULL DEFAULT 0,
  balance DECIMAL(14, 2) NOT NULL DEFAULT 0,
  closed_at TIMESTAMP,
  source claim_source_t NOT NULL,
  import_job_id BIGINT,
  natural_key VARCHAR NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS claim_lines (
  line_id BIGINT PRIMARY KEY DEFAULT nextval('seq_claim_lines'),
  claim_id BIGINT NOT NULL REFERENCES claims (claim_id),
  line_number INTEGER NOT NULL,
  cpt_code VARCHAR,
  modifiers JSON,
  units DOUBLE,
  charge_amount DECIMAL(14, 2),
  allowed_amount DECIMAL(14, 2),
  paid_amount DECIMAL(14, 2),
  adjustment_codes JSON
);

CREATE TABLE IF NOT EXISTS remittances (
  remit_id BIGINT PRIMARY KEY DEFAULT nextval('seq_remittances'),
  claim_id BIGINT NOT NULL REFERENCES claims (claim_id),
  source remit_source_t NOT NULL,
  check_number VARCHAR,
  received_at TIMESTAMP,
  total_paid DECIMAL(14, 2),
  patient_responsibility DECIMAL(14, 2),
  payer_icn VARCHAR
);

CREATE TABLE IF NOT EXISTS payments_patient (
  payment_id BIGINT PRIMARY KEY DEFAULT nextval('seq_payments_patient'),
  client_id BIGINT NOT NULL REFERENCES clients (client_id),
  claim_id BIGINT REFERENCES claims (claim_id),
  received_at TIMESTAMP,
  amount DECIMAL(14, 2)
);

CREATE TABLE IF NOT EXISTS denials (
  denial_id BIGINT PRIMARY KEY DEFAULT nextval('seq_denials'),
  claim_id BIGINT NOT NULL REFERENCES claims (claim_id),
  carc_code VARCHAR,
  rarc_code VARCHAR,
  description VARCHAR,
  category VARCHAR,
  root_cause_stage VARCHAR,
  recovered_amount DECIMAL(14, 2),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);

-- Manual-entry fallback — authoritative for a client-month when
-- claim-level data hasn't been imported. prior_values captures the
-- previous row as JSON on every update (audit trail, plan §3/step 6).
CREATE TABLE IF NOT EXISTS monthly_summaries (
  client_id BIGINT NOT NULL REFERENCES clients (client_id),
  period_month DATE NOT NULL,
  charges DECIMAL(14, 2),
  ins_collections DECIMAL(14, 2),
  pt_collections DECIMAL(14, 2),
  adjustments DECIMAL(14, 2),
  open_ar DECIMAL(14, 2),
  ar_aging_0_30 DECIMAL(14, 2),
  ar_aging_31_60 DECIMAL(14, 2),
  ar_aging_61_90 DECIMAL(14, 2),
  ar_aging_91_120 DECIMAL(14, 2),
  ar_aging_120_plus DECIMAL(14, 2),
  claims_submitted INTEGER,
  denials_count INTEGER,
  notes VARCHAR,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  prior_values JSON,
  PRIMARY KEY (client_id, period_month)
);

-- client_id is nullable (org-level snapshot) — DuckDB allows NULL in a
-- non-PK, non-UNIQUE column, so no special handling needed here; the KPI
-- engine (step 7) writes NULL-not-zero rate fields per the `rate()`
-- convention (plan §4 / kpi.py `_rate()`).
CREATE TABLE IF NOT EXISTS kpi_snapshots (
  client_id BIGINT REFERENCES clients (client_id),
  snapshot_date DATE NOT NULL,
  denial_rate DOUBLE,
  first_pass_rate DOUBLE,
  clean_claim_rate DOUBLE,
  days_to_cash DOUBLE,
  days_in_ar DOUBLE,
  open_ar DECIMAL(14, 2),
  ar_over_90_pct DOUBLE,
  net_collection_rate DOUBLE
);

-- ---------------------------------------------------------------------
-- Reference tables — small, bundled and/or beacon-refreshed (Phase 2).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref_carc (
  carc_code VARCHAR PRIMARY KEY,
  description VARCHAR,
  category VARCHAR
);

CREATE TABLE IF NOT EXISTS ref_cpt (
  cpt_code VARCHAR PRIMARY KEY,
  description VARCHAR
);

CREATE TABLE IF NOT EXISTS ref_payers_directory (
  payer_key VARCHAR PRIMARY KEY,
  name VARCHAR,
  payer_class payer_class_t,
  timely_filing_days INTEGER
);
