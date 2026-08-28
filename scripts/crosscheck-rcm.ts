/**
 * KPI parity cross-check against a live rcm-prototype instance (plan §4
 * / Risk 2c). Logs in, fetches `GET /api/reports/client/{code}`, mirrors
 * the same underlying claim facts into a local DuckDB (from a checked-in
 * seed file — see below), builds our own report via `buildClientReport`,
 * and diffs the two on every field the two shapes share.
 *
 * *** Executed 2026-08-28 against the live instance at 127.0.0.1:8000,
 * with explicit user authorization, using a dedicated client (XCHK1)
 * seeded via rcm-prototype's own public API — never by touching its
 * code or database directly. Result: 100% match on every shared field
 * (see docs/kpi-parity.md "Live cross-check results"). ***
 *
 * How XCHK1 was seeded (for reproducing or extending this check):
 *
 *   1. POST /api/auth/token (form-encoded username/password) -> bearer token.
 *   2. POST /api/clients — {"code":"XCHK1", "name":"...", "contract_type":
 *      "PERCENT_OF_COLLECTIONS", "contract_rate":0.05, "sla_days_to_submit":3}
 *   3. POST /api/patients and POST /api/providers — synthetic patients/provider
 *      for XCHK1 (payer_id from GET /api/payers, e.g. "MCR001").
 *   4. POST /api/notes/ingest per encounter (auto_run:true) — runs the note
 *      through AI coding -> charge capture -> scrubbing automatically. Some
 *      synthetic notes intentionally scrub-failed (NCCI unit-count / ICD-10
 *      format issues from ambiguous note wording) and were left as-is
 *      (SCRUB_FAILED is itself a valid, comparable claims_by_status value).
 *   5. For claims that passed scrubbing: complete their ELIGIBILITY_VERIFICATION,
 *      CLAIM_SUBMISSION, and PAYMENT_POSTING work items via
 *      POST /api/work-items/{id}/complete/{eligibility,submission,posting}
 *      (the outcome mix used: two PAID, one DENIED, one PARTIAL).
 *   6. GET /api/claims/{id} per claim to read back the exact resulting
 *      total_charge/allowed/paid/patient_responsibility/adjustments/balance/
 *      status/submitted_at (rcm-prototype's own AI coding and fee-schedule
 *      pricing decide these values — this script never dictates them).
 *   7. Recorded into sample-data/golden/xchk1-live-claims.json (dos values
 *      are from the original /api/notes/ingest payloads — rcm-prototype's
 *      public API doesn't expose date_of_service on GET /api/claims).
 *
 * Run with:
 *   RCM_BASE_URL=http://127.0.0.1:8000 RCM_USERNAME=manager \
 *   RCM_PASSWORD=<pwd> RCM_CLIENT_CODE=XCHK1 RCM_PERIOD=2026-08 \
 *   npm run crosscheck:rcm
 *
 * Credentials are read from the environment only — never hardcode them
 * here (this repository is public).
 */
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openDuckDb } from '../src/main/db/duckdb'
import { applyMigrations } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'
import { buildClientReport } from '../src/main/kpi/client-report'
import type { ClientReport } from '../src/shared/domain'

interface SeedClaim {
  claimNumber: string
  externalRef: string
  dos: string
  createdAt: string
  firstSubmittedAt: string | null
  submissionCount: number
  status: string
  totalCharge: number
  totalAllowed: number
  totalPaid: number
  patientResponsibility: number
  patientPaid: number
  adjustments: number
  balance: number
  denial?: { carcCode: string; rootCauseStage: string; createdAt: string }
}

interface SeedFile {
  clientCode: string
  clientName: string
  contractType: string
  contractRate: number
  slaDaysToSubmit: number
  periodMonth: string
  claims: SeedClaim[]
  remittances: Array<{ claimNumber: string; totalPaid: number; receivedAt: string }>
}

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
  const json = (await res.json()) as { access_token: string; user?: { mfa_required?: boolean } }
  if (json.user?.mfa_required) {
    throw new Error('MFA is required for this account — stopping rather than working around auth.')
  }
  return json.access_token
}

async function fetchRcmClientReport(
  config: CrosscheckConfig,
  token: string
): Promise<Record<string, unknown>> {
  const period = monthBounds(config.periodMonth)
  const url = new URL(`${config.baseUrl}/api/reports/client/${config.clientCode}`)
  url.searchParams.set('start', period.start)
  url.searchParams.set('end', period.end)
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>
}

