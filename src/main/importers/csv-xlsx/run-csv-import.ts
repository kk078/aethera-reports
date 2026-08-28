/**
 * CSV/XLSX import orchestration (plan §3, Phase 1 step 5): staging load
 * -> per-row transform/validate -> upsert canonical -> job bookkeeping.
 * A bad row is quarantined, never fails the job (Risk 3). Re-importing a
 * byte-identical file is a no-op (plan §2 dedup via `file_sha256`).
 *
 * Modeling note: the shipped preset is claim-*line* grain — one CSV row
 * per procedure line, with claim-level fields (payer, patient balances)
 * repeated on every line of a claim. Line amounts (charge/allowed/paid)
 * are SUMmed per claim; claim-level balances (patient responsibility,
 * patient paid, adjustments) are taken as MAX per claim rather than
 * summed, since they'd otherwise be double-counted once per repeated
 * line. `claims` totals are recomputed from `claim_lines` once per job
 * (not accumulated incrementally), so re-running a corrected mapping
 * against the same staged rows can never drift from what's actually in
 * `claim_lines`.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DuckDBConnection } from '@duckdb/node-api'
import type { CanonicalClaimLineRow, ImportStatus, MappingTemplate } from '../../../shared/domain'
import { buildCanonicalRow, type RawRow } from './transform'
import { readRows } from './readers'
import { computeNaturalKey, hashPatientKey } from './hashing'

export interface RunCsvImportInput {
  connection: DuckDBConnection
  filePath: string
  template: MappingTemplate
  clientCode: string
  sourceType?: string
}

export interface RunCsvImportResult {
  jobId: number
  status: ImportStatus
  rowsRead: number
  rowsLoaded: number
  rowsSkipped: number
  reusedExistingJob: boolean
}

const PROGRESS_UPDATE_EVERY_N_ROWS = 25

async function findSucceededJobBySha(
  connection: DuckDBConnection,
  fileSha256: string
): Promise<RunCsvImportResult | null> {
  const reader = await connection.runAndReadAll(
    `SELECT job_id, status, rows_read, rows_loaded, rows_skipped
     FROM import_jobs
     WHERE file_sha256 = ? AND status IN ('succeeded', 'succeeded_with_warnings')
     ORDER BY started_at DESC
     LIMIT 1`,
    [fileSha256]
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
    reusedExistingJob: true
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
  args: { sourceType: string; fileName: string; fileSha256: string; mappingTemplateId: string }
): Promise<number> {
  const reader = await connection.runAndReadAll(
    `INSERT INTO import_jobs (source_type, file_name, file_sha256, mapping_template_id, status)
     VALUES (?, ?, ?, ?, 'running')
     RETURNING job_id`,
    [args.sourceType, args.fileName, args.fileSha256, args.mappingTemplateId]
  )
  return Number(reader.getRowObjectsJS()[0].job_id)
}

async function updateImportJobProgress(
  connection: DuckDBConnection,
  jobId: number,
  counts: { rowsRead: number; rowsLoaded: number; rowsSkipped: number }
): Promise<void> {
  await connection.run(
    'UPDATE import_jobs SET rows_read = ?, rows_loaded = ?, rows_skipped = ? WHERE job_id = ?',
    [counts.rowsRead, counts.rowsLoaded, counts.rowsSkipped, jobId]
  )
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
     SET status = ?, rows_read = ?, rows_loaded = ?, rows_skipped = ?, finished_at = CURRENT_TIMESTAMP, error = ?
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

async function insertStagingRow(
  connection: DuckDBConnection,
  jobId: number,
  rowNumber: number,
  rawRow: RawRow
): Promise<void> {
  await connection.run(
    'INSERT INTO stg_rows (import_job_id, source_row_num, payload) VALUES (?, ?, ?)',
    [jobId, rowNumber, JSON.stringify(rawRow)]
  )
}

async function insertQuarantineRow(
  connection: DuckDBConnection,
  jobId: number,
  rowNumber: number,
  targetEntity: string,
  rawRow: RawRow,
  reasons: string[]
): Promise<void> {
  await connection.run(
    'INSERT INTO quarantine_rows (import_job_id, source_row_num, target_entity, payload, reasons) VALUES (?, ?, ?, ?, ?)',
    [jobId, rowNumber, targetEntity, JSON.stringify(rawRow), JSON.stringify(reasons)]
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

/**
 * Finds-or-creates the claim shell for one line. Deliberately NOT an
 * `INSERT ... ON CONFLICT DO UPDATE` — DuckDB implements that as an
 * internal delete+reinsert, which trips its FK-constraint check the
 * moment a second line for the same claim has already inserted a
 * `claim_lines` row referencing this `claim_id` ("Violates foreign key
 * constraint because key ... is still referenced ... refer to our
 * foreign key limitations in the documentation" — a documented DuckDB
 * limitation, not an app bug). A plain `SELECT` then `UPDATE`/`INSERT`
 * sidesteps it entirely, since a real `UPDATE` never touches the FK'd
 * primary key column.
 */
