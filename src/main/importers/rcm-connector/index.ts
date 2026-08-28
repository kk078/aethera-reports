/** Public surface of the generic RCM Platform REST connector (plan §3 bullet 3; claim-level sync per docs/connectors.md). */
export {
  loginRcmPlatform,
  fetchRcmPortfolio,
  fetchRcmClientReport,
  fetchRcmClients,
  fetchRcmBatches,
  fetchRcmBatchEdi837,
  fetchRcmClaimsPage,
  fetchAllRcmClaims,
  RcmConnectorError,
  type RcmConnectorErrorKind
} from './client'
export {
  findOrCreateClientForSync,
  upsertMonthlySummaryFromReport,
  upsertKpiSnapshotFromReport,
  portfolioRowIdentity,
  findLocalClientIdByCode,
  countApiSourcedClaims,
  findApiClaimIdByIdentifier,
  enrichClaimFromPlatform,
  type FindOrCreateClientResult
} from './sync'
export type {
  RcmAuthTokenResponse,
  RcmBatchRow,
  RcmClaimLineRow,
  RcmClaimRow,
  RcmClientReportRaw,
  RcmConnectorConfig,
  RcmPlatformClientRow,
  RcmPortfolioResponse,
  RcmPortfolioRow
} from './types'
