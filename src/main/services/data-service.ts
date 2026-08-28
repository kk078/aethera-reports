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
  AutomationInboxSettings,
  AutomationRule,
  AutomationRuleInput,
  BackupStatus,
  Branding,
  BrandingInput,
  Client,
  ClientPatch,
  ClientReport,
  ConnectorSettings,
  ConnectorSyncResult,
  ConnectorSyncStatusRow,
  ConnectorTestResult,
  DaysInArTrendPoint,
  DenialListRow,
  EmailSendQueueRow,
  EmailSettings,
  ExportAuditLogRow,
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
  ReferenceApiCacheRefreshResult,
  ReferenceApiSettings,
  ReferenceApiSettingsInput,
  RunCsvImportInput,
  RunX12ImportInput,
  TopAgedClaimRow,
  X12ParseSummary
} from '../../shared/domain'

/**
 * Shape of an already-encrypted (or documented-plaintext-fallback)
 * secret — structurally identical to `credentials.ts`'s `EncryptedSecret`
 * but declared independently here so this Electron-free file never even
 * has a `import type` edge to that Electron-touching module. Only
 * `ipc/rcm-connector.ts` produces/consumes the real encryption; this
 * interface just moves the opaque blob.
 */
export interface EncryptedSecretInput {
  data: string
  encoding: 'safeStorage' | 'plaintext'
}

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

  // --- Generic RCM Platform REST connector (plan §3 bullet 3, Phase 2 chunk C) ---
  getConnectorSettings(): Promise<ConnectorSettings>
  /** `encryptedPassword` is already-encrypted (or plaintext-fallback-flagged) by the caller — this method never touches `safeStorage`. Omit to keep the currently stored password. */
  saveConnectorSettings(input: {
    baseUrl: string
    username: string
    enabled: boolean
    encryptedPassword?: EncryptedSecretInput
  }): Promise<ConnectorSettings>
  getEncryptedConnectorPassword(): Promise<EncryptedSecretInput | null>
  /** Password already decrypted by the caller (`ipc/rcm-connector.ts`, via `credentials.ts`) — this method never touches `safeStorage` itself. */
  testConnectorConnection(
    baseUrl: string,
    username: string,
    password: string
  ): Promise<ConnectorTestResult>
  runConnectorSync(
    baseUrl: string,
    username: string,
    password: string,
    periodMonth: string
  ): Promise<ConnectorSyncResult>
  listConnectorSyncStatus(): Promise<ConnectorSyncStatusRow[]>

  // --- Reference & Benchmark API connector (beacon paragraph, Phase 2 chunk C) ---
  getReferenceApiSettings(): Promise<ReferenceApiSettings>
  saveReferenceApiSettings(input: ReferenceApiSettingsInput): Promise<ReferenceApiSettings>
  testReferenceApiConnection(): Promise<ConnectorTestResult>
  refreshReferenceApiCache(): Promise<ReferenceApiCacheRefreshResult>
  getCarcDescriptions(codes: string[]): Promise<Record<string, string>>

  // --- Watch-folder automation (plan §11, Phase 2 chunk D) ---
  getAutomationInboxSettings(): Promise<AutomationInboxSettings>
  setAutomationInboxRoot(inboxRoot: string | null): Promise<void>
  /** `templateId: null` removes the pin. */
  setFolderTemplatePin(clientCode: string, templateId: string | null): Promise<void>
  getPinnedTemplateId(clientCode: string): Promise<string | null>

  // --- Report scheduler (plan §11) ---
  listAutomationRules(): Promise<AutomationRule[]>
  saveAutomationRule(input: AutomationRuleInput): Promise<AutomationRule>
  deleteAutomationRule(ruleId: string): Promise<void>
  recordRuleRun(ruleId: string, periodMonth: string, status: 'ok' | 'error'): Promise<void>

  // --- Email delivery (plan §11) ---
  getEmailSettings(): Promise<EmailSettings>
  /** `encryptedPassword` already-encrypted by the caller, same pattern as the RCM connector's password. Omit to keep the currently stored one. */
  saveEmailSettings(input: {
    host: string
    port: number
    secure: boolean
    username: string | null
    fromAddress: string
    subjectTemplate: string
    bodyTemplate: string
    encryptedPassword?: EncryptedSecretInput
  }): Promise<EmailSettings>
  getEncryptedEmailPassword(): Promise<EncryptedSecretInput | null>
  enqueueEmailSend(entry: {
    clientCode: string
    periodMonth: string
    filePaths: string[]
    recipients: string[]
    subject: string
    body: string
  }): Promise<number>
  listEmailSendQueue(): Promise<EmailSendQueueRow[]>
  markEmailSendResult(queueId: number, ok: boolean, error: string | null): Promise<void>
  listExportAuditLog(limit?: number): Promise<ExportAuditLogRow[]>

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