async function upsertClaimShell(
  connection: DuckDBConnection,
  args: {
    clientId: number
    payerId: number | null
    providerId: number | null
    patientKey: string
    claimNumber: string | undefined
    externalRef: string | undefined
    dos: string
    status: string | undefined
    naturalKey: string
    importJobId: number
    patientResponsibility: number
    patientPaid: number
    adjustmentAmount: number
  }
): Promise<number> {
  const existing = await connection.runAndReadAll(
    'SELECT claim_id, patient_responsibility, patient_paid, adjustments FROM claims WHERE natural_key = ?',
    [args.naturalKey]
  )
  const existingRows = existing.getRowObjectsJS()

  if (existingRows.length > 0) {
    const claimId = Number(existingRows[0].claim_id)
    const priorPatientResp = Number(existingRows[0].patient_responsibility)
    const priorPatientPaid = Number(existingRows[0].patient_paid)
    const priorAdjustments = Number(existingRows[0].adjustments)

    await connection.run(
      `UPDATE claims SET
         status = ?,
         submission_count = submission_count + 1,
         patient_responsibility = ?,
         patient_paid = ?,
         adjustments = ?
       WHERE claim_id = ?`,
      [
        args.status ?? null,
        Math.max(priorPatientResp, args.patientResponsibility),
        Math.max(priorPatientPaid, args.patientPaid),
        Math.max(priorAdjustments, args.adjustmentAmount),
        claimId
      ]
    )
    return claimId
  }

  const inserted = await connection.runAndReadAll(
    `INSERT INTO claims (
       client_id, provider_id, payer_id, patient_key, claim_number, external_ref, dos,
       first_submitted_at, status, source, import_job_id, natural_key,
       patient_responsibility, patient_paid, adjustments
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'csv', ?, ?, ?, ?, ?)
     RETURNING claim_id`,
    [
      args.clientId,
      args.providerId,
      args.payerId,
      args.patientKey,
      args.claimNumber ?? null,
      args.externalRef ?? null,
      args.dos,
      args.status ?? null,
      args.importJobId,
      args.naturalKey,
      args.patientResponsibility,
      args.patientPaid,
      args.adjustmentAmount
    ]
  )
  return Number(inserted.getRowObjectsJS()[0].claim_id)
}

