/**
 * Thin typed wrapper over `window.aethera.invoke` (plan §5). Screens and
 * data hooks call functions from here, never `window.aethera` directly —
 * that keeps the IPC channel names in exactly one place.
 */
import type {
  ArAgingByClientRow,
  AutomationInboxSettings,
  AutomationRule,
  AutomationRuleInput,
  Branding,
  BrandingInput,
  Client,
  ClientPatch,
  ClientReport,
  ConnectorSettings,
  ConnectorSettingsInput,
  ConnectorSyncResult,
  ConnectorSyncStatusRow,
  ConnectorTestResult,
  DataModeStatus,
  UpdateCheckResult,
  UpdateSettingsStatus,
  DaysInArTrendPoint,
  DenialListRow,
  DryRunResult,
  EmailSendQueueRow,
  EmailSettings,
  EmailSettingsInput,
  ExportAuditLogRow,
  ExportFormat,
  ExportResult,
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
  PortalSettings,
  PortalSettingsInput,
  PublishToPortalInput,
  PublishToPortalResult,
  QuarantineRow,
  ReferenceApiCacheRefreshResult,
  ReferenceApiSettings,
  ReferenceApiSettingsInput,
  RunCsvImportInput,
  RunX12ImportInput,
  ScanResult,
  SendReportPackResult,
  SetServerDataModeInput,
  TopAgedClaimRow,
  X12ParseSummary,
  BackupStatus
} from '../../../shared/domain'
import type { IpcRequest, IpcResponse } from '../../../shared/ipc-contract'

export function ping(message: string): Promise<IpcResponse<'ping'>> {
  const payload: IpcRequest<'ping'> = { message }
  return window.aethera.invoke('ping', payload)
}

// --- Clients ---

export async function listClients(): Promise<Client[]> {
  const { clients } = await window.aethera.invoke('clients:list', {})
  return clients
}

export function createClient(input: NewClientInput): Promise<Client> {
  return window.aethera.invoke('clients:create', input)
}

export function updateClient(clientId: number, patch: ClientPatch): Promise<Client> {
  return window.aethera.invoke('clients:update', { clientId, patch })
}

export function deactivateClient(clientId: number): Promise<Client> {
  return window.aethera.invoke('clients:deactivate', { clientId })
}

// --- Mapping templates ---

export async function listMappingTemplates(): Promise<MappingTemplate[]> {
  const { templates } = await window.aethera.invoke('mappingTemplates:list', {})
  return templates
}

export function saveMappingTemplate(input: NewMappingTemplateInput): Promise<MappingTemplate> {
  return window.aethera.invoke('mappingTemplates:save', input)
}

export async function exportMappingTemplateToFile(templateId: string): Promise<string | null> {
  const { filePath } = await window.aethera.invoke('mappingTemplates:exportToFile', { templateId })
  return filePath
}

export async function importMappingTemplateFromFile(): Promise<MappingTemplate | null> {
  const { template } = await window.aethera.invoke('mappingTemplates:importFromFile', {})
  return template
}

// --- Imports ---

export async function listImportJobs(): Promise<ImportJob[]> {
  const { jobs } = await window.aethera.invoke('importJobs:list', {})
  return jobs
}

export async function getImportJob(jobId: number): Promise<ImportJob | null> {
  const { job } = await window.aethera.invoke('importJobs:get', { jobId })
  return job
}

export function runCsvImport(input: RunCsvImportInput): Promise<ImportJob> {
  return window.aethera.invoke('importJobs:runCsv', input)
}

export async function listQuarantineRows(jobId: number): Promise<QuarantineRow[]> {
  const { rows } = await window.aethera.invoke('importJobs:listQuarantine', { jobId })
  return rows
}

export async function pickImportFile(): Promise<string | null> {
  const { filePath } = await window.aethera.invoke('importJobs:pickFile', {})
  return filePath
}

export async function peekFileHeaders(filePath: string): Promise<string[]> {
  const { headers } = await window.aethera.invoke('importJobs:peekHeaders', { filePath })
  return headers
}

export async function suggestMapping(
  headers: string[]
): Promise<IpcResponse<'importJobs:suggestMapping'>['suggestions']> {
  const { suggestions } = await window.aethera.invoke('importJobs:suggestMapping', { headers })
  return suggestions
}

