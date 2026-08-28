/**
 * KPI parity cross-check against a live rcm-prototype instance (plan §4
 * / Risk 2c). Loads the golden fixtures (`sample-data/golden/`) into a
 * running rcm-prototype via its own REST API, then diffs
 * `GET /api/reports/client/{code}` against this project's
 * `buildClientReport()` on every field the two shapes share.
 *
 * *** Status in this session: authored, NOT executed. ***
 * rcm-prototype was confirmed live and reachable at
 * http://127.0.0.1:8000 (its OpenAPI schema loads fine), but this script
 * needs valid login credentials for that instance and would create a
 * client + claims/denials/remittances through its API to match the
 * golden fixtures — i.e. it writes into that instance's database. Per
 * the "do not modify rcm-prototype" constraint, and with no credentials
 * available for the running container in this session, running this
 * script was left for a human with access to that instance's admin
 * account to do deliberately, not automated here.
 *
 * How to run it once you have credentials:
 *
 *   1. Make sure rcm-prototype is up: `curl http://127.0.0.1:8000/openapi.json`
 *   2. Log in to get a bearer token:
 *      curl -s -X POST http://127.0.0.1:8000/api/auth/token \
 *        -d "username=<you>&password=<yours>" \
 *        -H 'Content-Type: application/x-www-form-urlencoded'
 *   3. Create a client + seed claims/denials/remittances matching one of
 *      the golden fixtures (`sample-data/golden/gold1-claims-expected.json`
 *      and the seed data documented in `test/kpi-golden.test.ts`) via
 *      rcm-prototype's own `/api/clients` and claim-ingestion endpoints —
 *      this project does not (and must not) write to rcm-prototype's
 *      database directly.
 *   4. RCM_BASE_URL=http://127.0.0.1:8000 RCM_USERNAME=<you> \
 *      RCM_PASSWORD=<yours> RCM_CLIENT_CODE=<the code you seeded> \
 *      RCM_PERIOD=2020-02 npm run crosscheck:rcm
 *
 * This is also the reference implementation for the generic "RCM
 * Platform REST connector" the open-source plan describes (Phase 2) —
 * the auth flow and `/reports/client/{code}` shape here are the
 * documented contract, with rcm-prototype as one deployment of it.
 */
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openDuckDb } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'
import { buildClientReport } from '../src/main/kpi/client-report'
import type { ClientReport } from '../src/shared/domain'

interface CrosscheckConfig {
  baseUrl: string
  username: string
  password: string
  clientCode: string
  periodMonth: string
}

function readConfig(): CrosscheckConfig | null {
  const baseUrl = process.env.RCM_BASE_URL
  const username = process.env.RCM_USERNAME
  const password = process.env.RCM_PASSWORD
  const clientCode = process.env.RCM_CLIENT_CODE
  const periodMonth = process.env.RCM_PERIOD
  if (!baseUrl || !username || !password || !clientCode || !periodMonth) return null
  return { baseUrl, username, password, clientCode, periodMonth }
}

