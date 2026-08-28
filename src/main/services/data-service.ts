/**
 * `IDataService` — the server-mode seam (plan §1). The renderer only
 * ever reaches the database through this interface via IPC; importers
 * and the KPI engine take a raw DB handle directly. `LocalDataService`
 * is the only implementation in Phase 1 — a future `RemoteDataService`
 * (Phase 3) implements the same interface over HTTP against a shared
 * server, and nothing above this boundary has to change.
 *
 * No Electron imports here (enforced by the `no-restricted-imports`
 * ESLint rule in `eslint.config.mjs`).
 */
import type {
  ArAgingByClientRow,
  BackupStatus,
  Branding,
  BrandingInput,
  Client,
  ClientPatch,
  ClientReport,
  DaysInArTrendPoint,
  DenialListRow,
  ImportFileKind,
  ImportJob,
  MappingTemplate,
  MonthlyRateTrendPoint,
  MonthlySummary,
  MonthlySummaryInput,
  NewClientInput,
  NewMappingTemplateInput,
  PayerAnalysisRow,
  PayerMixTrendPoint,
  PayerVsPatientSplit,
  QuarantineRow,
  RunCsvImportInput,
  RunX12ImportInput,
  TopAgedClaimRow,
  X12ParseSummary
} from '../../shared/domain'

export interface IDataService {
  // --- Clients ---
  listClients(): Promise<Client[]>
  getClientByCode(code: string): Promise<Client | null>
  createClient(input: NewClientInput): Promise<Client>
  updateClient(clientId: number, patch: ClientPatch): Promise<Client>
  deactivateClient(clientId: number): Promise<Client>

  // --- Mapping templates (meta.db) ---
  listMappingTemplates(): Promise<MappingTemplate[]>
  getMappingTemplate(templateId: string): Promise<MappingTemplate | null>
  saveMappingTemplate(input: NewMappingTemplateInput): Promise<MappingTemplate>
  exportMappingTemplate(templateId: string): Promise<string>
  importMappingTemplate(templateJson: string): Promise<MappingTemplate>

  // --- Imports ---
  listImportJobs(): Promise<ImportJob[]>
  getImportJob(jobId: number): Promise<ImportJob | null>
  runCsvImport(input: RunCsvImportInput): Promise<ImportJob>
  listQuarantineRows(jobId: number): Promise<QuarantineRow[]>

  // --- X12 835/837 (plan §3 bullet 2) ---
  detectImportFileKind(filePath: string): Promise<ImportFileKind>
  previewX12Import(filePath: string): Promise<X12ParseSummary>
  runX12Import(input: RunX12ImportInput): Promise<ImportJob>

  // --- Manual entry ---
  upsertMonthlySummary(input: MonthlySummaryInput): Promise<MonthlySummary>
  getMonthlySummary(clientId: number, periodMonth: string): Promise<MonthlySummary | null>

  // --- Denials / A/R / Payers analytics screens (plan §5, Phase 2 chunk B) ---
  listDenials(clientId: number | null, periodMonth: string): Promise<DenialListRow[]>
  getDenialRateTrend(
    clientId: number | null,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<MonthlyRateTrendPoint[]>
  getArAgingByClient(): Promise<ArAgingByClientRow[]>
  getArPayerVsPatientSplit(clientId: number | null): Promise<PayerVsPatientSplit>
  getTopAgedClaims(clientId: number | null, limit?: number): Promise<TopAgedClaimRow[]>
  getDaysInArTrend(
    clientId: number | null,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<DaysInArTrendPoint[]>
  getPayerAnalysis(clientId: number | null, periodMonth: string): Promise<PayerAnalysisRow[]>
  getPayerMixTrend(
    clientId: number | null,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<PayerMixTrendPoint[]>

  // --- KPI engine / reports (plan §4) ---
  buildClientReport(clientId: number, periodMonth: string): Promise<ClientReport>
  listClientReportsForPeriod(periodMonth: string): Promise<ClientReport[]>
  getClientFinancialTrend(
    clientId: number,
    endPeriodMonth: string,
    monthsBack?: number
  ): Promise<Array<{ month: string; grossCharges: number; totalCollections: number }>>

  // --- Branding (plan §6) ---
  getBranding(): Promise<Branding>
  updateBranding(input: BrandingInput): Promise<Branding>
  setBrandingLogoPath(logoPath: string | null): Promise<Branding>

  // --- Export audit log (plan §6) ---
  recordExport(entry: {
    action: string
    clientCode: string | null
    periodMonth: string | null
    filePath: string | null
  }): void

  // --- Maintenance (Risk 5) ---
  getBackupStatus(): Promise<BackupStatus>
  runBackupNow(): Promise<BackupStatus>
  restoreLatestBackup(): Promise<{ restoredFrom: string }>

  close(): void
}