export async function previewMapping(
  filePath: string,
  mapping: NewMappingTemplateInput
): Promise<IpcResponse<'importJobs:previewMapping'>['rows']> {
  const { rows } = await window.aethera.invoke('importJobs:previewMapping', { filePath, mapping })
  return rows
}

// --- X12 835/837 ---

export async function detectImportFileKind(filePath: string): Promise<ImportFileKind> {
  const { kind } = await window.aethera.invoke('importJobs:detectFileKind', { filePath })
  return kind
}

export async function previewX12Import(filePath: string): Promise<X12ParseSummary> {
  const { summary } = await window.aethera.invoke('importJobs:previewX12', { filePath })
  return summary
}

export function runX12Import(input: RunX12ImportInput): Promise<ImportJob> {
  return window.aethera.invoke('importJobs:runX12', input)
}

// --- Manual entry ---

export function upsertMonthlySummary(input: MonthlySummaryInput): Promise<MonthlySummary> {
  return window.aethera.invoke('manualEntry:upsert', input)
}

export async function getMonthlySummary(
  clientId: number,
  periodMonth: string
): Promise<MonthlySummary | null> {
  const { summary } = await window.aethera.invoke('manualEntry:get', { clientId, periodMonth })
  return summary
}

// --- Reports (KPI engine) ---

export function getClientReport(clientId: number, periodMonth: string): Promise<ClientReport> {
  return window.aethera.invoke('reports:client', { clientId, periodMonth })
}

export async function getPortfolioReports(periodMonth: string): Promise<ClientReport[]> {
  const { reports } = await window.aethera.invoke('reports:portfolio', { periodMonth })
  return reports
}

export async function getClientFinancialTrend(
  clientId: number,
  endPeriodMonth: string,
  monthsBack?: number
): Promise<Array<{ month: string; grossCharges: number; totalCollections: number }>> {
  const { points } = await window.aethera.invoke('reports:trend', {
    clientId,
    endPeriodMonth,
    monthsBack
  })
  return points
}

export async function getPortfolioSparklines(
  clientIds: number[],
  endPeriodMonth: string,
  monthsBack = 6
): Promise<Array<{ clientId: number; grossCharges: number[] }>> {
  const { sparklines } = await window.aethera.invoke('reports:portfolioSparklines', {
    clientIds,
    endPeriodMonth,
    monthsBack
  })
  return sparklines
}

// --- Denials / A/R / Payers analytics screens ---

export async function listDenials(
  clientId: number | null,
  periodMonth: string
): Promise<DenialListRow[]> {
  const { rows } = await window.aethera.invoke('analytics:listDenials', { clientId, periodMonth })
  return rows
}

export async function getDenialRateTrend(
  clientId: number | null,
  endPeriodMonth: string,
  monthsBack?: number
): Promise<MonthlyRateTrendPoint[]> {
  const { points } = await window.aethera.invoke('analytics:denialRateTrend', {
    clientId,
    endPeriodMonth,
    monthsBack
  })
  return points
}

export async function getArAgingByClient(): Promise<ArAgingByClientRow[]> {
  const { rows } = await window.aethera.invoke('analytics:arAgingByClient', {})
  return rows
}

export function getArPayerVsPatientSplit(clientId: number | null): Promise<PayerVsPatientSplit> {
  return window.aethera.invoke('analytics:arPayerVsPatientSplit', { clientId })
}

export async function getTopAgedClaims(
  clientId: number | null,
  limit?: number
): Promise<TopAgedClaimRow[]> {
  const { rows } = await window.aethera.invoke('analytics:topAgedClaims', { clientId, limit })
  return rows
}

export async function getDaysInArTrend(
  clientId: number | null,
  endPeriodMonth: string,
  monthsBack?: number
): Promise<DaysInArTrendPoint[]> {
  const { points } = await window.aethera.invoke('analytics:daysInArTrend', {
    clientId,
    endPeriodMonth,
    monthsBack
  })
  return points
}

export async function getPayerAnalysis(
  clientId: number | null,
  periodMonth: string
): Promise<PayerAnalysisRow[]> {
  const { rows } = await window.aethera.invoke('analytics:payerAnalysis', { clientId, periodMonth })
  return rows
}

export async function getPayerMixTrend(
  clientId: number | null,
  endPeriodMonth: string,
  monthsBack?: number
): Promise<PayerMixTrendPoint[]> {
  const { points } = await window.aethera.invoke('analytics:payerMixTrend', {
    clientId,
    endPeriodMonth,
    monthsBack
  })
  return points
}

