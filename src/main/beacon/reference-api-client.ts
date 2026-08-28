/**
 * HTTP client for the generic Reference & Benchmark API connector (the
 * "beacon" paragraph in the plan's "Existing assets" section; "Open-
 * source requirements" names this the *Reference & Benchmark API
 * connector* in public docs — internally this module is called
 * `reference-api`, never "beacon," to keep the code generic even though
 * `/home/aethera/projects/beacon` is the reference deployment this was
 * verified against, at `http://127.0.0.1:8110`).
 *
 * Every function here is best-effort and NEVER throws: this is optional
 * enrichment (plan) — a staff PC off-LAN, or no reference API configured
 * at all, must degrade to "no data" instantly, not an error dialog. Pure
 * `fetch`, no Electron import (importable from `LocalDataService`).
 */

const DEFAULT_TIMEOUT_MS = 3_000

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** `GET {base}/health` — never throws; `false` covers "unreachable," "timed out," and "responded but not ok." */
export async function checkReferenceApiHealth(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  const result = await getJson<{ ok?: boolean }>(`${normalizeBaseUrl(baseUrl)}/health`, timeoutMs)
  return result?.ok === true
}

export interface CarcDescription {
  code: string
  description: string
}

/** `GET {base}/denial/{carc}` — a bare numeric/alpha CARC code (e.g. "45"), no group-code prefix. */
export async function fetchCarcDescription(
  baseUrl: string,
  carcCode: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CarcDescription | null> {
  const result = await getJson<{ code?: string; description?: string }>(
    `${normalizeBaseUrl(baseUrl)}/denial/${encodeURIComponent(carcCode)}`,
    timeoutMs
  )
  if (!result?.description) return null
  return { code: carcCode, description: result.description }
}

export interface CptDescription {
  code: string
  description: string
}

/** `GET {base}/lookup/cpt/{code}` — verified against the live reference deployment's `/lookup/{codeset}/{code}` route. */
export async function fetchCptDescription(
  baseUrl: string,
  cptCode: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CptDescription | null> {
  const result = await getJson<{ long_desc?: string | null; short_desc?: string | null }>(
    `${normalizeBaseUrl(baseUrl)}/lookup/cpt/${encodeURIComponent(cptCode)}`,
    timeoutMs
  )
  const description = result?.long_desc ?? result?.short_desc
  if (!description) return null
  return { code: cptCode, description }
}

export interface CommercialBenchmarkResult {
  code: string
  state: string
  /** The blended/overall row (`payer_group: "Other"`) — see benchmark.ts's header comment for why this one row. */
  medianRate: number | null
  p25: number | null
  p75: number | null
  sampleCount: number | null
}

/**
 * `GET {base}/price/commercial/{code}?state=...` — verified against the
 * live reference deployment. Returns multiple rows (one per
 * `payer_group`); this picks the `payer_group: "Other"` row as the
 * overall state benchmark (the largest-sample, blended-across-payers
 * row in every observed response) rather than surfacing per-payer detail
 * in v1.
 */
export async function fetchCommercialBenchmark(
  baseUrl: string,
  code: string,
  state: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CommercialBenchmarkResult | null> {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/price/commercial/${encodeURIComponent(code)}`)
  url.searchParams.set('state', state)
  const result = await getJson<{
    benchmarks?: Array<{
      payer_group?: string
      median_rate?: number
      p25?: number
      p75?: number
      n?: number
    }>
  }>(url.toString(), timeoutMs)

  const overall =
    result?.benchmarks?.find((b) => b.payer_group === 'Other') ?? result?.benchmarks?.[0]
  if (!overall) return null
  return {
    code,
    state,
    medianRate: overall.median_rate ?? null,
    p25: overall.p25 ?? null,
    p75: overall.p75 ?? null,
    sampleCount: overall.n ?? null
  }
}