function monthBounds(yyyyMm: string): { start: string; end: string } {
  const [year, month] = yyyyMm.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start: `${yyyyMm}-01`, end: `${yyyyMm}-${String(lastDay).padStart(2, '0')}` }
}

async function seedLocalMirror(
  seed: SeedFile
): Promise<{ report: ClientReport; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'aethera-crosscheck-'))
  const db = await openDuckDb(join(dir, 'analytics.duckdb'))
  const c = db.connection
  await applyMigrations(c, migrations)

  const clientReader = await c.runAndReadAll(
    `INSERT INTO clients (code, name, contract_type, contract_rate, sla_days_to_submit, active)
     VALUES (?, ?, ?, ?, ?, true) RETURNING client_id`,
    [seed.clientCode, seed.clientName, seed.contractType, seed.contractRate, seed.slaDaysToSubmit]
  )
  const clientId = Number(clientReader.getRowObjectsJS()[0].client_id)

  const claimIds: Record<string, number> = {}
  for (const [i, row] of seed.claims.entries()) {
    const reader = await c.runAndReadAll(
      `INSERT INTO claims (
         client_id, patient_key, claim_number, external_ref, dos, created_at, first_submitted_at,
         submission_count, status, total_charge, total_allowed, total_paid,
         patient_responsibility, patient_paid, adjustments, balance, source, natural_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)
       RETURNING claim_id`,
      [
        clientId,
        `${seed.clientCode}-ph-${i}`,
        row.claimNumber,
        row.externalRef,
        row.dos,
        row.createdAt,
        row.firstSubmittedAt,
        row.submissionCount,
        row.status,
        row.totalCharge,
        row.totalAllowed,
        row.totalPaid,
        row.patientResponsibility,
        row.patientPaid,
        row.adjustments,
        row.balance,
        `${seed.clientCode}-nk-${i}`
      ]
    )
    claimIds[row.claimNumber] = Number(reader.getRowObjectsJS()[0].claim_id)

    if (row.denial) {
      await c.run(
        `INSERT INTO denials (claim_id, carc_code, root_cause_stage, created_at) VALUES (?, ?, ?, ?)`,
        [
          claimIds[row.claimNumber],
          row.denial.carcCode,
          row.denial.rootCauseStage,
          row.denial.createdAt
        ]
      )
    }
  }

  for (const remit of seed.remittances) {
    await c.run(
      `INSERT INTO remittances (claim_id, source, received_at, total_paid) VALUES (?, 'ERA', ?, ?)`,
      [claimIds[remit.claimNumber], remit.receivedAt, remit.totalPaid]
    )
  }

  const report = await buildClientReport(c, clientId, seed.periodMonth)
  return { report, cleanup: () => (db.close(), rmSync(dir, { recursive: true, force: true })) }
}

