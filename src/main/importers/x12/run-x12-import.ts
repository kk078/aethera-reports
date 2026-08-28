/**
 * X12 835/837 import orchestration (plan §3 bullet 2 "Registry
 * integration"). Mirrors `run-csv-import.ts`'s job bookkeeping and dedup
 * conventions exactly (file_sha256 short-circuit, `import_jobs` progress,
 * row-level quarantine that never fails the whole job) so the two
 * pipelines behave identically from the Imports screen's point of view.
 *
 * - 835: upserts `remittances` and updates the matching claim's
 *   paid/allowed/balance (matched by `claim_number`/`external_ref`
 *   within the picked client). A remit that matches no claim is still
 *   recorded (`remittances.claim_id = NULL`, plan §2 schema note) and
 *   surfaced as a quarantine row, same as an invalid CSV row (Risk 3).
 *   CAS adjustments on a matched claim become `denials` rows carrying
 *   the CARC code.
 * - 837: upserts `claims`/`claim_lines` using the same
 *   find-by-`natural_key`-then-UPDATE-or-INSERT pattern as
 *   `upsertClaimShell` in the CSV importer (never `ON CONFLICT DO
 *   UPDATE` — DuckDB's FK-constrained delete+reinsert implementation of
 *   that trips the moment a second line already references the claim;
 *   see that file's header comment for the full story). Provenance is
 *   `source: 'x12'` on every claim this path writes by default — the RCM
 *   Platform connector's claim-level sync passes `claimSource: 'api'`
 *   (see `RunX12ImportInput`) to mark claims pulled from a platform
 *   batch's 837.edi instead of a manual Imports Wizard upload.
 *
 * Client attribution for both is "the client picked in the wizard",
 * exactly like the CSV path — X12 files carry payer/provider identity
 * but not our internal client code.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DuckDBConnection } from '@duckdb/node-api'
import type { ImportStatus } from '../../../shared/domain'
import { hashPatientKey, computeNaturalKey } from '../csv-xlsx/hashing'
import { parse835, type Remit835Adjustment, type Remit835Claim } from './parse835'
import { parse837, type Claim837, type Claim837ServiceLine } from './parse837'
import { CAS_GROUP_CATEGORY } from './common'

export interface RunX12ImportInput {
  connection: DuckDBConnection
  filePath: string
  clientCode: string
  /**
   * `claims.source` (and the natural-key namespace, see `hashing.ts`) for
   * every claim this 837 run touches — defaults to `'x12'` (the Imports
   * Wizard's manual-upload path). The RCM Platform connector's
   * claim-level sync (`LocalDataService.runClaimLevelConnectorSync`)
   * passes `'api'` here so claims it pulls via `GET
   * {base}/api/batches/{id}/837.edi` carry the connector's provenance
   * (plan's claim-level sync chunk) instead of masquerading as a manual
   * X12 upload. Ignored by `run835Import` — remittances have no
   * equivalent provenance split.
   */
  claimSource?: 'x12' | 'api'
}

export interface RunX12ImportResult {
  jobId: number
  status: ImportStatus
  rowsRead: number
  rowsLoaded: number
  rowsSkipped: number
  reusedExistingJob: boolean
  /** Parser-level structural warnings (orphan segments, etc.) — folded into quarantine rows too, exposed here for tests/e2e output. */
  warnings: string[]
}

// ---------------------------------------------------------------------
// Shared job-bookkeeping helpers (deliberately duplicated from
// `run-csv-import.ts` rather than imported — the two pipelines are
// independent importer registrations and this keeps each one
// self-contained; see that file for the identical CSV-side versions).
// ---------------------------------------------------------------------

