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
import type { IDataService } from './data-service'
import {
  backupStatusSchema,
  brandingInputSchema,
  brandingSchema,
  clientPatchSchema,
  clientSchema,
  importJobSchema,
  mappingTemplateSchema,
  monthlySummaryInputSchema,
  monthlySummarySchema,
  newClientInputSchema,
  newMappingTemplateInputSchema,
  quarantineRowSchema,
  runCsvImportInputSchema,
  runX12ImportInputSchema,
  x12ParseSummarySchema,
  type BackupStatus,
  type Branding,
  type BrandingInput,
  type Client,
  type ClientPatch,
  type ClientReport,
  type ImportFileKind,
  type ImportJob,
  type MappingTemplate,
  type MonthlySummary,
  type MonthlySummaryInput,
  type NewClientInput,
  type NewMappingTemplateInput,
  type QuarantineRow,
  type RunCsvImportInput,
  type RunX12ImportInput,
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
      `INSERT INTO clients (code, name, contract_type, contract_rate, sla_days_to_submit, report_recipients, active)
       VALUES (?, ?, ?, ?, ?, ?, true)
       RETURNING *`,
      [
        validated.code,
        validated.name,
        validated.contractType ?? null,
        validated.contractRate ?? null,
        validated.slaDaysToSubmit ?? null,
        JSON.stringify(validated.reportRecipients ?? [])
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
      active: validated.active ?? existing.active
    }

    const reader = await this.duckdb.connection.runAndReadAll(
      `UPDATE clients SET name = ?, contract_type = ?, contract_rate = ?, sla_days_to_submit = ?,
         report_recipients = ?, active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE client_id = ?
       RETURNING *`,
      [
        merged.name,
        merged.contractType,
        merged.contractRate,
        merged.slaDaysToSubmit,
        JSON.stringify(merged.reportRecipients),
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
      priorValues: row.prior_values ? JSON.parse(String(row.prior_values)) : null
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
         claims_submitted, denials_count, notes, prior_values
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         prior_values = excluded.prior_values`,
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
  // KPI engine / reports (plan §4)
  // -------------------------------------------------------------------

  async buildClientReport(clientId: number, periodMonth: string): Promise<ClientReport> {
    return buildClientReportFn(this.duckdb.connection, clientId, periodMonth)
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
