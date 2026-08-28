/** Public surface of the generic RCM Platform REST connector (plan §3 bullet 3). */
export {
  loginRcmPlatform,
  fetchRcmPortfolio,
  fetchRcmClientReport,
  RcmConnectorError,
  type RcmConnectorErrorKind
} from './client'
export {
  findOrCreateClientForSync,
  upsertMonthlySummaryFromReport,
  upsertKpiSnapshotFromReport,
  portfolioRowIdentity,
  type FindOrCreateClientResult
} from './sync'
export type {
  RcmAuthTokenResponse,
  RcmClientReportRaw,
  RcmConnectorConfig,
  RcmPortfolioResponse,
  RcmPortfolioRow
} from './types'
