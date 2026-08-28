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
  payerMix
} as const
