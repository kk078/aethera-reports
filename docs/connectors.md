# Connectors

Aethera Reports ships two **generic, optional, URL-configurable**
connectors (plan §3 bullet 3; "Open-source requirements"). Neither one
is wired to any specific vendor or hosted service — both point at
whatever base URL you configure in Settings, and both are entirely
optional: the app is fully usable with CSV/XLSX/X12 imports and manual
entry alone.

This document describes the **public API contract** each connector
speaks. It does not describe any private deployment — the reference
implementations named below are examples you can point the app at (or
build your own compatible service against), not dependencies.

## 1. RCM Platform REST connector

Pulls a portfolio's computed monthly report numbers from an external RCM
platform into `monthly_summaries`/`kpi_snapshots`, with provenance
`synced` (as opposed to `claims` — imported claim-level data — or
`manual` — the Manual Entry screen). It syncs **computed report JSON,
not raw claims** — the contract below doesn't expose (or require) a
claim-level data dump.

Configure in **Settings → RCM Platform connector**: base URL, username,
password (encrypted at rest — see "Credential storage" below).

### Auth

```
POST {base}/api/auth/token
Content-Type: application/x-www-form-urlencoded

username=<username>&password=<password>
```

OAuth2 "password" grant shape (the same form `curl`/Swagger's "Authorize"
button send). Response:

```json
{ "access_token": "…", "token_type": "bearer" }
```

If the account requires a second factor, respond with `mfa_required:
true` at the top level instead of a usable token — the connector has no
interactive MFA step, so it treats this as a configuration error
("use a service account with MFA disabled") rather than retrying.

Every subsequent request sends `Authorization: Bearer <access_token>`.
A `401` at any point is treated as "token expired/invalid" and surfaces
clearly in Settings/sync status — the connector does not silently retry
forever.

### `GET {base}/api/reports/clients`

Portfolio list — every active client's headline numbers for a period.

```
GET {base}/api/reports/clients?start=2026-04-01&end=2026-04-30
Authorization: Bearer <token>
```

```json
{
  "period": { "start": "2026-04-01", "end": "2026-04-30" },
  "clients": [
    {
      "client": "ACME",
      "name": "Acme Health Group",
      "encounters": 120,
      "charges": 45000,
      "...": "..."
    }
  ]
}
```

Only `client` (the code — matched against/created in our `clients.code`)
and `name` are required by the connector; everything else in each row is
ignored (the per-client detail call below is the source of truth for
what actually gets synced).

### `GET {base}/api/reports/client/{code}`

The client-facing computed report for one client + period — this is the
shape the connector actually maps into `monthly_summaries`/
`kpi_snapshots`.

```
GET {base}/api/reports/client/ACME?start=2026-04-01&end=2026-04-30
Authorization: Bearer <token>
```

```json
{
  "client": { "code": "ACME", "name": "Acme Health Group", "contract": "5% of collections" },
  "period": { "start": "2026-04-01", "end": "2026-04-30" },
  "volume": { "encounters_received": 120, "claims_submitted": 110, "denials_received": 8 },
  "financials": {
    "gross_charges": 45000,
    "insurance_collections": 32000,
    "patient_collections": 1200,
    "total_collections": 33200,
    "rcm_fee": 1660,
    "net_collection_rate_pct": 71.2
  },
  "kpis": {
    "days_in_ar": 28.4,
    "open_ar": 12500,
    "ar_over_90_pct": 9.1,
    "charge_lag_days_avg": 2.3,
    "sla_days_to_submit": 3,
    "sla_met_pct": 91.0,
    "first_pass_acceptance_pct": 88.5,
    "denial_rate_pct": 7.3
  },
  "ar_aging": { "0-30": 5000, "31-60": 3000, "61-90": 2000, "91-120": 1500, "120+": 1000 },
  "denials_by_root_cause": { "CODING": 4, "ELIGIBILITY": 2 },
  "claims_by_status": { "Paid": 90, "Denied": 8, "Open": 12 }
}
```

Mapped into `monthly_summaries` (numeric fields directly; `ar_aging`
buckets → the matching `ar_aging_*` columns) and into one
`kpi_snapshots` row per sync, dated the period's end date
(`denial_rate`, `first_pass_rate`, `days_in_ar`, `open_ar`,
`ar_over_90_pct`, `net_collection_rate` — `clean_claim_rate` and
`days_to_cash` are left `NULL`: this endpoint doesn't expose them; see
"Not yet consumed" below).

### Sync behavior

- **Client matching**: by `code`. A portfolio row whose code doesn't
  match an existing client creates one (`active: true`) — flagged
  "created by connector" in the Settings sync-status list.
- **Idempotent**: re-syncing the same period is a no-op change-wise
  (upserts, not inserts) — safe to run repeatedly (e.g. from a scheduled
  task once the automation suite lands).
- **Per-client failure isolation**: one client's report failing to fetch
  (network error, `404`, malformed JSON) never aborts the sync for the
  rest — that client's sync status shows the error, others still update.
- **Sync cursor/status**: per-client `last_synced_period`,
  `last_synced_at`, `last_status`, `last_error` are tracked in meta.db
  (SQLite) and shown in Settings.

