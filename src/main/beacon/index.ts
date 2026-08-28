/** Public surface of the generic Reference & Benchmark API connector (see this dir's header comments — internally "reference-api", never "beacon"). */
export {
  checkReferenceApiHealth,
  fetchCarcDescription,
  fetchCptDescription,
  fetchCommercialBenchmark,
  type CarcDescription,
  type CptDescription,
  type CommercialBenchmarkResult
} from './reference-api-client'
export {
  refreshCarcCache,
  refreshCptCache,
  getCachedCarcDescriptions,
  type CacheRefreshResult
} from './cache'
export { buildBenchmarkBlock } from './benchmark'
