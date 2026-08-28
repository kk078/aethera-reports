# KPI parity contract

Risk 2 mitigation (plan): every KPI this app computes, its formula, and
the exact rcm-prototype source line it was ported from. **Any formula
edit in `src/main/kpi/` must update this table in the same PR.**

Source files referenced below (read-only reference, never modified):

- `production.py` = `/home/aethera/rcm-prototype/app/services/production.py`
- `kpi.py` = `/home/aethera/rcm-prototype/app/services/kpi.py`

Our implementation lives in `src/main/kpi/client-report.ts` (composition),
`src/main/kpi/kpi-trends.ts` (snapshot series), `src/main/kpi/rate.ts`
(the one shared null-safe rate helper), and `src/main/kpi/sql/*.sql`
(DuckDB aggregation, one file per query).

## Schema differences this port had to bridge

rcm-prototype's `client_report()` reads from a richer schema
(`Encounter`, `ProductionEvent`, `AIUsage`, `CodingResult`, specialty
packs) that this app's Phase 1 schema (plan §2) doesn't have. Every
substitution is called out below and in a code comment at its call site.
Two fields (`specialty`, `ai_coding`) have no analog at all and are
**omitted from our output**, not stubbed with fake data.

| rcm-prototype concept | Our substitute | Why |
|---|---|---|
| `Encounter` row | the `claims` row itself | we don't model encounters separately from claims |
| `encounter.date_of_service` | `claims.dos` | date of service lives directly on the claim in our schema |
| `ClaimStatus.CLOSED` enum check | `claims.closed_at IS NULL` | our `status` column is free text; `closed_at` is the authoritative "still open" signal |
| Patient payments via `ProductionEvent` ledger | `payments_patient` table | we have a dedicated patient-payment table (plan §2); more direct than reconstructing it from a production-tracking ledger |
| `kpi_snapshots` populated by a daily sweeper | same table, but **no sweeper exists yet** | the automation suite (plan §11) that would populate this on a schedule is out of Phase 1's scope; `kpi_trends` correctly returns the empty shape until it does |

## Field-by-field contract

### `volume`

| Field | Formula | Source |
|---|---|---|
| `encountersReceived` | count of claims with `created_at` in the period | production.py L156, L162 (via `created`) |
| `claimsSubmitted` | count of claims with `first_submitted_at` in the period | production.py L157 |
| `denialsReceived` | count of denials with `created_at` in the period, joined to this client's claims | production.py L163 |

### `financials`