// --- Generic RCM Platform REST connector (plan §3 bullet 3) ---

export function getConnectorSettings(): Promise<ConnectorSettings> {
  return window.aethera.invoke('connector:getSettings', {})
}

export function saveConnectorSettings(input: ConnectorSettingsInput): Promise<ConnectorSettings> {
  return window.aethera.invoke('connector:saveSettings', input)
}

export function testConnectorConnection(): Promise<ConnectorTestResult> {
  return window.aethera.invoke('connector:testConnection', {})
}

export function syncConnectorNow(periodMonth: string): Promise<ConnectorSyncResult> {
  return window.aethera.invoke('connector:syncNow', { periodMonth })
}

export async function getConnectorSyncStatus(): Promise<ConnectorSyncStatusRow[]> {
  const { rows } = await window.aethera.invoke('connector:syncStatus', {})
  return rows
}

// --- Reference & Benchmark API connector (beacon paragraph) ---

export function getReferenceApiSettings(): Promise<ReferenceApiSettings> {
  return window.aethera.invoke('referenceApi:getSettings', {})
}

export function saveReferenceApiSettings(
  input: ReferenceApiSettingsInput
): Promise<ReferenceApiSettings> {
  return window.aethera.invoke('referenceApi:saveSettings', input)
}

export function testReferenceApiConnection(): Promise<ConnectorTestResult> {
  return window.aethera.invoke('referenceApi:testConnection', {})
}

export function refreshReferenceApiCache(): Promise<ReferenceApiCacheRefreshResult> {
  return window.aethera.invoke('referenceApi:refreshCache', {})
}

export async function getCarcDescriptions(codes: string[]): Promise<Record<string, string>> {
  const { descriptions } = await window.aethera.invoke('referenceApi:getCarcDescriptions', {
    codes
  })
  return descriptions
}

// --- Backups ---

export function getBackupStatus(): Promise<BackupStatus> {
  return window.aethera.invoke('backups:status', {})
}

export function runBackupNow(): Promise<BackupStatus> {
  return window.aethera.invoke('backups:runNow', {})
}

export function restoreLatestBackup(): Promise<{ restoredFrom: string }> {
  return window.aethera.invoke('backups:restoreLatest', {})
}

// --- Branding ---

export function getBranding(): Promise<Branding> {
  return window.aethera.invoke('branding:get', {})
}

export function updateBranding(input: BrandingInput): Promise<Branding> {
  return window.aethera.invoke('branding:update', input)
}

export function pickAndSetBrandingLogo(): Promise<Branding> {
  return window.aethera.invoke('branding:pickAndSetLogo', {})
}

// --- Export engine: PDF/PPTX/XLSX, single + batch (plan §6, Phase 2 chunk B) ---

export async function generateClientReport(
  clientId: number,
  periodMonth: string,
  formats: ExportFormat[]
): Promise<ExportResult[]> {
  const { results } = await window.aethera.invoke('exports:generateReport', {
    clientId,
    periodMonth,
    formats
  })
  return results
}

export async function generateClientReportBatch(
  clientIds: number[],
  periodMonth: string,
  formats: ExportFormat[]
): Promise<ExportResult[]> {
  const { results } = await window.aethera.invoke('exports:generateBatch', {
    clientIds,
    periodMonth,
    formats
  })
  return results
}

// --- Print route internal signal ---

/** `chartImages`: each rendered chart's captured PNG data URI, keyed by chart name (plan §6 PPTX). */
export function signalPrintReady(
  chartImages: Record<string, string> = {}
): Promise<{ ok: boolean }> {
  return window.aethera.invoke('reports:printReady', { chartImages })
}

// --- Watch-folder auto-import (plan §11) ---

export function getAutomationInboxSettings(): Promise<AutomationInboxSettings> {
  return window.aethera.invoke('automation:getInboxSettings', {})
}

export function setAutomationInboxRoot(inboxRoot: string | null): Promise<AutomationInboxSettings> {
  return window.aethera.invoke('automation:setInboxRoot', { inboxRoot })
}

export function setFolderTemplatePin(
  clientCode: string,
  templateId: string | null
): Promise<AutomationInboxSettings> {
  return window.aethera.invoke('automation:setFolderTemplatePin', { clientCode, templateId })
}