async function findSucceededJobBySha(
  connection: DuckDBConnection,
  sourceType: string,
  fileSha256: string
): Promise<RunX12ImportResult | null> {
  const reader = await connection.runAndReadAll(
    `SELECT job_id, status, rows_read, rows_loaded, rows_skipped
     FROM import_jobs
     WHERE source_type = ? AND file_sha256 = ? AND status IN ('succeeded', 'succeeded_with_warnings')
     ORDER BY started_at DESC
     LIMIT 1`,
    [sourceType, fileSha256]
  )
  const rows = reader.getRowObjectsJS()
  if (rows.length === 0) return null
  const row = rows[0]
  return {
    jobId: Number(row.job_id),
    status: row.status as ImportStatus,
    rowsRead: Number(row.rows_read),
    rowsLoaded: Number(row.rows_loaded),
    rowsSkipped: Number(row.rows_skipped),
    reusedExistingJob: true,
    warnings: []
  }
}

async function getClientId(connection: DuckDBConnection, clientCode: string): Promise<number> {
  const reader = await connection.runAndReadAll('SELECT client_id FROM clients WHERE code = ?', [
    clientCode
  ])
  const rows = reader.getRowObjectsJS()
  if (rows.length === 0) throw new Error(`Unknown client code: ${clientCode}`)
  return Number(rows[0].client_id)
}

async function insertImportJob(
  connection: DuckDBConnection,
  args: { sourceType: string; fileName: string; fileSha256: string }
): Promise<number> {
  const reader = await connection.runAndReadAll(
    `INSERT INTO import_jobs (source_type, file_name, file_sha256, status)
     VALUES (?, ?, ?, 'running')
     RETURNING job_id`,
    [args.sourceType, args.fileName, args.fileSha256]
  )
  return Number(reader.getRowObjectsJS()[0].job_id)
}

async function finishImportJob(
  connection: DuckDBConnection,
  jobId: number,
  args: {
    status: ImportStatus
    rowsRead: number
    rowsLoaded: number
    rowsSkipped: number
    error?: string
  }
): Promise<void> {
  await connection.run(
    `UPDATE import_jobs
     SET status = ?, rows_read = ?, rows_loaded = ?, rows_skipped = ?, finished_at = now(), error = ?
     WHERE job_id = ?`,
    [
      args.status,
      args.rowsRead,
      args.rowsLoaded,
      args.rowsSkipped,
      args.error ? JSON.stringify({ message: args.error }) : null,
      jobId
    ]
  )
}

async function insertQuarantineRow(
  connection: DuckDBConnection,
  jobId: number,
  rowNumber: number,
  targetEntity: string,
  payload: unknown,
  reasons: string[]
): Promise<void> {
  await connection.run(
    'INSERT INTO quarantine_rows (import_job_id, source_row_num, target_entity, payload, reasons) VALUES (?, ?, ?, ?, ?)',
    [jobId, rowNumber, targetEntity, JSON.stringify(payload), JSON.stringify(reasons)]
  )
}

async function findOrCreatePayer(
  connection: DuckDBConnection,
  name: string
): Promise<number | null> {
  if (!name) return null
  const existing = await connection.runAndReadAll('SELECT payer_id FROM payers WHERE name = ?', [
    name
  ])
  const rows = existing.getRowObjectsJS()
  if (rows.length > 0) return Number(rows[0].payer_id)
  const inserted = await connection.runAndReadAll(
    "INSERT INTO payers (name, payer_class) VALUES (?, 'Other') RETURNING payer_id",
    [name]
  )
  return Number(inserted.getRowObjectsJS()[0].payer_id)
}

async function findOrCreateProvider(
  connection: DuckDBConnection,
  clientId: number,
  npi: string | undefined
): Promise<number | null> {
  if (!npi) return null
  const existing = await connection.runAndReadAll(
    'SELECT provider_id FROM providers WHERE client_id = ? AND npi = ?',
    [clientId, npi]
  )
  const rows = existing.getRowObjectsJS()
  if (rows.length > 0) return Number(rows[0].provider_id)
  const inserted = await connection.runAndReadAll(
    'INSERT INTO providers (client_id, npi) VALUES (?, ?) RETURNING provider_id',
    [clientId, npi]
  )
  return Number(inserted.getRowObjectsJS()[0].provider_id)
}