async function insertClaimLine(
  connection: DuckDBConnection,
  claimId: number,
  lineNumber: number,
  row: CanonicalClaimLineRow
): Promise<void> {
  await connection.run(
    `INSERT INTO claim_lines (claim_id, line_number, cpt_code, units, charge_amount, allowed_amount, paid_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      claimId,
      lineNumber,
      row.cptCode ?? null,
      row.units ?? null,
      row.chargeAmount,
      row.allowedAmount ?? null,
      row.paidAmount ?? null
    ]
  )
}

async function insertDenialIfPresent(
  connection: DuckDBConnection,
  claimId: number,
  row: CanonicalClaimLineRow
): Promise<void> {
  if (!row.carcCode) return
  await connection.run(
    `INSERT INTO denials (claim_id, carc_code, description, category)
     VALUES (?, ?, ?, 'unclassified')`,
    [claimId, row.carcCode, row.denialDescription ?? null]
  )
}

/** Recomputes claims.total_* / balance from claim_lines for every claim touched by this job. */
async function recomputeClaimTotalsForJob(
  connection: DuckDBConnection,
  jobId: number
): Promise<void> {
  await connection.run(
    `UPDATE claims SET
       total_charge = sub.total_charge,
       total_allowed = COALESCE(sub.total_allowed, 0),
       total_paid = COALESCE(sub.total_paid, 0)
     FROM (
       SELECT claim_id,
              SUM(charge_amount) AS total_charge,
              SUM(allowed_amount) AS total_allowed,
              SUM(paid_amount) AS total_paid
       FROM claim_lines
       GROUP BY claim_id
     ) sub
     WHERE claims.claim_id = sub.claim_id AND claims.import_job_id = ?`,
    [jobId]
  )
  // Simplified balance = total_charge - insurance_paid - patient_paid.
  // The full A/R-aging balance expression (balance + max(patient_resp -
  // patient_paid, 0)) is KPI-engine territory (plan §4, citing
  // production.py ~lines 166-172 verbatim there) — this column is a
  // reasonable claim-level default, not the final aging figure.
  await connection.run(
    `UPDATE claims
     SET balance = total_charge - total_paid - patient_paid
     WHERE import_job_id = ?`,
    [jobId]
  )
}

export async function runCsvImport(input: RunCsvImportInput): Promise<RunCsvImportResult> {
  const sourceType = input.sourceType ?? 'csv'
  const fileBuffer = await readFile(input.filePath)
  const fileSha256 = createHash('sha256').update(fileBuffer).digest('hex')
  const fileName = basename(input.filePath)

  const existing = await findSucceededJobBySha(input.connection, fileSha256)
  if (existing) return existing

  const clientId = await getClientId(input.connection, input.clientCode)
  const jobId = await insertImportJob(input.connection, {
    sourceType,
    fileName,
    fileSha256,
    mappingTemplateId: input.template.templateId
  })

  let rowsLoaded = 0
  let rowsSkipped = 0
  const claimLineCounters = new Map<number, number>()

  try {
    const result = await readRows(input.filePath, async (rawRow, rowNumber) => {
      await insertStagingRow(input.connection, jobId, rowNumber, rawRow)

      const { row, errors } = buildCanonicalRow(rawRow, input.template)
      if (!row) {
        await insertQuarantineRow(
          input.connection,
          jobId,
          rowNumber,
          input.template.targetEntity,
          rawRow,
          errors
        )
        rowsSkipped += 1
        return
      }

      const patientKey = hashPatientKey(row.patientKey, input.clientCode)
      const claimIdentifier = row.claimNumber ?? row.externalRef ?? ''
      const naturalKey = computeNaturalKey(sourceType, input.clientCode, claimIdentifier, row.dos)

      const payerId = row.payerName
        ? await findOrCreatePayer(input.connection, row.payerName)
        : null
      const providerId = row.providerNpi
        ? await findOrCreateProvider(input.connection, clientId, row.providerNpi)
        : null

      const claimId = await upsertClaimShell(input.connection, {
        clientId,
        payerId,
        providerId,
        patientKey,
        claimNumber: row.claimNumber,
        externalRef: row.externalRef,
        dos: row.dos,
        status: row.status,
        naturalKey,
        importJobId: jobId,
        patientResponsibility: row.patientResponsibility ?? 0,
        patientPaid: row.patientPaid ?? 0,
        adjustmentAmount: row.adjustmentAmount ?? 0
      })

      const lineNumber = (claimLineCounters.get(claimId) ?? 0) + 1
      claimLineCounters.set(claimId, lineNumber)

      await insertClaimLine(input.connection, claimId, lineNumber, row)
      await insertDenialIfPresent(input.connection, claimId, row)

      rowsLoaded += 1
      if (rowNumber % PROGRESS_UPDATE_EVERY_N_ROWS === 0) {
        await updateImportJobProgress(input.connection, jobId, {
          rowsRead: rowNumber,
          rowsLoaded,
          rowsSkipped
        })
      }
    })

    await recomputeClaimTotalsForJob(input.connection, jobId)

    const status: ImportStatus = rowsSkipped > 0 ? 'succeeded_with_warnings' : 'succeeded'
    await finishImportJob(input.connection, jobId, {
      status,
      rowsRead: result.rowCount,
      rowsLoaded,
      rowsSkipped
    })

    return {
      jobId,
      status,
      rowsRead: result.rowCount,
      rowsLoaded,
      rowsSkipped,
      reusedExistingJob: false
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
