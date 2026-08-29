/**
 * `LocalDataService` — the Phase 1 `IDataService` implementation: DuckDB
 * for analytics, better-sqlite3 for app metadata, both behind one class.
 * Owns the startup sequence (Risk 5): backup-before-migrate, daily
 * backup, integrity check.
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
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
import { buildFinancialTrend, buildPortfolioSparklines } from '../kpi/trend'
import * as analytics from '../kpi/analytics'
import {
  loginRcmPlatform,
  fetchRcmPortfolio,
  fetchRcmClientReport,
  fetchRcmClients,
  fetchRcmBatches,
  fetchRcmBatchEdi837,
  fetchAllRcmClaims,
  RcmConnectorError,
  findOrCreateClientForSync,
  upsertMonthlySummaryFromReport,
  upsertKpiSnapshotFromReport,
  findLocalClientIdByCode,
  countApiSourcedClaims,
  findApiClaimIdByIdentifier,
  enrichClaimFromPlatform,
  type RcmBatchRow,
  type RcmConnectorConfig,
  type RcmPlatformClientRow
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
  automationRuleInputSchema,
  automationRuleSchema,
  backupStatusSchema,
  brandingInputSchema,
  brandingSchema,
  clientPatchSchema,
  clientSchema,
  connectorBatchSyncResultSchema,
  connectorClaimLevelSyncResultSchema,
  connectorSettingsSchema,
  connectorSyncResultSchema,
  connectorSyncStatusRowSchema,
  connectorTestResultSchema,
  emailSendQueueRowSchema,
  emailSettingsSchema,
  exportAuditLogRowSchema,
  importJobSchema,
  mappingTemplateSchema,
  monthlySummaryInputSchema,
  monthlySummarySchema,
  newClientInputSchema,
  newMappingTemplateInputSchema,
  portalSettingsSchema,
  quarantineRowSchema,
  referenceApiCacheRefreshResultSchema,
  referenceApiSettingsSchema,
  runCsvImportInputSchema,
  runX12ImportInputSchema,
  x12ParseSummarySchema,
  type ArAgingByClientRow,
  type AutomationInboxSettings,
  type AutomationRule,
  type AutomationRuleInput,
  type BackupStatus,
  type Branding,
  type BrandingInput,
  type Client,
  type ClientPatch,
  type ClientReport,
  type ConnectorClaimLevelSyncResult,
  type ConnectorSettings,
  type ConnectorSyncResult,
  type ConnectorSyncStatusRow,
  type ConnectorTestResult,
  type DaysInArTrendPoint,
  type DenialListRow,
  type EmailSendQueueRow,
  type EmailSettings,
  type ExportAuditLogRow,
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
  type PortalSettings,
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
        passwordEncoding: null,
        syncClaimLevel: true
      })
    }
    return connectorSettingsSchema.parse({
      baseUrl: (row.base_url as string | null) ?? null,
      username: (row.username as string | null) ?? null,
      hasPassword: Boolean(row.password_data),
      enabled: Boolean(row.enabled),
      passwordEncoding: (row.password_encoding as 'safeStorage' | 'plaintext' | null) ?? null,
      // `sync_claim_level` predates the column existing at all in an
      // older meta.db (`ensureColumn` backfills it as `1`/true on next
      // open, but a row read between "table missing the column" and
      // that backfill can't happen — `ensureColumn` always runs before
      // any query does) — `?? true` is just the same "unset -> the
      // documented default" fallback as every other nullable column here.
      syncClaimLevel: row.sync_claim_level === undefined ? true : Boolean(row.sync_claim_level)
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
    syncClaimLevel: boolean
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
        `INSERT INTO connector_settings (id, base_url, username, password_data, password_encoding, enabled, sync_claim_level, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (id) DO UPDATE SET
           base_url = excluded.base_url, username = excluded.username,
           password_data = excluded.password_data, password_encoding = excluded.password_encoding,
           enabled = excluded.enabled, sync_claim_level = excluded.sync_claim_level,
           updated_at = excluded.updated_at`
      )
      .run(
        input.baseUrl,
        input.username,
        passwordData,
        passwordEncoding,
        input.enabled ? 1 : 0,
        input.syncClaimLevel ? 1 : 0
      )

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

  /** Claim-level sync's since-cursor (docs/connectors.md) — the highest platform `SubmissionBatch.id` successfully imported for this client so far. `null` if it's never run. */
  private getLastBatchCursor(clientCode: string): number | null {
    const row = this.meta
      .prepare('SELECT last_batch_cursor FROM connector_sync_state WHERE client_code = ?')
      .get(clientCode) as { last_batch_cursor: number | null } | undefined
    return row?.last_batch_cursor ?? null
  }

  /**
   * Advances the cursor. Uses `INSERT ... ON CONFLICT` (not a bare
   * `UPDATE`) purely as a defensive fallback — in practice a
   * `connector_sync_state` row for this client already exists by the
   * time this runs (the summary-sync loop above always
   * `upsertConnectorSyncState`s one first), but this makes the method
   * correct even if a caller reordered that.
   */
  private setLastBatchCursor(clientCode: string, batchId: number): void {
    this.meta
      .prepare(
        `INSERT INTO connector_sync_state (client_code, last_batch_cursor)
         VALUES (?, ?)
         ON CONFLICT (client_code) DO UPDATE SET last_batch_cursor = excluded.last_batch_cursor`
      )
      .run(clientCode, batchId)
  }

  /**
   * The batch-import half of the claim-level sync (docs/connectors.md):
   * for each client this cycle's summary sync touched, list its
   * submission batches, download every new one's (`id` past this
   * client's `last_batch_cursor`, `status !== 'OPEN'` — an open batch is
   * still being assembled, not final) 837.edi to a scratch file, and run
   * it through `run837Import` with `claimSource: 'api'`. `run837Import`'s
   * own `file_sha256` dedup makes a re-synced batch a no-op — this method
   * only needs to decide *which* batches are worth asking for.
   *
   * Batches are processed oldest-first per client, and **a batch's
   * failure never stops the rest of that client's batches this cycle**
   * (same "one bad item never blocks the others" philosophy as
   * `run837Import`'s own row-level quarantine) — verified necessary
   * against the live reference instance, not just theoretical: a real
   * batch there returns `200` with an **empty** 837.edi body (its
   * claim(s) no longer resolve — voided/reassigned after the batch was
   * created), which `fetchRcmBatchEdi837` passes through as `''` rather
   * than throwing (see its doc comment); this method treats that as
   * "zero claims to import," a clean success, not a failure. For an
   * actual failure (network error, genuinely malformed EDI), the cursor
   * only advances to the highest batch id that succeeded *this cycle* —
   * gaps are allowed (a failed batch doesn't have to be the strict next
   * one after the cursor for a later batch to still count). This means a
   * batch that keeps failing gets tried once more per sync only until a
   * later batch for the same client succeeds, at which point the cursor
   * passes it and it's not retried again — it still shows up in this
   * cycle's `batches[]` with its error for a human to notice, but the
   * alternative (block every later batch forever behind one permanently
   * broken one) is worse, as the live check above demonstrated.
   */
  private async runClaimLevelBatchSync(
    config: RcmConnectorConfig,
    token: string,
    platformClients: RcmPlatformClientRow[],
    allBatches: RcmBatchRow[],
    localClientCodes: string[]
  ): Promise<ConnectorClaimLevelSyncResult['batches']> {
    const platformIdByCode = new Map(platformClients.map((c) => [c.code, c.id]))
    const results: ConnectorClaimLevelSyncResult['batches'] = []
    const scratchDir = await mkdtemp(join(tmpdir(), 'aethera-connector-batches-'))

    try {
      for (const clientCode of localClientCodes) {
        const platformId = platformIdByCode.get(clientCode)
        if (platformId === undefined) continue // platform has no client matching this code — nothing to batch-sync
        const localClientId = await findLocalClientIdByCode(this.duckdb.connection, clientCode)
        if (localClientId === null) continue

        const cursor = this.getLastBatchCursor(clientCode) ?? 0
        const pending = allBatches
          .filter((b) => b.client_id === platformId && b.status !== 'OPEN' && b.id > cursor)
          .sort((a, b) => a.id - b.id)

        for (const batch of pending) {
          try {
            const edi = await fetchRcmBatchEdi837(config, token, batch.id)

            if (!edi.trim()) {
              // A real, observed response — see fetchRcmBatchEdi837's doc
              // comment. Nothing to import; still a success, still
              // advances the cursor.
              this.setLastBatchCursor(clientCode, batch.id)
              results.push(
                connectorBatchSyncResultSchema.parse({
                  clientCode,
                  batchId: batch.id,
                  batchNumber: batch.batch_number,
                  ok: true,
                  claimsRead: 0,
                  claimsLoaded: 0,
                  claimsSkipped: 0,
                  error: null
                })
              )
              continue
            }

            const filePath = join(scratchDir, `batch-${batch.id}.837`)
            await writeFile(filePath, edi, 'utf-8')
            const importResult = await run837Import({
              connection: this.duckdb.connection,
              filePath,
              clientCode,
              claimSource: 'api'
            })
            await rm(filePath, { force: true })
            this.setLastBatchCursor(clientCode, batch.id)
            results.push(
              connectorBatchSyncResultSchema.parse({
                clientCode,
                batchId: batch.id,
                batchNumber: batch.batch_number,
                ok: true,
                claimsRead: importResult.rowsRead,
                claimsLoaded: importResult.rowsLoaded,
                claimsSkipped: importResult.rowsSkipped,
                error: null
              })
            )
          } catch (error) {
            const message = error instanceof RcmConnectorError ? error.message : String(error)
            results.push(
              connectorBatchSyncResultSchema.parse({
                clientCode,
                batchId: batch.id,
                batchNumber: batch.batch_number,
                ok: false,
                claimsRead: 0,
                claimsLoaded: 0,
                claimsSkipped: 0,
                error: message
              })
            )
            // Deliberately no `break`: one batch failing never blocks the
            // rest of this client's pending batches (see doc comment
            // above) — the cursor just doesn't advance past this one
            // unless/until a later batch succeeds.
          }
        }
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true })
    }

    return results
  }

  /**
   * The enrichment half of the claim-level sync (docs/connectors.md):
   * for every client that has at least one `source = 'api'` claim
   * already (skipped entirely otherwise — no point paging its claims),
   * pulls the full current `GET /api/claims` list and upserts
   * paid/allowed/patient-responsibility/status + CARC denials onto the
   * matching local rows. Runs independently of `runClaimLevelBatchSync`
   * (same cycle, but not gated on it succeeding) — an older synced claim
   * whose payer posted a new remittance on the platform side since the
   * last sync needs re-enrichment even when no new batch showed up.
   */
  private async runClaimLevelEnrichment(
    config: RcmConnectorConfig,
    token: string,
    platformClients: RcmPlatformClientRow[],
    localClientCodes: string[]
  ): Promise<ConnectorClaimLevelSyncResult['enrichment']> {
    const platformIdByCode = new Map(platformClients.map((c) => [c.code, c.id]))
    let claimsUpdated = 0
    let denialsWritten = 0
    const errors: { clientCode: string; error: string }[] = []

    for (const clientCode of localClientCodes) {
      const platformId = platformIdByCode.get(clientCode)
      if (platformId === undefined) continue
      const localClientId = await findLocalClientIdByCode(this.duckdb.connection, clientCode)
      if (localClientId === null) continue
      const apiClaimCount = await countApiSourcedClaims(this.duckdb.connection, localClientId)
      if (apiClaimCount === 0) continue

      try {
        const claims = await fetchAllRcmClaims(config, token, platformId)
        for (const claim of claims) {
          const claimId = await findApiClaimIdByIdentifier(
            this.duckdb.connection,
            localClientId,
            claim.claim_number ?? null,
            claim.external_ref ?? null
          )
          if (claimId === null) continue
          const { denialsWritten: written } = await enrichClaimFromPlatform(
            this.duckdb.connection,
            claimId,
            claim
          )
          claimsUpdated += 1
          denialsWritten += written
        }
      } catch (error) {
        const message = error instanceof RcmConnectorError ? error.message : String(error)
        errors.push({ clientCode, error: message })
      }
    }

    return { claimsUpdated, denialsWritten, errors }
  }

  /**
   * The claim-level sync's entry point — runs both halves above and
   * folds their results together. Never throws: a platform that doesn't
   * implement `/api/clients`/`/api/batches`/`/api/claims` at all (an
   * older/minimal reference-contract implementation — these three
   * endpoints are optional relative to the summary-sync contract, see
   * docs/connectors.md) degrades to a clean `enrichment.errors` entry
   * rather than aborting `runConnectorSync`.
   */
  private async runClaimLevelConnectorSync(
    config: RcmConnectorConfig,
    token: string,
    localClientCodes: string[]
  ): Promise<ConnectorClaimLevelSyncResult> {
    let platformClients: RcmPlatformClientRow[]
    let allBatches: RcmBatchRow[]
    try {
      ;[platformClients, allBatches] = await Promise.all([
        fetchRcmClients(config, token),
        fetchRcmBatches(config, token)
      ])
    } catch (error) {
      const message = error instanceof RcmConnectorError ? error.message : String(error)
      return connectorClaimLevelSyncResultSchema.parse({
        enabled: true,
        batches: [],
        enrichment: {
          claimsUpdated: 0,
          denialsWritten: 0,
          errors: [{ clientCode: '*', error: message }]
        }
      })
    }

    const batches = await this.runClaimLevelBatchSync(
      config,
      token,
      platformClients,
      allBatches,
      localClientCodes
    )
    const enrichment = await this.runClaimLevelEnrichment(
      config,
      token,
      platformClients,
      localClientCodes
    )

    return connectorClaimLevelSyncResultSchema.parse({ enabled: true, batches, enrichment })
  }

  /**
   * Pulls the portfolio list + each client's computed report for
   * `periodMonth`, upserting `monthly_summaries`/`kpi_snapshots` with
   * `source: 'synced'` (plan §3 bullet 3). Per-client failure isolation —
   * one client's report failing to fetch/parse never aborts the sync for
   * the rest, matching the batch-export queue's established pattern.
   *
   * Then, when the stored `connector_settings.syncClaimLevel` is on
   * (default — see `mapConnectorSettingsRow`), runs the opt-in
   * claim-level sync (docs/connectors.md) for the same set of clients:
   * new submission batches -> `run837Import`, plus enrichment of
   * previously-synced claims' paid/allowed/status/denials. This reads
   * the setting itself rather than taking it as a parameter — same
   * pattern as `enabled` never gating this method's summary half; the
   * IPC/RPC layer already resolved `baseUrl`/`username`/`password` from
   * the same settings row before calling in.
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

    const settings = await this.getConnectorSettings()
    const claimLevel = settings.syncClaimLevel
      ? await this.runClaimLevelConnectorSync(
          config,
          token,
          portfolio.clients.map((row) => row.client)
        )
      : connectorClaimLevelSyncResultSchema.parse({
          enabled: false,
          batches: [],
          enrichment: { claimsUpdated: 0, denialsWritten: 0, errors: [] }
        })

    return connectorSyncResultSchema.parse({ periodMonth, results, claimLevel })
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
        lastBatchCursor: (row.last_batch_cursor as number | null) ?? null,
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
  // Watch-folder automation (plan §11, Phase 2 chunk D)
  // -------------------------------------------------------------------

  async getAutomationInboxSettings(): Promise<AutomationInboxSettings> {
    const row = this.meta
      .prepare("SELECT value FROM settings WHERE key = 'automation_inbox_root'")
      .get() as { value: string } | undefined
    const pinRows = this.meta
      .prepare(
        'SELECT client_code, template_id FROM automation_folder_templates ORDER BY client_code'
      )
      .all() as Array<{ client_code: string; template_id: string }>
    return {
      inboxRoot: row?.value ?? null,
      folderTemplatePins: pinRows.map((r) => ({
        clientCode: r.client_code,
        templateId: r.template_id
      }))
    }
  }

  async setAutomationInboxRoot(inboxRoot: string | null): Promise<void> {
    if (inboxRoot === null) {
      this.meta.prepare("DELETE FROM settings WHERE key = 'automation_inbox_root'").run()
      return
    }
    this.meta
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('automation_inbox_root', ?, datetime('now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(inboxRoot)
  }

  async setFolderTemplatePin(clientCode: string, templateId: string | null): Promise<void> {
    if (templateId === null) {
      this.meta
        .prepare('DELETE FROM automation_folder_templates WHERE client_code = ?')
        .run(clientCode)
      return
    }
    this.meta
      .prepare(
        `INSERT INTO automation_folder_templates (client_code, template_id, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT (client_code) DO UPDATE SET template_id = excluded.template_id, updated_at = excluded.updated_at`
      )
      .run(clientCode, templateId)
  }

  async getPinnedTemplateId(clientCode: string): Promise<string | null> {
    const row = this.meta
      .prepare('SELECT template_id FROM automation_folder_templates WHERE client_code = ?')
      .get(clientCode) as { template_id: string } | undefined
    return row?.template_id ?? null
  }

  // -------------------------------------------------------------------
  // Report scheduler (plan §11)
  // -------------------------------------------------------------------

  private mapAutomationRuleRow(row: DbRow): AutomationRule {
    return automationRuleSchema.parse({
      ruleId: row.rule_id,
      name: row.name,
      dayOfMonth: toNumber(row.day_of_month),
      clients: JSON.parse(String(row.clients_json)),
      formats: JSON.parse(String(row.formats_json)),
      outputDir: row.output_dir ?? null,
      deliver: row.deliver,
      enabled: Boolean(row.enabled),
      lastRunPeriod: row.last_run_period ?? null,
      lastRunAt: row.last_run_at ?? null,
      lastRunStatus: row.last_run_status ?? null
    })
  }

  async listAutomationRules(): Promise<AutomationRule[]> {
    const rows = this.meta.prepare('SELECT * FROM automation_rules ORDER BY name').all() as DbRow[]
    return rows.map((row) => this.mapAutomationRuleRow(row))
  }

  async saveAutomationRule(input: AutomationRuleInput): Promise<AutomationRule> {
    const validated = automationRuleInputSchema.parse(input)
    const ruleId = validated.ruleId ?? randomUUID()
    this.meta
      .prepare(
        `INSERT INTO automation_rules (rule_id, name, day_of_month, clients_json, formats_json, output_dir, deliver, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (rule_id) DO UPDATE SET
           name = excluded.name, day_of_month = excluded.day_of_month, clients_json = excluded.clients_json,
           formats_json = excluded.formats_json, output_dir = excluded.output_dir, deliver = excluded.deliver,
           enabled = excluded.enabled, updated_at = excluded.updated_at`
      )
      .run(
        ruleId,
        validated.name,
        validated.dayOfMonth,
        JSON.stringify(validated.clients),
        JSON.stringify(validated.formats),
        validated.outputDir ?? null,
        validated.deliver,
        validated.enabled ? 1 : 0
      )
    const row = this.meta
      .prepare('SELECT * FROM automation_rules WHERE rule_id = ?')
      .get(ruleId) as DbRow
    return this.mapAutomationRuleRow(row)
  }

  async deleteAutomationRule(ruleId: string): Promise<void> {
    this.meta.prepare('DELETE FROM automation_rules WHERE rule_id = ?').run(ruleId)
  }

  async recordRuleRun(ruleId: string, periodMonth: string, status: 'ok' | 'error'): Promise<void> {
    this.meta
      .prepare(
        `UPDATE automation_rules SET last_run_period = ?, last_run_at = datetime('now'), last_run_status = ?, updated_at = datetime('now')
         WHERE rule_id = ?`
      )
      .run(periodMonth, status, ruleId)
  }

  // -------------------------------------------------------------------
  // Email delivery (plan §11)
  // -------------------------------------------------------------------

  private mapEmailSettingsRow(row: DbRow | undefined): EmailSettings {
    return emailSettingsSchema.parse({
      host: (row?.host as string | null) ?? null,
      port: row?.port == null ? null : toNumber(row.port),
      secure: row ? Boolean(row.secure) : true,
      username: (row?.username as string | null) ?? null,
      hasPassword: Boolean(row?.password_data),
      passwordEncoding: (row?.password_encoding as 'safeStorage' | 'plaintext' | null) ?? null,
      fromAddress: (row?.from_address as string | null) ?? null,
      subjectTemplate:
        (row?.subject_template as string | undefined) ?? 'Your {client} report — {period}',
      bodyTemplate:
        (row?.body_template as string | undefined) ??
        'Attached is the {client} revenue cycle report for {period}.'
    })
  }

  async getEmailSettings(): Promise<EmailSettings> {
    const row = this.meta.prepare('SELECT * FROM email_settings WHERE id = 1').get() as
      DbRow | undefined
    return this.mapEmailSettingsRow(row)
  }

  async saveEmailSettings(input: {
    host: string
    port: number
    secure: boolean
    username: string | null
    fromAddress: string
    subjectTemplate: string
    bodyTemplate: string
    encryptedPassword?: EncryptedSecretInput
  }): Promise<EmailSettings> {
    const existing = this.meta.prepare('SELECT * FROM email_settings WHERE id = 1').get() as
      DbRow | undefined
    const passwordData =
      input.encryptedPassword?.data ?? (existing?.password_data as string | undefined) ?? null
    const passwordEncoding =
      input.encryptedPassword?.encoding ??
      (existing?.password_encoding as string | undefined) ??
      null

    this.meta
      .prepare(
        `INSERT INTO email_settings (id, host, port, secure, username, password_data, password_encoding, from_address, subject_template, body_template, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (id) DO UPDATE SET
           host = excluded.host, port = excluded.port, secure = excluded.secure, username = excluded.username,
           password_data = excluded.password_data, password_encoding = excluded.password_encoding,
           from_address = excluded.from_address, subject_template = excluded.subject_template,
           body_template = excluded.body_template, updated_at = excluded.updated_at`
      )
      .run(
        input.host,
        input.port,
        input.secure ? 1 : 0,
        input.username,
        passwordData,
        passwordEncoding,
        input.fromAddress,
        input.subjectTemplate,
        input.bodyTemplate
      )
    return this.getEmailSettings()
  }

  async getEncryptedEmailPassword(): Promise<EncryptedSecretInput | null> {
    const row = this.meta.prepare('SELECT * FROM email_settings WHERE id = 1').get() as
      DbRow | undefined
    if (!row?.password_data) return null
    return {
      data: String(row.password_data),
      encoding: row.password_encoding === 'safeStorage' ? 'safeStorage' : 'plaintext'
    }
  }

  // -------------------------------------------------------------------
  // Hosted client portal (plan's Phase 3 addendum, chunk F)
  // -------------------------------------------------------------------

  private mapPortalSettingsRow(row: DbRow | undefined): PortalSettings {
    return portalSettingsSchema.parse({
      baseUrl: (row?.base_url as string | null) ?? null,
      hasAdminToken: Boolean(row?.admin_token_data),
      tokenEncoding: (row?.admin_token_encoding as 'safeStorage' | 'plaintext' | null) ?? null
    })
  }

  async getPortalSettings(): Promise<PortalSettings> {
    const row = this.meta.prepare('SELECT * FROM portal_settings WHERE id = 1').get() as
      DbRow | undefined
    return this.mapPortalSettingsRow(row)
  }

  async savePortalSettings(input: {
    baseUrl: string
    encryptedAdminToken?: EncryptedSecretInput
  }): Promise<PortalSettings> {
    const existing = this.meta.prepare('SELECT * FROM portal_settings WHERE id = 1').get() as
      DbRow | undefined
    const tokenData =
      input.encryptedAdminToken?.data ?? (existing?.admin_token_data as string | undefined) ?? null
    const tokenEncoding =
      input.encryptedAdminToken?.encoding ??
      (existing?.admin_token_encoding as string | undefined) ??
      null

    this.meta
      .prepare(
        `INSERT INTO portal_settings (id, base_url, admin_token_data, admin_token_encoding, updated_at)
         VALUES (1, ?, ?, ?, datetime('now'))
         ON CONFLICT (id) DO UPDATE SET
           base_url = excluded.base_url, admin_token_data = excluded.admin_token_data,
           admin_token_encoding = excluded.admin_token_encoding, updated_at = excluded.updated_at`
      )
      .run(input.baseUrl, tokenData, tokenEncoding)
    return this.getPortalSettings()
  }

  async getEncryptedPortalAdminToken(): Promise<EncryptedSecretInput | null> {
    const row = this.meta.prepare('SELECT * FROM portal_settings WHERE id = 1').get() as
      DbRow | undefined
    if (!row?.admin_token_data) return null
    return {
      data: String(row.admin_token_data),
      encoding: row.admin_token_encoding === 'safeStorage' ? 'safeStorage' : 'plaintext'
    }
  }

  private mapEmailQueueRow(row: DbRow): EmailSendQueueRow {
    return emailSendQueueRowSchema.parse({
      queueId: toNumber(row.queue_id),
      clientCode: row.client_code,
      periodMonth: row.period_month,
      filePaths: JSON.parse(String(row.file_paths_json)),
      recipients: JSON.parse(String(row.recipients_json)),
      subject: row.subject,
      body: row.body,
      status: row.status,
      attempts: toNumber(row.attempts),
      lastError: row.last_error ?? null,
      createdAt: row.created_at,
      lastAttemptAt: row.last_attempt_at ?? null
    })
  }

  async enqueueEmailSend(entry: {
    clientCode: string
    periodMonth: string
    filePaths: string[]
    recipients: string[]
    subject: string
    body: string
  }): Promise<number> {
    const result = this.meta
      .prepare(
        `INSERT INTO email_send_queue (client_code, period_month, file_paths_json, recipients_json, subject, body, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        entry.clientCode,
        entry.periodMonth,
        JSON.stringify(entry.filePaths),
        JSON.stringify(entry.recipients),
        entry.subject,
        entry.body
      )
    return Number(result.lastInsertRowid)
  }

  async listEmailSendQueue(): Promise<EmailSendQueueRow[]> {
    const rows = this.meta
      .prepare('SELECT * FROM email_send_queue ORDER BY created_at DESC')
      .all() as DbRow[]
    return rows.map((row) => this.mapEmailQueueRow(row))
  }

  async markEmailSendResult(queueId: number, ok: boolean, error: string | null): Promise<void> {
    this.meta
      .prepare(
        `UPDATE email_send_queue SET status = ?, attempts = attempts + 1, last_error = ?, last_attempt_at = datetime('now')
         WHERE queue_id = ?`
      )
      .run(ok ? 'sent' : 'failed', error, queueId)
  }

  async listExportAuditLog(limit = 200): Promise<ExportAuditLogRow[]> {
    const rows = this.meta
      .prepare('SELECT * FROM export_audit_log ORDER BY performed_at DESC LIMIT ?')
      .all(limit) as DbRow[]
    return rows.map((row) =>
      exportAuditLogRowSchema.parse({
        auditId: toNumber(row.audit_id),
        action: row.action,
        clientCode: row.client_code ?? null,
        periodMonth: row.period_month ?? null,
        filePath: row.file_path ?? null,
        performedAt: row.performed_at,
        performedBy: row.performed_by ?? null
      })
    )
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

  async getPortfolioSparklines(
    clientIds: number[],
    endPeriodMonth: string,
    monthsBack = 6
  ): Promise<Array<{ clientId: number; grossCharges: number[] }>> {
    return buildPortfolioSparklines(this.duckdb.connection, clientIds, endPeriodMonth, monthsBack)
  }

  close(): void {
    this.duckdb.close()
    this.meta.close()
  }
}