/** Recomputes claims.total_charge/total_allowed for every 837-sourced claim touched by this job (mirrors run-csv-import.ts; 837 carries no paid amounts, those come from the 835 path). */
async function recomputeClaimChargeTotalsForJob(
  connection: DuckDBConnection,
  jobId: number
): Promise<void> {
  await connection.run(
    `UPDATE claims SET
       total_charge = sub.total_charge
     FROM (
       SELECT claim_id, SUM(charge_amount) AS total_charge
       FROM claim_lines
       GROUP BY claim_id
     ) sub
     WHERE claims.claim_id = sub.claim_id AND claims.import_job_id = ?`,
    [jobId]
  )
  await connection.run(
    `UPDATE claims SET balance = total_charge - total_paid - patient_paid WHERE import_job_id = ?`,
    [jobId]
  )
}

// ---------------------------------------------------------------------
// 835 — remittance import
// ---------------------------------------------------------------------

async function findMatchingClaimId(
  connection: DuckDBConnection,
  clientId: number,
  claimNumber: string
): Promise<number | null> {
  if (!claimNumber) return null
  const reader = await connection.runAndReadAll(
    'SELECT claim_id FROM claims WHERE client_id = ? AND (claim_number = ? OR external_ref = ?) LIMIT 1',
    [clientId, claimNumber, claimNumber]
  )
  const rows = reader.getRowObjectsJS()
  return rows.length > 0 ? Number(rows[0].claim_id) : null
}

async function applyRemitToClaim(
  connection: DuckDBConnection,
  claimId: number,
  remitClaim: Remit835Claim
): Promise<void> {
  const existing = await connection.runAndReadAll(
    'SELECT total_charge, total_paid, total_allowed, patient_paid FROM claims WHERE claim_id = ?',
    [claimId]
  )
  const row = existing.getRowObjectsJS()[0]
  const totalCharge = Number(row.total_charge)
  const patientPaid = Number(row.patient_paid)
  const priorAllowed = Number(row.total_allowed)
  const priorPaid = Number(row.total_paid)

  const newPaid = priorPaid + remitClaim.totalPaidAmount
  const newAllowed = remitClaim.allowedAmount ?? priorAllowed
  const newBalance = totalCharge - newPaid - patientPaid

  await connection.run(
    `UPDATE claims SET total_paid = ?, total_allowed = ?, patient_responsibility = ?, balance = ?
     WHERE claim_id = ?`,
    [newPaid, newAllowed, remitClaim.patientResponsibility, newBalance, claimId]
  )
}

async function insertRemittanceRow(
  connection: DuckDBConnection,
  claimId: number | null,
  traceNumber: string | undefined,
  receivedAt: string,
  remitClaim: Remit835Claim
): Promise<void> {
  await connection.run(
    `INSERT INTO remittances (claim_id, source, check_number, received_at, total_paid, patient_responsibility, payer_icn)
     VALUES (?, 'ERA', ?, ?, ?, ?, ?)`,
    [
      claimId,
      traceNumber ?? null,
      receivedAt,
      remitClaim.totalPaidAmount,
      remitClaim.patientResponsibility,
      remitClaim.payerClaimControlNumber ?? null
    ]
  )
}

async function insertDenialsForAdjustments(
  connection: DuckDBConnection,
  claimId: number,
  adjustments: Remit835Adjustment[]
): Promise<void> {
  for (const adjustment of adjustments) {
    await connection.run('INSERT INTO denials (claim_id, carc_code, category) VALUES (?, ?, ?)', [
      claimId,
      adjustment.carcCode,
      CAS_GROUP_CATEGORY[adjustment.groupCode] ?? 'unclassified'
    ])
  }
}