export function scanInboxNow(): Promise<ScanResult> {
  return window.aethera.invoke('automation:scanInboxNow', {})
}

// --- Report scheduler (plan §11) ---

export async function listAutomationRules(): Promise<AutomationRule[]> {
  const { rules } = await window.aethera.invoke('automation:listRules', {})
  return rules
}

export function saveAutomationRule(input: AutomationRuleInput): Promise<AutomationRule> {
  return window.aethera.invoke('automation:saveRule', input)
}

export async function deleteAutomationRule(ruleId: string): Promise<void> {
  await window.aethera.invoke('automation:deleteRule', { ruleId })
}

export function dryRunAutomationRule(ruleId: string): Promise<DryRunResult> {
  return window.aethera.invoke('automation:dryRunRule', { ruleId })
}

export function runAutomationRuleNow(ruleId: string): Promise<{ ok: boolean; message: string }> {
  return window.aethera.invoke('automation:runRuleNow', { ruleId })
}

export function copyTaskSchedulerCommand(ruleId: string): Promise<{ command: string }> {
  return window.aethera.invoke('automation:copyTaskSchedulerCommand', { ruleId })
}

// --- Email delivery (plan §11) ---

export function getEmailSettings(): Promise<EmailSettings> {
  return window.aethera.invoke('automation:getEmailSettings', {})
}

export function saveEmailSettings(input: EmailSettingsInput): Promise<EmailSettings> {
  return window.aethera.invoke('automation:saveEmailSettings', input)
}

export function testEmailConnection(): Promise<{ ok: boolean; message: string }> {
  return window.aethera.invoke('automation:testEmailConnection', {})
}

export async function listEmailSendQueue(): Promise<EmailSendQueueRow[]> {
  const { rows } = await window.aethera.invoke('automation:listSendQueue', {})
  return rows
}

export function retryEmailSend(queueId: number): Promise<{ ok: boolean; error: string | null }> {
  return window.aethera.invoke('automation:retrySend', { queueId })
}

export function sendReportPackNow(
  clientId: number,
  periodMonth: string,
  formats: ExportFormat[]
): Promise<SendReportPackResult> {
  return window.aethera.invoke('automation:sendReportPackNow', { clientId, periodMonth, formats })
}

// --- Automation screen run history ---

export async function listExportAuditLog(): Promise<ExportAuditLogRow[]> {
  const { rows } = await window.aethera.invoke('automation:listExportAuditLog', {})
  return rows
}

// --- Opt-in update check (notify only) ---

export function getUpdateStatus(): Promise<UpdateSettingsStatus> {
  return window.aethera.invoke('updates:getStatus', {})
}

export function setAutoCheckUpdates(enabled: boolean): Promise<UpdateSettingsStatus> {
  return window.aethera.invoke('updates:setAutoCheck', { enabled })
}

export function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  return window.aethera.invoke('updates:checkNow', {})
}

// --- Data mode: Local / Server (plan's Phase 3 addendum, chunk E) ---

export function getDataMode(): Promise<DataModeStatus> {
  return window.aethera.invoke('dataMode:get', {})
}

export function setLocalDataMode(): Promise<DataModeStatus> {
  return window.aethera.invoke('dataMode:setLocal', {})
}

export function setServerDataMode(input: SetServerDataModeInput): Promise<DataModeStatus> {
  return window.aethera.invoke('dataMode:setServer', input)
}

export function testServerDataModeConnection(
  input: SetServerDataModeInput
): Promise<ConnectorTestResult> {
  return window.aethera.invoke('dataMode:testServerConnection', input)
}

export async function restartApp(): Promise<void> {
  await window.aethera.invoke('app:restart', {})
}

// --- Hosted client portal (plan's Phase 3 addendum, chunk F) ---

export function getPortalSettings(): Promise<PortalSettings> {
  return window.aethera.invoke('portal:getSettings', {})
}

export function savePortalSettings(input: PortalSettingsInput): Promise<PortalSettings> {
  return window.aethera.invoke('portal:saveSettings', input)
}

export function testPortalConnection(): Promise<{ ok: boolean; message: string }> {
  return window.aethera.invoke('portal:testConnection', {})
}

export function publishToPortal(input: PublishToPortalInput): Promise<PublishToPortalResult> {
  return window.aethera.invoke('portal:publishReport', input)
}
