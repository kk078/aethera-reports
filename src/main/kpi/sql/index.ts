import createdClaims from './created-claims.sql?raw'
import submittedClaims from './submitted-claims.sql?raw'
import denialsInPeriod from './denials-in-period.sql?raw'
import openClaimsAging from './open-claims-aging.sql?raw'
import insuranceCollections from './insurance-collections.sql?raw'
import patientCollections from './patient-collections.sql?raw'
import claimsByStatus from './claims-by-status.sql?raw'
import denialsByRootCause from './denials-by-root-cause.sql?raw'
import firstPassClaims from './first-pass-claims.sql?raw'
import kpiSnapshotSeries from './kpi-snapshot-series.sql?raw'
import payerMix from './payer-mix.sql?raw'
// Cross-client analytics screens (plan §5, Phase 2 chunk B) — every
// query below is scoped by a NULLABLE client_id ("all active clients"
// when NULL), unlike the single-client-only queries above.
import denialsList from './denials-list.sql?raw'
import denialRateTrendInputs from './denial-rate-trend-inputs.sql?raw'
import openClaimsAgingDetail from './open-claims-aging-detail.sql?raw'
import createdClaimsScoped from './created-claims-scoped.sql?raw'
import openClaimsAsOfDate from './open-claims-as-of-date.sql?raw'
import payerMixScoped from './payer-mix-scoped.sql?raw'
import payerAnalysis from './payer-analysis.sql?raw'

export const kpiSql = {
  createdClaims,
  submittedClaims,
  denialsInPeriod,
  openClaimsAging,
  insuranceCollections,
  patientCollections,
  claimsByStatus,
  denialsByRootCause,
  firstPassClaims,
  kpiSnapshotSeries,
  payerMix,
  denialsList,
  denialRateTrendInputs,
  openClaimsAgingDetail,
  createdClaimsScoped,
  openClaimsAsOfDate,
  payerMixScoped,
  payerAnalysis
} as const