export async function run835Import(input: RunX12ImportInput): Promise<RunX12ImportResult> {
  const sourceType = 'x12-835'
  const fileBuffer = await readFile(input.filePath)
  const fileSha256 = createHash('sha256').update(fileBuffer).digest('hex')
  const fileName = basename(input.filePath)

  const existing = await findSucceededJobBySha(input.connection, sourceType, fileSha256)
  if (existing) return existing

  const clientId = await getClientId(input.connection, input.clientCode)
  const jobId = await insertImportJob(input.connection, { sourceType, fileName, fileSha256 })

  let rowsLoaded = 0
  let rowsSkipped = 0

  try {
    const content = fileBuffer.toString('utf-8')
    const remit = parse835(content)
    const receivedAt = remit.paymentDate ?? new Date().toISOString()

    let position = 0
    for (const remitClaim of remit.claims) {
      position += 1
      const claimId = await findMatchingClaimId(input.connection, clientId, remitClaim.claimNumber)

      if (claimId === null) {
        await insertRemittanceRow(input.connection, null, remit.traceNumber, receivedAt, remitClaim)
        await insertQuarantineRow(input.connection, jobId, position, 'remittances', remitClaim, [
          remitClaim.claimNumber
            ? `No matching claim found for claim_number "${remitClaim.claimNumber}" (client ${input.clientCode}).`
            : 'CLP segment carried no claim number (CLP01) — cannot match to any claim.'
        ])
        rowsSkipped += 1
        continue
      }

      await applyRemitToClaim(input.connection, claimId, remitClaim)
      await insertRemittanceRow(
        input.connection,
        claimId,
        remit.traceNumber,
        receivedAt,
        remitClaim
      )
      await insertDenialsForAdjustments(input.connection, claimId, remitClaim.claimAdjustments)
      for (const line of remitClaim.serviceLines) {
        await insertDenialsForAdjustments(input.connection, claimId, line.adjustments)
      }
      rowsLoaded += 1
    }

    for (const warning of remit.warnings) {
      await insertQuarantineRow(input.connection, jobId, 0, 'remittances', null, [warning])
    }

    const status: ImportStatus =
      rowsSkipped > 0 || remit.warnings.length > 0 ? 'succeeded_with_warnings' : 'succeeded'
    await finishImportJob(input.connection, jobId, {
      status,
      rowsRead: remit.claims.length,
      rowsLoaded,
      rowsSkipped
    })

    return {
      jobId,
      status,
      rowsRead: remit.claims.length,
      rowsLoaded,
      rowsSkipped,
      reusedExistingJob: false,
      warnings: remit.warnings
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishImportJob(input.connection, jobId, {
      status: 'failed',
      rowsRead: rowsLoaded + rowsSkipped,
      rowsLoaded,
      rowsSkipped,
      error: message
    })
    throw error
  }
}

// ---------------------------------------------------------------------
// 837 — claim import
// ---------------------------------------------------------------------

function resolveClaim837Dos(claim: Claim837): string | undefined {
  return claim.serviceDate ?? claim.serviceLines.find((line) => line.serviceDate)?.serviceDate
}

function resolveClaim837PatientKeyRaw(claim: Claim837): string {
  if (claim.subscriberMemberId) return claim.subscriberMemberId
  const subscriberName = [claim.subscriberLastName, claim.subscriberFirstName]
    .filter(Boolean)
    .join(' ')
  if (subscriberName) return subscriberName
  return [claim.patientLastName, claim.patientFirstName].filter(Boolean).join(' ')
}

async function upsertClaim837Shell(
  connection: DuckDBConnection,
  args: {
    clientId: number
    payerId: number | null
    providerId: number | null
    patientKey: string
    claimNumber: string
    dos: string
    naturalKey: string
    importJobId: number
    claimSource: 'x12' | 'api'
  }
): Promise<number> {
  const existing = await connection.runAndReadAll(
    'SELECT claim_id FROM claims WHERE natural_key = ?',
    [args.naturalKey]
  )
  const existingRows = existing.getRowObjectsJS()
  if (existingRows.length > 0) {
    const claimId = Number(existingRows[0].claim_id)
    await connection.run(
      'UPDATE claims SET submission_count = submission_count + 1 WHERE claim_id = ?',
      [claimId]
    )
    return claimId
  }

  const inserted = await connection.runAndReadAll(
    `INSERT INTO claims (
       client_id, provider_id, payer_id, patient_key, claim_number, dos,
       first_submitted_at, source, import_job_id, natural_key
     )
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
     RETURNING claim_id`,
    [
      args.clientId,
      args.providerId,
      args.payerId,
      args.patientKey,
      args.claimNumber,
      args.dos,
      args.claimSource,
      args.importJobId,
      args.naturalKey
    ]
  )
  return Number(inserted.getRowObjectsJS()[0].claim_id)
}

async function insertClaim837Line(
  connection: DuckDBConnection,
  claimId: number,
  line: Claim837ServiceLine
): Promise<void> {
  await connection.run(
    `INSERT INTO claim_lines (claim_id, line_number, cpt_code, modifiers, units, charge_amount)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      claimId,
      line.lineNumber,
      line.procedureCode ?? null,
      line.modifiers.length > 0 ? JSON.stringify(line.modifiers) : null,
      line.units ?? null,
      line.chargeAmount
    ]
  )
}

export async function run837Import(input: RunX12ImportInput): Promise<RunX12ImportResult> {
  const sourceType = 'x12-837'
  const fileBuffer = await readFile(input.filePath)
  const fileSha256 = createHash('sha256').update(fileBuffer).digest('hex')
  const fileName = basename(input.filePath)

  const existing = await findSucceededJobBySha(input.connection, sourceType, fileSha256)
  if (existing) return existing

  const clientId = await getClientId(input.connection, input.clientCode)
  const jobId = await insertImportJob(input.connection, { sourceType, fileName, fileSha256 })
  const claimSource = input.claimSource ?? 'x12'

  let rowsLoaded = 0
  let rowsSkipped = 0

  try {
    const content = fileBuffer.toString('utf-8')
    const parsed = parse837(content)

    let position = 0
    for (const claim of parsed.claims) {
      position += 1
      const dos = resolveClaim837Dos(claim)
      const patientKeyRaw = resolveClaim837PatientKeyRaw(claim)
      const reasons: string[] = []
      if (!claim.claimNumber) reasons.push('CLM segment carried no claim number (CLM01).')
      if (!patientKeyRaw) reasons.push('No subscriber/patient identifier found (NM1*IL / NM1*QC).')
      if (!dos)
        reasons.push('No service date found (DTP*434 at claim level or DTP*472 on any line).')

      if (reasons.length > 0) {
        await insertQuarantineRow(input.connection, jobId, position, 'claims', claim, reasons)
        rowsSkipped += 1
        continue
      }

      const patientKey = hashPatientKey(patientKeyRaw, input.clientCode)
      const naturalKey = computeNaturalKey(
        claimSource,
        input.clientCode,
        claim.claimNumber,
        dos as string
      )
      const payerId = claim.payerName
        ? await findOrCreatePayer(input.connection, claim.payerName)
        : null
      const providerId = await findOrCreateProvider(
        input.connection,
        clientId,
        claim.billingProviderNpi ?? claim.renderingProviderNpi
      )

      const claimId = await upsertClaim837Shell(input.connection, {
        clientId,
        payerId,
        providerId,
        patientKey,
        claimNumber: claim.claimNumber,
        dos: dos as string,
        naturalKey,
        importJobId: jobId,
        claimSource
      })

      for (const line of claim.serviceLines) {
        await insertClaim837Line(input.connection, claimId, line)
      }
      rowsLoaded += 1
    }

    await recomputeClaimChargeTotalsForJob(input.connection, jobId)

    for (const warning of parsed.warnings) {
      await insertQuarantineRow(input.connection, jobId, 0, 'claims', null, [warning])
    }

    const status: ImportStatus =
      rowsSkipped > 0 || parsed.warnings.length > 0 ? 'succeeded_with_warnings' : 'succeeded'
    await finishImportJob(input.connection, jobId, {
      status,
      rowsRead: parsed.claims.length,
      rowsLoaded,
      rowsSkipped
    })

    return {
      jobId,
      status,
      rowsRead: parsed.claims.length,
      rowsLoaded,
      rowsSkipped,
      reusedExistingJob: false,
      warnings: parsed.warnings
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishImportJob(input.connection, jobId, {
      status: 'failed',
      rowsRead: rowsLoaded + rowsSkipped,
      rowsLoaded,
      rowsSkipped,
      error: message
    })
    throw error
  }
}
