/**
 * Wire shapes for the generic RCM Platform REST connector (plan §3
 * bullet 3; "Open-source requirements" — generic connectors section).
 * These mirror rcm-prototype's JSON verbatim (snake_case, as returned by
 * `/home/aethera/rcm-prototype/app/routers/reports.py` and `auth.py`) —
 * rcm-prototype is the documented *reference implementation* of this
 * contract, not a hardcoded dependency; any platform exposing the same
 * shapes at a configurable base URL works. See `docs/connectors.md` for
 * the full public contract.
 */

export interface RcmAuthTokenResponse {
  access_token?: string
  token_type?: string
  /** Present (true) instead of a usable access_token when a second factor is still needed — see auth.py `_login()`. */
  mfa_required?: boolean
  user?: { mfa_required?: boolean }
}

export interface RcmPortfolioRow {
  client: string
  name: string
  facility_type?: string
  encounters?: number
  charges?: number
  collections?: number
  fee?: number
  days_in_ar?: number | null
  denial_rate_pct?: number | null
  sla_met_pct?: number | null
}

export interface RcmPortfolioResponse {
  period: { start: string; end: string }
  clients: RcmPortfolioRow[]
}

/** `GET /api/reports/client/{code}` — the shape `client-report.ts`'s ClientReport is designed to be diffable against (see scripts/crosscheck-rcm.ts). */
export interface RcmClientReportRaw {
  client: { code: string; name: string; contract: string }
  period: { start: string; end: string }
  volume: { encounters_received: number; claims_submitted: number; denials_received: number }
  financials: {
    gross_charges: number
    insurance_collections: number
    patient_collections: number
    total_collections: number
    rcm_fee: number
    net_collection_rate_pct: number | null
  }
  kpis: {
    days_in_ar: number | null
    open_ar: number
    ar_over_90_pct: number
    charge_lag_days_avg: number | null
    sla_days_to_submit: number | null
    sla_met_pct: number | null
    first_pass_acceptance_pct: number | null
    denial_rate_pct: number | null
  }
  ar_aging: Record<string, number>
  denials_by_root_cause: Record<string, number>
  claims_by_status: Record<string, number>
}

export interface RcmConnectorConfig {
  baseUrl: string
  username: string
  password: string
  /** ms before an HTTP call is aborted — the connector must never hang app startup or a Sync-now click indefinitely. */
  timeoutMs?: number
}

// ---------------------------------------------------------------------
// Claim-level sync (837 submission batches + claim/denial enrichment) —
// see docs/connectors.md "Claim-level sync" section. These mirror
// rcm-prototype's `/api/clients`, `/api/batches`, and `/api/claims`
// verbatim; like the summary-sync shapes above, this is the documented
// *reference implementation's* wire shape, not a hardcoded dependency.
// ---------------------------------------------------------------------

/** `GET /api/clients` row — only the fields the connector actually reads; the platform's response carries many more. */
export interface RcmPlatformClientRow {
  id: number
  code: string
  name: string
}

/** `GET /api/batches` row (`SubmissionBatch` in rcm-prototype). `status` is a free-text field there ('OPEN' | 'SUBMITTED' | 'ACKNOWLEDGED' in the reference implementation) — the connector only special-cases 'OPEN' (still being assembled, not yet final). */
export interface RcmBatchRow {
  id: number
  batch_number: string
  client_id: number
  status: string
  claims: number
  total_charge: number
  clearinghouse_ref?: string
  created_at: string
}

export interface RcmClaimLineRow {
  line_number?: number
  cpt_code?: string | null
  /** e.g. `["CO-16", "PR-1"]` — group code + CARC hyphen-joined, the reference implementation's compact encoding of an X12 CAS adjustment (no separate amount per code). */
  adjustment_codes?: string[]
}

/** `GET /api/claims` row (also what `GET /api/claims/{id}` returns) — the claim-detail/list shape the enrichment step reads. */
export interface RcmClaimRow {
  id: number
  claim_number: string
  client_id: number
  batch_id?: number | null
  status?: string | null
  external_ref?: string | null
  total_charge: number
  total_allowed: number
  total_paid: number
  patient_responsibility: number
  patient_paid: number
  adjustments: number
  balance: number
  lines?: RcmClaimLineRow[]
}
