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