### Not yet consumed

`GET {base}/api/reports/kpi-trends` exists in the reference
implementation (a daily KPI snapshot series with richer fields —
`clean_claim_rate`, `days_to_cash`) but is **not** pulled by this
version of the connector; only the single-period `client/{code}` report
is synced. This is a deliberate v1 scope decision, not an oversight —
extending the sync to backfill a full snapshot history from that
endpoint is a natural follow-up.

### Reference implementation

`rcm-prototype` — a FastAPI RCM back-office application used during this
project's development — implements this exact contract at
`/api/auth/token` and `/api/reports/*`; this document was written
against its live behavior. It's referenced here purely as an example of
a compatible service (it's not a public project and this app has no
dependency on it): any platform that exposes the same three endpoints
with the same shapes works with this connector, pointed at whatever base
URL you configure (e.g. `http://127.0.0.1:8000` for a local instance —
Settings has no notion of "the" RCM platform, only "a" base URL).

### Credential storage

The password is encrypted at rest using Electron's `safeStorage` (OS
keychain/DPAPI/libsecret, depending on platform) before it ever touches
`meta.db`. On a machine/setup where OS-level encryption isn't available
(`safeStorage.isEncryptionAvailable()` returns `false` — some
minimal Linux setups with no keyring), the app falls back to storing the
password in **plaintext** rather than refusing to save it — Settings
surfaces a clear warning when this fallback is active. This is a
documented tradeoff (plan §7), not a silent downgrade.

## 2. Reference & Benchmark API connector

Optional local enrichment — CARC/RARC denial descriptions, CPT
descriptions, and commercial-payer rate percentile benchmarks. No
authentication; degrades gracefully (short timeout, cached health state)
whenever unreachable, which is expected on a staff machine that's off
the LAN where a reference deployment runs.

Configure in **Settings → Reference & Benchmark API**: base URL
(default `http://127.0.0.1:8110`), enabled toggle.

### `GET {base}/health`

```json
{ "ok": true }
```

Anything other than `ok: true` (including a network error, timeout, or
non-2xx status) is treated as "unreachable" — the app never surfaces a
raw HTTP error for this endpoint, only a boolean the caller checks.

### `GET {base}/denial/{carc}`

A bare CARC code (e.g. `45`, not `CO-45` — the group code and reason
code are separate concepts in X12; this endpoint takes the reason code
alone).

```json
{ "code": "45", "description": "Charge exceeds fee schedule/maximum allowable..." }
```

Cached into `ref_carc` for every CARC code that actually appears in this
install's `denials` table (never bulk-downloaded) — refreshed on demand
from Settings and automatically (fire-and-forget) after every CSV/X12
import. The Denials screen and the XLSX export's Denials sheet show the
cached description next to each code when available.

### `GET {base}/lookup/cpt/{code}`

```json
{ "code": "99213", "short_desc": null, "long_desc": "Office o/p est low 20 min" }
```

`long_desc` (falling back to `short_desc`) is cached into `ref_cpt` for
every CPT code that appears in `claim_lines`, same policy as CARC codes
above.

### `GET {base}/price/commercial/{code}?state=XX`

Commercial-payer rate percentiles for a CPT/HCPCS code in a state,
broken out by `payer_group`.

```json
{
  "code": "99213",
  "benchmarks": [
    {
      "payer_group": "Other",
      "payer_type": "Other",
      "n": 40275,
      "median_rate": 168.75,
      "p25": 70.6,
      "p75": 231.0
    },
    { "payer_group": "BCBS", "payer_type": "Commercial", "n": 8144, "median_rate": 231.0 }
  ]
}
```

The connector uses the `payer_group: "Other"` row as the overall
state benchmark (the largest-sample, blended-across-payers row observed
in every response) — per-payer detail (`BCBS`, `Aetna`, etc.) is
returned by the API but not surfaced by this version of the app.

Powers the **benchmark block** in `ClientReport` (`report.benchmark`) —
avg allowed on the client's top 3 CPT codes by charge volume this
period, vs. the state median/p25/p75 — rendered as a callout section on
the report doc/PDF, but **only** when: the connector is enabled, the
client has a `state` set (Clients screen), the reference API answers
healthy, and at least one CPT came back with benchmark data. Every other
case is a clean `null` — no placeholder, no fabricated numbers. This
block has no equivalent in rcm-prototype's report shape and is
deliberately excluded from the KPI parity crosscheck (`docs/kpi-parity.md`).

### Reference deployment

`beacon` — a local read-only reference/benchmark API over
CPT/ICD/HCPCS/CARC/RARC code sets, CMS fee schedules, a payer directory,
and a 10M+-row commercial-rate percentile database, used during this
project's development — is the reference deployment this contract was
verified against, running at `http://127.0.0.1:8110`. It's referenced
here purely as an example of a compatible service (it's not a public
project and this app has no dependency on it). Any service exposing
`/health`, `/denial/{carc}`, `/lookup/cpt/{code}`, and
`/price/commercial/{code}` with the shapes above works.