async function login(config: CrosscheckConfig): Promise<string> {
  const body = new URLSearchParams({ username: config.username, password: config.password })
  const res = await fetch(`${config.baseUrl}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { access_token: string }
  return json.access_token
}

async function fetchRcmClientReport(
  config: CrosscheckConfig,
  token: string
): Promise<Record<string, unknown>> {
  const url = new URL(`${config.baseUrl}/api/reports/client/${config.clientCode}`)
  const [start, end] = [`${config.periodMonth}-01`, `${config.periodMonth}-28`] // caller should pass exact bounds if needed
  url.searchParams.set('start', start)
  url.searchParams.set('end', end)
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>
}

/** Fields present in both shapes, camelCase (ours) -> snake_case path (rcm-prototype's), per docs/kpi-parity.md. */
const SHARED_FIELD_MAP: Array<{
  ours: (r: ClientReport) => unknown
  theirs: (r: Record<string, unknown>) => unknown
  label: string
}> = [
  {
    label: 'volume.claimsSubmitted',
    ours: (r) => r.volume.claimsSubmitted,
    theirs: (r) => (r.volume as Record<string, unknown>)?.claims_submitted
  },
  {
    label: 'volume.denialsReceived',
    ours: (r) => r.volume.denialsReceived,
    theirs: (r) => (r.volume as Record<string, unknown>)?.denials_received
  },
  {
    label: 'financials.grossCharges',
    ours: (r) => r.financials.grossCharges,
    theirs: (r) => (r.financials as Record<string, unknown>)?.gross_charges
  },
  {
    label: 'financials.insuranceCollections',
    ours: (r) => r.financials.insuranceCollections,
    theirs: (r) => (r.financials as Record<string, unknown>)?.insurance_collections
  },
  {
    label: 'kpis.openAr',
    ours: (r) => r.kpis.openAr,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.open_ar
  },
  {
    label: 'kpis.daysInAr',
    ours: (r) => r.kpis.daysInAr,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.days_in_ar
  },
  {
    label: 'kpis.denialRatePct',
    ours: (r) => r.kpis.denialRatePct,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.denial_rate_pct
  },
  {
    label: 'kpis.firstPassAcceptancePct',
    ours: (r) => r.kpis.firstPassAcceptancePct,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.first_pass_acceptance_pct
  },
  {
    label: 'arAging.0-30',
    ours: (r) => r.arAging['0-30'],
    theirs: (r) => (r.ar_aging as Record<string, unknown>)?.['0-30']
  },
  {
    label: 'arAging.120+',
    ours: (r) => r.arAging['120+'],
    theirs: (r) => (r.ar_aging as Record<string, unknown>)?.['120+']
  }
]

async function main(): Promise<void> {
  const config = readConfig()
  if (!config) {
    console.error(
      '[crosscheck] Missing config. Set RCM_BASE_URL, RCM_USERNAME, RCM_PASSWORD, RCM_CLIENT_CODE, RCM_PERIOD.\n' +
        "See this file's header comment for the full manual-run procedure."
    )
    process.exitCode = 1
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'aethera-crosscheck-'))
  const db = await openDuckDb(join(dir, 'analytics.duckdb'))
  try {
    await applyMigrations(db.connection, migrations)

    console.log(`[crosscheck] logging in to ${config.baseUrl} as ${config.username}...`)
    const token = await login(config)

    console.log(
      `[crosscheck] fetching rcm-prototype's report for ${config.clientCode} / ${config.periodMonth}...`
    )
    const theirReport = await fetchRcmClientReport(config, token)

    console.log(
      '[crosscheck] you must seed the SAME claim data into this local DuckDB via runCsvImport'
    )
    console.log(
      "[crosscheck] or direct INSERTs before this comparison is meaningful — see this file's header."
    )

    // Placeholder client id: replace once local data has been seeded to
    // match the rcm-prototype client above (documented manual step).
    const clientIdReader = await db.connection.runAndReadAll(
      'SELECT client_id FROM clients WHERE code = ?',
      [config.clientCode]
    )
    const rows = clientIdReader.getRowObjectsJS()
    if (rows.length === 0) {
      throw new Error(
        `No local client with code "${config.clientCode}" — seed matching data locally first (see header comment).`
      )
    }
    const clientId = Number(rows[0].client_id)

    const ourReport = await buildClientReport(db.connection, clientId, config.periodMonth)

    let mismatches = 0
    for (const field of SHARED_FIELD_MAP) {
      const ours = field.ours(ourReport)
      const theirs = field.theirs(theirReport)
      const match =
        ours === theirs ||
        (typeof ours === 'number' && typeof theirs === 'number' && Math.abs(ours - theirs) < 0.01)
      console.log(
        `  ${match ? 'OK  ' : 'DIFF'} ${field.label}: ours=${JSON.stringify(ours)} theirs=${JSON.stringify(theirs)}`
      )
      if (!match) mismatches += 1
    }

    if (mismatches > 0) {
      console.error(`[crosscheck] ${mismatches} field(s) diverged.`)
      process.exitCode = 1
    } else {
      console.log('[crosscheck] all shared fields match.')
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error('[crosscheck] FAILED:', error)
  process.exitCode = 1
})