| Field | Formula | Source |
|---|---|---|
| `grossCharges` | `sum(total_charge)` over claims created in the period | production.py L162 |
| `insuranceCollections` | `sum(remittances.total_paid)` where `received_at` in period | production.py L160 |
| `patientCollections` | `sum(payments_patient.amount)` where `received_at` in period (substitute — see table above) | production.py L161 |
| `totalCollections` | `insuranceCollections + patientCollections` | production.py L182 |
| `rcmFee` | `totalCollections * contractRate` if `contractType === 'PERCENT_OF_COLLECTIONS'`, else `claimsSubmitted * contractRate` | production.py L183 |
| `netCollectionRatePct` | `null` if no submitted claims; else `100 * totalCollections / sum(allowedOrCharge)` where `allowedOrCharge = totalAllowed \|\| totalCharge` (0 is falsy, exactly like Python's `or`) | production.py L197 — **deviation:** if the sum is 0 despite submitted claims existing, Python raises `ZeroDivisionError`; we return `null` instead of crashing (no meaningful value to diff against a crash) |

### `kpis`

| Field | Formula | Source |
|---|---|---|
| `daysInAr` | `null` if `avgDailyCharge` is 0; else `openAr / avgDailyCharge`, 1 decimal. `avgDailyCharge = grossCharges / max(1, inclusive days in period)` | production.py L175, L198 |
| `openAr` | `sum(balance + max(patientResponsibility - patientPaid, 0))` over open claims (`closed_at IS NULL`) | production.py L165 |
| `arOver90Pct` | **verbatim quirk — NOT null-safe:** `0` (not `null`) when `openAr` is 0, unlike every other rate field. Else `100 * (aging['91-120'] + aging['120+']) / openAr` | production.py L199 |
| `chargeLagDaysAvg` | `null` if no submitted claims have both `dos` and `first_submitted_at`; else average of `(first_submitted_at - dos)` in days | production.py L173, L175, L200 |
| `slaDaysToSubmit` | pass-through from `clients.sla_days_to_submit` | production.py L200 |
| `slaMetPct` | `null` if no lag samples or client has no SLA configured; else `100 * count(lag <= slaDaysToSubmit) / count(lag)` | production.py L201 — deviation: Python would crash comparing against a `None` SLA; we return `null` |
| `firstPassAcceptancePct` | `null` if no submitted claims; else `100 * firstPassCount / submittedCount`. First-pass = `submissionCount === 1 AND` claim has never had any denial (not period-scoped) | production.py L174, L202 |
| `denialRatePct` | `null` if no submitted claims; else `100 * denialsInPeriodCount / submittedCount` — **note:** numerator (denials *received* in period) and denominator (claims *submitted* in period) are not the same claim set; this mismatch exists in rcm-prototype too, not "fixed" here | production.py L203 |

### `arAging`

Buckets `0-30` / `31-60` / `61-90` / `91-120` / `120+`, each
`sum(balance + max(patientResponsibility - patientPaid, 0))` for open
claims whose `age = today - COALESCE(first_submitted_at, created_at)`
falls in that bucket. `today` is the actual wall-clock date the report is
generated on — **not** the report period's end date — matching
rcm-prototype's point-in-time aging exactly.

Source: production.py L166-172 (bucket boundaries and the balance
expression are copied verbatim).

### `denialsByRootCause`

`GROUP BY root_cause_stage, COUNT(*)` over denials received in the
period. Source: production.py L176-178.

### `claimsByStatus`

`GROUP BY status, COUNT(*)` over **all** claims ever for this client —
not period-scoped, matching `_status_counts(claims_q.all())`. Source:
production.py L210, L214-218.

### `kpiTrends`

Trailing 180-day `kpi_snapshots` series for this client, plus 7-day/
30-day deltas against the oldest snapshot at least that many days older
than the latest. Source: kpi.py L116-136 (`kpi_trends`). Currently always
returns the empty shape (`series: [], latest: null, deltas: {}`) — see
schema-differences table above.

### `payerMix`

Not present in rcm-prototype's `client_report()` — added for the
dashboard's payer-mix chart (plan §5/§6): charges by payer, for claims
created in the period, sorted descending. Excluded from `scripts/crosscheck-rcm.ts`'s
comparison since there's nothing on the rcm-prototype side to diff it
against.

### `source`

Not present in rcm-prototype's output — new provenance field (plan §4)
so exports can footnote which fallback rung produced the numbers:
`"claims"` (claim-level data existed for this client), `"manual"` (no
claims at all; fell back to the client-month's `monthly_summaries` row),
or `"synced"` (Phase 2: populated by the rcm-prototype/RCM-platform
connector — not used yet).

## The one shared `rate()` helper

`src/main/kpi/rate.ts` exports `rate(num, den, decimals)` — `null` when
`den` is falsy, otherwise `round(num/den, decimals)` — mirroring
`kpi.py`'s `_rate()` (L27-28) exactly. `ratePercent()` and `average()`
are built on top of it so every percentage/average field in this file
goes through the same one null-guard, per Risk 2(d): "one shared `rate()`
helper so NULL semantics can't diverge per-KPI." The single documented
exception is `arOver90Pct`, which intentionally does **not** use the
null-safe path — see its row above.

## Verification

- **Golden fixtures** (`sample-data/golden/`): hand-computed expected
  `ClientReport` JSON for small, fully-specified claim sets, including an
  empty-client-month case that must produce nulls, not zeros, everywhere
  the table above says `null`. Run via `npm test` (`test/kpi-golden.test.ts`).
- **Cross-check against live rcm-prototype** (`scripts/crosscheck-rcm.ts`):
  loads the same golden fixtures into a running rcm-prototype instance via
  its own API and diffs `/api/reports/client/{code}` against
  `buildClientReport()` on every shared field. See that script's header
  comment for how to run it — it was authored but not executed against
  the live instance in this session (no credentials were available for
  the running container, and seeding data into it without valid
  credentials risks writing to a live system this project must not
  modify).
