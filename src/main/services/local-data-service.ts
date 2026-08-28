/**
 * `LocalDataService` — the Phase 1 `IDataService` implementation: DuckDB
 * for analytics, better-sqlite3 for app metadata, both behind one class.
 * Owns the startup sequence (Risk 5): backup-before-migrate, daily
 * backup, integrity check.
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { openDuckDb, type DuckDbHandle } from '../db/duckdb'
import { openMetaDb } from '../db/meta'
import { applyMigrations, hasPendingMigrations } from '../db/migrate'
import { migrations } from '../db/migrations'
import {
  backupDatabases,
  checkDuckDbIntegrity,
  checkSqliteIntegrity,
  checkpointDuckDb
} from '../db/backup'
import { runCsvImport as runCsvImportPipeline } from '../importers/csv-xlsx/run-csv-import'
import { tebraClaimExportTemplate } from '../importers/csv-xlsx/presets/tebra'
import { detectCsvXlsxFile } from '../importers/csv-xlsx'
import { detectX12File, detectX12Kind } from '../importers/x12'
import { parse835 } from '../importers/x12/parse835'
import { parse837 } from '../importers/x12/parse837'
import { run835Import, run837Import } from '../importers/x12/run-x12-import'
import { buildClientReport as buildClientReportFn } from '../kpi/client-report'
import { buildFinancialTrend } from '../kpi/trend'
import * as analytics from '../kpi/analytics'
import {
  loginRcmPlatform,
  fetchRcmPortfolio,
  fetchRcmClientReport,
  RcmConnectorError,
  findOrCreateClientForSync,
  upsertMonthlySummaryFromReport,
  upsertKpiSnapshotFromReport
} from '../importers/rcm-connector'
import {
  checkReferenceApiHealth,
  refreshCarcCache,
  refreshCptCache,
  getCachedCarcDescriptions,
  buildBenchmarkBlock
} from '../beacon'
import { monthPeriod, periodMonthColumn } from '../../shared/periods'
import type { IDataService, EncryptedSecretInput } from './data-service'
import {
  backupStatusSchema,
  brandingInputSchema,
  brandingSchema,
  clientPatchSchema,
  clientSchema,
  connectorSettingsSchema,
  connectorSyncResultSchema,
  connectorSyncStatusRowSchema,
  connectorTestResultSchema,
  importJobSchema,
  mappingTemplateSchema,
  monthlySummaryInputSchema,
  monthlySummarySchema,
  newClientInputSchema,
  newMappingTemplateInputSchema,
  quarantineRowSchema,
  referenceApiCacheRefreshResultSchema,
  referenceApiSettingsSchema,
  runCsvImportInputSchema,
  runX12ImportInputSchema,
  x12ParseSummarySchema,
  type ArAgingByClientRow,
  type BackupStatus,
  type Branding,
  type BrandingInput,
  type Client,
  type ClientPatch,
  type ClientReport,
  type ConnectorSettings,
  type ConnectorSyncResult,
  type ConnectorSyncStatusRow,
  type ConnectorTestResult,
  type DaysInArTrendPoint,
  type DenialListRow,
  type ImportFileKind,
  type ImportJob,
  type MappingTemplate,
  type MonthlyRateTrendPoint,
  type MonthlySummary,
  type MonthlySummaryInput,
  type NewClientInput,
  type NewMappingTemplateInput,
  type PayerAnalysisRow,
  type PayerMixTrendPoint,
  type PayerVsPatientSplit,
  type QuarantineRow,
  type ReferenceApiCacheRefreshResult,
  type ReferenceApiSettings,
  type ReferenceApiSettingsInput,
  type RunCsvImportInput,
  type RunX12ImportInput,
  type TopAgedClaimRow,
  type X12ParseSummary
} from '../../shared/domain'

export interface LocalDataServicePaths {
  duckdbPath: string
  metaDbPath: string
  backupsDir: string
}

type DbRow = Record<string, unknown>

function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

function toIsoDateTime(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function toIsoDate(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export class LocalDataService implements IDataService {
  private duckdb!: DuckDbHandle
  private meta!: Database.Database
  private readonly paths: LocalDataServicePaths

  private constructor(paths: LocalDataServicePaths) {
    this.paths = paths
  }

  static async create(paths: LocalDataServicePaths): Promise<LocalDataService> {
    const service = new LocalDataService(paths)
    await service.bootstrap()
    return service
  }

  private async bootstrap(): Promise<void> {
    mkdirSync(dirname(this.paths.duckdbPath), { recursive: true })
    mkdirSync(this.paths.backupsDir, { recursive: true })

    this.meta = openMetaDb(this.paths.metaDbPath)
    this.ensureBuiltInTemplates()
    this.ensureDefaultBranding()
    this.ensureDefaultReferenceApiSettings()

    const duckdb = await openDuckDb(this.paths.duckdbPath)
    this.duckdb = duckdb

    // Risk 5: back up before applying any pending migration.
    const pending = await hasPendingMigrations(duckdb.connection, migrations)
    if (pending && existsSync(this.paths.duckdbPath)) {
      await checkpointDuckDb(duckdb.connection).catch(() => undefined)
      backupDatabases(this.paths.backupsDir, this.paths.duckdbPath, this.paths.metaDbPath)
    }
    await applyMigrations(duckdb.connection, migrations)

    // Risk 5: once-per-day backup on first launch of the day.
    await this.maybeRunDailyBackup()

    // Risk 5: startup integrity check. Phase 1 step 4 logs and exposes
    // this via getBackupStatus(); a guided "restore from backup" flow is
    // deferred (see PR notes) rather than shipped half-safe against a
    // live connection.
    const duckdbIntegrity = await checkDuckDbIntegrity(duckdb.connection)
    const sqliteIntegrity = checkSqliteIntegrity(this.meta)
    if (!duckdbIntegrity.ok)
      console.error('[db] DuckDB integrity check failed:', duckdbIntegrity.error)
    if (!sqliteIntegrity.ok)
      console.error('[db] SQLite integrity check failed:', sqliteIntegrity.error)
  }

  private async maybeRunDailyBackup(): Promise<void> {
    const row = this.meta
      .prepare("SELECT value FROM settings WHERE key = 'last_backup_at'")
      .get() as { value: string } | undefined
    const today = new Date().toISOString().slice(0, 10)
    if (row && row.value.slice(0, 10) === today) return
    await this.runBackupNow()
  }

  private ensureBuiltInTemplates(): void {
    const templateId = 'tebra-claim-export'
    const existing = this.meta
      .prepare('SELECT template_id FROM mapping_templates WHERE template_id = ?')
      .get(templateId)
    if (existing) return

    const t = tebraClaimExportTemplate
    this.meta
      .prepare(
        `INSERT INTO mapping_templates
           (template_id, name, pm_system, target_entity, grain, columns_json, key_fields_json, version, built_in)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`
      )
      .run(
        templateId,
        t.name,
        t.pmSystem,
        t.targetEntity,
        t.grain,
        JSON.stringify(t.columns),
        JSON.stringify(t.keyFields)
      )
  }

  /** Seeds the singleton branding row (neutral committed defaults, plan §6) on first launch. */
  private ensureDefaultBranding(): void {
    const existing = this.meta.prepare('SELECT id FROM branding WHERE id = 1').get()
    if (existing) return
    this.meta.prepare('INSERT INTO branding (id) VALUES (1)').run()
  }

  /** Seeds the singleton reference-api-settings row (default: the reference deployment's local URL, enabled) on first launch. */
  private ensureDefaultReferenceApiSettings(): void {
    const existing = this.meta.prepare('SELECT id FROM reference_api_settings WHERE id = 1').get()
    if (existing) return
    this.meta.prepare('INSERT INTO reference_api_settings (id) VALUES (1)').run()
  }

  // -------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------

  private mapClientRow(row: DbRow): Client {
    return clientSchema.parse({
      clientId: toNumber(row.client_id),
      code: row.code,
      name: row.name,
      contractType: row.contract_type ?? null,
      contractRate: row.contract_rate ?? null,
      slaDaysToSubmit: row.sla_days_to_submit == null ? null : toNumber(row.sla_days_to_submit),
      reportRecipients: parseJsonArray(row.report_recipients),
      state: (row.state as string | null) ?? null,
      active: Boolean(row.active),
      createdAt: toIsoDateTime(row.created_at),
      updatedAt: toIsoDateTime(row.updated_at)
    })
  }

  async listClients(): Promise<Client[]> {
    const reader = await this.duckdb.connection.runAndReadAll('SELECT * FROM clients ORDER BY code')
    return reader.getRowObjectsJS().map((row) => this.mapClientRow(row))
  }

  async getClientByCode(code: string): Promise<Client | null> {
    const reader = await this.duckdb.connection.runAndReadAll(
      'SELECT * FROM clients WHERE code = ?',
      [code]
    )
    const rows = reader.getRowObjectsJS()
    return rows.length > 0 ? this.mapClientRow(rows[0]) : null
  }

  private async getClientById(clientId: number): Promise<Client | null> {
    const reader = await this.duckdb.connection.runAndReadAll(
      'SELECT * FROM clients WHERE client_id = ?',
      [clientId]
    )
    const rows = reader.getRowObjectsJS()
    return rows.length > 0 ? this.mapClientRow(rows[0]) : null
  }

  async createClient(input: NewClientInput): Promise<Client> {
    const validated = newClientInputSchema.parse(input)
    const reader = await this.duckdb.connection.runAndReadAll(
      `INSERT INTO clients (code, name, contract_type, contract_rate, sla_days_to_submit, report_recipients, state, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, true)
       RETURNING *`,
      [
        validated.code,
        validated.name,
        validated.contractType ?? null,
        validated.contractRate ?? null,
        validated.slaDaysToSubmit ?? null,
        JSON.stringify(validated.reportRecipients ?? []),
        validated.state ?? null
      ]
    )
    return this.mapClientRow(reader.getRowObjectsJS()[0])
  }

  async updateClient(clientId: number, patch: ClientPatch): Promise<Client> {
    const validated = clientPatchSchema.parse(patch)
    const existing = await this.getClientById(clientId)
    if (!existing) throw new Error(`Client ${clientId} not found`)

    const merged = {
      name: validated.name ?? existing.name,
      contractType:
        validated.contractType !== undefined ? validated.contractType : existing.contractType,
      contractRate:
        validated.contractRate !== undefined ? validated.contractRate : existing.contractRate,
      slaDaysToSubmit:
        validated.slaDaysToSubmit !== undefined
          ? validated.slaDaysToSubmit
          : existing.slaDaysToSubmit,
      reportRecipients: validated.reportRecipients ?? existing.reportRecipients,
      state: validated.state !== undefined ? validated.state : existing.state,
      active: validated.active ?? existing.active
    }

    const reader = await this.duckdb.connection.runAndReadAll(
      `UPDATE clients SET name = ?, contract_type = ?, contract_rate = ?, sla_days_to_submit = ?,
         report_recipients = ?, state = ?, active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE client_id = ?
       RETURNING *`,
      [
        merged.name,
        merged.contractType,
        merged.contractRate,
        merged.slaDaysToSubmit,
        JSON.stringify(merged.reportRecipients),
        merged.state,
        merged.active,
        clientId
      ]
    )
    return this.mapClientRow(reader.getRowObjectsJS()[0])
  }

  async deactivateClient(clientId: number): Promise<Client> {
    return this.updateClient(clientId, { active: false })
  }

  // -------------------------------------------------------------------
  // Mapping templates (meta.db)
  // -------------------------------------------------------------------

  private mapTemplateRow(row: DbRow): MappingTemplate {
    return mappingTemplateSchema.parse({
      templateId: row.template_id,
      name: row.name,
      pmSystem: row.pm_system,
      targetEntity: row.target_entity,
      grain: row.grain,
      columns: JSON.parse(String(row.columns_json)),
      keyFields: JSON.parse(String(row.key_fields_json)),
      version: Number(row.version),
      builtIn: Boolean(row.built_in),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    })
  }

  async listMappingTemplates(): Promise<MappingTemplate[]> {
    const rows = this.meta.prepare('SELECT * FROM mapping_templates ORDER BY name').all() as DbRow[]
    return rows.map((row) => this.mapTemplateRow(row))
  }

  async getMappingTemplate(templateId: string): Promise<MappingTemplate | null> {
    const row = this.meta
      .prepare('SELECT * FROM mapping_templates WHERE template_id = ?')
      .get(templateId) as DbRow | undefined
    return row ? this.mapTemplateRow(row) : null
  }

  async saveMappingTemplate(input: NewMappingTemplateInput): Promise<MappingTemplate> {
    const validated = newMappingTemplateInputSchema.parse(input)
    const templateId =
      validated.templateId ?? `${slugify(validated.name)}-${randomUUID().slice(0, 8)}`

    const existing = this.meta
      .prepare('SELECT version, built_in FROM mapping_templates WHERE template_id = ?')
      .get(templateId) as { version: number; built_in: number } | undefined
    if (existing?.built_in) {
      throw new Error(
        `Template "${templateId}" is built in and cannot be modified — save as a new template instead.`
      )
    }
    const version = existing ? existing.version + 1 : 1

    this.meta
      .prepare(
        `INSERT INTO mapping_templates
           (template_id, name, pm_system, target_entity, grain, columns_json, key_fields_json, version, built_in, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
         ON CONFLICT (template_id) DO UPDATE SET
           name = excluded.name,
           pm_system = excluded.pm_system,
           target_entity = excluded.target_entity,
           grain = excluded.grain,
           columns_json = excluded.columns_json,
           key_fields_json = excluded.key_fields_json,
           version = excluded.version,
           updated_at = excluded.updated_at`
      )
      .run(
        templateId,
        validated.name,
        validated.pmSystem,
        validated.targetEntity,
        validated.grain,
        JSON.stringify(validated.columns),
        JSON.stringify(validated.keyFields),
        version
      )

    const saved = await this.getMappingTemplate(templateId)
    if (!saved) throw new Error('Mapping template vanished immediately after save')
    return saved
  }

  async exportMappingTemplate(templateId: string): Promise<string> {
    const template = await this.getMappingTemplate(templateId)
    if (!template) throw new Error(`Template "${templateId}" not found`)
    return JSON.stringify(template, null, 2)
  }

  async importMappingTemplate(templateJson: string): Promise<MappingTemplate> {
    const parsed = mappingTemplateSchema.parse(JSON.parse(templateJson))
    if (parsed.builtIn) {
      throw new Error('Refusing to import a template marked built-in — rename it first.')
    }
    return this.saveMappingTemplate({
      templateId: parsed.templateId,
      name: parsed.name,
      pmSystem: parsed.pmSystem,
      targetEntity: parsed.targetEntity,
      grain: parsed.grain,
      columns: parsed.columns,
      keyFields: parsed.keyFields
    })
  }

  // -------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------

  private mapImportJobRow(row: DbRow): ImportJob {
    return importJobSchema.parse({
      jobId: toNumber(row.job_id),
      sourceType: row.source_type,
      fileName: row.file_name ?? null,
      fileSha256: row.file_sha256 ?? null,
      mappingTemplateId: row.mapping_template_id ?? null,
      startedAt: toIsoDateTime(row.started_at),
      finishedAt: row.finished_at ? toIsoDateTime(row.finished_at) : null,
      status: row.status,
      rowsRead: toNumber(row.rows_read),
      rowsLoaded: toNumber(row.rows_loaded),
      rowsSkipped: toNumber(row.rows_skipped),
      error: row.error ? JSON.parse(String(row.error)) : null
    })
  }

  async listImportJobs(): Promise<ImportJob[]> {
    const reader = await this.duckdb.connection.runAndReadAll(
      'SELECT * FROM import_jobs ORDER BY started_at DESC'
    )
    return reader.getRowObjectsJS().map((row) => this.mapImportJobRow(row))
  }

  async getImportJob(jobId: number): Promise<ImportJob | null> {
    const reader = await this.duckdb.connection.runAndReadAll(
      'SELECT * FROM import_jobs WHERE job_id = ?',
      [jobId]
    )
    const rows = reader.getRowObjectsJS()
    return rows.length > 0 ? this.mapImportJobRow(rows[0]) : null
  }

  async runCsvImport(input: RunCsvImportInput): Promise<ImportJob> {
    const validated = runCsvImportInputSchema.parse(input)
    const template = await this.getMappingTemplate(validated.templateId)
    if (!template) throw new Error(`Unknown mapping template: ${validated.templateId}`)

    const result = await runCsvImportPipeline({
      connection: this.duckdb.connection,
      filePath: validated.filePath,
      template,
      clientCode: validated.clientCode
    })

    const job = await this.getImportJob(result.jobId)
    if (!job) throw new Error('Import job vanished immediately after running')
    return job
  }

  async listQuarantineRows(jobId: number): Promise<QuarantineRow[]> {
    const reader = await this.duckdb.connection.runAndReadAll(
      'SELECT * FROM quarantine_rows WHERE import_job_id = ? ORDER BY source_row_num',
      [jobId]
    )
    return reader.getRowObjectsJS().map((row) =>
      quarantineRowSchema.parse({
        quarantineId: toNumber(row.quarantine_id),
        importJobId: toNumber(row.import_job_id),
        sourceRowNum: toNumber(row.source_row_num),
        targetEntity: row.target_entity,
        payload: JSON.parse(String(row.payload)),
        reasons: JSON.parse(String(row.reasons)),
        createdAt: toIsoDateTime(row.created_at)
      })
    )
  }

  // -------------------------------------------------------------------
  // X12 835/837 (plan §3 bullet 2)
  // -------------------------------------------------------------------

  async detectImportFileKind(filePath: string): Promise<ImportFileKind> {
    if (detectCsvXlsxFile(filePath)) {
      return extname(filePath).toLowerCase() === '.csv' ? 'csv' : 'xlsx'
    }
    const x12Kind = await detectX12File(filePath)
    if (x12Kind === '835') return 'x12-835'
    if (x12Kind === '837') return 'x12-837'
    return 'unknown'
  }

  async previewX12Import(filePath: string): Promise<X12ParseSummary> {
    const content = await readFile(filePath, 'utf-8')
    const kind = detectX12Kind(content)
    if (!kind)
      throw new Error(`"${filePath}" does not look like a recognizable X12 835 or 837 file.`)

    if (kind === '835') {
      const remit = parse835(content)
      const lineCount = remit.claims.reduce((sum, claim) => sum + claim.serviceLines.length, 0)
      const adjustmentCount = remit.claims.reduce(
        (sum, claim) =>
          sum +
          claim.claimAdjustments.length +
          claim.serviceLines.reduce((lineSum, line) => lineSum + line.adjustments.length, 0),
        0
      )
      return x12ParseSummarySchema.parse({
        kind,
        claimsCount: remit.claims.length,
        lineCount,
        adjustmentCount,
        totalPaymentAmount: remit.paymentAmount,
        warnings: remit.warnings
      })
    }

    const parsed = parse837(content)
    const lineCount = parsed.claims.reduce((sum, claim) => sum + claim.serviceLines.length, 0)
    return x12ParseSummarySchema.parse({
      kind,
      claimsCount: parsed.claims.length,
      lineCount,
      adjustmentCount: 0,
      totalPaymentAmount: null,
      warnings: parsed.warnings
    })
  }

  async runX12Import(input: RunX12ImportInput): Promise<ImportJob> {
    const validated = runX12ImportInputSchema.parse(input)
    const content = await readFile(validated.filePath, 'utf-8')
    const kind = detectX12Kind(content)
    if (!kind) {
      throw new Error(
        `"${validated.filePath}" does not look like a recognizable X12 835 or 837 file.`
      )
    }

    const runner = kind === '835' ? run835Import : run837Import
    const result = await runner({
      connection: this.duckdb.connection,
      filePath: validated.filePath,
      clientCode: validated.clientCode
    })

    const job = await this.getImportJob(result.jobId)
    if (!job) throw new Error('Import job vanished immediately after running')
    return job
  }

  // -------------------------------------------------------------------
  // Manual entry
  // -------------------------------------------------------------------

  private mapMonthlySummaryRow(row: DbRow): MonthlySummary {
    return monthlySummarySchema.parse({
      clientId: toNumber(row.client_id),
      periodMonth: toIsoDate(row.period_month),
      charges: row.charges ?? null,
      insCollections: row.ins_collections ?? null,
      ptCollections: row.pt_collections ?? null,
      adjustments: row.adjustments ?? null,
      openAr: row.open_ar ?? null,
      arAging0To30: row.ar_aging_0_30 ?? null,
      arAging31To60: row.ar_aging_31_60 ?? null,
      arAging61To90: row.ar_aging_61_90 ?? null,
      arAging91To120: row.ar_aging_91_120 ?? null,
      arAging120Plus: row.ar_aging_120_plus ?? null,
      claimsSubmitted: row.claims_submitted == null ? null : toNumber(row.claims_submitted),
      denialsCount: row.denials_count == null ? null : toNumber(row.denials_count),
      notes: row.notes ?? null,
      updatedAt: toIsoDateTime(row.updated_at),
      priorValues: row.prior_values ? JSON.parse(String(row.prior_values)) : null,
      source: row.source === 'synced' ? 'synced' : 'manual'
    })
  }

  async upsertMonthlySummary(input: MonthlySummaryInput): Promise<MonthlySummary> {
    const validated = monthlySummaryInputSchema.parse(input)

    const existingReader = await this.duckdb.connection.runAndReadAll(
      'SELECT * FROM monthly_summaries WHERE client_id = ? AND period_month = ?',
      [validated.clientId, validated.periodMonth]
    )
    const existingRows = existingReader.getRowObjectsJS()
    const priorValues = existingRows.length > 0 ? this.mapMonthlySummaryRow(existingRows[0]) : null

    await this.duckdb.connection.run(
      `INSERT INTO monthly_summaries (
         client_id, period_month, charges, ins_collections, pt_collections, adjustments, open_ar,
         ar_aging_0_30, ar_aging_31_60, ar_aging_61_90, ar_aging_91_120, ar_aging_120_plus,
         claims_submitted, denials_count, notes, prior_values, source
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
       ON CONFLICT (client_id, period_month) DO UPDATE SET
         charges = excluded.charges,
         ins_collections = excluded.ins_collections,
         pt_collections = excluded.pt_collections,
         adjustments = excluded.adjustments,
         open_ar = excluded.open_ar,
         ar_aging_0_30 = excluded.ar_aging_0_30,
         ar_aging_31_60 = excluded.ar_aging_31_60,
         ar_aging_61_90 = excluded.ar_aging_61_90,
         ar_aging_91_120 = excluded.ar_aging_91_120,
         ar_aging_120_plus = excluded.ar_aging_120_plus,
         claims_submitted = excluded.claims_submitted,
         denials_count = excluded.denials_count,
         notes = excluded.notes,
         updated_at = now(),
         prior_values = excluded.prior_values,
         source = 'manual'`,
      [
        validated.clientId,
        validated.periodMonth,
        validated.charges ?? null,
        validated.insCollections ?? null,
        validated.ptCollections ?? null,
        validated.adjustments ?? null,
        validated.openAr ?? null,
        validated.arAging0To30 ?? null,
        validated.arAging31To60 ?? null,
        validated.arAging61To90 ?? null,
        validated.arAging91To120 ?? null,
        validated.arAging120Plus ?? null,
        validated.claimsSubmitted ?? null,
        validated.denialsCount ?? null,
        validated.notes ?? null,
        priorValues ? JSON.stringify(priorValues) : null
      ]
    )

    const result = await this.getMonthlySummary(validated.clientId, validated.periodMonth)
    if (!result) throw new Error('Monthly summary vanished immediately after upsert')
    return result
  }

  async getMonthlySummary(clientId: number, periodMonth: string): Promise<MonthlySummary | null> {
    const reader = await this.duckdb.connection.runAndReadAll(
      'SELECT * FROM monthly_summaries WHERE client_id = ? AND period_month = ?',
      [clientId, periodMonth]
    )
    const rows = reader.getRowObjectsJS()
    return rows.length > 0 ? this.mapMonthlySummaryRow(rows[0]) : null
  }

  // -------------------------------------------------------------------
  // Maintenance (Risk 5)
  // -------------------------------------------------------------------

  async getBackupStatus(): Promise<BackupStatus> {
    const row = this.meta
      .prepare("SELECT value FROM settings WHERE key = 'last_backup_at'")
      .get() as { value: string } | undefined
    const backupCount = existsSync(this.paths.backupsDir)
      ? readdirSync(this.paths.backupsDir).filter((name) =>
          statSync(join(this.paths.backupsDir, name)).isDirectory()
        ).length
      : 0
    const duckdbCheck = await checkDuckDbIntegrity(this.duckdb.connection)
    const sqliteCheck = checkSqliteIntegrity(this.meta)

    return backupStatusSchema.parse({
      lastBackupAt: row?.value ?? null,
      backupCount,
      duckdbIntegrityOk: duckdbCheck.ok,
      sqliteIntegrityOk: sqliteCheck.ok
    })
  }

  async runBackupNow(): Promise<BackupStatus> {
    await checkpointDuckDb(this.duckdb.connection).catch(() => undefined)
    backupDatabases(this.paths.backupsDir, this.paths.duckdbPath, this.paths.metaDbPath)

    const now = new Date().toISOString()
    this.meta
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('last_backup_at', ?, datetime('now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(now)

    return this.getBackupStatus()
  }

  /**
   * Restore-from-backup (plan step 9, deferred from step 4): closes both
   * DB connections, copies the most recent backup's files back over the
   * live paths, and returns which backup was used. This instance is
   * unusable afterward — the caller (an Electron-aware IPC handler) must
   * relaunch the app immediately; we deliberately don't try to reopen a
   * fresh connection in-process, which is the unsafe part of a "restore"
   * this keeps simple by not attempting.
   */
  async restoreLatestBackup(): Promise<{ restoredFrom: string }> {
    if (!existsSync(this.paths.backupsDir)) {
      throw new Error('No backups directory exists yet.')
    }
    const backupDirs = readdirSync(this.paths.backupsDir)
      .filter((name) => statSync(join(this.paths.backupsDir, name)).isDirectory())
      .sort((a, b) => b.localeCompare(a)) // ISO-named dirs sort newest-first lexically
    const latest = backupDirs[0]
    if (!latest) throw new Error('No backups found to restore from.')

    const latestDir = join(this.paths.backupsDir, latest)
    await checkpointDuckDb(this.duckdb.connection).catch(() => undefined)
    this.duckdb.close()
    this.meta.close()

    const duckdbBackup = join(latestDir, 'analytics.duckdb')
    const metaBackup = join(latestDir, 'meta.db')
    if (existsSync(duckdbBackup)) copyFileSync(duckdbBackup, this.paths.duckdbPath)
    if (existsSync(metaBackup)) copyFileSync(metaBackup, this.paths.metaDbPath)

    return { restoredFrom: latest }
  }

  // -------------------------------------------------------------------
  // Branding (plan §6)
  // -------------------------------------------------------------------

  private mapBrandingRow(row: DbRow): Branding {
    return brandingSchema.parse({
      firmName: row.firm_name,
      logoPath: row.logo_path ?? null,
      primaryColor: row.primary_color,
      secondaryColor: row.secondary_color,
      footerDisclaimer: row.footer_disclaimer ?? null,
      updatedAt: row.updated_at
    })
  }

  async getBranding(): Promise<Branding> {
    const row = this.meta.prepare('SELECT * FROM branding WHERE id = 1').get() as DbRow
    return this.mapBrandingRow(row)
  }

  async updateBranding(input: BrandingInput): Promise<Branding> {
    const validated = brandingInputSchema.parse(input)
    const existing = await this.getBranding()
    const merged = {
      firmName: validated.firmName ?? existing.firmName,
      primaryColor: validated.primaryColor ?? existing.primaryColor,
      secondaryColor: validated.secondaryColor ?? existing.secondaryColor,
      footerDisclaimer:
        validated.footerDisclaimer !== undefined
          ? validated.footerDisclaimer
          : existing.footerDisclaimer
    }
    this.meta
      .prepare(
        `UPDATE branding SET firm_name = ?, primary_color = ?, secondary_color = ?, footer_disclaimer = ?, updated_at = datetime('now')
         WHERE id = 1`
      )
      .run(merged.firmName, merged.primaryColor, merged.secondaryColor, merged.footerDisclaimer)
    return this.getBranding()
  }

  /** Stores a logo path already copied into userData by the (Electron-aware) IPC handler. */
  async setBrandingLogoPath(logoPath: string | null): Promise<Branding> {
    this.meta
      .prepare(`UPDATE branding SET logo_path = ?, updated_at = datetime('now') WHERE id = 1`)
      .run(logoPath)
    return this.getBranding()
  }

  // -------------------------------------------------------------------
  // Export audit log (plan §6)
  // -------------------------------------------------------------------

  recordExport(entry: {
    action: string
    clientCode: string | null
    periodMonth: string | null
    filePath: string | null
  }): void {
    this.meta
      .prepare(
        `INSERT INTO export_audit_log (action, client_code, period_month, file_path) VALUES (?, ?, ?, ?)`
      )
      .run(entry.action, entry.clientCode, entry.periodMonth, entry.filePath)
  }

  // -------------------------------------------------------------------
  // Denials / A/R / Payers analytics screens (plan §5, Phase 2 chunk B)
  // -------------------------------------------------------------------

  async listDenials(clientId: number | null, periodMonth: string): Promise<DenialListRow[]> {
    return analytics.listDenials(this.duckdb.connection, clientId, periodMonth)
  }

  async getDenialRateTrend(
    clientId: number | null,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<MonthlyRateTrendPoint[]> {
    return analytics.denialRateTrend(this.duckdb.connection, clientId, endPeriodMonth, monthsBack)
  }

  async getArAgingByClient(): Promise<ArAgingByClientRow[]> {
    return analytics.arAgingByClient(this.duckdb.connection)
  }

  async getArPayerVsPatientSplit(clientId: number | null): Promise<PayerVsPatientSplit> {
    return analytics.arPayerVsPatientSplit(this.duckdb.connection, clientId)
  }

  async getTopAgedClaims(clientId: number | null, limit?: number): Promise<TopAgedClaimRow[]> {
    return analytics.topAgedClaims(this.duckdb.connection, clientId, limit)
  }

  async getDaysInArTrend(
    clientId: number | null,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<DaysInArTrendPoint[]> {
    return analytics.daysInArTrend(this.duckdb.connection, clientId, endPeriodMonth, monthsBack)
  }

  async getPayerAnalysis(
    clientId: number | null,
    periodMonth: string
  ): Promise<PayerAnalysisRow[]> {
    return analytics.payerAnalysis(this.duckdb.connection, clientId, periodMonth)
  }

  async getPayerMixTrend(
    clientId: number | null,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<PayerMixTrendPoint[]> {
    return analytics.payerMixTrend(this.duckdb.connection, clientId, endPeriodMonth, monthsBack)
  }

  // -------------------------------------------------------------------
  // Generic RCM Platform REST connector (plan §3 bullet 3, Phase 2 chunk C)
  // -------------------------------------------------------------------

  private mapConnectorSettingsRow(row: DbRow | undefined): ConnectorSettings {
    if (!row) {
      return connectorSettingsSchema.parse({
        baseUrl: null,
        username: null,
        hasPassword: false,
        enabled: false,
        passwordEncoding: null
      })
    }
    return connectorSettingsSchema.parse({
      baseUrl: (row.base_url as string | null) ?? null,
      username: (row.username as string | null) ?? null,
      hasPassword: Boolean(row.password_data),
      enabled: Boolean(row.enabled),
      passwordEncoding: (row.password_encoding as 'safeStorage' | 'plaintext' | null) ?? null
    })
  }

  async getConnectorSettings(): Promise<ConnectorSettings> {
    const row = this.meta.prepare('SELECT * FROM connector_settings WHERE id = 1').get() as
      DbRow | undefined
    return this.mapConnectorSettingsRow(row)
  }

  async saveConnectorSettings(input: {
    baseUrl: string
    username: string
    enabled: boolean
    encryptedPassword?: EncryptedSecretInput
  }): Promise<ConnectorSettings> {
    const existing = this.meta.prepare('SELECT * FROM connector_settings WHERE id = 1').get() as
      DbRow | undefined
    const passwordData =
      input.encryptedPassword?.data ?? (existing?.password_data as string | undefined) ?? null
    const passwordEncoding =
      input.encryptedPassword?.encoding ??
      (existing?.password_encoding as string | undefined) ??
      null

    this.meta
      .prepare(
        `INSERT INTO connector_settings (id, base_url, username, password_data, password_encoding, enabled, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (id) DO UPDATE SET
           base_url = excluded.base_url, username = excluded.username,
           password_data = excluded.password_data, password_encoding = excluded.password_encoding,
           enabled = excluded.enabled, updated_at = excluded.updated_at`
      )
      .run(input.baseUrl, input.username, passwordData, passwordEncoding, input.enabled ? 1 : 0)

    return this.getConnectorSettings()
  }

  async getEncryptedConnectorPassword(): Promise<EncryptedSecretInput | null> {
    const row = this.meta.prepare('SELECT * FROM connector_settings WHERE id = 1').get() as
      DbRow | undefined
    if (!row?.password_data) return null
    return {
      data: String(row.password_data),
      encoding: row.password_encoding === 'safeStorage' ? 'safeStorage' : 'plaintext'
    }
  }

  async testConnectorConnection(
    baseUrl: string,
    username: string,
    password: string
  ): Promise<ConnectorTestResult> {
    try {
      await loginRcmPlatform({ baseUrl, username, password })
      return connectorTestResultSchema.parse({ ok: true, message: 'Connected successfully.' })
    } catch (error) {
      const message = error instanceof RcmConnectorError ? error.message : String(error)
      return connectorTestResultSchema.parse({ ok: false, message })
    }
  }

  private upsertConnectorSyncState(entry: {
    clientCode: string
    periodMonth: string
    status: 'ok' | 'error'
    error: string | null
    created: boolean
  }): void {
    this.meta
      .prepare(
        `INSERT INTO connector_sync_state (client_code, last_synced_period, last_synced_at, last_status, last_error, created_by_connector)
         VALUES (?, ?, datetime('now'), ?, ?, ?)
         ON CONFLICT (client_code) DO UPDATE SET
           last_synced_period = excluded.last_synced_period,
           last_synced_at = excluded.last_synced_at,
           last_status = excluded.last_status,
           last_error = excluded.last_error`
      )
      .run(entry.clientCode, entry.periodMonth, entry.status, entry.error, entry.created ? 1 : 0)
  }

  /**
   * Pulls the portfolio list + each client's computed report for
   * `periodMonth`, upserting `monthly_summaries`/`kpi_snapshots` with
   * `source: 'synced'` (plan §3 bullet 3). Per-client failure isolation —
   * one client's report failing to fetch/parse never aborts the sync for
   * the rest, matching the batch-export queue's established pattern.
   */
  async runConnectorSync(
    baseUrl: string,
    username: string,
    password: string,
    periodMonth: string
  ): Promise<ConnectorSyncResult> {
    const config = { baseUrl, username, password }
    const token = await loginRcmPlatform(config)
    const period = monthPeriod(periodMonth)
    const periodMonthCol = periodMonthColumn(periodMonth)

    const portfolio = await fetchRcmPortfolio(config, token, period.start, period.end)

    const results: ConnectorSyncResult['results'] = []
    for (const row of portfolio.clients) {
      try {
        const { clientId, created } = await findOrCreateClientForSync(
          this.duckdb.connection,
          row.client,
          row.name
        )
        const report = await fetchRcmClientReport(
          config,
          token,
          row.client,
          period.start,
          period.end
        )
        await upsertMonthlySummaryFromReport(
          this.duckdb.connection,
          clientId,
          periodMonthCol,
          report
        )
        await upsertKpiSnapshotFromReport(this.duckdb.connection, clientId, period.end, report)
        this.upsertConnectorSyncState({
          clientCode: row.client,
          periodMonth,
          status: 'ok',
          error: null,
          created
        })
        results.push(
          connectorSyncResultSchema.shape.results.element.parse({
            clientCode: row.client,
            ok: true,
            created,
            error: null
          })
        )
      } catch (error) {
        const message = error instanceof RcmConnectorError ? error.message : String(error)
        this.upsertConnectorSyncState({
          clientCode: row.client,
          periodMonth,
          status: 'error',
          error: message,
          created: false
        })
        results.push(
          connectorSyncResultSchema.shape.results.element.parse({
            clientCode: row.client,
            ok: false,
            created: false,
            error: message
          })
        )
      }
    }

    return connectorSyncResultSchema.parse({ periodMonth, results })
  }

  async listConnectorSyncStatus(): Promise<ConnectorSyncStatusRow[]> {
    const rows = this.meta
      .prepare('SELECT * FROM connector_sync_state ORDER BY client_code')
      .all() as DbRow[]
    return rows.map((row) =>
      connectorSyncStatusRowSchema.parse({
        clientCode: row.client_code,
        lastSyncedPeriod: row.last_synced_period ?? null,
        lastSyncedAt: row.last_synced_at ?? null,
        lastStatus: row.last_status ?? null,
        lastError: row.last_error ?? null,
        createdByConnector: Boolean(row.created_by_connector)
      })
    )
  }

  // -------------------------------------------------------------------
  // Reference & Benchmark API connector (beacon paragraph, Phase 2 chunk C)
  // -------------------------------------------------------------------

  async getReferenceApiSettings(): Promise<ReferenceApiSettings> {
    const row = this.meta.prepare('SELECT * FROM reference_api_settings WHERE id = 1').get() as
      DbRow | undefined
    return referenceApiSettingsSchema.parse({
      baseUrl: (row?.base_url as string | undefined) ?? 'http://127.0.0.1:8110',
      enabled: row ? Boolean(row.enabled) : true,
      lastHealthOk: row?.last_health_ok == null ? null : Boolean(row.last_health_ok),
      lastHealthAt: (row?.last_health_at as string | null) ?? null
    })
  }

  async saveReferenceApiSettings(input: ReferenceApiSettingsInput): Promise<ReferenceApiSettings> {
    this.meta
      .prepare(
        `INSERT INTO reference_api_settings (id, base_url, enabled, updated_at)
         VALUES (1, ?, ?, datetime('now'))
         ON CONFLICT (id) DO UPDATE SET base_url = excluded.base_url, enabled = excluded.enabled, updated_at = excluded.updated_at`
      )
      .run(input.baseUrl, input.enabled ? 1 : 0)
    return this.getReferenceApiSettings()
  }

  async testReferenceApiConnection(): Promise<ConnectorTestResult> {
    const settings = await this.getReferenceApiSettings()
    const ok = await checkReferenceApiHealth(settings.baseUrl)
    this.meta
      .prepare(
        `UPDATE reference_api_settings SET last_health_ok = ?, last_health_at = datetime('now') WHERE id = 1`
      )
      .run(ok ? 1 : 0)
    return connectorTestResultSchema.parse({
      ok,
      message: ok
        ? 'Reference API is reachable.'
        : 'Reference API did not respond (this is optional enrichment — the app degrades gracefully).'
    })
  }

  /** Cached health check (plan: "no error spam") — re-verifies at most once per `maxAgeMs`, otherwise trusts the last cached result. */
  private async getReferenceApiHealthCached(maxAgeMs = 60_000): Promise<boolean> {
    const settings = await this.getReferenceApiSettings()
    if (!settings.enabled) return false
    if (settings.lastHealthAt) {
      const ageMs = Date.now() - Date.parse(settings.lastHealthAt)
      if (ageMs >= 0 && ageMs < maxAgeMs && settings.lastHealthOk !== null) {
        return settings.lastHealthOk
      }
    }
    const result = await this.testReferenceApiConnection()
    return result.ok
  }

  async refreshReferenceApiCache(): Promise<ReferenceApiCacheRefreshResult> {
    const settings = await this.getReferenceApiSettings()
    if (!settings.enabled || !(await this.getReferenceApiHealthCached())) {
      return referenceApiCacheRefreshResultSchema.parse({
        carc: { cached: 0, notFound: 0 },
        cpt: { cached: 0, notFound: 0 }
      })
    }
    const [carc, cpt] = await Promise.all([
      refreshCarcCache(this.duckdb.connection, settings.baseUrl),
      refreshCptCache(this.duckdb.connection, settings.baseUrl)
    ])
    return referenceApiCacheRefreshResultSchema.parse({
      carc: { cached: carc.cached, notFound: carc.notFound },
      cpt: { cached: cpt.cached, notFound: cpt.notFound }
    })
  }

  async getCarcDescriptions(codes: string[]): Promise<Record<string, string>> {
    const map = await getCachedCarcDescriptions(this.duckdb.connection, codes)
    return Object.fromEntries(map)
  }

  // -------------------------------------------------------------------
  // KPI engine / reports (plan §4)
  // -------------------------------------------------------------------

  async buildClientReport(clientId: number, periodMonth: string): Promise<ClientReport> {
    const benchmark = await this.tryBuildBenchmarkBlock(clientId, periodMonth)
    return buildClientReportFn(this.duckdb.connection, clientId, periodMonth, { benchmark })
  }

  /**
   * Assembles the benchmark block for one client (plan's beacon
   * paragraph) — never for `listClientReportsForPeriod`'s whole
   * portfolio, which would multiply the reference-API round trips by
   * every active client on a screen that doesn't render the callout
   * anyway (only the ClientDetail/PDF/PPTX/XLSX report doc does).
   */
  private async tryBuildBenchmarkBlock(
    clientId: number,
    periodMonth: string
  ): Promise<ClientReport['benchmark']> {
    try {
      const settings = await this.getReferenceApiSettings()
      if (!settings.enabled) return null
      const healthy = await this.getReferenceApiHealthCached()
      if (!healthy) return null
      const client = await this.getClientById(clientId)
      if (!client?.state) return null
      return await buildBenchmarkBlock(
        this.duckdb.connection,
        settings.baseUrl,
        client.state,
        clientId,
        periodMonth,
        healthy
      )
    } catch {
      // Optional enrichment (plan): any failure here degrades to "no benchmark," never an error surfaced to the report.
      return null
    }
  }

  async listClientReportsForPeriod(periodMonth: string): Promise<ClientReport[]> {
    const clients = await this.listClients()
    const reports: ClientReport[] = []
    for (const client of clients) {
      if (!client.active) continue
      reports.push(await buildClientReportFn(this.duckdb.connection, client.clientId, periodMonth))
    }
    return reports
  }

  async getClientFinancialTrend(
    clientId: number,
    endPeriodMonth: string,
    monthsBack = 6
  ): Promise<Array<{ month: string; grossCharges: number; totalCollections: number }>> {
    return buildFinancialTrend(this.duckdb.connection, clientId, endPeriodMonth, monthsBack)
  }

  close(): void {
    this.duckdb.close()
    this.meta.close()
  }
}
