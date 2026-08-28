/**
 * Local caching of reference data into DuckDB's `ref_carc`/`ref_cpt`
 * tables (plan §2 schema; beacon paragraph: "cache small reference
 * subsets locally"). Only caches codes that actually appear in this
 * install's data (plan's chunk-C instruction) — never bulk-downloads the
 * reference API's full code sets. Pure DB + reference-api-client calls,
 * no Electron.
 */
import type { DuckDBConnection } from '@duckdb/node-api'
import { fetchCarcDescription, fetchCptDescription } from './reference-api-client'

export interface CacheRefreshResult {
  cached: number
  alreadyCached: number
  notFound: number
}

async function distinctUncachedCarcCodes(connection: DuckDBConnection): Promise<string[]> {
  const reader = await connection.runAndReadAll(
    `SELECT DISTINCT d.carc_code AS code
     FROM denials d
     LEFT JOIN ref_carc r ON r.carc_code = d.carc_code
     WHERE d.carc_code IS NOT NULL AND r.carc_code IS NULL`
  )
  return reader.getRowObjectsJS().map((row) => String(row.code))
}

async function distinctUncachedCptCodes(connection: DuckDBConnection): Promise<string[]> {
  const reader = await connection.runAndReadAll(
    `SELECT DISTINCT cl.cpt_code AS code
     FROM claim_lines cl
     LEFT JOIN ref_cpt r ON r.cpt_code = cl.cpt_code
     WHERE cl.cpt_code IS NOT NULL AND r.cpt_code IS NULL`
  )
  return reader.getRowObjectsJS().map((row) => String(row.code))
}

/** Fetches + upserts descriptions for every CARC code in `denials` not already cached (plan's "codes that actually appear in our data"). */
export async function refreshCarcCache(
  connection: DuckDBConnection,
  baseUrl: string
): Promise<CacheRefreshResult> {
  const codes = await distinctUncachedCarcCodes(connection)
  let cached = 0
  let notFound = 0
  for (const code of codes) {
    const result = await fetchCarcDescription(baseUrl, code)
    if (!result) {
      notFound += 1
      continue
    }
    await connection.run(
      `INSERT INTO ref_carc (carc_code, description) VALUES (?, ?)
       ON CONFLICT (carc_code) DO UPDATE SET description = excluded.description`,
      [code, result.description]
    )
    cached += 1
  }
  return { cached, alreadyCached: 0, notFound }
}

/** Fetches + upserts descriptions for every CPT code in `claim_lines` not already cached. */
export async function refreshCptCache(
  connection: DuckDBConnection,
  baseUrl: string
): Promise<CacheRefreshResult> {
  const codes = await distinctUncachedCptCodes(connection)
  let cached = 0
  let notFound = 0
  for (const code of codes) {
    const result = await fetchCptDescription(baseUrl, code)
    if (!result) {
      notFound += 1
      continue
    }
    await connection.run(
      `INSERT INTO ref_cpt (cpt_code, description) VALUES (?, ?)
       ON CONFLICT (cpt_code) DO UPDATE SET description = excluded.description`,
      [code, result.description]
    )
    cached += 1
  }
  return { cached, alreadyCached: 0, notFound }
}

/** Reads back cached CARC descriptions for the given codes (Denials screen + XLSX export — plan chunk C item 2's last bullet). */
export async function getCachedCarcDescriptions(
  connection: DuckDBConnection,
  codes: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (codes.length === 0) return map
  const placeholders = codes.map(() => '?').join(',')
  const reader = await connection.runAndReadAll(
    `SELECT carc_code, description FROM ref_carc WHERE carc_code IN (${placeholders})`,
    codes
  )
  for (const row of reader.getRowObjectsJS()) {
    if (row.description) map.set(String(row.carc_code), String(row.description))
  }
  return map
}