const SHARED_FIELDS: Array<{
  label: string
  ours: (r: ClientReport) => unknown
  theirs: (r: Record<string, unknown>) => unknown
}> = [
  {
    label: 'client.contract',
    ours: (r) => r.client.contract,
    theirs: (r) => (r.client as Record<string, unknown>)?.contract
  },
  {
    label: 'volume.encountersReceived',
    ours: (r) => r.volume.encountersReceived,
    theirs: (r) => (r.volume as Record<string, unknown>)?.encounters_received
  },
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
    label: 'financials.patientCollections',
    ours: (r) => r.financials.patientCollections,
    theirs: (r) => (r.financials as Record<string, unknown>)?.patient_collections
  },
  {
    label: 'financials.totalCollections',
    ours: (r) => r.financials.totalCollections,
    theirs: (r) => (r.financials as Record<string, unknown>)?.total_collections
  },
  {
    label: 'financials.rcmFee',
    ours: (r) => r.financials.rcmFee,
    theirs: (r) => (r.financials as Record<string, unknown>)?.rcm_fee
  },
  {
    label: 'financials.netCollectionRatePct',
    ours: (r) => r.financials.netCollectionRatePct,
    theirs: (r) => (r.financials as Record<string, unknown>)?.net_collection_rate_pct
  },
  {
    label: 'kpis.daysInAr',
    ours: (r) => r.kpis.daysInAr,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.days_in_ar
  },
  {
    label: 'kpis.openAr',
    ours: (r) => r.kpis.openAr,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.open_ar
  },
  {
    label: 'kpis.arOver90Pct',
    ours: (r) => r.kpis.arOver90Pct,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.ar_over_90_pct
  },
  {
    label: 'kpis.chargeLagDaysAvg',
    ours: (r) => r.kpis.chargeLagDaysAvg,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.charge_lag_days_avg
  },
  {
    label: 'kpis.slaDaysToSubmit',
    ours: (r) => r.kpis.slaDaysToSubmit,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.sla_days_to_submit
  },
  {
    label: 'kpis.slaMetPct',
    ours: (r) => r.kpis.slaMetPct,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.sla_met_pct
  },
  {
    label: 'kpis.firstPassAcceptancePct',
    ours: (r) => r.kpis.firstPassAcceptancePct,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.first_pass_acceptance_pct
  },
  {
    label: 'kpis.denialRatePct',
    ours: (r) => r.kpis.denialRatePct,
    theirs: (r) => (r.kpis as Record<string, unknown>)?.denial_rate_pct
  },
  {
    label: 'arAging.0-30',
    ours: (r) => r.arAging['0-30'],
    theirs: (r) => (r.ar_aging as Record<string, unknown>)?.['0-30']
  },
  {
    label: 'arAging.31-60',
    ours: (r) => r.arAging['31-60'],
    theirs: (r) => (r.ar_aging as Record<string, unknown>)?.['31-60']
  },
  {
    label: 'arAging.61-90',
    ours: (r) => r.arAging['61-90'],
    theirs: (r) => (r.ar_aging as Record<string, unknown>)?.['61-90']
  },
  {
    label: 'arAging.91-120',
    ours: (r) => r.arAging['91-120'],
    theirs: (r) => (r.ar_aging as Record<string, unknown>)?.['91-120']
  },
  {
    label: 'arAging.120+',
    ours: (r) => r.arAging['120+'],
    theirs: (r) => (r.ar_aging as Record<string, unknown>)?.['120+']
  },
  {
    label: 'denialsByRootCause',
    ours: (r) => r.denialsByRootCause,
    theirs: (r) => r.denials_by_root_cause
  },
  { label: 'claimsByStatus', ours: (r) => r.claimsByStatus, theirs: (r) => r.claims_by_status }
]

/** Order-independent for plain objects/maps — {A:1,B:2} and {B:2,A:1} are equal. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.01
  if (a === b) return true
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aRec = a as Record<string, unknown>
    const bRec = b as Record<string, unknown>
    const aKeys = Object.keys(aRec).sort()
    const bKeys = Object.keys(bRec).sort()
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false
    return aKeys.every((k) => deepEqual(aRec[k], bRec[k]))
  }
  return false
}

async function main(): Promise<void> {
  const config = readConfig()
  if (!config) {
    console.error(
      '[crosscheck] Missing config. Set RCM_BASE_URL, RCM_USERNAME, RCM_PASSWORD, RCM_CLIENT_CODE, RCM_PERIOD.\n' +
        "See this file's header comment for the full seeding procedure."
    )
    process.exitCode = 1
    return
  }

  console.log(`[crosscheck] logging in to ${config.baseUrl} as ${config.username}...`)
  const token = await login(config)
  console.log('[crosscheck] login OK (no MFA required for this account).')

  console.log(
    `[crosscheck] fetching rcm-prototype's report for ${config.clientCode} / ${config.periodMonth}...`
  )
  const theirReport = await fetchRcmClientReport(config, token)

  const seedPath = join(
    __dirname,
    '..',
    'sample-data',
    'golden',
    `${config.clientCode.toLowerCase()}-live-claims.json`
  )
  console.log(`[crosscheck] mirroring seed data from ${seedPath} into a local DuckDB...`)
  const seed = JSON.parse(readFileSync(seedPath, 'utf-8')) as SeedFile
  const { report: ourReport, cleanup } = await seedLocalMirror(seed)

  try {
    let mismatches = 0
    for (const field of SHARED_FIELDS) {
      const ours = field.ours(ourReport)
      const theirs = field.theirs(theirReport)
      const match = deepEqual(ours, theirs)
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
    cleanup()
  }
}

main().catch((error: unknown) => {
  console.error('[crosscheck] FAILED:', error)
  process.exitCode = 1
})
